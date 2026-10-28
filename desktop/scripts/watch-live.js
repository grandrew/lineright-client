#!/usr/bin/env node
'use strict';
/**
 * Watching lines and the AI check, tried for real on this machine: a private
 * regbot site with the California lines, the DMV stand-in after its office
 * button was renamed (the stand-in's drift 'offices'), two apps' readers — the
 * real reader.js, robots and AI check, with no window — and the model's
 * stand-in, or DeepSeek.
 *
 *   node scripts/watch-live.js                    the model's stand-in (test/helpers/brain.js diagnoseBrain)
 *   node scripts/watch-live.js --model=deepseek   DeepSeek, through the private site (needs DEEPSEEK_API_KEY)
 *   node scripts/watch-live.js --drift=           the stand-in unchanged: the watch reads, and nothing goes wrong
 *   node scripts/watch-live.js --keep             keep the private site's folder
 *
 * App A, which has no AI, is handed a watch read of a line nobody bids on; its
 * scout fails at the renamed button, and the site opens trouble on the line.
 * App B, with the AI on, is handed the check read; its scout fails too, the
 * answer carries the grant, and B's AI goes through the stand-in on it and
 * reports. Then it prints what the site kept — the issue, its diagnosis, the
 * AI session and who paid for it — and what the apps are shown on the line.
 * The model's key goes to the private site only, and is never printed.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RobotRunner } = require('../src/robots');
const { SyncClient } = require('../src/sync');
const { Reader } = require('../src/reader');
const { runDiagnosis } = require('../src/agent/diagnose');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ROOT = path.join(__dirname, '..');
const DMQ = path.join(ROOT, '..', 'dmq');
const SERVER_DIR = path.resolve(process.env.LINERIGHT_SERVER_DIR || path.join(ROOT, '..', '..', 'lineright-server'));
const say = (...parts) => console.log(`[watch] ${parts.join(' ')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(300);
  }
  throw new Error(`${url} did not come up`);
}

function python() {
  const venv = path.join(SERVER_DIR, 'regbot', '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

/** A private site with the public catalogue, read by the apps, and two devices. */
async function privateSite(env0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-watch-site-'));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, REGBOT_ENV_FILE: '/dev/null',
    REGBOT_DB: path.join(dir, 'regbot.db'), PORT: String(port), REGBOT_BASE_URL: `http://127.0.0.1:${port}`,
    REGBOT_CROWD: '0', REGBOT_PAYMENTS: 'simulated', REGBOT_PRACTICE: '1', ...env0 };
  const py = (code) => childProcess.execFileSync(python(), ['-c', code], { cwd: path.join(SERVER_DIR, 'regbot'), env, encoding: 'utf8' })
    .trim().split('\n').pop();
  const made = JSON.parse(py(`
import json, random, client_api, db, models, seed, settings
conn = db.connect(); db.init_db(conn)
seed.seed_public(conn, random.Random(7))
settings.set_many(conn, {"discovery_by": "apps", "watch_offices": "1", "read_rest_seconds": "1"})
out = {}
for nick in ("watcher", "checker"):
    uid = models.create_user(conn, nick, nick + "@example.invalid", None, balance=35)
    cid, token = client_api.pair(conn, uid, nick + "-box", "linux", "live")
    out[nick] = token
print(json.dumps(out))
`));
  const log = fs.openSync(path.join(dir, 'site.log'), 'a');
  const site = childProcess.spawn(python(), ['app.py'], { cwd: path.join(SERVER_DIR, 'regbot'), env, stdio: ['ignore', log, log] });
  await waitFor(`http://127.0.0.1:${port}/`);
  const stop = () => new Promise((resolve) => {
    site.once('exit', resolve);
    site.kill('SIGTERM');
    setTimeout(resolve, 3000);
  }).then(() => { if (!args.keep) fs.rmSync(dir, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${port}`, tokens: made, dir, py, stop };
}

/** One app's reader, with no window: the real reader.js, robots and AI check. */
function app(name, site, token, { ai }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `regbot-watch-${name}-`));
  const client = new SyncClient({ serverUrl: site.url, token, app: { name, version: 'live', platform: process.platform } });
  const runner = new RobotRunner({ paths: { dmq: DMQ, browsers: process.env.PLAYWRIGHT_BROWSERS_PATH || null, host: path.join(ROOT, 'host'),
    packaged: false }, node: process.execPath, stateDir: path.join(dir, 'robots'), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const reader = new Reader({ runner, getClient: () => client, getStore: () => ({ get: (_k, d) => d }),
    log: (m) => say(`${name}:`, m), aiAllowed: () => ai,
    diagnose: ({ grant, result, robotLog }) => runDiagnosis({ runner, client, grant, result, robotLog,
      log: (line) => say(`${name} AI:`, line) }) });
  const sync = async () => {
    const doc = await client.sync({ reader: reader.capabilities() });
    reader.offer(doc.reads || []);
    return doc;
  };
  return { name, client, reader, sync, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function until(what, test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await test();
    if (got) return got;
    await sleep(1000);
  }
  throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
}

async function main() {
  const drift = args.drift === undefined ? 'offices' : String(args.drift === true ? '' : args.drift);
  const { createState, createServer } = await import(pathToFileURL(path.join(SERVER_DIR, 'testsite', 'server.js')).href);
  const state = createState({ gate: 'off', officeCount: 0, drift, cancelIntervalMs: 1e9, busyDays: 2 });
  const dmv = createServer(state);
  await new Promise((resolve) => dmv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${dmv.address().port}`;
  say(`the DMV stand-in at ${base}, changed: ${drift || 'nothing'}`);
  let model = null;
  let site = null;
  const apps = [];
  try {
    let modelEnv;
    if (args.model === 'deepseek') {
      if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set');
      modelEnv = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
      say('the model: DeepSeek, through the private site');
    } else {
      const { diagnoseBrain, serveBrain } = require('../test/helpers/brain');
      model = await serveBrain(diagnoseBrain());
      modelEnv = { DEEPSEEK_API_KEY: 'standin', DEEPSEEK_BASE_URL: model.url };
      say(`the model's stand-in at ${model.url}`);
    }
    site = await privateSite({ ...modelEnv, DMV_BASE_URL: base });
    say(`a private regbot site at ${site.url} (data in ${site.dir})`);
    const a = app('A', site, site.tokens.watcher, { ai: false });
    const b = app('B', site, site.tokens.checker, { ai: true });
    apps.push(a, b);
    const started = Date.now();

    // A has nothing to read for anybody: a watch read, which fails at the renamed button.
    await a.sync();
    await until('A\'s watch read', async () => (a.reader.last ? a.reader.last : (await a.sync(), null)), 180000);
    say(`A's read: ${a.reader.last.status} on ${a.reader.last.queue_name}`);
    const issue = JSON.parse(site.py('import json, db\nconn = db.connect()\nr = db.one(conn, "SELECT * FROM line_issues ORDER BY id DESC LIMIT 1")\nprint(json.dumps(dict(r) if r else None))'));
    say(issue ? `the site opened trouble #${issue.id} (${issue.kind}): ${issue.message}; check ${issue.check_state}` : 'no trouble on the line');
    if (!issue) {
      say(drift ? 'FAIL: the changed site went unnoticed' : 'PASS: the watch read the line, and nothing is wrong');
      process.exitCode = drift ? 1 : 0;
      return;
    }

    // B can run the AI: the check read, its scout fails too, and the grant.
    await until('B\'s AI check', async () => (b.reader.lastCheck ? b.reader.lastCheck : (await b.sync(), null)), 420000);
    say(`B's AI check: ${b.reader.lastCheck.outcome}`);
    const kept = JSON.parse(site.py(`
import json, db, linewatch
conn = db.connect()
i = dict(db.one(conn, "SELECT * FROM line_issues WHERE id=?", (${Number(issue.id)},)))
s = dict(db.one(conn, "SELECT id, paid_by, purpose, client_id, calls, charged, tokens_in, tokens_out, outcome FROM agent_sessions WHERE id=?", (i["session_id"],))) if i["session_id"] else None
q = linewatch.models.get_queue(conn, i["queue_id"])
ledger = db.one(conn, "SELECT COUNT(*) AS n FROM ledger WHERE kind='agent'")["n"]
print(json.dumps({"issue": i, "session": s, "shown": linewatch.summary(conn, q), "agent_ledger": ledger}, default=str))
`));
    const d = kept.issue.diagnosis ? JSON.parse(kept.issue.diagnosis) : null;
    say(`the issue: check ${kept.issue.check_state}, ${kept.issue.reads} failed read(s) by ${JSON.parse(kept.issue.devices).length} app(s)`);
    if (kept.session) say(`the AI session #${kept.session.id}: paid by ${kept.session.paid_by}, ${kept.session.calls} call(s), ${kept.session.charged} credit(s) charged, ${kept.session.tokens_in} tokens in, ${kept.session.outcome}`);
    if (d) say(`the diagnosis: ${d.outcome} — ${d.summary}\n  cause: ${d.cause}\n  fix: ${d.fix}`);
    say(`what the apps are shown: ${kept.shown.label}; ${kept.shown.issue ? kept.shown.issue.found_text || 'not checked yet' : ''}`);
    say(`the stand-in holds ${state.bookings.length} booking(s) and ${state.holds.size} hold(s)`);
    const ok = kept.session && kept.session.paid_by === 'site' && kept.session.charged === 0 && kept.agent_ledger === 0
      && d && kept.issue.check_state === 'done' && state.bookings.length === 0 && state.holds.size === 0
      && (args.model === 'deepseek' || d.outcome === 'site_changed');
    say(`took ${Math.round((Date.now() - started) / 1000)} s`);
    say(ok ? 'PASS: watched, noticed, checked again, and diagnosed on the site\'s money, holding nothing' : 'FAIL: see above');
    process.exitCode = ok ? 0 : 1;
  } finally {
    for (const x of apps) { x.reader.stop(); x.done(); }
    dmv.close();
    if (model) await model.close();
    if (site) await site.stop();
  }
}

main().catch((err) => {
  console.error(`[watch] ${err.message}`);
  process.exitCode = 2;
});
