'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Booker, budgetMs } = require('../src/booker');

const SITE = 'http://127.0.0.1:5000';
const PRACTICE = 'http://127.0.0.1:8787';
const PROFILE = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.invalid', phone: '5555550100',
  dl_number: 'D1234567', dob: '12/10/1990', ssn: '000-00-0000', passport: 'P123', street: '1 Main St' };

function handoff(extra = {}) {
  return {
    job_id: 77, queue_name: 'REAL ID', phase: 'booking', seconds_left: 280, booker: null,
    slot: { office_code: 'P1', office_name: 'Poway', date: '2026-10-06', time: '09:00' },
    robot: {
      name: 'dmq-rqp/1', base_url: PRACTICE, captcha_solver_url: `${PRACTICE}/__captcha/solve`,
      requires: ['first_name', 'last_name', 'email', 'phone'],
      request: { protocol: 'RQP/1', kind: 'booking.request', job_id: 77, idempotency_key: 'rqp1-job-77-20260926',
        target: { queue: 'real-id' }, slot: { window: ['2026-10-06', '2026-10-06'], allocated: { office_code: 'P1', time: '09:00' } },
        personal_data: { office_mode: 'specific', office: 'Poway', booked_by: 'applicant' } },
    },
    ...extra,
  };
}

const refused = (status, message, body = { error: message }) => Object.assign(new Error(message), { status, body });

function world({ result = { status: 'confirmed', confirmation: 'TS-12345678' }, claim = null, report = null,
  claimed = { ok: true, claimed: true }, settings = {}, available = true, serverUrl = SITE, profile = PROFILE,
  records = {} } = {}) {
  const calls = { runs: [], claims: [], booked: [], gone: [], busy: [] };
  const runner = {
    available: () => available,
    run: async (kind, envelope, opts) => { calls.runs.push({ kind, envelope, opts }); return result; },
    recorded: (key) => records[key] ?? null,
  };
  const client = {
    serverUrl,
    claim: async (id) => { calls.claims.push(id); if (claim) throw claim; return claimed; },
    booked: async (id, ref, opts) => { calls.booked.push({ id, ref, ...opts }); if (report) throw report; return { ok: true }; },
    gone: async (id, reason) => { calls.gone.push({ id, reason }); if (report) throw report; return { ok: true }; },
  };
  const store = { get: (key, fallback) => (key in settings ? settings[key] : fallback) };
  const reader = { setBusy: (b) => calls.busy.push(b) };
  const booker = new Booker({ runner, reader, getClient: () => client, getStore: () => store, getProfile: () => profile });
  return { booker, calls };
}

test('the app books a hand-off itself only when it has everything it needs', () => {
  const { booker } = world();
  assert.deepEqual(booker.wants(handoff()), { ok: true });
  assert.equal(booker.wants(handoff({ slot: null })).why, 'no-robot', 'a hunt has no slot to book');
  assert.equal(booker.wants(handoff({ robot: null })).why, 'no-robot');
  assert.equal(booker.wants(handoff({ phase: 'booked' })).why, 'no-robot');
  assert.deepEqual(booker.wants(handoff({ booker: { name: 'desktop', you: false } })),
    { ok: false, why: 'elsewhere', device: 'desktop' });
  assert.equal(booker.wants(handoff({ booker: { name: 'laptop', you: true } })).ok, true);
  assert.equal(world({ available: false }).booker.wants(handoff()).why, 'no-robot');
  assert.equal(booker.wants(handoff({ robot: { ...handoff().robot, base_url: 'https://dmv.example' } })).why, 'target');
  const real = handoff({ robot: { ...handoff().robot, base_url: 'https://www.dmv.ca.gov', captcha_solver_url: null } });
  assert.equal(world({ serverUrl: 'https://regbot.example' }).booker.wants(real).why, 'not-agreed');
  assert.equal(world({ serverUrl: 'https://regbot.example', settings: { realDmvRobots: true } }).booker.wants(real).ok, true);
  assert.deepEqual(world({ profile: { first_name: 'Ada' } }).booker.wants(handoff()),
    { ok: false, why: 'profile', missing: ['last_name', 'email', 'phone'] });
});

test('it books with the stored request, adding only what the form wants from the profile', async () => {
  const { booker, calls } = world();
  const h = handoff();
  const outcome = await booker.book(h);
  assert.deepEqual(outcome, { kind: 'booked', confirmation: 'TS-12345678' });
  assert.deepEqual(calls.claims, [77], 'claimed first');
  const [run] = calls.runs;
  assert.equal(run.kind, 'book');
  assert.deepEqual(run.opts, { dmvBase: PRACTICE, solverUrl: `${PRACTICE}/__captcha/solve`, allowBooking: true,
    timeoutMs: 235000 });
  assert.deepEqual(run.envelope.personal_data, { office_mode: 'specific', office: 'Poway', booked_by: 'applicant',
    first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.invalid', phone: '5555550100' },
  'never the SSN, the passport or the address');
  assert.equal(run.envelope.idempotency_key, '127.0.0.1:5000/rqp1-job-77-20260926', 'unique across sites');
  assert.deepEqual(run.envelope.slot, h.robot.request.slot);
  assert.equal(h.robot.request.personal_data.first_name, undefined, 'the hand-off itself is untouched');
  assert.deepEqual(calls.booked, [{ id: 77, ref: 'TS-12345678', robot: true }], 'said to be the robot\'s booking');
  assert.deepEqual(calls.busy, [true, false], 'no reads taken while it books');
  assert.equal(booker.wants(h).why, 'tried', 'once per hand-off');
  assert.equal(booker.state().lastBooking.kind, 'booked');
});

test('a slot the robot found gone is reported gone', async () => {
  const { booker, calls } = world({ result: { status: 'unavailable', slot_gone: true, message: 'The allocated slot is no longer listed.' } });
  assert.deepEqual(await booker.book(handoff()), { kind: 'gone' });
  assert.deepEqual(calls.gone, [{ id: 77, reason: 'The allocated slot is no longer listed.' }]);
  assert.deepEqual(calls.booked, []);
  const unheard = world({ result: { status: 'unavailable', slot_gone: true }, report: refused(409, 'not held') });
  assert.deepEqual(await unheard.booker.book(handoff()), { kind: 'gone' }, 'gone whether or not the site hears it');
});

test('booked is booked, even when the site will not take the report', async () => {
  const late = 'That slot is no longer held for you — its deadline may have passed and the slot cascaded.';
  const { booker, calls } = world({ report: refused(409, late) });
  assert.deepEqual(await booker.book(handoff()), { kind: 'booked', confirmation: 'TS-12345678', unreported: late });
  assert.equal(calls.booked.length, 1);
});

test('anything else opens the page for the person, saying why, and an unconfirmed booking is never retried', async () => {
  const gated = world({ result: { status: 'unavailable', gate: { kind: 'recaptcha', sitekey: 'k' } } });
  assert.match((await gated.booker.book(handoff())).why, /human check/);
  const unconfirmed = world({ result: { status: 'rejected', unconfirmed: true } });
  const page = await unconfirmed.booker.book(handoff());
  assert.equal(page.kind, 'page');
  assert.match(page.why, /Check your email/);
  assert.deepEqual(unconfirmed.calls.booked, []);
  assert.deepEqual(unconfirmed.calls.gone, []);
  assert.equal(unconfirmed.booker.wants(handoff()).why, 'tried');
  const failed = world({ result: { status: 'unavailable', message: 'The robot did not finish within 240s.' } });
  assert.match((await failed.booker.book(handoff())).why, /did not finish/);
});

test('another device of the person that claimed it first books it; this one stands back', async () => {
  const taken = refused(409, 'desktop-box is already booking this slot.',
    { error: 'desktop-box is already booking this slot.', booker: { name: 'desktop-box' } });
  const { booker, calls } = world({ claim: taken });
  assert.deepEqual(await booker.book(handoff()), { kind: 'elsewhere', device: 'desktop-box' });
  assert.deepEqual(calls.runs, [], 'no robot run');
  assert.deepEqual(calls.busy, [true, false]);
});

test('a slot no longer held for the person is not booked, and no page opens for it', async () => {
  for (const err of [refused(409, "That slot's time to book has run out."), refused(404, 'That slot is not held for you right now.')]) {
    const { booker, calls } = world({ claim: err });
    assert.deepEqual(await booker.book(handoff()), { kind: 'late', why: err.message });
    assert.deepEqual(calls.runs, []);
  }
  // A site that cannot be reached is not "late": the person gets the page.
  const { booker, calls } = world({ claim: refused(0, 'Could not reach http://127.0.0.1:5000: fetch failed') });
  assert.equal((await booker.book(handoff())).kind, 'page');
  assert.deepEqual(calls.runs, []);
});

test('a new account or site starts with nothing tried', async () => {
  const { booker } = world();
  await booker.book(handoff());
  assert.equal(booker.wants(handoff()).why, 'tried');
  booker.forget();
  assert.deepEqual(booker.wants(handoff()), { ok: true });
  assert.equal(booker.state().lastBooking, null);
});

test('a slot that went to somebody else offered it too is left alone', () => {
  const { booker } = world();
  assert.deepEqual(booker.wants(handoff({ over: { kind: 'taken', message: '#1 booked it first.' } })),
    { ok: false, why: 'over' });
  assert.deepEqual(booker.wants(handoff({ wave: { place: 2, of: 3 } })), { ok: true }, 'a place in a wave is a turn');
});

test('a device of the person that went quiet mid-booking is taken over', async () => {
  const quiet = handoff({ booker: { name: 'desktop-box', you: false, silent: true } });
  const { booker, calls } = world({ claimed: { ok: true, claimed: true, took_over_from: 'desktop-box' } });
  assert.deepEqual(booker.wants(quiet), { ok: true }, 'a quiet device holds nothing');
  assert.deepEqual(await booker.book(quiet), { kind: 'booked', confirmation: 'TS-12345678' });
  assert.equal(calls.runs.length, 1);

  // Stood back when another device claimed first; that one goes quiet later: not "tried".
  const taken = refused(409, 'desktop-box is already booking this slot.',
    { error: 'desktop-box is already booking this slot.', booker: { name: 'desktop-box' } });
  const later = world({ claim: taken });
  assert.equal((await later.booker.book(handoff())).kind, 'elsewhere');
  assert.deepEqual(later.booker.wants(quiet), { ok: true });
});

test('after taking over, a slot found gone is not reported gone: the quiet one may have got it', async () => {
  const { booker, calls } = world({ claimed: { ok: true, claimed: true, took_over_from: 'desktop-box' },
    result: { status: 'unavailable', slot_gone: true, message: 'The allocated slot is no longer listed.' } });
  const outcome = await booker.book(handoff({ booker: { name: 'desktop-box', you: false, silent: true } }));
  assert.deepEqual(outcome, { kind: 'gone', quiet: true, device: 'desktop-box' });
  assert.deepEqual(calls.gone, [], 'the hand-off runs out its time instead');
});

test('a booking this computer\'s robot made before the app stopped is said, whoever holds the slot now', async () => {
  // The laptop crashed a second into booking; its robot booked the slot anyway and
  // recorded it. Meanwhile the desktop took the slot over and found it gone. The
  // laptop, started again, finds the desktop holding it: its own booking is the
  // appointment all the same.
  const key = '127.0.0.1:5000/rqp1-job-77-20260926';
  const made = { [key]: { confirmation: 'TS-AAA3150A', booked_date: '2026-10-06' } };
  const elsewhere = handoff({ booker: { name: 'desktop-box', you: false } });
  const { booker, calls } = world({ records: made });
  assert.deepEqual(booker.wants(elsewhere), { ok: true, recorded: true });
  assert.deepEqual(await booker.book(elsewhere), { kind: 'booked', confirmation: 'TS-AAA3150A', recorded: true });
  assert.deepEqual(calls.claims, [], 'no claim: the other device holds it');
  assert.deepEqual(calls.runs, [], 'and no second robot');
  assert.deepEqual(calls.booked, [{ id: 77, ref: 'TS-AAA3150A', robot: true }]);
  assert.equal(booker.wants(elsewhere).why, 'tried', 'said once');

  // Said again later if the site could not be reached.
  const offline = world({ records: made, report: refused(0, 'Could not reach http://127.0.0.1:5000: fetch failed') });
  const outcome = await offline.booker.book(elsewhere);
  assert.equal(outcome.kind, 'booked');
  assert.equal(outcome.unreported, 'Could not reach http://127.0.0.1:5000: fetch failed');
  assert.equal(offline.booker.pending.size, 1);

  // Only a booking it made, on this site: one sent with no answer, or another site's, is not one.
  assert.equal(world({ records: { [key]: { unconfirmed: true, message: 'no answer' } } }).booker.wants(elsewhere).why, 'elsewhere');
  assert.equal(world({ records: { 'regbot.example/rqp1-job-77-20260926': { confirmation: 'TS-1' } } }).booker.wants(elsewhere).why, 'elsewhere');
  assert.equal(world().booker.wants(elsewhere).why, 'elsewhere', 'nothing recorded: it stands back, as before');
});

test('a booking the site did not hear about is said again until it answers, yes or no', async () => {
  const replies = [];
  const calls = [];
  const client = {
    serverUrl: SITE,
    claim: async () => ({ ok: true, claimed: true }),
    booked: async (id, ref, opts) => {
      calls.push({ id, ref, ...opts });
      const next = replies.shift();
      if (next) throw next;
      return { ok: true };
    },
    gone: async () => ({ ok: true }),
  };
  const runner = { available: () => true, run: async () => ({ status: 'confirmed', confirmation: 'TS-9' }) };
  const booker = new Booker({ runner, getClient: () => client, getStore: () => ({ get: (k, f) => f }),
    getProfile: () => PROFILE });
  const unreachable = refused(0, 'Could not reach http://127.0.0.1:5000: fetch failed');
  replies.push(unreachable, unreachable);
  const outcome = await booker.book(handoff());
  assert.equal(outcome.kind, 'booked', 'booked is booked');
  assert.match(outcome.unreported, /Could not reach/);
  await booker.retryReports();                     // still unreachable: kept
  assert.equal(booker.pending.size, 1);
  await booker.retryReports();                     // heard
  assert.equal(booker.pending.size, 0);
  assert.deepEqual(calls.map((c) => c.robot), [true, true, true]);

  // A "no" is an answer too: not said again.
  replies.push(unreachable, refused(409, 'That slot is no longer held for you.'));
  await booker.book(handoff({ job_id: 78 }));
  await booker.retryReports();
  assert.equal(booker.pending.size, 0);
  await booker.retryReports();
  assert.equal(calls.length, 5, 'nothing more after the "no"');
});

test('the robot gets the hand-off\'s time, less a margin for the page, within bounds', () => {
  assert.equal(budgetMs(280), 235000);
  assert.equal(budgetMs(600), 240000);
  assert.equal(budgetMs(50), 30000);
  assert.equal(budgetMs(undefined), 240000);
});

test('two bookings at once keep the app busy until both are done', async () => {
  // One person in two lines can be handed two slots in one sync; the app books
  // both at once, and must not offer to read until the second is done too.
  const { booker, calls } = world();
  const finish = {};
  booker.runner.run = (kind, envelope) => new Promise((resolve) => {
    finish[envelope.job_id] = () => resolve({ status: 'confirmed', confirmation: `TS-${envelope.job_id}` });
  });
  const first = booker.book(handoff());
  const second = booker.book(handoff({ job_id: 78, robot: { ...handoff().robot,
    request: { ...handoff().robot.request, job_id: 78, idempotency_key: 'rqp1-job-78-20260926' } } }));
  await new Promise((r) => setImmediate(r));
  finish[77]();
  assert.equal((await first).kind, 'booked');
  assert.equal(calls.busy.at(-1), true, 'still booking the second');
  assert.equal(booker.state().booking.job_id, 78);
  finish[78]();
  assert.equal((await second).kind, 'booked');
  assert.equal(calls.busy.at(-1), false);
  assert.equal(booker.state().booking, null);
});
