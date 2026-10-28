'use strict';
/**
 * AI oversight, end to end on this machine: the real booking robot (dmq's
 * handler, in its own process, in a real headless browser) books on the DMV
 * stand-in (lineright-server's testsite) after the stand-in has "changed"
 * under it — its buttons and labels renamed, its confirmation laid out anew
 * (the stand-in's `drift`). The robot gets stuck, offers its page over the
 * channel, and the app's real overseer takes over with the real agent loop
 * and tools. The one stand-in is the model: a few rules that read the page
 * as the model would get it and answer with tool calls as the model would.
 * So everything is exercised but the language model itself — that is the
 * live check (scripts/oversight-live.js).
 *
 * Needs the lineright-server checkout beside this one (LINERIGHT_SERVER_DIR),
 * and Playwright's Chromium; skipped without them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RobotRunner } = require('../src/robots');
const { Overseer } = require('../src/overseer');
const { bookingBrain: brain, checkBrain, diagnoseBrain, to24 } = require('./helpers/brain');

const DMQ = path.join(__dirname, '..', '..', 'dmq');
const SERVER = process.env.LINERIGHT_SERVER_DIR || path.join(__dirname, '..', '..', '..', 'lineright-server');
const STANDIN = path.join(SERVER, 'testsite', 'server.js');
const HAVE = fs.existsSync(STANDIN) && fs.existsSync(path.join(DMQ, 'bin', 'rqp-handler.js'))
  && fs.existsSync(path.join(DMQ, 'node_modules', 'playwright'));
const HOST = path.join(__dirname, '..', 'host');
const PROFILE = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '5555550123' };

async function standIn(drift) {
  const { createState, createServer, slotsFor } = await import(pathToFileURL(STANDIN).href);
  const state = createState({ gate: 'off', officeCount: 0, drift, cancelIntervalMs: 1e9 });
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const office = state.offices.find((o) => o.name === 'Poway');
  const [day] = slotsFor(state, office.code, 'VR');
  return { state, server, base: `http://127.0.0.1:${server.address().port}`, office,
    target: { date: day.date, label: day.times[0], time: to24(day.times[0]) } };
}

async function book(drift, { oversight = true } = {}) {
  const site = await standIn(drift);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-oversight-'));
  const reports = [];
  const opened = [];
  const think = brain(site.target);
  const log = [];
  const overseer = new Overseer({
    getClient: () => ({
      agentOpen: async (body) => { opened.push(body); return { session_id: opened.length, max_calls: 40 }; },
      agentChat: async (_id, body) => think.chat(body),
      agentReport: async (id, body) => { reports.push({ id, body }); return { ok: true }; },
    }),
    getStore: () => ({ get: (_k, d) => d }), getProfile: () => PROFILE,
    getStatus: () => ({ available: oversight, step_credits: 1.7, session_credits: 150 }),
    log: (m) => log.push(m),
  });
  const runner = new RobotRunner({ paths: { dmq: DMQ, browsers: null, host: HOST, packaged: false }, node: process.execPath,
    stateDir: path.join(dir, 'robots'), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const h = { job_id: 77, queue_name: 'Vehicle registration', site_name: 'California DMV', connector: 'dmv.ca.gov.qmatic',
    slot: { office_name: 'Poway', date: site.target.date, time: site.target.time },
    robot: { requires: ['first_name', 'last_name', 'email', 'phone'], guide: 'Search the office, pick the day, the time, fill in the details.' } };
  const envelope = {
    protocol: 'RQP/1', kind: 'booking.request', job_id: 77,
    target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' },
    slot: { window: [site.target.date, site.target.date], allocated: { office_name: 'Poway', date: site.target.date, time: site.target.time } },
    personal_data: { office_mode: 'specific', office: 'Poway', ...PROFILE },
    idempotency_key: `e2e-${drift || 'none'}`,
  };
  const timeoutMs = 150000;
  const watch = overseer.watch(h, { deadline: Date.now() + timeoutMs });
  try {
    const result = await runner.run('book', envelope, { dmvBase: site.base, allowBooking: true, timeoutMs, watch });
    return { result, site, reports, opened, heard: think.heard, log };
  } finally {
    site.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const brainSawNobody = (heard) => {
  const sent = JSON.stringify(heard);
  for (const value of Object.values(PROFILE)) {
    const at = sent.indexOf(value);
    assert.ok(at < 0, `the model never sees "${value}": …${sent.slice(Math.max(0, at - 120), at + 60)}…`);
  }
};

test('the site renamed its buttons and labels: the robot stops, the AI finishes the booking',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const { result, site, reports, opened, heard } = await book('labels');
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.match(result.confirmation, /^TS-[0-9A-F]{8}$/);
  assert.equal(result.overseen, true);
  const made = site.state.bookings;
  assert.equal(made.length, 1, 'booked once');
  assert.equal(made[0].ref, result.confirmation);
  assert.deepEqual(made[0].applicant, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com', phone: '5555550123' },
    'the details typed from the profile, through placeholders');
  assert.equal(`${made[0].date} ${made[0].time}`, `${site.target.date} ${site.target.label}`, 'the slot allocated, no other');
  assert.equal(opened[0].stage, 'booking');
  assert.match(opened[0].trigger, /No "Confirm" button/);
  assert.equal(reports[0].body.outcome, 'booked');
  assert.deepEqual(reports[0].body.steps.map((s) => s.tool).filter((t, i, a) => a.indexOf(t) === i),
    ['click', 'type_text', 'finish']);
  brainSawNobody(heard);
});

test('the confirmation is laid out anew: the robot books, cannot read it, and the AI reads it — and only reads',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const { result, site, reports, opened, heard } = await book('confirmation');
  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.equal(result.confirmation, site.state.bookings[0].ref);
  assert.equal(result.overseen, true);
  assert.equal(opened[0].stage, 'confirming');
  assert.equal(site.state.bookings.length, 1);
  const tools = heard[0].tools.map((t) => t.function.name).sort();
  assert.deepEqual(tools, ['finish', 'look_at_page', 'read_text', 'scroll', 'wait'], 'read only');
  assert.deepEqual(reports[0].body.steps.map((s) => s.tool), ['finish']);
  brainSawNobody(heard);
});

test('the office button is renamed: the AI takes over at the search and goes all the way',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const { result, site, opened, reports, log, heard } = await book('offices,labels,confirmation');
  assert.equal(result.status, 'confirmed', JSON.stringify({ result, reports, log,
    page: heard.length ? heard[heard.length - 1].messages.slice(-1)[0].content.slice(0, 3000) : null }, null, 1));
  assert.equal(result.overseen, true);
  assert.equal(opened[0].stage, 'booking');
  assert.equal(site.state.bookings.length, 1);
  assert.equal(`${site.state.bookings[0].date} ${site.state.bookings[0].time}`, `${site.target.date} ${site.target.label}`);
});

test('without oversight the robot ends as it always did, and with a site as it was nobody steps in',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const off = await book('labels', { oversight: false });
  assert.equal(off.result.status, 'unavailable', JSON.stringify(off.result));
  assert.match(off.result.message, /No "Confirm" button/);
  assert.equal(off.opened.length, 0);
  assert.equal(off.site.state.bookings.length, 0);
  const plain = await book('');
  assert.equal(plain.result.status, 'confirmed');
  assert.equal(plain.result.overseen, undefined);
  assert.equal(plain.opened.length, 0, 'nothing went wrong, nothing to oversee');
});

test('a site described in plain words: the AI alone checks what is open, booking nothing',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const { runSiteTask } = require('../src/agent/sitetask');
  const site = await standIn('');
  const think = checkBrain({ where: 'Poway' });
  const reports = [];
  const opened = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-task-'));
  const runner = new RobotRunner({ paths: { dmq: DMQ, browsers: null, host: HOST, packaged: false }, node: process.execPath,
    stateDir: path.join(dir, 'robots'), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  try {
    const run = await runSiteTask({
      runner,
      client: {
        agentOpen: async (body) => { opened.push(body); return { session_id: 9, max_calls: 40 }; },
        agentChat: async (_id, body) => think.chat(body),
        agentReport: async (id, body) => { reports.push({ id, body }); return { ok: true }; },
      },
      site: { name: 'A DMV office calendar', description: 'Each open day is a button named "<day> Open Times"; "Next month" pages on.',
        start_url: `${site.base}/portal/appointments/select-date?branch=${encodeURIComponent(site.office.code)}&service=VR` },
      kind: 'check', want: 'the first open day', budgetMs: 120000,
    });
    assert.equal(run.outcome.outcome, 'checked', JSON.stringify(run));
    assert.deepEqual(run.outcome.findings, [{ where: 'Poway', date: site.target.date, note: 'open times' }]);
    assert.equal(opened[0].purpose, 'task');
    assert.equal(opened[0].stage, 'task.check');
    assert.equal(reports[0].body.outcome, 'checked');
    assert.equal(reports[0].body.result.findings, 1);
    assert.equal(site.state.bookings.length, 0, 'nothing booked');
    assert.equal(site.state.holds.size, 0, 'nothing held');
    const tools = think.heard[0].tools.map((t) => t.function.name);
    assert.ok(tools.includes('open_page'), 'a task may go about its site by address');
    assert.deepEqual(think.heard[0].tools.find((t) => t.function.name === 'finish').function.parameters.properties.outcome.enum,
      ['checked', 'human_check', 'failed']);
  } finally {
    site.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a line the robots cannot read: the scout fails, and the AI check on the site\'s grant finds what changed, holding nothing',
  { skip: !HAVE && 'needs lineright-server and Playwright', timeout: 240000 }, async () => {
  const { runDiagnosis } = require('../src/agent/diagnose');
  const { createState, createServer } = await import(pathToFileURL(STANDIN).href);
  const state = createState({ gate: 'off', officeCount: 0, drift: 'offices', cancelIntervalMs: 1e9, busyDays: 2 });
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-check-'));
  const runner = new RobotRunner({ paths: { dmq: DMQ, browsers: null, host: HOST, packaged: false }, node: process.execPath,
    stateDir: path.join(dir, 'robots'), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  try {
    // The site's check read: the scout, as the app runs it, on the office that failed.
    const scout = await runner.run('scout', { protocol: 'RQP/1', kind: 'discovery.request',
      target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' }, offices: ['Poway'],
      window: [new Date().toISOString().slice(0, 10), '2027-12-31'], hours: ['08:00', '17:00'], timezone: 'America/Los_Angeles' },
    { dmvBase: base, timeoutMs: 120000 });
    assert.equal(scout.offers.length, 0, JSON.stringify(scout));
    assert.match(scout.checked[0].error, /its button is not Select Location/);
    assert.ok(runner.tail('scout').some((l) => /OFFICE_ERROR/.test(l)), 'the scout\'s log is kept for the AI');
    // The grant that came back with the failed answer, and the AI on it.
    const think = diagnoseBrain({ office: 'Poway' });
    const reports = [];
    const grant = { session_id: 41, issue_id: 3, paid_by: 'site', max_calls: 20, seconds: 180, site_name: 'California DMV',
      queue_name: 'Vehicle registration', offices: ['Poway'], trouble: scout.message,
      start_url: `${base}/portal/appointments/select-appointment-type?option=VR`, base_url: base,
      guide: 'Search the office by city, press its "Select Location", pick an open day, see its times.' };
    const done = await runDiagnosis({ runner, grant, result: scout, robotLog: runner.tail('scout'),
      client: {
        agentChat: async (id, body) => { assert.equal(id, 41, 'every call on the grant'); return think.chat(body); },
        agentReport: async (id, body) => { reports.push({ id, body }); return { ok: true }; },
      } });
    assert.equal(done.diagnosis.outcome, 'site_changed', JSON.stringify({ done, last: think.heard.length
      ? think.heard[think.heard.length - 1].messages.slice(-1)[0].content.slice(0, 2000) : null }, null, 1));
    assert.match(done.diagnosis.cause, /"Choose this office"/);
    assert.match(done.diagnosis.fix, /Choose this office/);
    assert.ok(done.diagnosis.times_seen >= 1);
    assert.match(think.heard[0].messages[1].content, /its button is not Select Location/, 'told what the robot said');
    assert.equal(reports[0].body.stage, 'watch.check');
    assert.equal(reports[0].body.diagnosis.outcome, 'site_changed');
    assert.ok(reports[0].body.robot.log.length > 0);
    assert.equal(state.bookings.length, 0, 'nothing booked');
    assert.equal(state.holds.size, 0, 'nothing held');
    assert.deepEqual(think.heard[0].tools.find((t) => t.function.name === 'finish').function.parameters.properties.outcome.enum,
      ['read', 'site_changed', 'human_check', 'site_down', 'no_times', 'failed']);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
