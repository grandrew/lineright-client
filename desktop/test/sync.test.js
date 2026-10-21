'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncClient, SyncLoop, SyncError, NotPaired, diffHandoffs, describeHandoff, clock, backoffMs,
  ANSWER_TIMEOUT_MS } = require('../src/sync');

/** A fetch that answers from a route table and remembers what it was asked. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, init, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const route = routes[path];
    if (!route) return { status: 404, ok: false, json: async () => ({ error: 'no such route' }) };
    const res = typeof route === 'function' ? route(calls[calls.length - 1]) : route;
    const status = res.status || 200;
    return { status, ok: status < 400, json: async () => res.body };
  };
  fetch.calls = calls;
  return fetch;
}

const doc = (extra = {}) => ({ protocol: 'RQP/1', poll_after_ms: 4000, positions: [], handoffs: [], ...extra });

test('pairing posts the device description through the cookie fetch and keeps the token', async () => {
  const cookie = fakeFetch({ '/api/client/pair': { body: { ok: true, token: 'tok-1', user: { id: 1, nickname: 'ada' } } } });
  const client = new SyncClient({ serverUrl: 'http://srv/', fetch: fakeFetch({}), app: { name: 'box', version: '0.1.0', platform: 'linux' } });
  assert.equal(client.paired, false);
  const reply = await client.pair(cookie);
  assert.equal(reply.user.nickname, 'ada');
  assert.equal(client.token, 'tok-1');
  assert.equal(client.serverUrl, 'http://srv', 'trailing slash dropped');
  assert.deepEqual(cookie.calls[0].body, { name: 'box', platform: 'linux', app_version: '0.1.0' });
  assert.equal(cookie.calls[0].headers.authorization, undefined, 'pairing carries no token');
});

test('pairing while nobody is signed in is "not paired", not a failure', async () => {
  const cookie = fakeFetch({ '/api/client/pair': { status: 401, body: { error: 'Sign in on this site first, then pair.' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', fetch: fakeFetch({}), app: { name: 'box', version: '0.1.0', platform: 'linux' } });
  await assert.rejects(client.pair(cookie), (err) => err instanceof NotPaired && /Sign in/.test(err.message));
  assert.equal(client.paired, false);
  // Any other refusal is still a failure worth showing.
  const broken = fakeFetch({ '/api/client/pair': { status: 500, body: { error: 'database locked' } } });
  await assert.rejects(client.pair(broken), (err) => err instanceof SyncError && !(err instanceof NotPaired));
});

test('sync sends the bearer token and the version, and returns the document', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { body: doc({ positions: [{ rank: 2 }] }) } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch, app: { version: '9.9' } });
  const reply = await client.sync();
  assert.equal(reply.positions[0].rank, 2);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(fetch.calls[0].body, { app_version: '9.9' });
});

test('a 401 forgets the token and says so as NotPaired', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { status: 401, body: { error: 'revoked' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  await assert.rejects(client.sync(), (err) => err instanceof NotPaired && err.message === 'revoked');
  assert.equal(client.token, null);
  await assert.rejects(client.sync(), NotPaired, 'and no request is made without one');
  assert.equal(fetch.calls.length, 1);
});

test('server errors carry the server message and status', async () => {
  const fetch = fakeFetch({ '/api/client/found': { status: 429, body: { error: 'Too many reports' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  await assert.rejects(client.found({ queue_id: 1 }), (err) => err instanceof SyncError && err.status === 429 && err.message === 'Too many reports');
});

test('a server that cannot be reached is a SyncError with status 0', async () => {
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(client.sync(), (err) => err instanceof SyncError && err.status === 0 && /ECONNREFUSED/.test(err.message));
});

test('applying a suggestion posts that suggestion\'s key and no other change', async () => {
  const fetch = fakeFetch({ '/api/client/bids/2/advice': { body: { ok: true, message: 'The range is now 15 miles.' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  const reply = await client.applyAdvice(2, '2:radius:15');
  assert.equal(reply.message, 'The range is now 15 miles.');
  assert.equal(fetch.calls[0].path, '/api/client/bids/2/advice');
  assert.deepEqual(fetch.calls[0].body, { key: '2:radius:15' });
});

test('a quote and a change of a bid go to the bid\'s routes with what was asked', async () => {
  const fetch = fakeFetch({
    '/api/client/bids/5/quote': { body: { kind: 'client.quote', suggested: { kind: 'refund', amount: 71 } } },
    '/api/client/bids/5/change': { body: { ok: true, amount: 71, delta: -89 } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.equal((await client.quoteBid('5')).suggested.amount, 71);
  assert.deepEqual(fetch.calls[0].body, {}, 'as it is');
  await client.quoteBid(5, { fields: { radius_miles: 15 } });
  assert.deepEqual(fetch.calls[1].body, { fields: { radius_miles: 15 } });
  const done = await client.changeBid(5, { amount: 71, expect_amount: 160 });
  assert.equal(done.delta, -89);
  assert.equal(fetch.calls[2].path, '/api/client/bids/5/change');
  assert.deepEqual(fetch.calls[2].body, { amount: 71, expect_amount: 160 });
  assert.equal(fetch.calls[2].init.method, 'POST');
});

test('the hand-off answers and reports go to the right routes', async () => {
  const fetch = fakeFetch({
    '/api/client/handoffs/7/booked': { body: { ok: true } },
    '/api/client/handoffs/7/pass': { body: { ok: true } },
    '/api/client/found': { body: { ok: true, verdict: 'passed' } },
    '/api/client/places/ca-dmv': { body: { places: [{ code: 'A' }] } },
    '/api/client/unpair': { body: { ok: true } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  await client.booked(7, 'REF');
  assert.deepEqual(fetch.calls[0].body, { confirmation: 'REF' });
  await client.pass('7', 'busy');
  assert.deepEqual(fetch.calls[1].body, { reason: 'busy' });
  assert.equal((await client.found({ queue_id: 1 })).verdict, 'passed');
  assert.deepEqual(await client.places('ca-dmv'), [{ code: 'A' }]);
  assert.equal(fetch.calls[3].init.method, 'GET');
  await client.unpair();
  assert.equal(client.token, null);
});

test('a sync carries what the loop is told to say, asked afresh each time', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { body: doc({ poll_after_ms: 1000 }) } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch, app: { version: '0.2.0' } });
  let reading = null;
  const loop = new SyncLoop(client, { body: () => ({ reader: { enabled: true, robots: ['dmq-rqp/1'], reading } }),
    setTimeout: () => 0, clearTimeout: () => {} });
  loop.running = true;
  await loop.tick();
  reading = 7;
  await loop.tick();
  assert.deepEqual(fetch.calls.map((c) => c.body.reader.reading), [null, 7]);
  assert.equal(fetch.calls[0].body.app_version, '0.2.0');
});

test('answering a read waits longer than a sync', async () => {
  const seen = [];
  const original = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { seen.push(ms); return original(fn, ms, ...rest); };
  try {
    const fetch = fakeFetch({
      '/api/client/sync': { body: doc() },
      '/api/client/reads/5': { body: { ok: true, status: 'done' } },
    });
    const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch, timeoutMs: 10000 });
    await client.sync();
    await client.answerRead(5, { offers: [] });
    assert.deepEqual(seen, [10000, ANSWER_TIMEOUT_MS]);
  } finally {
    global.setTimeout = original;
  }
});

test('a read is answered, and a hand-off claimed or reported gone, by id', async () => {
  const fetch = fakeFetch({
    '/api/client/reads/5': { body: { ok: true, status: 'done' } },
    '/api/client/handoffs/9/claim': { body: { ok: true, claimed: true } },
    '/api/client/handoffs/9/gone': { body: { ok: true } },
    '/api/client/reads/5/release': { body: { ok: true, released: true } },
    '/api/client/ping': { body: { ok: true, echo: 'e', measure: false, next_ms: 1000, wake: false } },
    '/api/client/handoffs/9/booked': { body: { ok: true } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.equal((await client.answerRead(5, { kind: 'discovery.result', offers: [] })).status, 'done');
  assert.deepEqual(fetch.calls[0].body, { kind: 'discovery.result', offers: [] });
  assert.equal((await client.claim(9)).claimed, true);
  await client.gone(9, 'no longer listed');
  assert.deepEqual(fetch.calls[2].body, { reason: 'no longer listed' });
  assert.equal((await client.releaseRead(5)).released, true);
  assert.equal((await client.ping({ echo: 'x' })).next_ms, 1000);
  assert.deepEqual(fetch.calls.at(-1).body, { echo: 'x' });
  await client.booked(9, 'TS-1', { robot: true });
  assert.deepEqual(fetch.calls.at(-1).body, { confirmation: 'TS-1', robot: true });
  await client.booked(9, 'TS-2');
  assert.deepEqual(fetch.calls.at(-1).body, { confirmation: 'TS-2' }, 'by hand, it says nothing of a robot');
  assert.ok(fetch.calls.every((c) => c.init.method === 'POST' && c.headers.authorization === 'Bearer tok'));
});

test('a new nickname is sent as typed, and a refusal carries the site\'s reason', async () => {
  const fetch = fakeFetch({ '/api/client/account/nickname': (call) => (call.body.nickname === 'taken'
    ? { status: 400, body: { error: 'That nickname is taken.', rule: '3 to 24 letters' } }
    : { body: { ok: true, user: { id: 3, nickname: call.body.nickname } } }) });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.deepEqual(await client.setNickname('night_owl'), { ok: true, user: { id: 3, nickname: 'night_owl' } });
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer tok');
  await assert.rejects(client.setNickname('taken'), (err) => err.status === 400 && err.message === 'That nickname is taken.');
});

test('another device of the account is unpaired by id, and this one stays signed in', async () => {
  const fetch = fakeFetch({ '/api/client/devices/7/revoke': { body: { ok: true } } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.deepEqual(await client.revokeDevice('7'), { ok: true });
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer tok');
  assert.equal(client.token, 'tok');
});

test('unpair forgets the token even when the server does not answer', async () => {
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch: async () => { throw new Error('down'); } });
  await assert.rejects(client.unpair());
  assert.equal(client.token, null);
});

test('diffHandoffs finds what arrived and what went, by job id', () => {
  const before = [{ job_id: 1 }, { job_id: 2 }];
  const after = [{ job_id: 2, phase: 'booked' }, { job_id: 3 }];
  const d = diffHandoffs(before, after);
  assert.deepEqual(d.arrived.map((h) => h.job_id), [3]);
  assert.deepEqual(d.gone.map((h) => h.job_id), [1]);
  assert.deepEqual(d.kept.map((h) => h.job_id), [2]);
  assert.deepEqual(diffHandoffs(undefined, undefined), { arrived: [], gone: [], kept: [] });
});

test('describeHandoff and clock read well', () => {
  assert.equal(describeHandoff({ queue_name: 'REAL ID', slot: { office_name: 'Poway', date: '2026-10-06', time: '10:00' } }),
    'REAL ID — Poway, 2026-10-06 at 10:00');
  assert.equal(describeHandoff({ queue_name: 'Road test', slot: null }), 'Road test — you reached the front of Road test');
  assert.equal(clock(272), '4:32');
  assert.equal(clock(-3), '0:00');
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(3), 8000);
  assert.equal(backoffMs(40), 60000);
});

// ------------------------------------------------------------------- loop
function fakeTimers() {
  const pending = [];
  const setTimeout = (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; };
  const clearTimeout = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  const fire = async () => { const t = pending.shift(); if (t) { t.fn(); } };
  return { pending, setTimeout, clearTimeout, fire };
}

test('the loop polls at the cadence the server asks for', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { body: doc({ poll_after_ms: 2500 }) } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  const timers = fakeTimers();
  const docs = [], statuses = [];
  const loop = new SyncLoop(client, { onDoc: (d) => docs.push(d), onStatus: (s) => statuses.push(s.state), ...timers });
  loop.start();
  await loop.inFlight;
  assert.equal(docs.length, 1);
  assert.deepEqual(statuses, ['syncing', 'synced']);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, 2500);
  await timers.fire();
  await loop.inFlight;
  assert.equal(docs.length, 2);
  loop.stop();
  assert.equal(timers.pending.length, 0, 'stop cancels the next tick');
});

test('the loop backs off while the server is down and recovers', async () => {
  let down = true;
  const fetch = async (url, init) => {
    if (down) throw new Error('refused');
    return { status: 200, ok: true, json: async () => doc() };
  };
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  const timers = fakeTimers();
  const statuses = [];
  const loop = new SyncLoop(client, { onStatus: (s) => statuses.push(s), ...timers });
  loop.start();
  await loop.inFlight;
  assert.equal(statuses.at(-1).state, 'offline');
  assert.equal(timers.pending[0].ms, 2000);
  await timers.fire(); await loop.inFlight;
  assert.equal(timers.pending[0].ms, 4000);
  await timers.fire(); await loop.inFlight;
  assert.equal(timers.pending[0].ms, 8000);
  down = false;
  await timers.fire(); await loop.inFlight;
  assert.equal(statuses.at(-1).state, 'synced');
  assert.equal(loop.failures, 0);
  assert.equal(timers.pending[0].ms, 4000, 'back to the server cadence');
});

test('an unpaired loop waits without asking, and a poke syncs now', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { body: doc() } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: null, fetch });
  const timers = fakeTimers();
  const statuses = [];
  const loop = new SyncLoop(client, { onStatus: (s) => statuses.push(s.state), ...timers, defaultMs: 3000 });
  loop.start();
  assert.deepEqual(statuses, ['unpaired']);
  assert.equal(fetch.calls.length, 0);
  assert.equal(timers.pending[0].ms, 3000);
  client.token = 'tok';
  loop.poke();
  await loop.inFlight;
  assert.equal(fetch.calls.length, 1);
  assert.equal(statuses.at(-1), 'synced');
  assert.equal(timers.pending.length, 1, 'the old tick was replaced, not doubled');
});

test('a revoked token stops the loop asking until it is paired again', async () => {
  const fetch = fakeFetch({ '/api/client/sync': { status: 401, body: { error: 'gone' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  const timers = fakeTimers();
  const errors = [];
  const loop = new SyncLoop(client, { onError: (e) => errors.push(e), ...timers });
  loop.start();
  await loop.inFlight;
  assert.ok(errors[0] instanceof NotPaired);
  assert.equal(client.paired, false);
  await timers.fire();
  assert.equal(fetch.calls.length, 1, 'no second request without a token');
});

test('signing in by code: start without a token, poll until approved, keep the token', async () => {
  let polls = 0;
  const fetch = fakeFetch({
    '/api/client/pair/start': { body: { ok: true, code: 'KX7M-4Q2R', secret: 's3', verify_url: 'http://srv/pair?code=KX7M-4Q2R', poll_ms: 100 } },
    '/api/client/pair/poll': () => { polls += 1; return polls < 2 ? { body: { status: 'pending' } } : { body: { status: 'approved', token: 'tok-9', user: { id: 1, nickname: 'ada' } } }; },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', fetch, app: { name: 'box', version: '0.1.0', platform: 'linux' } });
  const opened = await client.pairStart();
  assert.equal(opened.code, 'KX7M-4Q2R');
  assert.equal(fetch.calls[0].headers.authorization, undefined);
  assert.deepEqual(fetch.calls[0].body, { name: 'box', platform: 'linux', app_version: '0.1.0' });
  assert.equal((await client.pairPoll('s3')).status, 'pending');
  assert.equal(client.paired, false);
  const done = await client.pairPoll('s3');
  assert.equal(done.status, 'approved');
  assert.equal(client.token, 'tok-9');
  assert.deepEqual(fetch.calls[1].body, { secret: 's3' });
});

test('a code that expired or was declined is a 410 the app can read', async () => {
  const fetch = fakeFetch({ '/api/client/pair/poll': { status: 410, body: { status: 'expired', error: 'That code has expired.' } } });
  const client = new SyncClient({ serverUrl: 'http://srv', fetch });
  await assert.rejects(client.pairPoll('x'), (err) => err instanceof SyncError && err.status === 410 && /expired/.test(err.message));
});

test('the screens read the directory, a site and a board, with the token only once there is one', async () => {
  const fetch = fakeFetch({
    '/api/client/sites': { body: { sites: [{ slug: 'ca-dmv' }] } },
    '/api/client/sites/ca-dmv': { body: { site: { slug: 'ca-dmv' } } },
    '/api/client/queues/9': { body: { queue: { id: 9 } } },
    '/api/client/queues/9/bids': { body: { ok: true, rank: 2 } },
    '/api/client/bids/5/raise': { body: { ok: true, amount: 250 } },
    '/api/client/bids/5/withdraw': { body: { ok: true, refunded: 250 } },
    '/api/client/account': { body: { user: { nickname: 'ada' } } },
    '/api/client/topup': { body: { ok: true, balance: 3000 } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', fetch });
  assert.deepEqual((await client.sites('dmv')).sites, [{ slug: 'ca-dmv' }]);
  assert.equal(fetch.calls[0].headers.authorization, undefined, 'no token, no header');
  assert.equal(fetch.calls[0].init.method, 'GET');
  client.token = 'tok';
  await client.site('ca-dmv');
  assert.equal(fetch.calls[1].headers.authorization, 'Bearer tok');
  assert.equal((await client.board(9)).queue.id, 9);
  assert.equal((await client.placeBid(9, { amount: 120 })).rank, 2);
  assert.deepEqual(fetch.calls[3].body, { amount: 120 });
  assert.equal((await client.raiseBid('5', '50')).amount, 250);
  assert.deepEqual(fetch.calls[4].body, { delta: 50 });
  assert.equal((await client.withdrawBid(5)).refunded, 250);
  assert.equal((await client.account()).user.nickname, 'ada');
  assert.equal((await client.topup('starter')).balance, 3000);
  assert.deepEqual(fetch.calls[7].body, { pack: 'starter' });
});

test('every request is timed for the app\'s own telemetry, the failed ones too', async () => {
  const seen = [];
  const fetch = fakeFetch({
    '/api/client/sync': { body: doc() },
    '/api/client/queues/9/bids': { status: 402, body: { error: 'short', code: 'insufficient_credits', need: 500, short: 380 } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch, onRequest: (r) => seen.push(r) });
  await client.sync();
  await assert.rejects(client.placeBid(9, { amount: 500 }), (err) => err.status === 402 && err.body.short === 380);
  const offline = new SyncClient({ serverUrl: 'http://srv', token: 'tok', onRequest: (r) => seen.push(r),
    fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(offline.sync());
  assert.deepEqual(seen.map((r) => [r.path, r.status]), [
    ['/api/client/sync', 200], ['/api/client/queues/9/bids', 402], ['/api/client/sync', 0]]);
  for (const r of seen) assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
});

test('the logs hear each exchange whole: what was sent, and what came back or went wrong', async () => {
  const seen = [];
  const fetch = fakeFetch({
    '/api/client/sync': { body: { protocol: 'RQP/1', handoffs: [] } },
    '/api/client/handoffs/77/booked': { status: 409, body: { error: 'That slot is no longer held for you.' } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch, onExchange: (r) => seen.push(r) });
  await client.sync();
  await assert.rejects(client.booked(77, 'TS-1', { robot: true }));
  assert.equal(seen[0].path, '/api/client/sync');
  assert.deepEqual(seen[0].reply, { protocol: 'RQP/1', handoffs: [] });
  assert.equal(seen[0].error, null);
  assert.deepEqual([seen[1].path, seen[1].status], ['/api/client/handoffs/77/booked', 409]);
  assert.deepEqual(seen[1].body, { confirmation: 'TS-1', robot: true });
  assert.equal(seen[1].error.message, 'That slot is no longer held for you.');
  assert.equal(seen[1].reply, undefined);
});

test('a site that asks to be left alone says for how long', async () => {
  const fetch = async () => ({ status: 429, ok: false, headers: { get: (h) => (h === 'retry-after' ? '1800' : null) },
    json: async () => ({ error: 'Shared recently enough — try again later.' }) });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  await assert.rejects(client.shareTelemetry({ schema: 'x' }), (err) => err.status === 429 && err.retryAfter === 1800);
});

test('credits: the balance, a purchase\'s state, cancelling it, and sharing telemetry go where the site expects', async () => {
  const fetch = fakeFetch({
    '/api/client/credits': { body: { balance: 120, packs: [] } },
    '/api/client/payments/7': { body: { id: 7, status: 'pending' } },
    '/api/client/payments/7/cancel': { body: { id: 7, status: 'failed' } },
    '/api/client/telemetry': { body: { ok: true, id: 3 } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.equal((await client.credits()).balance, 120);
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal((await client.payment('7')).status, 'pending');
  assert.equal((await client.cancelPayment(7)).status, 'failed');
  assert.equal(fetch.calls[2].init.method, 'POST');
  assert.equal((await client.shareTelemetry({ schema: 'regbot.app-telemetry/1' })).id, 3);
  assert.deepEqual(fetch.calls[3].body, { schema: 'regbot.app-telemetry/1' });
  assert.equal(fetch.calls[3].headers.authorization, 'Bearer tok');
});

test('asking for a line: what was asked, a new ask, and "me too" go where the site expects', async () => {
  const fetch = fakeFetch({
    '/api/client/site-requests': { body: { mine: [], popular: [{ id: 4 }], roles: {} } },
    '/api/client/site-requests/4/support': { body: { ok: true, id: 4, supporters: 3 } },
  });
  const client = new SyncClient({ serverUrl: 'http://srv', token: 'tok', fetch });
  assert.equal((await client.siteRequests()).popular[0].id, 4);
  assert.equal(fetch.calls[0].init.method, 'GET');
  await client.requestSite({ url: 'https://dmv.nv.gov', site_name: 'Nevada DMV' });
  assert.equal(fetch.calls[1].init.method, 'POST');
  assert.deepEqual(fetch.calls[1].body, { url: 'https://dmv.nv.gov', site_name: 'Nevada DMV' });
  assert.equal((await client.supportSiteRequest('4')).supporters, 3);
  await assert.rejects(client.supportSiteRequest('4/../../x'), () => true, 'an id is a number, not a path');
  assert.ok(fetch.calls.every((c) => c.headers.authorization === 'Bearer tok'));
});
