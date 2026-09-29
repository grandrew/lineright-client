'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const afterPack = require('../scripts/linux-launcher');
const { install, ELECTRON } = afterPack;

const quiet = { log: () => {} };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-launcher-'));
const posix = process.platform !== 'win32';

/** A packed directory whose "Electron" is a script that prints its pid and arguments. */
function packed() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'regbot-desktop'), Buffer.from('\x7fELF-not-really', 'latin1'), { mode: 0o755 });
  return dir;
}

function withFakeElectron(dir) {
  fs.writeFileSync(path.join(dir, ELECTRON), '#!/bin/sh\necho "pid $$"\nfor a in "$@"; do echo "arg $a"; done\n', { mode: 0o755 });
}

/** Run the launcher with an `unshare` that succeeds or fails, as a user namespace would. */
function run(exe, { userns, env = {}, args = [] }) {
  const bin = tmpdir();
  fs.writeFileSync(path.join(bin, 'unshare'), `#!/bin/sh\nexit ${userns ? 0 : 1}\n`, { mode: 0o755 });
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  return { pid: r.pid, ranAs: Number(lines[0].slice(4)), args: lines.slice(1).map((l) => l.slice(4)) };
}

test('the packed Electron moves aside and the executable becomes the launcher', () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  assert.equal(fs.readFileSync(path.join(dir, ELECTRON), 'latin1'), '\x7fELF-not-really');
  const launcher = fs.readFileSync(path.join(dir, 'regbot-desktop'), 'utf8');
  assert.match(launcher, /^#!\/bin\/sh\n# regbot linux launcher/);
  if (posix) assert.equal(fs.statSync(path.join(dir, 'regbot-desktop')).mode & 0o777, 0o755);
});

test('running it twice leaves Electron where it is', () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  install(dir, 'regbot-desktop', quiet);
  assert.equal(fs.readFileSync(path.join(dir, ELECTRON), 'latin1'), '\x7fELF-not-really');
});

test('anything else in the executable\'s place is refused, not overwritten', () => {
  const script = packed();
  fs.writeFileSync(path.join(script, 'regbot-desktop'), '#!/bin/sh\necho somebody else\n');
  assert.throws(() => install(script, 'regbot-desktop', quiet), /a script, but not this launcher/);
  const junk = packed();
  fs.writeFileSync(path.join(junk, 'regbot-desktop'), 'MZ');
  assert.throws(() => install(junk, 'regbot-desktop', quiet), /neither Electron nor the launcher/);
  const orphan = packed();
  install(orphan, 'regbot-desktop', quiet);
  fs.unlinkSync(path.join(orphan, ELECTRON));
  assert.throws(() => install(orphan, 'regbot-desktop', quiet), /missing/);
});

test('only Linux packs get it', async () => {
  const dir = packed();
  for (const electronPlatformName of ['win32', 'darwin']) {
    await afterPack({ electronPlatformName, appOutDir: dir, packager: { executableName: 'regbot-desktop' } });
  }
  assert.equal(fs.existsSync(path.join(dir, ELECTRON)), false);
});

test('with a user namespace to be had, the app starts sandboxed, as the same process', { skip: !posix && 'POSIX shell' }, () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  withFakeElectron(dir);
  const r = run(path.join(dir, 'regbot-desktop'), { userns: true, args: ['--smoke', 'two words'] });
  assert.deepEqual(r.args, ['--smoke', 'two words']);
  assert.equal(r.ranAs, r.pid);
});

test('without one, it starts with --no-sandbox rather than aborting', { skip: !posix && 'POSIX shell' }, () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  withFakeElectron(dir);
  const r = run(path.join(dir, 'regbot-desktop'), { userns: false, args: ['--user-data=/x y'] });
  assert.deepEqual(r.args, ['--no-sandbox', '--user-data=/x y']);
});

test('a setuid helper counts only when root owns it, and never in an AppImage', { skip: !posix && 'POSIX shell' }, () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  withFakeElectron(dir);
  const helper = path.join(dir, 'chrome-sandbox');
  fs.writeFileSync(helper, '');
  fs.chmodSync(helper, 0o4755);   // setuid, but ours: Chromium rejects it
  assert.deepEqual(run(path.join(dir, 'regbot-desktop'), { userns: false }).args, ['--no-sandbox']);
  assert.deepEqual(run(path.join(dir, 'regbot-desktop'), { userns: false, env: { APPIMAGE: '/a.AppImage' } }).args, ['--no-sandbox']);
});

test('started through a link, as /usr/bin/regbot-desktop is, it finds Electron beside itself', { skip: !posix && 'POSIX shell' }, () => {
  const dir = packed();
  install(dir, 'regbot-desktop', quiet);
  withFakeElectron(dir);
  const link = path.join(tmpdir(), 'regbot-desktop');
  fs.symlinkSync(path.join(dir, 'regbot-desktop'), link);
  assert.deepEqual(run(link, { userns: true, args: ['x'] }).args, ['x']);
});
