import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION, ACK, NACK_RETRY, NACK_FATAL,
  SERVICE_BY_QUEUE, serviceForQueue, requestToEnv,
  outcomeToResult, errorToResult, result, toDateOnly, RqpError, offersToResult,
} from '../src/rqp.js';
import { SERVICES } from '../src/services.js';
import { loadConfig } from '../src/config.js';

const REQUEST = {
  protocol: 'RQP/1',
  kind: 'booking.request',
  job_id: 412,
  idempotency_key: 'rqp1-job-412',
  target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' },
  slot: { preferred_date: '2026-10-08', preferred_time: '10:00', window: ['2026-10-01', '2026-10-31'] },
  applicant: { user_id: 21, nickname: 'demo_runner' },
  personal_data: {
    offices: 'Poway,San Marcos',
    first_name: 'A', last_name: 'B', email: 'a@b.c', phone: '5555550123',
  },
  priority: { bid: 140, currency: 'CHR' },
};

// assert.throws does not hand back the error, and these cases care about the
// `permanent` flag on it -- that flag is what decides refund versus retry.
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw' });
}

const driveTest = (extra = {}) => ({
  ...REQUEST,
  target: { ...REQUEST.target, queue: 'drive-test-auto' },
  personal_data: { ...REQUEST.personal_data, dl_number: 'X1234567', dob: '01/02/1990', ...extra },
});

test('every mapped line names a service this bot implements', () => {
  for (const [queue, code] of Object.entries(SERVICE_BY_QUEUE)) {
    assert.ok(SERVICES[code], `line "${queue}" maps to unknown service ${code}`);
  }
});

test('serviceForQueue resolves the line, and refuses an unknown one permanently', () => {
  assert.equal(serviceForQueue(REQUEST), 'VR');
  assert.equal(serviceForQueue(driveTest()), 'DT');
  const err = caught(() => serviceForQueue({ target: { queue: 'nope' } }));
  assert.ok(err instanceof RqpError);
  assert.equal(err.permanent, true, 'an unmapped line cannot be fixed by retrying');
});

test('requestToEnv rejects a foreign protocol or envelope kind', () => {
  assert.throws(() => requestToEnv({ ...REQUEST, protocol: 'RQP/2' }), /Unsupported protocol/);
  assert.throws(() => requestToEnv({ ...REQUEST, kind: 'booking.result' }), /Unsupported envelope kind/);
});

test('requestToEnv maps the slot window onto the search window', () => {
  const env = requestToEnv(REQUEST, {});
  assert.equal(env.DATE_START, '2026-10-01');
  assert.equal(env.DATE_END, '2026-10-31');
  assert.equal(env.DMV_SERVICE, 'VR');
  assert.equal(env.DMV_OFFICES, 'Poway,San Marcos');
});

test('requestToEnv output is accepted by loadConfig', () => {
  // The two contracts have to line up, or a job only fails once a browser is up.
  const cfg = loadConfig(requestToEnv(driveTest(), {}));
  assert.equal(cfg.service.code, 'DT');
  assert.deepEqual(cfg.offices.map((o) => o.term), ['Poway', 'San Marcos']);
  assert.equal(cfg.licenseNumber, 'X1234567');
});

test('booking is off unless the operator opts in, whatever regbot asks for', () => {
  assert.equal(requestToEnv(REQUEST, {}).AUTO_SUBMIT, 'false');
  assert.equal(requestToEnv(REQUEST, { RQP_ALLOW_BOOKING: 'yes' }).AUTO_SUBMIT, 'false');
  assert.equal(requestToEnv(REQUEST, { RQP_ALLOW_BOOKING: 'true' }).AUTO_SUBMIT, 'true');
});

test('drive-test lines demand credentials; office-visit lines do not', () => {
  const vr = requestToEnv(REQUEST, {});
  assert.equal(vr.DMV_LICENSE, undefined);
  assert.equal(vr.DMV_DOB, undefined);

  const dt = requestToEnv(driveTest(), {});
  assert.equal(dt.DMV_LICENSE, 'X1234567');
  assert.equal(dt.DMV_DOB, '01/02/1990');

  const missing = { ...REQUEST, target: { ...REQUEST.target, queue: 'drive-test-auto' } };
  const err = caught(() => requestToEnv(missing, {}));
  assert.match(err.message, /Driver licence or permit number is missing/);
  assert.equal(err.permanent, true, 'missing personal data is the applicant’s to fix');
});

test('contact details are only demanded when booking is actually enabled', () => {
  const bare = { ...REQUEST, personal_data: { offices: 'Poway' } };
  assert.equal(requestToEnv(bare, {}).DMV_OFFICES, 'Poway');
  assert.throws(() => requestToEnv(bare, { RQP_ALLOW_BOOKING: 'true' }), /First name is missing/);
});

test('a request with no window is refused permanently', () => {
  const err = caught(() => requestToEnv({ ...REQUEST, slot: {} }));
  assert.ok(err instanceof RqpError);
  assert.equal(err.permanent, true);
});

test('a booking maps to confirmed with the confirmation number DMV showed', () => {
  const env = outcomeToResult(
    { status: 'BOOKED_SUCCESS', date: new Date(2026, 9, 8), time: '10:30 AM', office: 'Poway',
      reference: 'TS-1A2B3C4D' },
    { latencyMs: 812 }
  );
  assert.equal(env.protocol, VERSION);
  assert.equal(env.kind, 'booking.result');
  assert.equal(env.status, ACK);
  assert.equal(env.confirmation, 'TS-1A2B3C4D', 'regbot captures escrow against this reference');
  assert.match(env.message, /TS-1A2B3C4D/);
  assert.equal(env.booked_date, '2026-10-08');
  assert.equal(env.latency_ms, 812);
});

test('an allocated slot that is not there says so, apart from an empty calendar', () => {
  const gone = outcomeToResult({ status: 'NO_AVAILABILITY', slot_gone: true, office: 'Poway' });
  assert.equal(gone.status, NACK_RETRY);
  assert.equal(gone.slot_gone, true);
  assert.match(gone.message, /no longer listed/);
  const empty = outcomeToResult({ status: 'NO_AVAILABILITY' });
  assert.equal(empty.slot_gone, undefined);
});

test('a booking DMV did not confirm is refused, so regbot neither captures nor retries', () => {
  const env = outcomeToResult({
    status: 'BOOKING_UNCONFIRMED', date: new Date(2026, 8, 29), time: '10:00 AM', office: 'Poway',
    seen: 'still on /portal/appointments/details, no confirmation shown',
  });
  assert.equal(env.status, NACK_FATAL, 'a retry could book the same person twice');
  assert.equal(env.confirmation, '');
  assert.equal(env.unconfirmed, true);
  assert.deepEqual(env.attempted, { office: 'Poway', date: '2026-09-29', time: '10:00 AM' });
  assert.match(env.seen, /no confirmation shown/);
  assert.match(env.message, /may or may not have gone through/);
});

test('a booking with no confirmation number is never confirmed under an invented one', () => {
  // How 2026-09-25's "CADMV-2026-09-29-1000" happened: regbot stored a number
  // DMV had never issued, and the person could not cancel with it.
  const env = outcomeToResult(
    { status: 'BOOKED_SUCCESS', date: new Date(2026, 8, 29), time: '10:00 AM', office: 'Poway' });
  assert.equal(env.status, NACK_FATAL);
  assert.equal(env.confirmation, '');
  assert.equal(env.unconfirmed, true);
});

test('no availability is transient, so regbot retries rather than refunding at once', () => {
  const env = outcomeToResult({
    status: 'NO_AVAILABILITY',
    results: [{ office: 'Poway', status: 'NO_AVAILABILITY', date: null }],
  });
  assert.equal(env.status, NACK_RETRY);
  assert.deepEqual(env.offices, [{ office: 'Poway', status: 'NO_AVAILABILITY', date: null }]);
});

test('a probe run reports what it found but does not claim a booking', () => {
  const env = outcomeToResult({
    status: 'FOUND_AND_STOPPED',
    best: { office: 'San Marcos', date: new Date(2026, 9, 12) },
    results: [],
  });
  assert.equal(env.status, NACK_RETRY);
  assert.equal(env.confirmation, '', 'nothing was booked, so nothing may be captured');
  assert.equal(env.found_date, '2026-10-12');
});

test('an unrecognised outcome is treated as transient, never as a booking', () => {
  assert.equal(outcomeToResult({ status: 'WAT' }).status, NACK_RETRY);
  assert.equal(outcomeToResult(undefined).status, NACK_RETRY);
});

test('errorToResult distinguishes a bad application from a bad day', () => {
  assert.equal(errorToResult(new RqpError('nope', { permanent: true })).status, NACK_FATAL);
  assert.equal(errorToResult(new RqpError('later')).status, NACK_RETRY);
  assert.equal(errorToResult(new Error('boom')).status, NACK_RETRY);
});

test('a captcha gate travels as structured data, not just prose', () => {
  // regbot turns a gate into a third outcome -- the job parks and the applicant
  // is asked to clear it -- so the sitekey and page URL must survive onto the
  // envelope. Losing them would demote a solvable gate back to a blind retry.
  const gate = { kind: 'recaptcha_v2_invisible', sitekey: '6Lc', page_url: 'https://dmv/x', step: 'dates' };
  const err = new Error('Calendar never loaded (reCAPTCHA).');
  err.gate = gate;
  const env = errorToResult(err);
  assert.equal(env.status, NACK_RETRY);
  assert.deepEqual(env.gate, gate);
  // A plain error carries no gate, so regbot can tell the two apart.
  assert.equal('gate' in errorToResult(new Error('boom')), false);
});

test('result envelopes carry the fields regbot reads', () => {
  const env = result(ACK, 'done');
  for (const key of ['protocol', 'kind', 'status', 'message', 'confirmation', 'connector', 'at']) {
    assert.ok(key in env, `missing ${key}`);
  }
  assert.match(env.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'regbot formats timestamps this way');
});

test('toDateOnly renders local calendar dates, not UTC-shifted ones', () => {
  assert.equal(toDateOnly(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(toDateOnly(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(toDateOnly('nonsense'), null);
});

test('a discovery result carries a gate, because a gate is not an empty calendar', () => {
  // The distinction ca_dmv.discover exists to preserve: "blocked at a human
  // check" and "there is nothing available" are opposite facts, and regbot
  // answers them in opposite ways — park and ask, or retry later. Dropping the
  // gate here made the branch that handles it unreachable for months.
  const gate = { kind: 'recaptcha_v2_invisible', sitekey: '6LcTEST', page_url: 'http://x/y',
                 step: 'looking up dates at ALTURAS', extra: { office: 'ALTURAS' } };
  const blocked = offersToResult({
    offers: [],
    checked: [{ office: 'ALTURAS', found: 0, error: 'Calendar never loaded', gate }],
    gate,
  });
  assert.deepEqual(blocked.gate, gate);
  assert.match(blocked.message, /human check/i);

  const empty = offersToResult({ offers: [], checked: [{ office: 'ALTURAS', found: 0, error: null }] });
  assert.equal(empty.gate, undefined, 'an empty calendar must not look like a gate');
  assert.match(empty.message, /no availability/i);
});
