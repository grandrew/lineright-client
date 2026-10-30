'use strict';
/**
 * The server the app runs on this machine, supervised: what is started in
 * which order and with what, what happens when a piece falls over or is not
 * there at all, and that stopping reaches everything. Driven with a fake
 * spawn and fake timers — test/host.test.js and the smoke test run the real
 * processes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { Stack, locate, findServer, killTree, NOWHERE, NO_SERVER, NO_STANDIN } = require('../src/stack');

class FakeChild extends EventEmitter {
  constructor(file, args, opts, pid) {
    super();
    Object.assign(this, { file, args, opts, pid, exitCode: null, signalCode: null, killed: [] });
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.ended = false;
    this.stdin.end = () => { this.stdin.ended = true; };
  }

  get service() {
    const i = this.args.indexOf('--regbot');
    return i > 0 ? this.args[i - 1] : 'standin';
  }

  ready(fields = {}) {
    this.stdout.emit('data', `some chatter\nREGBOT-READY ${JSON.stringify({ service: this.service, ...fields })}\n`);
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** Timers that only move when told to. */
function clock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    pending: () => [...pending.values()].map((t) => t.at - now),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-stack-'));
  const children = [];
  const kills = [];
  const timers = clock();
  const stack = new Stack({
    paths: opts.paths || { packaged: true, server: '/srv/lineright-server', regbot: '/srv/lineright-server/regbot', standin: '/srv/lineright-server/testsite/standin.mjs', dmq: '/r/stack/dmq', host: '/r/stack/host', python: '/srv/lineright-server/regbot/.venv/bin/python', browsers: '/r/browsers' },
    dataDir,
    node: '/opt/regbot/regbot',
    token: 'tok', secret: 'sec', adminToken: 'adm', ticket: 'tkt',
    identity: { name: 'ada', platform: 'linux', version: '0.2.0' },
    env: { PATH: '/usr/bin', HOME: '/home/ada', DMV_BASE_URL: 'https://leaked.example', NODE_OPTIONS: '--inspect', REGBOT_CROWD: '0' },
    platform: 'linux',
    spawn: (file, args, o) => {
      if (opts.spawnError && opts.spawnError(file, args)) {
        const child = new FakeChild(file, args, o, 0);
        setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })));
        children.push(child);
        return child;
      }
      const child = new FakeChild(file, args, o, 1000 + children.length);
      children.push(child);
      return child;
    },
    kill: (child, o) => { kills.push({ pid: child.pid, force: o.force }); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...opts.stack,
  });
  const latest = (service) => children.filter((c) => c.service === service).pop();
  return { stack, children, kills, timers, latest, dataDir };
}

/** Bring the three services up in order, each announcing itself. */
async function bootAll(h, ports = { standin: 8801, web: 8802 }) {
  const started = h.stack.start();
  await tick();
  h.latest('standin').ready({ port: ports.standin });
  await tick();
  h.latest('web').ready({ port: ports.web, owner: { id: 7, nickname: 'ada' } });
  await tick();
  h.latest('worker').ready();
  return started;
}

test('starts the stand-in, then the site, then the processor, each once the one before is up', async () => {
  const h = harness();
  const started = h.stack.start();
  await tick();
  assert.deepEqual(h.children.map((c) => c.service), ['standin']);
  h.latest('standin').ready({ port: 8801 });
  await tick();
  assert.deepEqual(h.children.map((c) => c.service), ['standin', 'web']);
  h.latest('web').ready({ port: 8802, owner: { id: 7, nickname: 'ada' } });
  await tick();
  assert.deepEqual(h.children.map((c) => c.service), ['standin', 'web', 'worker']);
  h.latest('worker').ready();
  const status = await started;
  assert.equal(status.url, 'http://127.0.0.1:8802');
  assert.equal(status.standin, 'http://127.0.0.1:8801');
  assert.deepEqual(status.owner, { id: 7, nickname: 'ada' });
  assert.equal(status.services.admin.state, 'stopped', 'the control room waits until it is opened');
});

test('each service is launched the way the bundle expects, isolated and in its own process group', async () => {
  const h = harness();
  await bootAll(h);
  const standin = h.latest('standin');
  assert.equal(standin.file, '/opt/regbot/regbot', 'the stand-in is the app binary running as Node');
  // Joined the way this machine joins paths: the app builds them with path.join.
  assert.deepEqual(standin.args, ['/srv/lineright-server/testsite/standin.mjs', '--port=0'], "the server checkout's stand-in: none comes with the app");
  const web = h.latest('web');
  assert.equal(web.file, '/srv/lineright-server/regbot/.venv/bin/python');
  assert.deepEqual(web.args, ['-I', '-B', '-u', '-X', 'utf8', path.join('/srv/lineright-server/regbot', 'desktop_host.py'), 'web', '--regbot', '/srv/lineright-server/regbot', '--port', '0']);
  assert.deepEqual(h.latest('worker').args.slice(-3), ['worker', '--regbot', '/srv/lineright-server/regbot']);
  for (const c of h.children) {
    assert.equal(c.opts.detached, true, `${c.service} leads its own group, so stopping it stops what it started`);
    assert.equal(c.opts.windowsHide, true);
    assert.deepEqual(c.opts.stdio, ['pipe', 'pipe', 'pipe']);
  }
});

test('the site gets the account token and the sign-in ticket; the processor gets the robots', async () => {
  const h = harness();
  await bootAll(h);
  const web = h.latest('web').opts.env;
  assert.equal(web.REGBOT_DESKTOP_TOKEN, 'tok');
  assert.equal(web.REGBOT_DESKTOP_TICKET, 'tkt');
  assert.equal(web.REGBOT_DESKTOP_NAME, 'ada');
  assert.equal(web.REGBOT_SECRET, 'sec');
  assert.equal(web.REGBOT_DB, path.join(h.dataDir, 'regbot.db'));
  assert.equal(web.REGBOT_ENV_FILE, path.join(h.dataDir, 'regbot.env'));
  assert.equal(web.DMV_BASE_URL, 'http://127.0.0.1:8801', 'hand-offs go to the stand-in');
  assert.equal(web.ELECTRON_RUN_AS_NODE, undefined);

  const worker = h.latest('worker').opts.env;
  assert.equal(worker.REGBOT_CADMV_NODE, '/opt/regbot/regbot', 'the robots run on the app binary');
  assert.equal(worker.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(worker.REGBOT_CADMV_DIR, '/r/stack/dmq');
  assert.equal(worker.PLAYWRIGHT_BROWSERS_PATH, '/r/browsers');
  assert.equal(worker.DMV_BASE_URL, 'http://127.0.0.1:8801');
  assert.equal(worker.REGBOT_TESTSITE_URL, 'http://127.0.0.1:8801');
  assert.equal(worker.RQP_STATE_PATH, path.join(h.dataDir, 'bot', 'rqp-bookings.json'));
  assert.equal(worker.REGBOT_DESKTOP_TOKEN, undefined, 'only the site needs the token');

  assert.equal(h.latest('standin').opts.env.ELECTRON_RUN_AS_NODE, '1');
});

test("the machine's own settings for what the app decides do not leak in; the rest passes through", async () => {
  const h = harness();
  await bootAll(h);
  for (const c of h.children) {
    assert.notEqual(c.opts.env.DMV_BASE_URL, 'https://leaked.example', `${c.service} must not inherit a DMV address`);
    assert.equal(c.opts.env.NODE_OPTIONS, undefined);
    assert.equal(c.opts.env.PATH, '/usr/bin');
  }
  assert.equal(h.latest('worker').opts.env.REGBOT_CROWD, '0', 'regbot knobs set on purpose still reach it');
});

test('pointed at the real DMV: no stand-in, and nothing names one', async () => {
  const h = harness({ stack: { dmv: 'live' } });
  const started = h.stack.start();
  await tick();
  assert.deepEqual(h.children.map((c) => c.service), ['web']);
  h.latest('web').ready({ port: 8802 });
  await tick();
  h.latest('worker').ready();
  await started;
  const worker = h.latest('worker').opts.env;
  assert.equal(worker.DMV_BASE_URL, undefined, 'unset means dmv.ca.gov, to the bot and the site alike');
  assert.equal(worker.REGBOT_TESTSITE_URL, NOWHERE, 'and no simulated solving farm');
  assert.equal(h.stack.status().dmvBase, '');
});

test('the robots book on the stand-in, and on the real DMV only if regbot.env says so', async () => {
  const practice = harness({ stack: { env: { PATH: '/usr/bin', RQP_ALLOW_BOOKING: 'false' } } });
  await bootAll(practice);
  assert.equal(practice.latest('worker').opts.env.RQP_ALLOW_BOOKING, 'true', 'a practice booking takes nothing real');
  assert.equal(practice.latest('web').opts.env.RQP_ALLOW_BOOKING, undefined, 'only the robots book');

  const live = harness({ stack: { dmv: 'live', env: { PATH: '/usr/bin', RQP_ALLOW_BOOKING: 'true' } } });
  const started = live.stack.start();
  await tick();
  live.latest('web').ready({ port: 8802 });
  await tick();
  live.latest('worker').ready();
  await started;
  assert.equal(live.latest('worker').opts.env.RQP_ALLOW_BOOKING, undefined,
    "a shell's setting does not book real appointments; regbot.env, read by the server, still can");
});

test('a stand-in that will not start points the robots nowhere — never at the real DMV', async () => {
  const h = harness({ spawnError: (file) => file === '/opt/regbot/regbot' });
  const started = h.stack.start();
  await tick(); await tick();
  assert.equal(h.stack.status().services.standin.state, 'failed');
  h.latest('web').ready({ port: 8802 });
  await tick();
  h.latest('worker').ready();
  await started;
  assert.equal(h.latest('worker').opts.env.DMV_BASE_URL, NOWHERE);
  assert.equal(h.latest('web').opts.env.DMV_BASE_URL, NOWHERE);
});

test('a missing Python fails the start once, with the reason, and is not retried', async () => {
  const h = harness({ spawnError: (file) => file.endsWith('/bin/python') });
  const started = h.stack.start();
  await tick();
  h.latest('standin').ready({ port: 8801 });
  await assert.rejects(started, /web: \/srv\/lineright-server\/regbot\/\.venv\/bin\/python was not found/);
  const status = h.stack.status();
  assert.equal(status.services.web.state, 'failed');
  assert.equal(status.services.worker.state, 'failed');
  assert.deepEqual(h.timers.pending(), [], 'nothing scheduled to try again');
});

test('a service that falls over is started again, later each time, and the screen hears why', async () => {
  const h = harness();
  await bootAll(h);
  const states = [];
  h.stack.on('state', (s) => states.push(s.services.worker.state));
  const first = h.latest('worker');
  first.stderr.emit('data', 'Traceback (most recent call last):\nsqlite3.OperationalError: database is locked\n');
  first.exit(1);
  let status = h.stack.status().services.worker;
  assert.equal(status.state, 'restarting');
  assert.match(status.message, /database is locked — starting it again in 1s/);
  h.timers.advance(1000);
  const second = h.latest('worker');
  assert.notEqual(second, first);
  second.exit(1);
  assert.match(h.stack.status().services.worker.message, /again in 2s/);
  h.timers.advance(1999);
  assert.equal(h.latest('worker'), second, 'not before its time');
  h.timers.advance(1);
  const third = h.latest('worker');
  third.ready();
  status = h.stack.status().services.worker;
  assert.equal(status.state, 'running');
  assert.equal(status.message, '');
  assert.ok(states.includes('restarting') && states.at(-1) === 'running');
});

test('one that never says it is ready is killed and started again', async () => {
  const h = harness({ stack: { readyMs: 5000 } });
  const started = h.stack.start();
  await tick();
  const standin = h.latest('standin');
  h.timers.advance(5000);
  assert.deepEqual(h.kills, [{ pid: standin.pid, force: true }]);
  standin.exit(null, 'SIGKILL');
  assert.match(h.stack.status().services.standin.message, /did not say it was ready within 5s/);
  started.catch(() => {});
});

test('stopping lets go of each lifeline, then signals the group, then insists — and restarts nothing', async () => {
  const h = harness({ stack: { graceMs: 1000 } });
  await bootAll(h);
  const stopping = h.stack.stop();
  for (const name of ['standin', 'web', 'worker']) assert.equal(h.latest(name).stdin.ended, true, `${name}'s lifeline closed`);
  // The site and the stand-in leave on their own; the processor is mid-robot.
  h.latest('standin').exit(0);
  h.latest('web').exit(0);
  h.timers.advance(1000);
  assert.deepEqual(h.kills, [{ pid: h.latest('worker').pid, force: false }]);
  h.timers.advance(1000);
  assert.deepEqual(h.kills.at(-1), { pid: h.latest('worker').pid, force: true });
  h.latest('worker').exit(null, 'SIGKILL');
  await stopping;
  const status = h.stack.status();
  for (const name of ['standin', 'web', 'worker', 'admin']) assert.equal(status.services[name].state, 'stopped');
  assert.equal(h.children.length, 3, 'nothing was started again');
  assert.deepEqual(h.timers.pending(), []);
});

test('the control room starts on demand, and opens unlocked with the launch ticket', async () => {
  const h = harness();
  await bootAll(h);
  assert.equal(h.stack.adminUrl(), null);
  const opening = h.stack.ensure('admin');
  await tick();
  const admin = h.latest('admin');
  assert.equal(admin.opts.env.REGBOT_ADMIN_TOKEN, 'adm');
  assert.equal(admin.opts.env.REGBOT_PUBLIC_URL, 'http://127.0.0.1:8802');
  admin.ready({ port: 8803 });
  await opening;
  assert.equal(h.stack.adminUrl('/gate'), 'http://127.0.0.1:8803/desktop/unlock?ticket=tkt&next=%2Fgate');
  assert.equal(h.stack.signinUrl('/console'), 'http://127.0.0.1:8802/desktop/signin?ticket=tkt&next=%2Fconsole');
});

test('a stand-in back on a different port takes the site and the processor with it', async () => {
  const h = harness({ stack: { graceMs: 10 } });
  await bootAll(h);
  const oldWeb = h.latest('web');
  const oldWorker = h.latest('worker');
  h.latest('standin').exit(1);
  h.timers.advance(1000);
  h.latest('standin').ready({ port: 9901 });
  await tick();
  assert.equal(oldWeb.stdin.ended, true);
  assert.equal(oldWorker.stdin.ended, true);
  oldWeb.exit(0);
  oldWorker.exit(0);
  await tick(); await tick();
  assert.equal(h.latest('web').opts.env.DMV_BASE_URL, 'http://127.0.0.1:9901');
  h.latest('web').ready({ port: 8802 });
  await tick(); await tick();
  assert.equal(h.latest('worker').opts.env.DMV_BASE_URL, 'http://127.0.0.1:9901');
});

test('switching to the real DMV stops the stand-in and restarts what reads the address', async () => {
  const h = harness({ stack: { graceMs: 10 } });
  await bootAll(h);
  const switching = h.stack.setDmv('live');
  h.latest('standin').exit(0);
  await tick(); await tick();
  h.latest('web').exit(0);
  await tick(); await tick();
  h.latest('web').ready({ port: 8802 });
  await tick(); await tick();
  h.latest('worker').exit(0);
  await tick(); await tick();
  h.latest('worker').ready();
  const status = await switching;
  assert.equal(status.dmv, 'live');
  assert.equal(status.services.standin.state, 'stopped');
  assert.equal(h.latest('worker').opts.env.DMV_BASE_URL, undefined);
});

test('the credentials are made once, kept beside the database, and private', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-creds-'));
  const make = () => new Stack({ paths: {}, dataDir, node: 'n' }).prepare();
  const first = make();
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first.token, first.secret);
  const file = path.join(dataDir, 'desktop.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  first.ports.web = 5123;
  first.save();
  const again = make();
  assert.equal(again.token, first.token);
  assert.equal(again.secret, first.secret);
  assert.equal(again.ports.web, 5123, 'the port is tried again next time');
  const env = fs.readFileSync(path.join(dataDir, 'regbot.env'), 'utf8');
  assert.match(env, /RQP_ALLOW_BOOKING/);
  fs.writeFileSync(path.join(dataDir, 'regbot.env'), 'REGBOT_CROWD=0\n');
  make();
  assert.equal(fs.readFileSync(path.join(dataDir, 'regbot.env'), 'utf8'), 'REGBOT_CROWD=0\n', 'an edited file is left alone');
});

test('installed, the robots, the host and the browser are under the resources, and the server is not', () => {
  const linux = locate({ packaged: true, resourcesPath: '/opt/regbot/resources', appPath: '/opt/regbot/resources/app.asar',
    platform: 'linux', env: {}, exists: () => false });
  assert.equal(linux.dmq, path.join('/opt/regbot/resources', 'stack', 'dmq'));
  assert.equal(linux.host, path.join('/opt/regbot/resources', 'stack', 'host'));
  assert.equal(linux.browsers, path.join('/opt/regbot/resources', 'browsers'));
  assert.equal(linux.regbot, null, 'no lineright server ships in the app');
  assert.equal(linux.standin, null, 'and no DMV stand-in');
  assert.equal(linux.python, 'python3');
  // A lineright-server checkout named outright is used, installed or not.
  const server = path.resolve('/home/ada/lineright-server');
  const named = locate({ packaged: true, resourcesPath: 'C:\\regbot\\resources', appPath: 'C:\\regbot\\resources\\app.asar',
    platform: 'win32', env: { LINERIGHT_SERVER_DIR: server },
    exists: (p) => p === path.join(server, 'regbot', 'desktop_host.py') || p === path.join(server, 'regbot', '.venv', 'Scripts', 'python.exe') });
  assert.equal(named.regbot, path.join(server, 'regbot'));
  assert.equal(named.python, path.join(server, 'regbot', '.venv', 'Scripts', 'python.exe'));
});

test('a checkout finds lineright-server beside it, with its virtualenv, else whatever python3 is', () => {
  const app = path.resolve('/src/lineright-client/desktop');
  const server = path.resolve('/src/lineright-server');
  const host = path.join(server, 'regbot', 'desktop_host.py');
  const venv = path.join(server, 'regbot', '.venv', 'bin', 'python');
  const some = (...present) => (p) => present.includes(p);
  const standin = path.join(server, 'testsite', 'standin.mjs');
  const found = locate({ packaged: false, appPath: app, platform: 'linux', arch: 'x64', env: {},
    exists: some(host, venv, standin, path.join(app, 'vendor', 'linux-x64', 'browsers')) });
  assert.equal(found.server, server);
  assert.equal(found.regbot, path.join(server, 'regbot'));
  assert.equal(found.standin, standin, "the DMV stand-in is the server checkout's");
  assert.equal(locate({ packaged: false, appPath: app, platform: 'linux', env: {}, exists: some(host) }).standin, null,
    'a checkout from before the stand-in moved there has none');
  const own = path.resolve('/src/lineright-client/simulators/ca-dmv/standin.mjs');
  assert.equal(locate({ packaged: false, appPath: app, platform: 'linux', env: {}, exists: some(host, standin, own) }).standin,
    own, "this repository's own simulator comes first");
  assert.equal(locate({ packaged: true, resourcesPath: '/opt/r', appPath: app, platform: 'linux', env: {},
    exists: some(host, standin, own) }).standin, standin, 'an installed app has none of its own');
  assert.equal(found.python, venv);
  assert.equal(found.dmq, path.resolve('/src/lineright-client/dmq'));
  assert.equal(found.host, path.join(app, 'host'));
  assert.equal(found.browsers, path.join(app, 'vendor', 'linux-x64', 'browsers'));
  assert.equal(locate({ packaged: false, appPath: app, platform: 'linux', env: {}, exists: some(host) }).python, 'python3');
  assert.equal(locate({ packaged: false, appPath: app, platform: 'linux', env: { REGBOT_PYTHON: '/x/py' }, exists: some(host, venv) }).python, '/x/py');
  const bare = locate({ packaged: false, appPath: app, platform: 'linux', arch: 'x64', env: {}, exists: some() });
  assert.equal(bare.regbot, null, 'a folder is a server only with its desktop host in it');
  assert.equal(bare.browsers, null, "Playwright's own cache, then");
  const elsewhere = path.resolve('/opt/lineright-server');
  assert.equal(findServer({ appPath: app, env: { LINERIGHT_SERVER_DIR: elsewhere },
    exists: some(host, path.join(elsewhere, 'regbot', 'desktop_host.py')) }), elsewhere, 'the one named, not the one beside it');
});

test('a server checkout without the stand-in runs the rest, and points the robots nowhere', async () => {
  const h = harness({ paths: { packaged: true, server: '/srv/old-server', regbot: '/srv/old-server/regbot', standin: null, dmq: '/r/stack/dmq', host: '/r/stack/host', python: 'python3', browsers: '/r/browsers' } });
  const started = h.stack.start();
  await tick();
  assert.equal(h.latest('standin'), undefined, 'nothing is started for it');
  assert.equal(h.stack.status().services.standin.message, NO_STANDIN);
  h.latest('web').ready({ port: 8802 });
  await tick();
  h.latest('worker').ready();
  await started;
  assert.equal(h.latest('worker').opts.env.DMV_BASE_URL, NOWHERE, 'never the real DMV');
});

test('without a server, practice says what it needs and starts nothing', async () => {
  const h = harness({ paths: { packaged: true, server: null, regbot: null, dmq: '/r/stack/dmq', host: '/r/stack/host', python: 'python3', browsers: '/r/browsers' } });
  await assert.rejects(h.stack.start(), (err) => err.message === NO_SERVER);
  await assert.rejects(h.stack.ensure('admin'), (err) => err.message === NO_SERVER);
  assert.equal(h.children.length, 0, 'not even the stand-in');
  const status = h.stack.status();
  assert.equal(status.available, false);
  assert.equal(status.services.web.state, 'failed');
  assert.equal(status.services.web.message, NO_SERVER);
  assert.match(NO_SERVER, /lineright-server/);
});

test('killTree takes a whole process group down', { skip: process.platform === 'win32' }, async () => {
  // A shell that starts a grandchild: both must go.
  const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  killTree(child, { platform: process.platform });
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'the grandchild went with it');
});

test('on Windows, killTree asks taskkill for the tree', () => {
  const calls = [];
  const fakeSpawn = (file, args) => { calls.push([file, ...args]); return new EventEmitter(); };
  killTree({ pid: 4321, exitCode: null, signalCode: null }, { platform: 'win32', spawn: fakeSpawn });
  assert.deepEqual(calls, [['taskkill', '/pid', '4321', '/T', '/F']]);
  killTree({ pid: 4321, exitCode: 0, signalCode: null }, { platform: 'win32', spawn: fakeSpawn });
  assert.equal(calls.length, 1, 'nothing to kill once it has exited');
});

test('on Windows the robots skip the DLL check they have no helper for, and hide the browser\'s console', async () => {
  const h = harness({ stack: { platform: 'win32' } });
  await bootAll(h);
  const worker = h.latest('worker').opts.env;
  assert.equal(worker.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, '1');
  assert.equal(worker.NODE_OPTIONS, '--require="/r/stack/host/robot-preload.cjs"');
  for (const c of h.children) assert.equal(c.opts.detached, false, 'Windows gives a detached process a console window');
  const linux = harness();
  await bootAll(linux);
  assert.equal(linux.latest('worker').opts.env.NODE_OPTIONS, undefined);
  assert.equal(linux.latest('worker').opts.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, undefined, 'elsewhere a missing library is named');
});

test('the robot preload hides every child process unless told otherwise', () => {
  const { hidden, hideWindows } = require('../host/robot-preload.cjs');
  const cb = () => {};
  assert.deepEqual(hidden(['chrome.exe', ['--headless'], { stdio: 'pipe' }]), ['chrome.exe', ['--headless'], { stdio: 'pipe', windowsHide: true }]);
  assert.deepEqual(hidden(['chrome.exe', ['--headless']]), ['chrome.exe', ['--headless'], { windowsHide: true }]);
  assert.deepEqual(hidden(['chrome.exe']), ['chrome.exe', { windowsHide: true }]);
  assert.deepEqual(hidden(['dir', cb]), ['dir', { windowsHide: true }, cb]);
  assert.deepEqual(hidden(['x.exe', null, cb]), ['x.exe', null, { windowsHide: true }, cb]);
  assert.deepEqual(hidden(['x.exe', [], { windowsHide: false }]), ['x.exe', [], { windowsHide: false }], 'an explicit no stands');
  const calls = [];
  const fake = { spawn: (...a) => calls.push(a), execFile: (...a) => calls.push(a) };
  hideWindows(fake);
  fake.spawn('chrome.exe', ['--a'], { env: {} });
  fake.execFile('x.exe', cb);
  assert.deepEqual(calls, [['chrome.exe', ['--a'], { env: {}, windowsHide: true }], ['x.exe', { windowsHide: true }, cb]]);
});

test('waiting for a service that is then stopped for good ends, rather than hanging', async () => {
  const h = harness({ stack: { graceMs: 10 } });
  await bootAll(h);
  const opening = h.stack.ensure('admin');
  await tick();
  const stopping = h.stack.stop();
  h.latest('admin').exit(0);
  for (const name of ['standin', 'web', 'worker']) h.latest(name).exit(0);
  await assert.rejects(opening, /admin: stopped/);
  await stopping;
});
