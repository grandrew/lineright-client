'use strict';
/**
 * The regbot server this app runs on the person's own machine: practice mode.
 *
 * Practice is the whole of regbot here, not a window onto somebody else's: the
 * website its screens read, the queue processor that hands slots out, the
 * California DMV robots the processor sends, and a DMV stand-in for them to
 * practise on. The robots come with the app (scripts/bundle.js); the server
 * and the stand-in are lineright-server, which is not open source and never
 * ships in the app, so practice needs a checkout of it (locate()). They are
 * separate programs, started here, watched here, and stopped with the app:
 *
 *   standin   the DMV stand-in (the server's testsite/)  Node, through this app's own binary
 *   web       the website and its JSON API (app.py)      the server's Python
 *   worker    the queue processor (worker.py)            the server's Python; runs the robots as Node
 *   admin     the control room (admin.py)                the server's Python; started when first opened
 *
 * Each announces its port on one line when it is ready (host/), holds a
 * lifeline to this process on its stdin, and writes everything else to a log
 * under the app's user data. One that falls over is started again after a
 * pause that grows while it keeps falling over, and the screen is told.
 * Nothing listens beyond 127.0.0.1. Quitting closes every lifeline and then
 * takes down each process with everything it started — a robot mid-run and
 * its browser included.
 *
 * Plain Node, no Electron: everything the app knows (where the bundle is, which
 * binary is Node, where data goes) is handed in, so the supervision is tested
 * with a fake spawn.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const READY = 'REGBOT-READY ';
const ORDER = ['standin', 'web', 'worker', 'admin'];
const OS_NAMES = { linux: 'linux', darwin: 'mac', win32: 'win' };
const LOG_LIMIT = 5 * 1024 * 1024;
// A DMV the robots cannot reach. Where the stand-in should be and is not, this
// is what they are pointed at instead — never, by default, the real one.
const NOWHERE = 'http://127.0.0.1:9';

// Everything the app decides for its own server, and nothing the machine's
// environment gets to decide instead: a developer's shell pointed at their own
// stand-in must not quietly point the app's robots there too.
const OWNED = new Set([
  'DMV_BASE_URL', 'CAPTCHA_SOLVER_URL', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PORT',
  'REGBOT_DB', 'REGBOT_SECRET', 'REGBOT_ENV_FILE', 'REGBOT_BASE_URL', 'REGBOT_PUBLIC_URL',
  'REGBOT_TESTSITE_URL', 'REGBOT_ADMIN_TOKEN', 'REGBOT_CADMV_DIR', 'REGBOT_CADMV_NODE',
  'RQP_STATE_PATH', 'RUN_LOG_PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'RQP_ALLOW_BOOKING',
  'REGBOT_DISCOVERY_BY', 'REGBOT_PRACTICE',
]);

/**
 * `--require` for NODE_OPTIONS, which splits on spaces and, inside quotes,
 * treats a backslash as an escape: so the path is quoted, and a Windows one
 * (`C:\Users\Jo Smith\…`) is written with forward slashes, which Node takes.
 */
function nodeRequire(file) {
  return `--require="${String(file).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}


/**
 * Where the robots, their browser and the server are.
 *
 * The robots (dmq/), how the app starts them (host/) and the robots' browser
 * come with the app. Installed: under its resources, where electron-builder put
 * them. A checkout: the sibling ../dmq and this app's host/, and the browser
 * scripts/bundle.js fetched into vendor/ when there is one (otherwise
 * Playwright's usual cache).
 *
 * The server practice mode runs is lineright-server, which is not part of this
 * app: a checkout of it named by LINERIGHT_SERVER_DIR, or `lineright-server`
 * beside this repository. Its Python is REGBOT_PYTHON, or that checkout's
 * regbot/.venv, or the machine's own. Without one, `regbot` is null and
 * practice mode says what it needs instead of starting (NO_SERVER). The DMV
 * stand-in the robots practise on is that checkout's too (`standin`).
 */
function locate({
  packaged, resourcesPath, appPath, platform = process.platform, arch = process.arch,
  env = process.env, exists = fs.existsSync,
}) {
  const server = findServer({ appPath, env, exists });
  const regbot = server ? path.join(server, 'regbot') : null;
  const python = serverPython(regbot, { env, platform, exists });
  const standinFile = server ? path.join(server, 'testsite', 'standin.mjs') : null;
  const standin = standinFile && exists(standinFile) ? standinFile : null;
  if (packaged) {
    const stack = path.join(resourcesPath, 'stack');
    return {
      packaged: true, server, regbot, python, standin,
      dmq: path.join(stack, 'dmq'),
      host: path.join(stack, 'host'),
      browsers: path.join(resourcesPath, 'browsers'),
    };
  }
  const repo = path.dirname(appPath);
  const vendor = path.join(appPath, 'vendor', `${OS_NAMES[platform] || platform}-${arch}`);
  return {
    packaged: false, server, regbot, python, standin,
    dmq: path.join(repo, 'dmq'),
    host: path.join(appPath, 'host'),
    browsers: exists(path.join(vendor, 'browsers')) ? path.join(vendor, 'browsers') : null,
  };
}

/** A lineright-server checkout: LINERIGHT_SERVER_DIR, or one beside this repository. */
function findServer({ appPath, env = process.env, exists = fs.existsSync }) {
  const named = String(env.LINERIGHT_SERVER_DIR || '').trim();
  const candidates = named ? [named] : [path.join(path.dirname(path.dirname(appPath)), 'lineright-server')];
  return candidates.map((dir) => path.resolve(dir))
    .find((dir) => exists(path.join(dir, 'regbot', 'desktop_host.py'))) || null;
}

function serverPython(regbot, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.REGBOT_PYTHON) return env.REGBOT_PYTHON;
  if (regbot) {
    const venv = platform === 'win32'
      ? path.join(regbot, '.venv', 'Scripts', 'python.exe')
      : path.join(regbot, '.venv', 'bin', 'python');
    if (exists(venv)) return venv;
  }
  return platform === 'win32' ? 'python' : 'python3';
}

/** What practice mode says when there is no server to run. */
const NO_SERVER = 'Practice on this computer runs the LineRight Regbot server, which does not come with this app. '
  + 'Check out lineright-server beside lineright-client (or set LINERIGHT_SERVER_DIR to a checkout of it), '
  + 'then restart the app — or choose the LineRight Regbot site in Settings.';

/** What it says when that server is too old to have the DMV stand-in. */
const NO_STANDIN = 'This lineright-server checkout has no DMV stand-in (testsite/standin.mjs): update it to practise against one. '
  + 'Until then the robots are pointed nowhere, never at the real DMV.';

/**
 * What a robot needs from the platform it runs on, on top of its own settings.
 * Shared by the practice server's worker, whose robots inherit it, and by the
 * robots the app runs for the regbot site itself (robots.js).
 *
 * Before a launch Playwright checks the browser's libraries are on the machine,
 * which on Windows takes a helper it installs only when it is itself installed
 * there — so an installer built anywhere else lacks it. What the check looks for
 * (the C runtime) is part of every Windows this app runs on; elsewhere it stays,
 * because it names a missing library. And on Windows the browser a robot starts
 * must not open a console window of its own on the person's screen
 * (host/robot-preload.cjs says why).
 */
function robotPlatformEnv(paths, platform = process.platform) {
  if (platform !== 'win32') return {};
  return {
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1',
    NODE_OPTIONS: nodeRequire(path.join(paths.host, 'robot-preload.cjs')),
  };
}

/**
 * Stop a process and everything it started.
 *
 * Elsewhere each service leads its own process group (spawned detached), so
 * one signal reaches a robot the worker is waiting on as well. Windows has no
 * groups to signal; taskkill walks the tree instead.
 */
function killTree(child, { platform = process.platform, force = false, spawn = childProcess.spawn } = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

const ENV_TEMPLATE = `# The LineRight Regbot server this app runs on this computer reads this file at start.
# One KEY=value per line; restart the app (or Settings -> Restart the server)
# after editing. The app sets the database, ports, secrets and which DMV the
# robots talk to itself; see regbot/.env.example and regbot/README.md for the
# rest. Some that matter here:
#
# Who books an allocated slot: the site's robot ("connector"), or you in the
# app's browser ("applicant"). Bids placed from this app are always yours to
# book; this decides the rest. The control room changes it too.
#REGBOT_BOOKED_BY=connector
#
# Let the California DMV robot submit a booking against the real DMV, rather
# than only report what it found. Off unless this says exactly true. It books
# for every bid the robots book, the simulated rivals' included, so turn those
# off first (REGBOT_CROWD=0). On the practice DMV the robots always book: a
# booking there takes nothing real, and this line does not change that.
#RQP_ALLOW_BOOKING=false
#
# Simulated rival bidders, so the boards move. 0 turns them off.
#REGBOT_CROWD=1
#
# Sell credits with Stripe instead of the practice checkout, which hands them
# out for nothing.
#REGBOT_PAYMENTS=stripe
#STRIPE_SECRET_KEY=
#STRIPE_WEBHOOK_SECRET=
`;

class Stack extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.paths        from locate()
   * @param {string} opts.dataDir      where the database, logs and the robots' state live
   * @param {string} opts.node         a binary that runs JavaScript as Node (the app's own, with ELECTRON_RUN_AS_NODE)
   * @param {object} [opts.identity]   {name, platform, version}: who the account is made for
   * @param {string} [opts.dmv]        'standin' (the default) or 'live'
   *
   * The device token the app signs in with, the session secret, the control
   * room's token and the ports last used are the server's, kept beside its
   * database in desktop.json and made on the first start (prepare()). Tests
   * pass them in instead.
   */
  constructor(opts) {
    super();
    this.paths = opts.paths;
    this.dataDir = opts.dataDir;
    this.node = opts.node;
    this.token = opts.token || null;
    this.secret = opts.secret || null;
    this.adminToken = opts.adminToken || null;
    this.identity = { name: '', platform: process.platform, version: '', ...(opts.identity || {}) };
    this.ports = { ...(opts.ports || {}) };
    this.dmv = opts.dmv === 'live' ? 'live' : 'standin';
    this.env = opts.env || process.env;
    this.platform = opts.platform || process.platform;
    this.spawn = opts.spawn || childProcess.spawn;
    this.kill = opts.kill || ((child, o) => killTree(child, { platform: this.platform, ...o }));
    this.log = opts.log || (() => {});
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.readyMs = opts.readyMs || 120000;
    this.graceMs = opts.graceMs === undefined ? 1500 : opts.graceMs;
    // Changed on every launch: the key the app uses to open the site or the
    // control room in a tab already signed in (the server's regbot/desktop_host.py).
    this.ticket = opts.ticket || crypto.randomBytes(24).toString('base64url');
    this.owner = null;
    this.stopping = false;
    this.services = {};
    for (const name of ORDER) {
      this.services[name] = {
        name, want: false, state: 'stopped', port: null, pid: null, child: null, since: 0,
        restarts: 0, message: '', tail: [], timer: null, waiters: [], logFile: null, halting: false,
      };
    }
  }

  // ------------------------------------------------------------ addresses
  urlOf(name) {
    const svc = this.services[name];
    return svc.state === 'running' && svc.port ? `http://127.0.0.1:${svc.port}` : null;
  }

  get url() { return this.urlOf('web'); }

  get logsDir() { return path.join(this.dataDir, 'logs'); }

  get envFile() { return path.join(this.dataDir, 'regbot.env'); }

  /** The site, opened at `next`, signed in as the person this app is. */
  signinUrl(next = '/console') {
    return this.url ? `${this.url}/desktop/signin?ticket=${encodeURIComponent(this.ticket)}&next=${encodeURIComponent(next)}` : null;
  }

  /** The control room, unlocked. */
  adminUrl(next = '/') {
    const base = this.urlOf('admin');
    return base ? `${base}/desktop/unlock?ticket=${encodeURIComponent(this.ticket)}&next=${encodeURIComponent(next)}` : null;
  }

  /** Where the robots and the hand-offs are sent for California: the stand-in, or the real DMV (''). */
  dmvBase() {
    if (this.dmv === 'live') return '';
    return this.urlOf('standin') || (this.ports.standin ? `http://127.0.0.1:${this.ports.standin}` : NOWHERE);
  }

  status() {
    const services = {};
    for (const name of ORDER) {
      const s = this.services[name];
      services[name] = { state: s.state, port: s.port, pid: s.pid, restarts: s.restarts, since: s.since, message: s.message, log: s.logFile };
    }
    return {
      url: this.url, admin: this.urlOf('admin'), standin: this.urlOf('standin'), dmv: this.dmv,
      dmvBase: this.dmvBase(), owner: this.owner, dataDir: this.dataDir, logsDir: this.logsDir,
      envFile: this.envFile, python: this.paths.python, packaged: this.paths.packaged, services,
      server: this.paths.server || null, available: Boolean(this.paths.regbot),
    };
  }

  changed() {
    this.emit('state', this.status());
  }

  // ------------------------------------------------------------- starting
  /** The server as the app needs it: the stand-in (unless live), the site, the processor. */
  async start() {
    this.stopping = false;
    if (!this.paths.regbot) {
      for (const name of ['web', 'worker']) Object.assign(this.services[name], { state: 'failed', message: NO_SERVER });
      this.changed();
      throw new Error(NO_SERVER);
    }
    this.prepare();
    if (this.dmv === 'standin') {
      // Not fatal: without it the robots are pointed nowhere, never at the
      // real DMV, and the rest of the server is still worth having.
      await this.ensure('standin').catch((err) => this.log(`stand-in: ${err.message}`));
    }
    // The site first: on a first run it creates and seeds the database the
    // processor reads. The processor is started even if the site is not up —
    // it will be retried, and the two share nothing but the database.
    let failure = null;
    await this.ensure('web').catch((err) => { failure = err; });
    await this.ensure('worker').catch((err) => { failure = failure || err; });
    if (failure) throw failure;
    return this.status();
  }

  get credentialsFile() { return path.join(this.dataDir, 'desktop.json'); }

  /**
   * The directories, the configuration file a person may edit, and the
   * server's credentials: read from desktop.json, or made and written there
   * the first time. They sit with the database rather than in the app's
   * settings because they mean nothing without it — the token is what the
   * account in that database recognises this app by.
   */
  prepare() {
    for (const dir of [this.dataDir, this.logsDir, path.join(this.dataDir, 'bot')]) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.envFile)) {
      try { fs.writeFileSync(this.envFile, ENV_TEMPLATE); } catch { /* the server does without */ }
    }
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8')) || {}; } catch { /* first start */ }
    const make = () => crypto.randomBytes(32).toString('base64url');
    this.token = this.token || saved.token || make();
    this.secret = this.secret || saved.secret || make();
    this.adminToken = this.adminToken || saved.adminToken || make();
    this.ports = { ...(saved.ports || {}), ...this.ports };
    this.save();
    return this;
  }

  save() {
    const body = JSON.stringify({ token: this.token, secret: this.secret, adminToken: this.adminToken, ports: this.ports }, null, 2);
    try {
      const tmp = `${this.credentialsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.credentialsFile);
    } catch (err) {
      this.log(`could not save ${this.credentialsFile}: ${err.message}`);
    }
  }

  /** Want `name` running; resolve once it is (at once if it already is). */
  ensure(name) {
    const svc = this.services[name];
    const missing = !this.paths.regbot ? NO_SERVER : name === 'standin' && !this.paths.standin ? NO_STANDIN : null;
    if (missing) {
      // Nothing to run: said on each part the screens show, and not tried.
      Object.assign(svc, { state: 'failed', message: missing });
      this.changed();
      return Promise.reject(new Error(missing));
    }
    svc.want = true;
    if (svc.state === 'running') return Promise.resolve(this.status());
    const ready = new Promise((resolve, reject) => svc.waiters.push({ resolve, reject }));
    if (!svc.child && !svc.timer) this.launch(svc);
    return ready;
  }

  command(name) {
    const p = this.paths;
    if (name === 'standin') return { file: this.node, args: [p.standin, `--port=${this.ports.standin || 0}`] };
    const args = ['-I', '-B', '-u', '-X', 'utf8', path.join(p.regbot, 'desktop_host.py'), name, '--regbot', p.regbot];
    if (name === 'web' || name === 'admin') args.push('--port', String(this.ports[name] || 0));
    return { file: p.python, args };
  }

  environment(name) {
    const env = {};
    for (const [key, value] of Object.entries(this.env)) if (!OWNED.has(key) && value !== undefined) env[key] = value;
    const common = {
      REGBOT_DB: path.join(this.dataDir, 'regbot.db'),
      REGBOT_SECRET: this.secret,
      REGBOT_ENV_FILE: this.envFile,
      REGBOT_TESTSITE_URL: this.dmv === 'live' ? NOWHERE : this.dmvBase(),
      // Practice runs the whole of regbot here, its own scouts and robots
      // included; handing reads to apps is the public site's way (reads.py).
      REGBOT_DISCOVERY_BY: 'server',
      // And its credits are play money: bought with the simulated checkout,
      // and some to start with. A server without this sells them through Stripe.
      REGBOT_PRACTICE: '1',
    };
    const dmv = this.dmvBase();
    if (dmv) common.DMV_BASE_URL = dmv;
    if (name === 'standin') return { ...env, ELECTRON_RUN_AS_NODE: '1' };
    if (name === 'web') {
      return {
        ...env, ...common,
        REGBOT_DESKTOP_TOKEN: this.token,
        REGBOT_DESKTOP_TICKET: this.ticket,
        REGBOT_DESKTOP_NAME: this.identity.name || '',
        REGBOT_DESKTOP_PLATFORM: this.identity.platform || '',
        REGBOT_DESKTOP_VERSION: this.identity.version || '',
      };
    }
    if (name === 'admin') {
      return {
        ...env, ...common,
        REGBOT_DESKTOP_TICKET: this.ticket,
        REGBOT_ADMIN_TOKEN: this.adminToken,
        REGBOT_PUBLIC_URL: this.url || '',
      };
    }
    // The worker, and through it the robots: they are this app's own binary
    // running as Node, with the Playwright and the browser the bundle carries.
    const worker = {
      ...env, ...common,
      REGBOT_CADMV_NODE: this.node,
      REGBOT_CADMV_DIR: this.paths.dmq,
      ELECTRON_RUN_AS_NODE: '1',
      RQP_STATE_PATH: path.join(this.dataDir, 'bot', 'rqp-bookings.json'),
      RUN_LOG_PATH: path.join(this.logsDir, 'dmv-robot.log'),
    };
    if (this.paths.browsers) worker.PLAYWRIGHT_BROWSERS_PATH = this.paths.browsers;
    // On the stand-in the robots book for real, form submitted and
    // confirmation read back, because a practice booking takes nothing from
    // anyone. Against the real DMV the app never turns it on — the simulated
    // bidders' made-up details would become real appointments — and neither
    // does the machine's environment (RQP_ALLOW_BOOKING is in OWNED): only the
    // server's own regbot.env can, on purpose.
    if (this.dmv === 'standin') worker.RQP_ALLOW_BOOKING = 'true';
    return { ...worker, ...robotPlatformEnv(this.paths, this.platform) };
  }

  openLog(svc) {
    const file = path.join(this.logsDir, `${svc.name}.log`);
    try {
      if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    svc.logFile = file;
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {});
    return stream;
  }

  launch(svc) {
    svc.timer = null;
    if (!svc.want || this.stopping) return;
    const { file, args } = this.command(svc.name);
    const log = this.openLog(svc);
    log.write(`\n--- ${new Date().toISOString()} starting ${svc.name}: ${file} ${args.join(' ')}\n`);
    let child;
    try {
      child = this.spawn(file, args, {
        cwd: this.dataDir,
        env: this.environment(svc.name),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so stopping it reaches what it started.
        detached: this.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      this.failed(svc, `could not start: ${err.message}`, log);
      return;
    }
    svc.child = child;
    svc.pid = child.pid || null;
    svc.state = 'starting';
    svc.since = Date.now();
    svc.message = '';
    svc.tail = [];
    this.changed();

    const deadline = this.setTimeout(() => {
      if (svc.child === child && svc.state === 'starting') {
        svc.message = `did not say it was ready within ${Math.round(this.readyMs / 1000)}s`;
        this.kill(child, { force: true });
      }
    }, this.readyMs);

    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        if (line.startsWith(READY)) this.ready(svc, child, line.slice(READY.length), deadline);
        else log.write(`${line}\n`);
      }
    });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      const lines = String(chunk).split(/\r?\n/).filter((l) => l.trim());
      svc.tail = [...svc.tail, ...lines].slice(-12);
    });
    // The lifeline: this end is never written to, and never closed until the
    // app wants the service gone. An EPIPE on it is the service already gone.
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      this.clearTimeout(deadline);
      if (svc.child !== child) return;
      svc.child = null;
      svc.pid = null;
      // A binary that is not there will not be there in a minute either.
      this.failed(svc, err.code === 'ENOENT' ? `${file} was not found` : err.message, log);
    });
    child.on('exit', (code, signal) => {
      this.clearTimeout(deadline);
      log.write(`--- ${new Date().toISOString()} ${svc.name} exited (${code === null ? signal : code})\n`);
      log.end();
      if (svc.child !== child) return;
      svc.child = null;
      svc.pid = null;
      this.exited(svc, code, signal);
    });
  }

  ready(svc, child, json, deadline) {
    let info = {};
    try { info = JSON.parse(json); } catch { /* a ready line without details is still ready */ }
    if (svc.child !== child) return;
    this.clearTimeout(deadline);
    const before = svc.port;
    svc.port = info.port || null;
    svc.state = 'running';
    svc.message = '';
    if (svc.name === 'web' && info.owner) this.owner = info.owner;
    if (svc.port && this.ports[svc.name] !== svc.port) {
      this.ports[svc.name] = svc.port;
      this.save();
    }
    this.log(`${svc.name} ready${svc.port ? ` on 127.0.0.1:${svc.port}` : ''} (pid ${svc.pid})`);
    const waiters = svc.waiters.splice(0);
    for (const w of waiters) w.resolve(this.status());
    this.changed();
    this.emit('ready', svc.name, info);
    // Whatever was started with the old address has to hear the new one.
    if (before && svc.port && before !== svc.port) {
      const dependents = svc.name === 'standin' ? ['web', 'worker', 'admin'] : svc.name === 'web' ? ['admin'] : [];
      for (const name of dependents) if (this.services[name].child) this.restart(name);
    }
  }

  failed(svc, message, log) {
    svc.state = 'failed';
    svc.message = message;
    if (log) { log.write(`--- ${svc.name} failed: ${message}\n`); log.end(); }
    this.log(`${svc.name} failed: ${message}`);
    const waiters = svc.waiters.splice(0);
    for (const w of waiters) w.reject(new Error(`${svc.name}: ${message}`));
    this.changed();
  }

  exited(svc, code, signal) {
    const said = svc.message || svc.tail[svc.tail.length - 1] || `exited ${code === null ? signal : code}`;
    // Stopped on purpose — for good, or to be started again by restart() —
    // is not falling over, and gets no crash back-off.
    if (!svc.want || this.stopping || svc.halting) {
      svc.state = 'stopped';
      svc.port = null;
      // Stopped for good: whoever was waiting for it to come up hears so. (A
      // restart keeps its waiters; they are answered when it is back.)
      if (!svc.halting || !svc.want) {
        for (const w of svc.waiters.splice(0)) w.reject(new Error(`${svc.name}: stopped`));
      }
      this.changed();
      return;
    }
    // One that ran for a while before falling over starts the count again.
    svc.restarts = Date.now() - svc.since > 60000 ? 1 : svc.restarts + 1;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(svc.restarts - 1, 5));
    svc.state = 'restarting';
    svc.message = `${said} — starting it again in ${Math.round(wait / 1000)}s`;
    this.log(`${svc.name} stopped (${code === null ? signal : code}); again in ${wait}ms`);
    // Whoever was waiting for the first start hears why it has not happened.
    const waiters = svc.waiters.splice(0);
    for (const w of waiters) w.reject(new Error(`${svc.name}: ${said}`));
    svc.timer = this.setTimeout(() => this.launch(svc), wait);
    this.changed();
  }

  // ------------------------------------------------------------- stopping
  /** Stop one service and whatever it started. Resolves once it has gone. */
  halt(name, { forget = true } = {}) {
    const svc = this.services[name];
    if (forget) svc.want = false;
    if (svc.timer) { this.clearTimeout(svc.timer); svc.timer = null; }
    const child = svc.child;
    if (!child) {
      if (svc.state !== 'failed' || forget) svc.state = 'stopped';
      this.changed();
      return Promise.resolve();
    }
    svc.halting = true;
    return new Promise((resolve) => {
      const timers = [];
      const finish = () => {
        for (const t of timers) this.clearTimeout(t);
        svc.halting = false;
        resolve();
      };
      child.once('exit', finish);
      // Let go of the lifeline first: the service winds itself down. Then
      // ask the whole group to stop, and then insist — and then stop waiting,
      // so a process that will not die cannot hold the app open either.
      try { child.stdin.end(); } catch { /* already closed */ }
      timers.push(this.setTimeout(() => this.kill(child, { force: false }), this.graceMs));
      timers.push(this.setTimeout(() => {
        this.kill(child, { force: true });
        timers.push(this.setTimeout(finish, 500));
      }, this.graceMs * 2));
    });
  }

  /** Stop and start one service, if it is wanted at all. */
  async restart(name) {
    const svc = this.services[name];
    const wanted = svc.want;
    await this.halt(name, { forget: false });
    if (!wanted || this.stopping) return this.status();
    svc.restarts = 0;
    return this.ensure(name);
  }

  /** Stop everything this app started. */
  async stop() {
    this.stopping = true;
    await Promise.all(ORDER.map((name) => this.halt(name)));
    this.changed();
  }

  /** Point the robots at the stand-in or at the real DMV, and restart what reads it. */
  async setDmv(target) {
    const next = target === 'live' ? 'live' : 'standin';
    if (next === this.dmv) return this.status();
    this.dmv = next;
    if (next === 'standin') await this.ensure('standin').catch((err) => this.log(`stand-in: ${err.message}`));
    else await this.halt('standin');
    for (const name of ['web', 'worker', 'admin']) {
      if (this.services[name].want) await this.restart(name).catch((err) => this.log(`${name}: ${err.message}`));
    }
    return this.status();
  }

  /** Everything again, as after a fresh start: for a configuration edited by hand. */
  async restartAll() {
    const again = ORDER.filter((name) => this.services[name].want || this.services[name].state === 'failed'
      || (name === 'standin' && this.dmv === 'standin'));
    for (const name of again) {
      this.services[name].want = true;
      await this.restart(name).catch((err) => this.log(`${name}: ${err.message}`));
    }
    return this.status();
  }
}

module.exports = {
  Stack, locate, findServer, serverPython, killTree, nodeRequire, robotPlatformEnv, READY, NOWHERE, OWNED, NO_SERVER, NO_STANDIN,
};
