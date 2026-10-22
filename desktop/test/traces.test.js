'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Scrubber } = require('../src/scrub');
const { TraceStore, SCHEMA, SEGMENT_BYTES } = require('../src/traces');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-traces-')), 'traces');
const scrubber = () => {
  const s = new Scrubber({ home: '/home/ada', user: '' });
  s.setProfile({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' });
  return s;
};

function store(opts = {}) {
  let now = opts.at || Date.UTC(2026, 9, 21, 12, 0, 0);
  const clock = () => now;
  const timers = [];
  const t = new TraceStore({ dir: opts.dir === undefined ? tmp() : opts.dir, scrubber: opts.scrubber || scrubber(), now: clock,
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout: () => {}, ...opts.store });
  return { t, tick: (ms) => { now += ms; }, timers };
}

test('each event is numbered, timed, named and scrubbed before it is kept', () => {
  const { t } = store();
  const e = t.add('page.load', { tab: 3, url: 'https://dmv.example/p?firstName=Ada&step=2', title: 'Welcome back, Ada Lovelace' });
  assert.deepEqual(e, { s: 1, t: Date.UTC(2026, 9, 21, 12, 0, 0), k: 'page.load', tab: 3,
    url: 'https://dmv.example/p?firstName=[redacted]&step=2', title: 'Welcome back, [first_name] [last_name]' });
  assert.equal(t.add('Not A Kind', {}), null);
  assert.equal(t.add('app.log', { s: 99, k: 'x', text: 'fields never overwrite the numbering' }).s, 2);
  assert.equal(t.status().next, 3);
});

test('what is kept outlives the app: a new start carries on the numbering from the files', () => {
  const dir = tmp();
  const a = store({ dir }).t;
  for (let i = 0; i < 5; i += 1) a.add('app.log', { text: `line ${i}` });
  a.flush();
  const b = store({ dir }).t;
  assert.equal(b.status().next, 6);
  assert.equal(b.status().stream, a.status().stream);
  assert.deepEqual(b.batch({ after: 2 }).events.map((e) => e.text), ['line 2', 'line 3', 'line 4']);
  // A crash after writing, before the state was saved: the files say how far it went.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), next: 2 }));
  fs.appendFileSync(path.join(dir, '000000000001.jsonl'), '{"s":6,"t":1,"k":"app.lo');
  const c = store({ dir }).t;
  assert.equal(c.status().next, 6, 'a line cut short is not counted');
  assert.equal(c.batch({ after: 0 }).events.length, 5);
});

test('outline leaves out the detail; off and the person\'s switch write nothing at all', () => {
  const { t } = store();
  t.setLevel('outline');
  assert.equal(t.add('net', { url: 'https://x.test/a' }), null);
  assert.equal(t.add('page.console', { text: 'warn' }), null);
  assert.ok(t.add('page.load', { url: 'https://x.test/a' }));
  t.setLevel('off');
  assert.equal(t.add('page.load', {}), null);
  t.setLevel('nonsense');
  assert.equal(t.level(), 'off', 'only the levels it knows');
  t.setLevel('full');
  assert.ok(t.add('net', {}));
  t.add('app.log', { text: 'kept' });
  t.flush();
  assert.equal(t.view().kept, 3);
  t.setOn(false);
  assert.equal(t.view().kept, 0, 'off deletes what was kept');
  assert.equal(t.add('app.log', { text: 'not kept' }), null);
  assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.endsWith('.jsonl')), []);
  const stream = t.status().stream;
  t.setOn(true);
  assert.notEqual(t.status().stream, stream, 'back on, a new history');
  assert.equal(t.add('app.log', { text: 'again' }).s, 1);
});

test('a batch is what comes after the site\'s mark, as much as it asked for, and says if there is more', () => {
  const { t } = store();
  for (let i = 0; i < 50; i += 1) t.add('app.log', { text: `line ${i}` });
  const first = t.batch({ after: 0, maxEvents: 20 });
  assert.equal(first.events.length, 20);
  assert.deepEqual([first.first, first.last, first.more, first.gap], [1, 20, true, null]);
  const second = t.batch({ after: 20, maxBytes: 600 });
  assert.ok(second.events.length > 0 && second.events.length < 30);
  assert.ok(second.bytes <= 600);
  assert.equal(second.first, 21);
  const rest = t.batch({ after: 40 });
  assert.deepEqual([rest.first, rest.last, rest.more], [41, 50, false]);
  assert.deepEqual(t.batch({ after: 50 }).events, []);
});

test('what the site has is deleted, a file at a time, and numbering carries on', () => {
  const { t } = store({ store: { perMinute: 1e9 } });
  const big = 'x'.repeat(400);
  let n = 0;
  while (t.bytes() < SEGMENT_BYTES * 2.5) { t.add('app.log', { text: big, i: n }); n += 1; t.flush(); }
  const files = () => fs.readdirSync(t.dir).filter((f) => f.endsWith('.jsonl')).sort();
  assert.ok(files().length >= 3, 'a megabyte a file');
  const firstFile = files()[0];
  const lastOfFirst = Number(files()[1].slice(0, 12)) - 1;
  assert.equal(t.ack(lastOfFirst - 1), true);
  assert.ok(files().includes(firstFile), 'a file is kept until all of it is acknowledged');
  t.ack(lastOfFirst);
  assert.ok(!files().includes(firstFile));
  assert.equal(t.status().acked, lastOfFirst);
  assert.equal(t.ack(lastOfFirst), false, 'the same mark again changes nothing');
  t.ack(10 ** 9);
  assert.equal(t.status().acked, n, 'a mark past what was written is what was written');
  assert.deepEqual(files(), []);
  assert.equal(t.add('app.log', { text: 'next' }).s, n + 1);
});

test('the old and the too much go, unsent ones counted, and the site sees the gap', () => {
  const { t, tick } = store({ store: { maxBytes: 3 * 1024 * 1024, perMinute: 1e9 } });
  const big = 'y'.repeat(500);
  for (let i = 0; i < 2000; i += 1) t.add('app.log', { text: big });
  t.flush();
  tick(8 * 24 * 3600 * 1000);
  for (let i = 0; i < 10; i += 1) t.add('app.log', { text: 'fresh' });
  t.flush();
  t.prune();
  // A file at a time: the one still being written to is not old.
  const got = t.batch({ after: 0 });
  assert.ok(t.status().lost > 1000, 'a week old and never asked for');
  assert.deepEqual(got.gap, { from: 1, to: t.status().lost });
  assert.equal(got.first, t.status().lost + 1);
  assert.deepEqual(got.events.slice(-10).map((e) => e.text), Array(10).fill('fresh'));
  // Too much, even when new: the oldest go until it fits.
  const small = store({ store: { maxBytes: 2 * 1024 * 1024, perMinute: 1e9 } }).t;
  for (let i = 0; i < 9000; i += 1) small.add('app.log', { text: big });
  small.flush();
  assert.ok(small.bytes() <= 2 * 1024 * 1024, `${small.bytes()} bytes`);
  assert.ok(small.status().lost > 0);
});

test('no more than so many events a minute; what is past it is counted and said', () => {
  const { t, tick } = store({ store: { perMinute: 5 } });
  for (let i = 0; i < 9; i += 1) t.add(i % 2 ? 'net' : 'page.console', { i });
  tick(60 * 1000);
  t.add('app.log', { text: 'next minute' });
  const kinds = t.batch({ after: 0 }).events.map((e) => [e.k, e.n, e.kinds]);
  assert.deepEqual(kinds.slice(-2), [['trace.dropped', 4, { net: 2, 'page.console': 2 }], ['app.log', undefined, undefined]]);
});

test('an event is scrubbed again as it goes, with what the scrubber has learnt since', () => {
  const s = scrubber();
  const { t } = store({ scrubber: s });
  t.add('page.at', { url: 'https://dmv.example/confirmation/TS-9F3K2' });
  s.learn('confirmation', 'TS-9F3K2');
  t.add('app.log', { text: 'booked — confirmation TS-9F3K2' });
  const events = t.batch({ after: 0 }).events;
  assert.equal(events[0].url, 'https://dmv.example/confirmation/[confirmation]');
  assert.equal(events[1].text, 'booked — confirmation [confirmation]');
  assert.ok(!JSON.stringify(t.recent(10)).includes('TS-9F3K2'));
});

test('an upload answers an ask: gzipped, saying which history and how far, and only what was asked', () => {
  const { t } = store();
  for (let i = 0; i < 30; i += 1) t.add(i === 3 ? 'handoff.arrive' : 'app.log', { text: `line ${i} for ada@example.com` });
  assert.equal(t.status().urgent, true, 'a turn is something the site wants soon');
  const up = t.upload({ id: 'ask-1', after: 10, max_events: 15, max_kb: 512 }, { version: '0.3.6' });
  const body = JSON.parse(zlib.gunzipSync(up.gzip).toString('utf8'));
  assert.equal(body.schema, SCHEMA);
  assert.deepEqual([body.ask, body.after, body.first, body.last, body.more, body.next], ['ask-1', 10, 11, 25, true, 31]);
  assert.equal(body.stream, t.status().stream);
  assert.deepEqual(body.app, { version: '0.3.6' });
  assert.equal(body.events.length, 15);
  assert.ok(!up.json.toString().includes('ada@example.com'));
  assert.equal(up.events, 15);
  t.noteUpload({ ok: true, events: 15, bytes: up.gzip.length });
  assert.equal(t.status().urgent, false);
  assert.equal(t.view().uploads[0].events, 15);
});

test('the site\'s levels are kept across starts; a full reset is a first start', () => {
  const dir = tmp();
  const a = store({ dir }).t;
  a.setLevel('outline');
  a.newSession();
  a.flush();
  const b = store({ dir }).t;
  assert.equal(b.level(), 'outline');
  assert.equal(b.newSession(), 2);
  b.reset();
  assert.deepEqual([b.level(), b.state.on, b.state.session, b.status().next], ['full', true, 0, 1]);
});

test('without a folder it keeps what it has in memory, for a test or a moment', () => {
  const { t } = store({ dir: null });
  t.add('app.log', { text: 'one' });
  t.add('app.log', { text: 'two' });
  assert.deepEqual(t.batch({ after: 0 }).events.map((e) => e.text), ['one', 'two']);
  t.ack(1);
  assert.deepEqual(t.batch({ after: 1 }).events.map((e) => e.text), ['two']);
});
