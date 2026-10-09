'use strict';
/**
 * The DMV robots, run by this app for the regbot site.
 *
 * The site holds the queue; the looking and the booking happen here, on the
 * person's own machine. When the site hands this device a read, the scout
 * (../dmq/bin/rqp-scout.js) looks at the offices it names; when a slot is this
 * person's, the booking handler (../dmq/bin/rqp-handler.js) books it with the
 * details kept in the profile here. Each is one process per run, on the app's
 * own binary as Node (ELECTRON_RUN_AS_NODE) with the Chromium the installer
 * carries: an RQP/1 envelope goes in on stdin and one comes back on stdout —
 * the last JSON line of it, since the handler logs as it goes.
 *
 * Where a robot may go is decided here and not by the site: the real DMV, or a
 * practice one on this machine when the site is on this machine too. A site that
 * names anywhere else gets no robot sent there, whatever it says.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { killTree, robotPlatformEnv, OWNED } = require('./stack');

const SCRIPTS = { scout: 'rqp-scout.js', book: 'rqp-handler.js' };
/** The robots this app carries, as the site knows them (a connector's app_robot). */
const ROBOTS = ['dmq-rqp/1'];
/** The booking systems they work, as the site names them (a site's connector). */
const CONNECTORS = ['dmv.ca.gov.qmatic'];
const REAL_DMV = 'https://www.dmv.ca.gov';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopback(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const trim = (url) => String(url || '').trim().replace(/\/+$/, '');

/** Whether a robot may be sent to `base` for the site at `serverUrl`. */
function targetAllowed(base, serverUrl) {
  if (trim(base) === REAL_DMV) return true;
  return isLoopback(base) && isLoopback(serverUrl);
}

/** Is this the real DMV, where the person has to have said yes first? */
function isRealDmv(base) {
  return trim(base) === REAL_DMV;
}

/**
 * The environment one robot runs in. Nothing the machine happens to have set
 * that would steer a robot — which DMV, which service, whether to submit, a
 * simulate mode, a solving farm — gets through; those come from the envelope
 * and from here.
 */
function robotEnv({ env = process.env, paths, platform = process.platform, stateDir, dmvBase = '',
  solverUrl = '', allowBooking = false, confirmationShot = '' }) {
  // Tests only: an unpackaged app may be told to run the robots in their own
  // simulate mode, which answers without a browser. An installed one never is.
  const simulate = !paths.packaged && env.REGBOT_ROBOT_SIMULATE === '1';
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || OWNED.has(key) || /^(RQP_|DMV_|CAPTCHA_)/.test(key) || key === 'HEADLESS') continue;
    out[key] = value;
  }
  Object.assign(out, {
    ELECTRON_RUN_AS_NODE: '1',
    HEADLESS: 'true',
    RQP_STATE_PATH: path.join(stateDir, 'rqp-bookings.json'),
    RUN_LOG_PATH: path.join(stateDir, 'dmv-robot.log'),
  }, robotPlatformEnv(paths, platform));
  if (paths.browsers) out.PLAYWRIGHT_BROWSERS_PATH = paths.browsers;
  if (dmvBase) out.DMV_BASE_URL = trim(dmvBase);
  // A practice farm only, and only for a practice DMV: the robot checks the same.
  if (solverUrl && isLoopback(solverUrl) && isLoopback(dmvBase)) out.CAPTCHA_SOLVER_URL = solverUrl;
  if (allowBooking) out.RQP_ALLOW_BOOKING = 'true';
  // Where a booking keeps its picture of the confirmation page, for the person.
  if (allowBooking && confirmationShot) out.RQP_CONFIRMATION_SHOT = confirmationShot;
  if (simulate) {
    out.RQP_MODE = 'simulate';
    if (env.REGBOT_ROBOT_OUTCOME) out.RQP_SIMULATE_OUTCOME = env.REGBOT_ROBOT_OUTCOME;
  }
  return out;
}

/** The last line of `text` that is a JSON object — the robot's answer. */
function lastJson(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* a log line that only looks like JSON */ }
  }
  return null;
}

class RobotRunner {
  /**
   * @param {object} opts
   * @param {object} opts.paths     locate()'s answer: dmq, browsers, host
   * @param {string} opts.node      the binary to run a robot on (process.execPath)
   * @param {string} opts.stateDir  where the booking replay store and the robot's log live
   */
  constructor({ paths, node = process.execPath, stateDir, env = process.env, platform = process.platform,
    spawn = childProcess.spawn, log = () => {}, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
    onRun = () => {} }) {
    Object.assign(this, { paths, node, stateDir, env, platform, spawn, log, setTimeout: st, clearTimeout: ct, onRun });
    this.running = new Set();
  }

  /** Whether this build has the robots at all (an unbundled checkout may not). */
  available() {
    return Boolean(this.paths && this.paths.dmq && fs.existsSync(path.join(this.paths.dmq, 'bin', SCRIPTS.scout)));
  }

  /**
   * Run one robot on one envelope. Always resolves, with the robot's envelope or
   * one saying why there is none — a robot that could not run is an answer too.
   */
  run(kind, envelope, { dmvBase = '', solverUrl = '', allowBooking = false, timeoutMs = 600000,
    confirmationShot = '' } = {}) {
    const script = path.join(this.paths.dmq, 'bin', SCRIPTS[kind]);
    fs.mkdirSync(this.stateDir, { recursive: true });
    const env = robotEnv({ env: this.env, paths: this.paths, platform: this.platform, stateDir: this.stateDir,
      dmvBase, solverUrl, allowBooking: kind === 'book' && allowBooking, confirmationShot });
    const failed = (message) => ({ protocol: 'RQP/1', kind: kind === 'scout' ? 'discovery.result' : 'booking.result',
      status: 'unavailable', message, offers: [], checked: [] });
    const started = Date.now();
    const answered = (answer) => {
      // What each run took and came to, for this app's own telemetry (telemetry.js).
      try { this.onRun({ kind, ms: Date.now() - started, status: String((answer && answer.status) || '') }); } catch { /* never the problem */ }
      return answer;
    };
    return new Promise((settle) => {
      const resolve = (answer) => settle(answered(answer));
      let child;
      try {
        child = this.spawn(this.node, [script], {
          cwd: this.paths.dmq, env, stdio: ['pipe', 'pipe', 'pipe'],
          // Its own process group, so stopping it reaches the browser it started.
          detached: this.platform !== 'win32', windowsHide: true,
        });
      } catch (err) {
        resolve(failed(`The robot could not be started: ${err.message}`));
        return;
      }
      this.running.add(child);
      let out = '';
      let err = '';
      let timedOut = false;
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      child.stdin.on('error', () => {});
      const timer = this.setTimeout(() => {
        timedOut = true;
        this.log(`${kind} robot ran past ${Math.round(timeoutMs / 1000)}s; stopping it`);
        killTree(child, { platform: this.platform, force: true });
      }, timeoutMs);
      const done = (answer) => {
        this.clearTimeout(timer);
        this.running.delete(child);
        resolve(answer);
      };
      child.on('error', (e) => done(failed(`The robot could not be started: ${e.message}`)));
      child.on('exit', (code) => {
        if (timedOut) return done(failed(`The robot did not finish within ${Math.round(timeoutMs / 1000)}s.`));
        const answer = lastJson(out);
        if (answer) return done(answer);
        const why = err.trim().split(/\r?\n/).slice(-1)[0] || `it exited with ${code}`;
        return done(failed(`The robot gave no answer: ${why}`));
      });
      child.stdin.end(JSON.stringify(envelope));
    });
  }

  /**
   * What the booking robot recorded on this computer for one booking (its
   * replay store, dmq's BookingStore): `{ confirmation, booked_date }` for one it
   * made, `{ unconfirmed: true, … }` for one it sent without an answer, or null.
   * A robot left running by an app that crashed records there too.
   */
  recorded(key) {
    try {
      const all = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'rqp-bookings.json'), 'utf8'));
      return (key && all[key]) || null;
    } catch {
      return null;
    }
  }

  /** Stop every robot this app started. On quit, and on a full reset. */
  stopAll() {
    for (const child of this.running) killTree(child, { platform: this.platform, force: true });
    this.running.clear();
  }
}

module.exports = { RobotRunner, robotEnv, targetAllowed, isRealDmv, isLoopback, lastJson, ROBOTS, CONNECTORS, REAL_DMV, SCRIPTS };
