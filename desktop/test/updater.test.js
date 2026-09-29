'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { wire } = require('../src/updater');

function fakeUpdater({ fail = false } = {}) {
  const u = new EventEmitter();
  u.feed = null;
  u.checks = 0;
  u.installed = 0;
  u.setFeedURL = (feed) => { u.feed = feed; };
  u.checkForUpdates = async () => {
    u.checks += 1;
    if (!fail) return 'checked';
    // electron-updater emits 'error' and then rejects with the same object.
    const err = fail instanceof Error ? fail : new Error('feed 404');
    u.emit('error', err);
    throw err;
  };
  u.quitAndInstall = () => { u.installed += 1; };
  return u;
}

function timers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeout = (fn, ms) => { t.timeouts.push({ fn, ms }); return t.timeouts.length; };
  t.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return t.intervals.length; };
  t.clearInterval = () => { t.intervals.length = 0; };
  return t;
}

test('an unpackaged run leaves updates off and says so', async () => {
  const u = fakeUpdater();
  const states = [];
  const w = wire(u, { isPackaged: false, onState: (s) => states.push(s), ...timers() });
  assert.equal(w.enabled, false);
  assert.equal(states[0].phase, 'disabled');
  assert.equal(await w.check(), null);
  assert.equal(u.checks, 0);
  assert.equal(w.install(), false);
});

test('a packaged build checks after a delay, then periodically, on the embedded feed', () => {
  const u = fakeUpdater();
  const t = timers();
  const states = [];
  const w = wire(u, { isPackaged: true, onState: (s) => states.push(s), ...t, firstDelayMs: 100, everyMs: 5000 });
  assert.equal(w.enabled, true);
  assert.equal(u.feed, null, 'no generic feed: the build decides');
  assert.equal(states[0].phase, 'idle');
  assert.equal(states[0].feed, 'embedded');
  assert.equal(t.timeouts[0].ms, 100);
  assert.equal(t.intervals[0].ms, 5000);
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true);
});

test('a feed URL from settings switches the updater to a generic server', () => {
  const u = fakeUpdater();
  wire(u, { isPackaged: false, force: true, feedUrl: 'http://127.0.0.1:8788', ...timers() });
  assert.deepEqual(u.feed, { provider: 'generic', url: 'http://127.0.0.1:8788' });
});

test('updater events become chrome states, and ready installs on request', () => {
  const u = fakeUpdater();
  const states = [];
  const w = wire(u, { isPackaged: true, onState: (s) => states.push(s), ...timers() });
  u.emit('checking-for-update');
  u.emit('update-available', { version: '0.2.0' });
  u.emit('download-progress', { percent: 41.6 });
  u.emit('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(states.slice(1), [
    { phase: 'checking' },
    { phase: 'available', version: '0.2.0' },
    { phase: 'downloading', percent: 42 },
    { phase: 'ready', version: '0.2.0' },
  ]);
  assert.equal(w.install(), true);
  assert.equal(u.installed, 1);
  u.emit('update-not-available', { version: '0.1.0' });
  assert.deepEqual(states.at(-1), { phase: 'none', version: '0.1.0' });
  u.emit('error', new Error('boom'));
  assert.deepEqual(states.at(-1), { phase: 'error', message: 'boom' });
});

test('a failing check is reported, not thrown', async () => {
  const u = fakeUpdater({ fail: true });
  const states = [];
  const logs = [];
  const w = wire(u, { isPackaged: true, onState: (s) => states.push(s), log: (l) => logs.push(l), ...timers() });
  assert.equal(await w.check(), null);
  assert.equal(states.at(-1).phase, 'error');
  assert.match(logs[0], /feed 404/);
});

test('a 404 from the feed means nothing is published yet: said once, not as a fault', async () => {
  const err = Object.assign(
    new Error('404\n"method: GET url: https://github.com/x/y/releases.atom"\nHeaders: { "set-cookie": [] }'),
    { statusCode: 404 });
  const u = fakeUpdater({ fail: err });
  const states = [];
  const logs = [];
  const w = wire(u, { isPackaged: true, onState: (s) => states.push(s), log: (l) => logs.push(l), ...timers() });
  assert.equal(await w.check(), null);
  assert.equal(states.at(-1).phase, 'none');
  assert.match(states.at(-1).message, /no release published yet/);
  assert.equal(logs.length, 1, 'the error event and the rejection are one failure');
  assert.doesNotMatch(logs[0], /Headers|set-cookie/);
  // The next check starts clean, so a repeat of the same answer is said again.
  assert.equal(await w.check(), null);
  assert.equal(logs.length, 2);
});

test('any other feed failure is shown by its first line only', async () => {
  const u = fakeUpdater({ fail: new Error('connect ECONNREFUSED 127.0.0.1:8788\nHeaders: {}') });
  const states = [];
  const logs = [];
  const w = wire(u, { isPackaged: true, onState: (s) => states.push(s), log: (l) => logs.push(l), ...timers() });
  assert.equal(await w.check(), null);
  assert.deepEqual(states.at(-1), { phase: 'error', message: 'connect ECONNREFUSED 127.0.0.1:8788' });
  assert.deepEqual(logs, ['update error: connect ECONNREFUSED 127.0.0.1:8788']);
});
