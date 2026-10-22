'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Scrubber } = require('../src/scrub');
const { TraceStore } = require('../src/traces');
const { TraceTaps, humanCheck, level } = require('../src/tracetaps');
const { Logbook } = require('../src/logbook');

const DMV = 'https://dmv.example';

function world({ booking = [DMV] } = {}) {
  let now = 1_800_000_000_000;
  const scrubber = new Scrubber({ home: '', user: '' });
  scrubber.setProfile({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', dob: '12/10/1985' });
  const traces = new TraceStore({ dir: null, scrubber, now: () => now });
  const taps = new TraceTaps({
    add: (kind, fields, opts) => traces.add(kind, fields, opts),
    learn: (label, value) => scrubber.learn(label, value),
    isBooking: (url) => booking.some((o) => String(url).startsWith(o)),
    now: () => now,
  });
  const events = () => traces.batch({ after: 0, maxEvents: 10000, maxBytes: 1e8 }).events;
  const strip = (e) => { const { s, t, ...rest } = e; return rest; };
  return { taps, traces, scrubber, events, strip, tick: (ms) => { now += ms; } };
}

test('a turn\'s booking page, as the trace has it: where it went, each request timed, what was done', () => {
  const w = world();
  const page = (record) => w.taps.logbookEvent('pages', { tab: 4, kind: 'handoff', job: 77, ...record });
  page({ type: 'opened', url: `${DMV}/portal/appointments/`, network: true });
  page({ type: 'navigating', url: `${DMV}/portal/appointments/select-date?firstName=Ada` });
  page({ type: 'request', id: 'r1', method: 'GET', url: `${DMV}/portal/appointments/select-date?firstName=Ada`, rtype: 'Document' });
  page({ type: 'response', id: 'r1', status: 200, url: `${DMV}/portal/appointments/select-date`, rtype: 'Document', mime: 'text/html', ms: 120 });
  page({ type: 'done', id: 'r1', ms: 180, bytes: 51200 });
  page({ type: 'request', id: 'r2', method: 'GET', url: 'https://www.google.com/recaptcha/api2/bframe?k=x', rtype: 'Document' });
  page({ type: 'request', id: 'r3', method: 'GET', url: `${DMV}/img/a.png`, rtype: 'Image' });
  page({ type: 'response', id: 'r3', status: 404, url: `${DMV}/img/a.png`, rtype: 'Image', ms: 30 });
  page({ type: 'failed', id: 'r4', url: `${DMV}/img/b.png`, rtype: 'Image', error: 'net::ERR_ABORTED', canceled: true });
  page({ type: 'request', id: 'r5', method: 'POST', url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rtype: 'XHR' });
  page({ type: 'failed', id: 'r5', url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rtype: 'XHR', error: 'net::ERR_TIMED_OUT', ms: 30000 });
  page({ type: 'navigated', url: `${DMV}/portal/appointments/select-date`, status: 200 });
  w.tick(1500);
  page({ type: 'loaded', url: `${DMV}/portal/appointments/select-date`, title: 'Pick a date, Ada' });
  page({ type: 'resources', n: 40, bytes: 1048576, failed: 1, slowest_ms: 900, slowest_url: `${DMV}/app.js`, types: { Script: 12 }, hosts: { 'dmv.example': 40 } });
  page({ type: 'action', action: 'change', target: { tag: 'input', id: 'firstName', label: 'First name' }, length: 3 });
  page({ type: 'action', action: 'change', target: { tag: 'input', id: 'zipcode' }, value: '95050' });
  page({ type: 'action', action: 'click', target: { tag: 'button', text: '9:40 AM' } });
  page({ type: 'action', action: 'change', target: { tag: 'select', id: 'office' }, chosen: 'Santa Clara' });
  page({ type: 'console', level: 'info', text: 'hello' });
  page({ type: 'console', level: 'error', text: 'Uncaught TypeError for ada@example.com', source: `${DMV}/app.js`, line: 3 });
  page({ type: 'snapshot', url: `${DMV}/x`, file: 'pages/x.html' });
  page({ type: 'autofill', asked: false, filled: 4, skipped: 1, fields: [{ key: 'first_name', how: 'autocomplete' }] });
  page({ type: 'confirmation', ref: 'TS-55555', url: `${DMV}/portal/appointments/confirmation/TS-55555` });
  page({ type: 'closed' });
  const got = w.events().map(w.strip);
  const b = { tab: 4, job: 77 };
  assert.deepEqual(got, [
    { k: 'tab.open', ...b, kind: 'handoff', url: `${DMV}/portal/appointments/`, network: true },
    { k: 'page.go', ...b, url: `${DMV}/portal/appointments/select-date?firstName=[redacted]` },
    { k: 'net', ...b, m: 'GET', url: `${DMV}/portal/appointments/select-date?firstName=[redacted]`, rt: 'document', st: 200, ms: 180, head_ms: 120, kb: 50, mime: 'text/html' },
    { k: 'human.check', ...b, provider: 'recaptcha', stage: 'challenge', url: 'https://www.google.com/recaptcha/api2/bframe?k=x' },
    { k: 'net', ...b, url: `${DMV}/img/a.png`, rt: 'image', st: 404, head_ms: 30 },
    { k: 'net', ...b, m: 'POST', url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rt: 'xhr', ms: 30000, err: 'net::ERR_TIMED_OUT' },
    { k: 'page.at', ...b, url: `${DMV}/portal/appointments/select-date`, st: 200 },
    { k: 'page.load', ...b, url: `${DMV}/portal/appointments/select-date`, title: 'Pick a date, [first_name]', ms: 1500 },
    { k: 'page.res', ...b, n: 40, kb: 1024, failed: 1, slow_ms: 900, slow_url: `${DMV}/app.js`, types: { Script: 12 }, hosts: { 'dmv.example': 40 } },
    { k: 'page.act', ...b, act: 'change', el: { tag: 'input', id: 'firstName', label: 'First name' }, v: { len: 3, personal: true } },
    { k: 'page.act', ...b, act: 'change', el: { tag: 'input', id: 'zipcode' }, v: { len: 5, kind: 'digits' } },
    { k: 'page.act', ...b, act: 'click', el: { tag: 'button', text: '9:40 AM' } },
    { k: 'page.act', ...b, act: 'change', el: { tag: 'select', id: 'office' }, chosen: 'Santa Clara' },
    { k: 'page.console', ...b, lvl: 'error', text: 'Uncaught TypeError for [email]', src: `${DMV}/app.js`, line: 3 },
    { k: 'page.note', ...b, type: 'autofill', asked: false, filled: 4, skipped: 1, fields: [{ key: 'first_name', how: 'autocomplete' }] },
    { k: 'page.note', ...b, type: 'confirmation', url: `${DMV}/portal/appointments/confirmation/[confirmation]`, ref: true },
    { k: 'tab.close', ...b, open_ms: 1500, pages: 1 },
  ]);
  assert.ok(!JSON.stringify(got).includes('95050'), 'what was typed is never in it');
});

test('a tab anywhere else says which site and nothing of what was on it or done there', () => {
  const w = world();
  const page = (record) => w.taps.logbookEvent('pages', { tab: 9, kind: 'page', ...record });
  page({ type: 'opened', url: 'https://mail.example/inbox/ada' });
  page({ type: 'navigating', url: 'https://mail.example/inbox/ada?q=dmv' });
  page({ type: 'request', id: 'x', method: 'GET', url: 'https://mail.example/api/messages', rtype: 'XHR' });
  page({ type: 'done', id: 'x', ms: 12, bytes: 10 });
  page({ type: 'action', action: 'click', target: { tag: 'a', text: 'Your appointment' } });
  page({ type: 'console', level: 'error', text: 'boom' });
  page({ type: 'loaded', url: 'https://mail.example/inbox/ada', title: 'Inbox (3) — ada' });
  const got = w.events().map(w.strip);
  assert.deepEqual(got, [
    { k: 'tab.open', tab: 9, kind: 'page', url: 'https://mail.example/' },
    { k: 'page.go', tab: 9, url: 'https://mail.example/' },
    { k: 'page.load', tab: 9, url: 'https://mail.example/', ms: 0 },
  ]);
});

test('a turn\'s tab handed on to the next turn on its line names the new turn from then on', () => {
  const w = world();
  const page = (record) => w.taps.logbookEvent('pages', { tab: 4, kind: 'handoff', ...record });
  page({ type: 'opened', job: 77, url: `${DMV}/portal/appointments/` });
  page({ type: 'over', job: 77, how: 'taken' });
  page({ type: 'reused', from: 77, job: 78 });
  page({ type: 'navigating', job: 78, url: `${DMV}/portal/appointments/select-date` });
  page({ type: 'closing', job: 78, why: 'spare' });
  const got = w.events().map(w.strip);
  assert.deepEqual(got, [
    { k: 'tab.open', tab: 4, job: 77, kind: 'handoff', url: `${DMV}/portal/appointments/` },
    { k: 'page.note', tab: 4, job: 77, type: 'over', how: 'taken' },
    { k: 'page.note', tab: 4, job: 78, type: 'reused', from: 77 },
    { k: 'page.go', tab: 4, job: 78, url: `${DMV}/portal/appointments/select-date` },
    { k: 'page.note', tab: 4, job: 78, type: 'closing', why: 'spare' },
  ]);
});

test('the site\'s exchanges: the routine ones counted elsewhere, the rest said without what was in them', () => {
  const w = world();
  w.taps.logbookEvent('site', { method: 'POST', path: '/api/client/sync', status: 200, ms: 40, body: { app_version: '1' }, reply: { positions: [] } });
  w.taps.logbookEvent('site', { method: 'POST', path: '/api/client/ping', status: 200, ms: 9 });
  w.taps.logbookEvent('site', { method: 'POST', path: '/api/client/traces', status: 200, ms: 90 });
  w.taps.logbookEvent('site', { method: 'POST', path: '/api/client/sync', status: 502, ms: 3000, error: { message: 'Bad gateway at https://site.example/?token=abc' } });
  w.taps.logbookEvent('site', { method: 'POST', path: '/api/client/handoffs/77/claim', status: 200, ms: 70, reply: { ok: true, took_over_from: 'Ada laptop' } });
  w.taps.logbookEvent('site', { method: 'GET', path: '/api/client/sites?q=Ada%20Lovelace', status: 200, ms: 20 });
  w.taps.logbookLine('app', 'booking Santa Clara for Ada Lovelace');
  w.taps.logbookLine('robot', 'not the app\'s');
  assert.deepEqual(w.events().map(w.strip), [
    { k: 'site.call', m: 'POST', path: '/api/client/sync', st: 502, ms: 3000, err: 'Bad gateway at https://site.example/?token=[redacted]' },
    { k: 'site.call', m: 'POST', path: '/api/client/handoffs/77/claim', st: 200, ms: 70, res: { ok: true } },
    { k: 'site.call', m: 'GET', path: '/api/client/sites', st: 200, ms: 20 },
    { k: 'app.log', text: 'booking Santa Clara for [first_name] [last_name]' },
  ]);
});

test('the logbook hands every record and line to its tap, secrets already struck out', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-tap-')), 'logs');
  const seen = [];
  const book = new Logbook({ dir, tap: { event: (name, r) => seen.push([name, r]), line: (name, text) => seen.push([name, text]) } });
  book.event('site', { path: '/x', reply: { token: 'abcdef' } });
  book.line('app', 'hello');
  assert.deepEqual(seen, [['site', { path: '/x', reply: { token: '‹redacted, 6 chars›' } }], ['app', 'hello']]);
  book.tap = { event: () => { throw new Error('a broken tap'); }, line: () => { throw new Error('a broken tap'); } };
  book.event('site', { path: '/y' });
  book.line('app', 'still written');
  assert.match(fs.readFileSync(book.file('app', 'log'), 'utf8'), /still written/);
});

function robotRun(lines) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-run-')), '20261021-191111-945-scout-license-id');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"cut`);
  return dir;
}

const at = (s) => new Date(Date.UTC(2026, 9, 22, 2, 11, s)).toISOString();
const RUN_LINES = [
  { t: at(0), type: 'start' },
  { t: at(1), type: 'page', page: 1, url: 'about:blank' },
  { t: at(1), type: 'request', page: 1, id: 1, method: 'GET', url: `${DMV}/portal/appointments/`, rtype: 'document' },
  { t: at(2), type: 'response', page: 1, id: 1, status: 200, url: `${DMV}/portal/appointments/`, rtype: 'document', mime: 'text/html' },
  { t: at(2), type: 'request', page: 1, id: 2, method: 'GET', url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', rtype: 'script' },
  { t: at(3), type: 'response', page: 1, id: 2, status: 200, url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', rtype: 'script' },
  { t: at(3), type: 'request', page: 1, id: 3, method: 'POST', url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rtype: 'xhr' },
  { t: at(7), type: 'response', page: 1, id: 3, status: 403, url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rtype: 'xhr', mime: 'application/json' },
  { t: at(7), type: 'failed', page: 1, id: 4, url: 'https://analytics.example/collect', rtype: 'ping', error: 'net::ERR_ABORTED' },
  { t: at(8), type: 'navigated', page: 1, url: `${DMV}/portal/appointments/select-location` },
  { t: at(8), type: 'step', tag: 'MONTH_SCANNED', detail: 'Santa Clara NOVEMBER 2026 openDays=19' },
  { t: at(9), type: 'step', tag: 'OFFICE_ERROR', detail: 'Santa Clara: blocked for Ada' },
  { t: at(9), type: 'console', page: 1, level: 'error', text: 'reCAPTCHA failed' },
  { t: at(9), type: 'console', page: 1, level: 'log', text: 'chatty' },
  { t: at(9), type: 'dialog', page: 1, kind: 'alert', message: 'Session expired' },
];

test('a look that went fine is one event, with what it did counted', async () => {
  const w = world();
  const dir = robotRun(RUN_LINES);
  await w.taps.robotRun({ kind: 'scout', dir, ms: 9000, code: 0, context: { read: 812 },
    answer: { status: 'confirmed', offers: [{}, {}], checked: [{ office: 'Santa Clara', found: 2 }] } });
  const got = w.events().map(w.strip);
  assert.deepEqual(got.map((e) => e.k), ['human.check', 'robot.end']);
  assert.deepEqual(got[0], { k: 'human.check', run: '20261021-191111-945', robot: 'scout', read: 812, provider: 'recaptcha', stage: 'script',
    url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js' });
  const end = got[1];
  assert.deepEqual([end.run, end.robot, end.read, end.status, end.offices, end.found, end.req, end.failed, end.pages, end.detail],
    ['20261021-191111-945', 'scout', 812, 'confirmed', 1, 2, 3, 1, 1, undefined]);
  assert.deepEqual(end.st, { '2xx': 2, '4xx': 1 });
  assert.deepEqual(end.steps, { MONTH_SCANNED: 1, OFFICE_ERROR: 1 });
  assert.deepEqual(end.slow, [{ url: `${DMV}/wp-json/dmv/v1/appointment/dates`, ms: 4000 }, { url: `${DMV}/portal/appointments/`, ms: 1000 }]);
  assert.equal(end.console_errors, 1);
});

test('a look that was stopped has its steps, pages, requests and errors besides', async () => {
  const w = world();
  const dir = robotRun(RUN_LINES);
  await w.taps.robotRun({ kind: 'scout', dir, ms: 9000, code: 0, context: { read: 813 },
    answer: { status: 'confirmed', gate: { kind: 'recaptcha_v2_invisible', sitekey: 'k' }, offers: [],
      checked: [{ office: 'Santa Clara', found: 0, error: 'blocked' }], message: 'Blocked at a human check: 1 of 1 office(s) could not be read.' } });
  const got = w.events().map(w.strip);
  assert.deepEqual(got.map((e) => e.k), ['net', 'human.check', 'net', 'net', 'robot.nav', 'robot.step', 'robot.step', 'robot.console',
    'robot.dialog', 'robot.end']);
  assert.deepEqual(got[2], { k: 'net', run: '20261021-191111-945', robot: 'scout', read: 813, m: 'POST',
    url: `${DMV}/wp-json/dmv/v1/appointment/dates`, rt: 'xhr', st: 403, ms: 4000, mime: 'application/json' });
  assert.equal(got[6].detail, 'Santa Clara: blocked for [first_name]');
  const end = got[got.length - 1];
  assert.deepEqual([end.gate, end.blocked, end.detail], ['recaptcha_v2_invisible', 1, true]);
});

test('a booking run is followed all the way, and its confirmation number never goes', async () => {
  const w = world();
  const dir = robotRun([...RUN_LINES, { t: at(10), type: 'step', tag: 'BOOKED_SUCCESS', detail: 'Santa Clara ref=TS-77777' },
    { t: at(10), type: 'navigated', page: 1, url: `${DMV}/portal/appointments/confirmation?number=TS-77777` }]);
  await w.taps.robotRun({ kind: 'book', dir, ms: 11000, code: 0, context: { job: 77 },
    answer: { status: 'confirmed', confirmation: 'TS-77777', message: 'Booked 2026-11-03 at 9:40 — Santa Clara. DMV confirmation number TS-77777.' } });
  const text = JSON.stringify(w.events());
  assert.ok(!text.includes('TS-77777'));
  const end = w.events().map(w.strip).find((e) => e.k === 'robot.end');
  assert.deepEqual([end.job, end.booked, end.msg], [77, true, 'Booked 2026-11-03 at 9:40 — Santa Clara. DMV confirmation number [confirmation].']);
  assert.ok(w.events().some((e) => e.k === 'robot.step' && e.tag === 'BOOKED_SUCCESS' && e.detail === 'Santa Clara ref=[confirmation]'));
});

test('a run with no record of itself still says how it ended', async () => {
  const w = world();
  await w.taps.robotRun({ kind: 'scout', dir: '', ms: 50, code: 1, timedOut: true, answer: { status: 'unavailable', message: 'The robot gave no answer' } });
  assert.deepEqual(w.events().map(w.strip), [{ k: 'robot.end', robot: 'scout', ms: 50, status: 'unavailable', msg: 'The robot gave no answer',
    code: 1, timed_out: true, detail: true, req: 0, st: {}, steps: {}, hosts: {} }]);
});

test('captchas are told by where they come from, and how far they went', () => {
  assert.deepEqual(humanCheck('https://www.google.com/recaptcha/api2/anchor?k=1'), { provider: 'recaptcha', stage: 'anchor' });
  assert.deepEqual(humanCheck('https://www.google.com/recaptcha/api2/bframe?k=1'), { provider: 'recaptcha', stage: 'challenge' });
  assert.deepEqual(humanCheck('https://www.google.com/recaptcha/api2/userverify?k=1'), { provider: 'recaptcha', stage: 'verify' });
  assert.deepEqual(humanCheck('https://www.recaptcha.net/recaptcha/api.js'), { provider: 'recaptcha', stage: 'script' });
  assert.deepEqual(humanCheck('https://hcaptcha.com/getcaptcha/x'), { provider: 'hcaptcha', stage: 'challenge' });
  assert.equal(humanCheck('https://www.google.com/maps/api/js'), null);
  assert.equal(humanCheck('not a url'), null);
  assert.deepEqual([level(3), level('warning'), level('error'), level('info'), level('debug')], [3, 2, 3, 1, 0]);
});
