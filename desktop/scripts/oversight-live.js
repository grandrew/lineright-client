#!/usr/bin/env node
'use strict';
/**
 * AI booking oversight, tried for real on this machine: the real booking robot
 * on the DMV stand-in after the stand-in has "changed" under it, the app's real
 * overseer, a real regbot site's gateway — and the real model (DeepSeek), or
 * the model's stand-in for the plumbing alone.
 *
 *   node scripts/oversight-live.js                         a private site, DeepSeek (needs DEEPSEEK_API_KEY)
 *   node scripts/oversight-live.js --model=standin         a private site, the rules in test/helpers/brain.js
 *   node scripts/oversight-live.js --drift=offices,labels  how the stand-in has changed (pages.js DRIFTED)
 *   node scripts/oversight-live.js --case=task             no robot: the AI alone checks a calendar it is told about in words
 *   node scripts/oversight-live.js --server=URL --token-file=F   a site of your own, as a paired device
 *   node scripts/oversight-live.js --app=dist-X/linux-unpacked   the robots a packaged build carries, on its own binary
 *
 * A private site is the lineright server from LINERIGHT_SERVER_DIR (default
 * ../../lineright-server), on a free port with a database of its own in a
 * temporary folder: an account is made there with a simulated purchase of 500
 * credits, and a device token for it. The model's key goes to that site only,
 * from this process's environment, and is never printed.
 *
 * It ends by printing what came of it: the robot's answer, the overseer's
 * report, and — on a private site — the session as the site kept it, with its
 * calls and what they cost. The private site's folder goes after, unless --keep.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RobotRunner } = require('../src/robots');
const { Overseer } = require('../src/overseer');
const { SyncClient } = require('../src/sync');
const { runSiteTask } = require('../src/agent/sitetask');
const { Scrubber } = require('../src/scrub');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ROOT = path.join(__dirname, '..');
const DMQ = path.join(ROOT, '..', 'dmq');
const SERVER_DIR = path.resolve(process.env.LINERIGHT_SERVER_DIR || path.join(ROOT, '..', '..', 'lineright-server'));
const PROFILE = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.invalid', phone: '5555550123' };
const say = (...parts) => console.log(`[oversight] ${parts.join(' ')}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function waitFor(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

function python() {
  const venv = path.join(SERVER_DIR, 'regbot', '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

/** A private regbot site with an account that has bought credits, and its device token. */
async function privateSite(modelEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-oversight-site-'));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, REGBOT_ENV_FILE: '/dev/null',
    REGBOT_DB: path.join(dir, 'regbot.db'), PORT: String(port), REGBOT_BASE_URL: `http://127.0.0.1:${port}`,
    REGBOT_CROWD: '0', REGBOT_PAYMENTS: 'simulated', REGBOT_PRACTICE: '1', ...modelEnv };
  const made = childProcess.execFileSync(python(), ['-c', `
import json, client_api, db, models
conn = db.connect(); db.init_db(conn)
uid = models.create_user(conn, 'oversight', 'oversight@example.invalid', None, balance=0)
with db.write_tx(conn):
    conn.execute("INSERT INTO payments (user_id, provider, pack, coins, amount_minor, status, settled_at)"
                 " VALUES (?,?,?,?,?,?,?)", (uid, 'simulated', 'starter', 500, 200, 'paid', db.now_ts()))
    models.move_coins(conn, uid, 500, 'topup', 'Starter pack (oversight check)')
cid, token = client_api.pair(conn, uid, 'oversight-check', 'linux', 'live')
print(json.dumps({'token': token, 'user': uid}))
`], { cwd: path.join(SERVER_DIR, 'regbot'), env, encoding: 'utf8' });
  const { token } = JSON.parse(made.trim().split('\n').pop());
  const log = fs.openSync(path.join(dir, 'site.log'), 'a');
  const site = childProcess.spawn(python(), ['app.py'], { cwd: path.join(SERVER_DIR, 'regbot'), env, stdio: ['ignore', log, log] });
  await waitFor(`http://127.0.0.1:${port}/`);
  const session = (id) => JSON.parse(childProcess.execFileSync(python(), ['-c', `
import json, agent, db
conn = db.connect()
s = agent.one(conn, ${Number(id)})
if s:
    s.pop('email', None)
    s['calls_list'] = [dict(c) for c in s['calls_list']]
print(json.dumps(s, default=str))
`], { cwd: path.join(SERVER_DIR, 'regbot'), env, encoding: 'utf8' }).trim().split('\n').pop());
  const stop = () => new Promise((resolve) => {
    site.once('exit', resolve);
    site.kill('SIGTERM');
    setTimeout(resolve, 3000);
  }).then(() => { if (!args.keep) fs.rmSync(dir, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${port}`, token, dir, session, stop };
}

async function standIn(drift) {
  const { createState, createServer, slotsFor } = await import(pathToFileURL(path.join(SERVER_DIR, 'testsite', 'server.js')).href);
  const state = createState({ gate: 'off', officeCount: 0, drift, cancelIntervalMs: 1e9 });
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const office = state.offices.find((o) => o.name === (args.office || 'Poway'));
  const [day] = slotsFor(state, office.code, 'VR');
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(day.times[0]);
  const time = `${String((Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0)).padStart(2, '0')}:${m[2]}`;
  return { state, server, base: `http://127.0.0.1:${server.address().port}`, office, date: day.date, label: day.times[0], time };
}

async function main() {
  const brainHelpers = args.model === 'standin' ? require('../test/helpers/brain') : null;
  const drift = args.drift === undefined ? 'labels,confirmation' : String(args.drift === true ? '' : args.drift);
  const dmv = await standIn(drift);
  say(`the DMV stand-in at ${dmv.base}, changed: ${drift || 'nothing'}; the slot: ${dmv.office.name} ${dmv.date} ${dmv.label}`);
  let model = null;
  let site = null;
  let robotsDir = null;
  let client;
  try {
    if (args.server) {
      const token = fs.readFileSync(String(args['token-file'] || ''), 'utf8').trim();
      client = new SyncClient({ serverUrl: String(args.server), token, app: { name: 'oversight-check', version: 'live', platform: process.platform } });
    } else {
      let modelEnv;
      if (brainHelpers) {
        const brain = args.case === 'task' ? brainHelpers.checkBrain({ where: dmv.office.name })
          : brainHelpers.bookingBrain({ date: dmv.date, label: dmv.label, time: dmv.time });
        model = await brainHelpers.serveBrain(brain);
        modelEnv = { DEEPSEEK_API_KEY: 'standin', DEEPSEEK_BASE_URL: model.url };
        say(`the model's stand-in at ${model.url}`);
      } else {
        if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set: set it, or use --model=standin');
        modelEnv = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
          ...(process.env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {}) };
        say('the model: DeepSeek, through the private site');
      }
      site = await privateSite(modelEnv);
      say(`a private regbot site at ${site.url} (data in ${site.dir})`);
      client = new SyncClient({ serverUrl: site.url, token: site.token, app: { name: 'oversight-check', version: 'live', platform: process.platform } });
    }
    const terms = await client.agentStatus();
    say(`the site says: ${terms.available ? `available, about ${terms.step_credits} credits a step, ${terms.can_spend} to spend` : terms.message}`);
    if (!terms.available) throw new Error(terms.message);
    robotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-oversight-'));
    // A packaged build: its own robots and browser, run on its own binary as Node, as the installed app runs them.
    const built = args.app ? path.resolve(String(args.app)) : null;
    const binary = built ? ['regbot', 'regbot.exe', 'LineRight Regbot'].map((n) => path.join(built, n)).find((f) => fs.existsSync(f)) : null;
    if (built && !binary) throw new Error(`no app binary in ${built}`);
    const paths = built
      ? { dmq: path.join(built, 'resources', 'stack', 'dmq'), host: path.join(built, 'resources', 'stack', 'host'),
        browsers: path.join(built, 'resources', 'browsers'), packaged: true }
      : { dmq: DMQ, browsers: process.env.PLAYWRIGHT_BROWSERS_PATH || null, host: path.join(ROOT, 'host'), packaged: false };
    if (built) say(`the robots of the packaged build in ${built}`);
    const runner = new RobotRunner({ paths,
      node: binary || process.execPath, stateDir: path.join(robotsDir, 'robots'),
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, log: (m) => say('robots:', m) });
    const started = Date.now();
    let sessionId = null;
    if (args.case === 'task') {
      const scrubber = new Scrubber();
      scrubber.setProfile(PROFILE);
      const run = await runSiteTask({
        runner, client, kind: 'check', want: 'the first day with open times', budgetMs: 180000,
        site: { name: `DMV office calendar (${dmv.office.name})`,
          description: 'A month calendar of the office. Days with appointments are buttons named "<day> Open Times"; '
            + '"Next month" pages forward. Report the first day that has open times.',
          start_url: `${dmv.base}/portal/appointments/select-date?branch=${encodeURIComponent(dmv.office.code)}&service=VR` },
        scrub: (s) => scrubber.plain(s), log: (line) => say('ai:', line),
      });
      sessionId = run.session;
      say(`the task: ${run.outcome ? `${run.outcome.outcome} — ${run.outcome.summary} ${JSON.stringify(run.outcome.findings || [])}` : `stopped: ${run.stopped}`}`);
      say(`truth: the first open day is ${dmv.date}`);
    } else {
      const opened = [];
      const overseer = new Overseer({
        getClient: () => ({ ...client, agentOpen: async (b) => { const s = await client.agentOpen(b); opened.push(s); return s; },
          agentChat: (...a) => client.agentChat(...a), agentReport: (...a) => client.agentReport(...a) }),
        getStore: () => ({ get: (_k, d) => d }), getProfile: () => PROFILE, getStatus: () => terms,
        log: (m) => say(m), appVersion: 'live',
      });
      const h = { job_id: null, queue_name: 'Vehicle registration', site_name: 'California DMV (stand-in)', connector: 'dmv.ca.gov.qmatic',
        slot: { office_name: dmv.office.name, date: dmv.date, time: dmv.time },
        robot: { requires: Object.keys(PROFILE), guide: String(args.guide === undefined ? GUIDE : '') } };
      const timeoutMs = Number(args.timeout || 240) * 1000;
      const result = await runner.run('book', {
        protocol: 'RQP/1', kind: 'booking.request', job_id: 1,
        target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' },
        slot: { window: [dmv.date, dmv.date], allocated: { office_name: dmv.office.name, date: dmv.date, time: dmv.time } },
        personal_data: { office_mode: 'specific', office: dmv.office.name, ...PROFILE },
        idempotency_key: `live-${Date.now()}`,
      }, { dmvBase: dmv.base, allowBooking: true, timeoutMs, watch: overseer.watch(h, { deadline: Date.now() + timeoutMs }) });
      sessionId = opened[0] ? opened[0].session_id : null;
      say(`the robot answered: ${result.status}${result.confirmation ? ` ${result.confirmation}` : ''}${result.overseen ? ' (overseen)' : ''} — ${result.message}`);
      const made = dmv.state.bookings;
      say(`the stand-in holds ${made.length} booking${made.length === 1 ? '' : 's'}: ${made.map((b) => `${b.ref} ${b.date} ${b.time} for ${b.applicant.first} ${b.applicant.last}`).join('; ') || 'none'}`);
      const ok = result.status === 'confirmed' && made.length === 1 && made[0].ref === result.confirmation
        && made[0].date === dmv.date && made[0].time === dmv.label;
      say(ok ? 'PASS: booked the allocated slot once, with the profile\'s details' : 'FAIL: see above');
      process.exitCode = ok ? 0 : 1;
    }
    say(`took ${Math.round((Date.now() - started) / 1000)} s`);
    if (site && sessionId) {
      const s = site.session(sessionId);
      say(`the site kept session #${s.id}: ${s.outcome}, ${s.calls} calls, ${s.tokens_in} tokens in (${s.tokens_cached} cached), ${s.tokens_out} out, ${s.charged} credits charged, ${s.pii_caught} personal details caught`);
      for (const step of (s.report && s.report.steps) || []) say(`  ${step.tool} ${JSON.stringify(step.args || {})} → ${step.result || ''}`);
      if (s.report && s.report.summary) say(`  summary: ${s.report.summary}`);
    }
  } finally {
    dmv.server.close();
    if (model) await model.close();
    if (site) await site.stop();
    if (robotsDir && !args.keep) fs.rmSync(robotsDir, { recursive: true, force: true });
  }
}

/** What the site would send as its guide to the DMV's pages (the server's connectors/ca_dmv.py agent_guide). */
const GUIDE = [
  '1. The appointment page for the service opens on the office search.',
  '2. Office search: type the office\'s city into the search box and search; press the button on the office\'s card.',
  '3. The calendar: days with times are buttons whose name ends in "Open Times"; "Next month" pages forward.',
  '4. The times for that day: press the time, then the button that holds it.',
  '5. Your details: first name, last name, email, phone; then on to a review, where one button books it.',
  '6. Confirmation: the appointment confirmed, and its number.',
].join('\n');

main().catch((err) => {
  console.error(`[oversight] ${err.message}`);
  process.exitCode = 2;
});
