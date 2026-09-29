'use strict';
/**
 * The server's desktop host (regbot/desktop_host.py in lineright-server), run
 * for real: the regbot site, control room and queue processor as practice mode
 * starts them, with the Python it would use here (that checkout's virtualenv,
 * or the machine's). What is checked is what the app relies on — the
 * announcement, the account made once and found again, the ways in with a
 * ticket, the port it asked for, and the lifeline. The server is not part of
 * this app: this skips itself without a lineright-server checkout beside this
 * one (or LINERIGHT_SERVER_DIR), or without a Python with Flask.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { locate } = require('../src/stack');

const ROOT = path.join(__dirname, '..');
const paths = locate({ packaged: false, appPath: ROOT });
const usable = Boolean(paths.regbot) && fs.existsSync(path.join(paths.regbot, 'app.py'))
  && spawnSync(paths.python, ['-I', '-c', 'import flask'], { encoding: 'utf8' }).status === 0;
const skip = usable ? false : (paths.regbot
  ? `no Python with Flask for the server (${paths.python}): make its regbot/.venv`
  : 'no lineright-server checkout beside this one (or LINERIGHT_SERVER_DIR)');

function host(service, dataDir, { env = {}, args = [] } = {}) {
  const child = spawn(paths.python, ['-I', '-B', '-u', '-X', 'utf8', path.join(paths.regbot, 'desktop_host.py'), service, '--regbot', paths.regbot, ...args], {
    env: {
      PATH: process.env.PATH, HOME: os.homedir(), SYSTEMROOT: process.env.SYSTEMROOT,
      REGBOT_DB: path.join(dataDir, 'regbot.db'), REGBOT_SECRET: 'test-secret', REGBOT_ENV_FILE: path.join(dataDir, 'none.env'),
      REGBOT_CROWD: '0', ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('REGBOT-READY '));
      if (line) resolve(JSON.parse(line.slice('REGBOT-READY '.length)));
    });
    exited.then((code) => reject(new Error(`${service} exited ${code} before it was ready:\n${err.slice(-1500)}`)));
  });
  return {
    child, ready, exited,
    async stop() { child.stdin.end(); return exited; },
    stderr: () => err,
  };
}

const web = (dataDir, token, extra = {}) => host('web', dataDir, {
  ...extra,
  env: { REGBOT_DESKTOP_TOKEN: token, REGBOT_DESKTOP_TICKET: 'ticket-1', REGBOT_DESKTOP_NAME: 'Ada Lovelace', REGBOT_DESKTOP_VERSION: '9.9.9', ...(extra.env || {}) },
});

async function sync(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/api/client/sync`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('the site makes an account for the person, signed in by the token the app gave it', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const site = web(dir, 'tok-one');
  const ready = await site.ready;
  assert.equal(ready.service, 'web');
  assert.ok(ready.port > 0);
  assert.equal(ready.created, true);
  assert.equal(ready.owner.nickname, 'Ada_Lovelace', "the login, made to fit a nickname");
  assert.equal(ready.catalogue, 'seeded');
  const { status, body } = await sync(ready.port, 'tok-one');
  assert.equal(status, 200);
  assert.equal(body.user.nickname, 'Ada_Lovelace');
  assert.equal(body.site_url, `http://127.0.0.1:${ready.port}`, 'the site knows its own address');
  assert.equal((await sync(ready.port, 'someone-else')).status, 401);

  // The ticket is a way into the website as that person, and nowhere else.
  const signin = await fetch(`http://127.0.0.1:${ready.port}/desktop/signin?ticket=ticket-1&next=/account`, { redirect: 'manual' });
  assert.equal(signin.status, 302);
  assert.equal(new URL(signin.headers.get('location'), 'http://x').pathname, '/account');
  const cookie = signin.headers.get('set-cookie').split(';')[0];
  const accountPage = await fetch(`http://127.0.0.1:${ready.port}/account`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(accountPage.status, 200);
  assert.match(await accountPage.text(), /Ada_Lovelace/);
  const bare = await fetch(`http://127.0.0.1:${ready.port}/desktop/signin?ticket=ticket-1`, { redirect: 'manual' });
  assert.equal(new URL(bare.headers.get('location'), 'http://x').pathname, '/account', 'the account page by default');
  const away = await fetch(`http://127.0.0.1:${ready.port}/desktop/signin?ticket=ticket-1&next=//evil.example/`, { redirect: 'manual' });
  assert.equal(new URL(away.headers.get('location'), 'http://x').host, 'x', 'never sent off-site');
  const wrong = await fetch(`http://127.0.0.1:${ready.port}/desktop/signin?ticket=nope`, { redirect: 'manual' });
  assert.equal(wrong.status, 403);

  const t0 = Date.now();
  assert.equal(await site.stop(), 0, 'a closed lifeline is a clean exit');
  assert.ok(Date.now() - t0 < 5000);
});

test('the account is found again: same token, a lost token, a revoked one', { skip, timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const first = web(dir, 'tok-one');
  const one = await first.ready;
  // The person removes "This computer" from the website's list of devices.
  const unpair = await fetch(`http://127.0.0.1:${one.port}/api/client/unpair`, {
    method: 'POST', headers: { authorization: 'Bearer tok-one', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unpair.status, 200);
  assert.equal((await sync(one.port, 'tok-one')).status, 401);
  await first.stop();

  const again = web(dir, 'tok-one');
  const two = await again.ready;
  assert.equal(two.created, false);
  assert.equal(two.catalogue, 'current', 'a second start adds nothing to a current catalogue');
  assert.equal(two.owner.id, one.owner.id);
  assert.equal((await sync(two.port, 'tok-one')).status, 200, 'its own server lets the app back in');
  await again.stop();

  // The credentials file went; the database did not.
  const lost = web(dir, 'tok-two');
  const three = await lost.ready;
  assert.equal(three.created, false);
  assert.equal(three.owner.id, one.owner.id, 'the same person, not a stranger with an empty wallet');
  assert.equal((await sync(three.port, 'tok-two')).status, 200);
  await lost.stop();
});

test('the site takes the port it is given when it is free, and another when it is not', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const want = await freePort();
  const first = web(dir, 'tok', { args: ['--port', String(want)] });
  assert.equal((await first.ready).port, want);
  const second = web(dir, 'tok', { args: ['--port', String(want)] });
  const got = (await second.ready).port;
  assert.notEqual(got, want);
  assert.equal((await sync(got, 'tok')).status, 200);
  await Promise.all([first.stop(), second.stop()]);
});

test('the control room opens with the ticket and not without', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const site = web(dir, 'tok');
  await site.ready;
  const admin = host('admin', dir, { env: { REGBOT_ADMIN_TOKEN: 'adm-secret', REGBOT_DESKTOP_TICKET: 'ticket-1' } });
  const { port } = await admin.ready;
  const shut = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
  assert.equal(shut.status, 302);
  assert.match(shut.headers.get('location'), /\/unlock$/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop/unlock?ticket=wrong`, { redirect: 'manual' })).status, 403);
  const open = await fetch(`http://127.0.0.1:${port}/desktop/unlock?ticket=ticket-1&next=/queue`, { redirect: 'manual' });
  assert.equal(open.status, 302);
  assert.equal(new URL(open.headers.get('location'), 'http://x').pathname, '/queue');
  const cookie = open.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, redirect: 'manual' })).status, 200);
  await Promise.all([admin.stop(), site.stop()]);
});

test('the processor announces itself and stops when the app lets go', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const site = web(dir, 'tok');
  await site.ready;
  const worker = host('worker', dir, { env: { DMV_BASE_URL: 'http://127.0.0.1:9', REGBOT_CADMV_NODE: process.execPath } });
  const ready = await worker.ready;
  assert.equal(ready.service, 'worker');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const t0 = Date.now();
  const code = await worker.stop();
  assert.equal(code, 0, worker.stderr().slice(-800));
  assert.ok(Date.now() - t0 < 12000, 'within the processor\'s own grace');
  assert.match(worker.stderr(), /worker .* up — protocol RQP\/1/);
  await site.stop();
});

test('a processor whose app died takes a robot mid-run down with it', { skip: skip || (process.platform === 'win32' && 'process groups are POSIX'), timeout: 90000 }, async () => {
  // Seeded bids on the DMV lines make the processor scout as soon as it
  // starts. The "robot" here only sleeps and says who it is, standing in for
  // a Node process driving a browser.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-host-'));
  const site = web(dir, 'tok');
  await site.ready;
  await site.stop();
  const pidFile = path.join(dir, 'robot.pid');
  const robot = path.join(dir, 'fake-node');
  fs.writeFileSync(robot, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 120\n`, { mode: 0o755 });
  const worker = spawn(paths.python, ['-I', '-B', '-u', path.join(paths.regbot, 'desktop_host.py'), 'worker', '--regbot', paths.regbot], {
    env: {
      PATH: process.env.PATH, HOME: os.homedir(), REGBOT_DB: path.join(dir, 'regbot.db'), REGBOT_SECRET: 's',
      REGBOT_ENV_FILE: path.join(dir, 'none.env'), REGBOT_CROWD: '0', REGBOT_CADMV_NODE: robot,
      DMV_BASE_URL: 'http://127.0.0.1:9',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,   // as the app starts it: the leader of its own group
  });
  const exited = new Promise((resolve) => worker.on('exit', resolve));
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(pidFile), 'the processor started a robot');
  const robotPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  process.kill(robotPid, 0);
  worker.stdin.end();   // the app is gone
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(robotPid, 0), (err) => err.code === 'ESRCH', 'the robot went too');
});
