'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Telemetry, SCHEMA, quantile } = require('../src/telemetry');

const START = 1_800_000_000_000;      // a minute boundary, in ms

/** A collector on a hand-cranked clock. */
function world(opts = {}) {
  const clock = { t: START };
  const tm = new Telemetry({ now: () => clock.t, app: { version: '0.2.0', platform: 'linux', arch: 'x64', electron: '38.1.0', packaged: true }, ...opts });
  const tick = (ms) => { clock.t += ms; };
  return { tm, clock, tick };
}

test('each conversation with the site lands in its minute, syncs apart from the rest', () => {
  const { tm, tick } = world();
  tm.request({ path: '/api/client/sync', ms: 40, status: 200 });
  tm.request({ path: '/api/client/ping', ms: 10, status: 200 });
  tick(61000);
  tm.request({ path: '/api/client/sync', ms: 80, status: 200 });
  tm.request({ path: '/api/client/sync', ms: 5, status: 0 });
  assert.equal(tm.minutes.length, 2);
  assert.deepEqual([tm.minutes[0].syncs, tm.minutes[0].api_calls], [1, 2]);
  assert.deepEqual([tm.minutes[1].syncs, tm.minutes[1].sync_errors, tm.minutes[1].offline], [2, 1, 1]);
  const s = tm.summary();
  assert.equal(s.syncs, 3);
  assert.equal(s.sync_errors, 1);
  assert.equal(s.sync_ms_p50, 40);
});

test('a run of failures is one event where it starts and one where it ends', () => {
  const { tm, tick } = world();
  for (let i = 0; i < 10; i += 1) { tm.request({ path: '/api/client/sync', ms: 3, status: 0 }); tick(4000); }
  tm.request({ path: '/api/client/sync', ms: 30, status: 200 });
  assert.deepEqual(tm.events.map((e) => e.kind), ['offline', 'online']);
  assert.equal(tm.events[1].ms, 40000, 'how long it was away');
});

test('reads, robots, bookings and round trips are counted and summarised', () => {
  const { tm } = world();
  tm.rtt(40); tm.rtt(60);
  tm.read({ status: 'done', ms: 120000, offices: 4, found: 2 });
  tm.read({ status: 'blocked', ms: 30000, offices: 4, found: 0 });
  tm.robot({ kind: 'scout', ms: 118000, status: 'found' });
  tm.robot({ kind: 'book', ms: 20000, status: 'unavailable' });
  tm.booking({ kind: 'booked', ms: 25000 });
  const s = tm.summary();
  assert.deepEqual([s.reads, s.reads_done, s.reads_blocked, s.openings_found], [2, 1, 1, 2]);
  assert.deepEqual([s.robot_runs, s.robot_failures, s.bookings, s.bookings_booked], [2, 1, 1, 1]);
  assert.equal(s.rtt_ms_p50, 50);
  assert.deepEqual(tm.events.map((e) => `${e.kind}:${e.status || e.robot}`), ['read:done', 'read:blocked', 'robot:found', 'robot:unavailable', 'booking:booked']);
});

test('memory and CPU are summed across every process the app runs', () => {
  const { tm } = world();
  tm.processes([{ memory: { workingSetSize: 204800 }, cpu: { percentCPUUsage: 1.25 } },
    { memory: { workingSetSize: 102400 }, cpu: { percentCPUUsage: 0.5 } }], { heapUsed: 52428800 });
  assert.deepEqual([tm.minutes[0].memory_mb, tm.minutes[0].cpu_pct, tm.minutes[0].heap_mb], [300, 1.8, 50]);
});

test('a snapshot has a value per point, zero for counts and a gap where nothing was measured', () => {
  const { tm, tick } = world();
  tm.request({ path: '/api/client/sync', ms: 40, status: 200 });
  tick(5 * 60000);
  tm.rtt(33);
  const snap = tm.snapshot('1h');
  assert.equal(snap.points.length, 60);
  for (const values of Object.values(snap.series)) assert.equal(values.length, 60);
  assert.equal(snap.series.syncs.reduce((a, b) => a + b, 0), 1);
  assert.equal(snap.series.rtt_ms.filter((v) => v !== null).length, 1);
  assert.equal(snap.series.memory_mb.every((v) => v === null), true);
});

test('what would be shared is numbers and known words, inside the period it names', () => {
  const { tm, tick } = world();
  for (let i = 0; i < 90; i += 1) {
    tm.request({ path: '/api/client/sync', ms: 30 + i, status: 200 });
    if (i % 9 === 0) tm.rtt(40);
    tick(60000);
  }
  tm.read({ status: 'done', ms: 100000, offices: 3, found: 1 });
  tm.event('read', { status: 'Poway, 12 High St', ms: 5 });
  const body = tm.payload({ mode: 'public' });
  assert.equal(body.schema, SCHEMA);
  assert.match(body.upload_id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(body.period.from % 300, 0, 'from the start of a five-minute point');
  assert.ok(body.period.to >= body.period.from);
  for (const [key, points] of Object.entries(body.series)) {
    assert.match(key, /^[a-z][a-z0-9_]{0,39}$/);
    for (const [t, v] of points) {
      assert.ok(t >= body.period.from && t <= body.period.to, `${key} ${t}`);
      assert.ok(v === null || Number.isFinite(v));
    }
  }
  for (const [key, value] of Object.entries(body.summary)) {
    assert.match(key, /^[a-z][a-z0-9_]{0,39}$/);
    assert.ok(Number.isFinite(value), key);
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /poway|high.st/i, 'a word that is not a word is dropped, not tidied up and sent');
  assert.equal(body.app.version, '0.2.0');
  assert.equal(body.app.mode, 'public');
  assert.ok(text.length < 256 * 1024);
});

test('a share reaches back to the last one, and a day at most', () => {
  const { tm, tick } = world();
  tm.request({ path: '/api/client/sync', ms: 30, status: 200 });
  tick(3 * 3600 * 1000);
  const first = tm.payload();
  tm.noteShare({ ok: true, id: 7, period: first.period });
  tick(600000);
  const second = tm.payload();
  assert.ok(second.period.from >= first.period.to - 300, 'it starts where the last share ended');
  assert.equal(tm.lastShare().id, 7);
  tm.noteShare({ ok: false, message: 'Shared recently enough — try again later.' });
  assert.equal(tm.lastShare().id, 7, 'a refused share is not the last share');
  assert.equal(tm.shares.length, 2);
});

test('a share sent again before it was answered is the same upload', () => {
  const { tm, tick } = world();
  tm.request({ path: '/api/client/sync', ms: 30, status: 200 });
  tick(3 * 3600 * 1000);
  const first = tm.payload();
  // The reply never came back: nothing noted, and the next try covers the same period.
  tick(120000);
  const again = tm.payload();
  assert.equal(again.upload_id, first.upload_id, 'the site keeps it once');
  tm.noteShare({ ok: true, id: 8, period: again.period });
  tick(600000);
  assert.notEqual(tm.payload().upload_id, first.upload_id, 'the next period is a new upload');
  const before = tm.installId;
  tm.clear();
  assert.notEqual(tm.installId, before, 'a cleared history is not tied to the uploads before it');
});

test('a day is kept, and it is kept across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-telemetry-'));
  const file = path.join(dir, 'telemetry.json');
  const { tm, tick, clock } = world({ file });
  for (let i = 0; i < 30; i += 1) { tm.request({ path: '/api/client/sync', ms: 20, status: 200 }); tick(60000 * 60); }
  tm.prune();
  assert.ok(tm.minutes.length <= 24 * 60);
  assert.ok(tm.minutes[0].t >= Math.floor(clock.t / 1000) - 24 * 3600, 'older than a day is gone');
  tm.event('start');
  tm.save();
  // Readable by this user only — where the file system has such modes; Windows has none.
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new Telemetry({ file, now: () => clock.t });
  assert.equal(again.minutes.length, tm.minutes.length);
  assert.equal(again.events.length, tm.events.length);
  assert.equal(again.installId, tm.installId, 'its uploads keep their names across a restart');
  again.clear();
  assert.equal(new Telemetry({ file, now: () => clock.t }).minutes.length, 0);
});

test('a percentile is interpolated like the site interpolates it', () => {
  assert.equal(quantile([], 50), null);
  assert.equal(quantile([10, 20, 30, 40], 50), 25);
  assert.equal(quantile([5], 95), 5);
});

test('the charts are the same file the site draws with', (t) => {
  // The site is lineright-server's: compared when a checkout of it is beside this one.
  const server = require('../src/stack').findServer({ appPath: path.join(__dirname, '..') });
  if (!server) return t.skip('no lineright-server checkout beside this one (or LINERIGHT_SERVER_DIR)');
  const site = path.join(server, 'regbot', 'static');
  for (const [ours, theirs] of [['ui/charts.js', 'js/charts.js'], ['ui/charts.css', 'css/charts.css']]) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', ours), 'utf8'),
      fs.readFileSync(path.join(site, theirs), 'utf8'), `${ours} has drifted from lineright-server's regbot/static/${theirs}`);
  }
});
