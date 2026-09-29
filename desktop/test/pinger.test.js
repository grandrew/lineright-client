'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pinger, IDLE_MS } = require('../src/pinger');

/** A pinger on a hand-cranked clock, and a site that answers from a script. */
function world({ replies = [], paired = true } = {}) {
  const calls = { pings: [], wakes: 0, measured: [], timers: [] };
  const client = {
    paired,
    ping: async (body) => {
      calls.pings.push(body);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next || { ok: true, echo: 'e', measure: false, next_ms: 1000, wake: false };
    },
  };
  const pinger = new Pinger({
    getClient: () => client,
    onWake: () => { calls.wakes += 1; },
    onMeasured: (m) => calls.measured.push(m),
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimeout: () => {},
  });
  pinger.running = true;   // as if started; each test turns the crank itself
  return { pinger, calls, client };
}

test('asked to measure, it sends the echo straight back and keeps what the site timed', async () => {
  const { pinger, calls } = world({ replies: [
    { ok: true, echo: 'tok-1', measure: true, next_ms: 1000, wake: false, rtt_ms: null },
    { ok: true, echo: 'tok-2', measure: false, next_ms: 1000, wake: false, rtt_ms: 42 },
  ] });
  await pinger.tick();
  assert.deepEqual(calls.pings, [{}, { echo: 'tok-1' }]);
  assert.equal(calls.measured.length, 1);
  assert.equal(calls.measured[0].rtt_ms, 42);
  assert.equal(pinger.last.rtt_ms, 42);
  assert.equal(calls.timers.at(-1).ms, 1000, 'at the pace the site asked for');
});

test('not asked to measure, one ping; told a slot was released, it says so at once', async () => {
  const { pinger, calls } = world({ replies: [
    { ok: true, echo: 'tok', measure: false, next_ms: 15000, wake: true },
  ] });
  await pinger.tick();
  assert.equal(calls.pings.length, 1);
  assert.equal(calls.wakes, 1);
  assert.equal(calls.timers.at(-1).ms, 15000);
});

test('signed out it pings nothing; offline it tries again at an easy pace', async () => {
  const out = world({ paired: false });
  await out.pinger.tick();
  assert.equal(out.calls.pings.length, 0);
  assert.equal(out.calls.timers.at(-1).ms, IDLE_MS);

  const down = world({ replies: [Object.assign(new Error('fetch failed'), { status: 0 })] });
  down.pinger.everyMs = 1000;
  await down.pinger.tick();
  assert.ok(down.calls.timers.at(-1).ms >= 5000);
});

test('stopped, it schedules nothing more', async () => {
  const { pinger, calls } = world();
  pinger.running = false;
  pinger.start();
  assert.equal(calls.timers.length, 1, 'the first ping at once');
  pinger.stop();
  await pinger.tick();
  assert.equal(calls.timers.length, 1);
});

test('a slow line, for tests only: the echo waits before it goes back', async () => {
  const { pinger, calls } = world({ replies: [
    { ok: true, echo: 'tok', measure: true, next_ms: 1000 },
    { ok: true, echo: 'tok-2', rtt_ms: 900 },
  ] });
  pinger.delayMs = 900;
  const ticking = pinger.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const hold = calls.timers.find((t) => t.ms === 900);
  assert.ok(hold, 'held before answering');
  assert.equal(calls.pings.length, 1);
  hold.fn();
  await ticking;
  assert.deepEqual(calls.pings[1], { echo: 'tok' });
});
