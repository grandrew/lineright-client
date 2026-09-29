import test from 'node:test';
import assert from 'node:assert/strict';
import { officesForConstraint, requestToEnv, discoveryRequestToEnv, RqpError } from '../src/rqp.js';
import { pickBest, FOUND, NO_AVAILABILITY } from '../src/offices.js';

const request = (personal, extra = {}) => ({
  protocol: 'RQP/1',
  kind: 'booking.request',
  target: { queue: 'vehicle-registration' },
  slot: { window: ['2026-10-01', '2026-11-30'] },
  personal_data: personal,
  ...extra,
});

function caught(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

test('a specific constraint resolves to exactly one office', () => {
  assert.deepEqual(officesForConstraint({ office_mode: 'specific', office: 'Poway' }), ['Poway']);
  // Stored under its public name even when the applicant typed the booking one.
  assert.deepEqual(officesForConstraint({ office_mode: 'specific', office: 'HOLLYWOOD COLE' }), ['Hollywood']);
});

test('a radius constraint expands to every office in range, nearest first', () => {
  const offices = officesForConstraint({ office_mode: 'radius', origin: '92064', radius_miles: 25 });
  assert.equal(offices[0], 'Poway');
  assert.ok(offices.length > 1);
});

test('a radius constraint prefers the coordinates regbot already resolved', () => {
  // Stored coordinates are what the bid was accepted against. Re-deriving them
  // from the typed origin would let a catalogue refresh silently move a bid.
  const offices = officesForConstraint({
    office_mode: 'radius', origin: 'ignored nonsense', origin_lat: 32.9602, origin_lng: -117.0407,
    radius_miles: 10,
  });
  assert.equal(offices[0], 'Poway');
});

test('a broken constraint is permanent, not something to retry', () => {
  for (const personal of [
    { office_mode: 'specific', office: 'Atlantis' },
    { office_mode: 'radius', origin: 'Narnia', radius_miles: 25 },
    { office_mode: 'radius', origin: '92064', radius_miles: 0 },
    { office_mode: 'radius', origin: '92064', radius_miles: 'soon' },
    {},
  ]) {
    const error = caught(() => officesForConstraint(personal));
    assert.ok(error instanceof RqpError, `accepted ${JSON.stringify(personal)}`);
    assert.equal(error.permanent, true, `retryable for ${JSON.stringify(personal)}`);
  }
});

test('a bid placed before the constraint existed still runs', () => {
  assert.deepEqual(officesForConstraint({ offices: 'Poway, San Marcos' }), ['Poway, San Marcos']);
});

test('the envelope carries the whole office list, best first', () => {
  const env = requestToEnv(request({ office_mode: 'radius', origin: '92064', radius_miles: 15 }));
  assert.ok(env.DMV_OFFICES.startsWith('Poway'));
  assert.equal(env.DATE_START, '2026-10-01');
  assert.equal(env.DATE_END, '2026-11-30');
});

test('an allocated slot goes to the front and travels as a target', () => {
  const env = requestToEnv(request(
    { office_mode: 'radius', origin: '92064', radius_miles: 25 },
    { slot: {
      window: ['2026-10-01', '2026-11-30'],
      allocated: { office_name: 'El Cajon', date: '2026-10-03', time: '10:20' },
    } },
  ));
  assert.equal(env.DMV_OFFICES.split(',')[0].trim(), 'El Cajon');
  assert.equal(env.DMV_TARGET_OFFICE, 'El Cajon');
  assert.equal(env.DMV_TARGET_DATE, '2026-10-03');
  assert.equal(env.DMV_TARGET_TIME, '10:20');
  // The rest stay behind it: between allocation and booking the slot can be
  // taken by somebody who walked in off the street.
  assert.ok(env.DMV_OFFICES.includes('Poway'));
  assert.equal(env.DMV_OFFICES.split(',').filter((o) => o.trim() === 'El Cajon').length, 1);
});

test('no allocation means no target', () => {
  const env = requestToEnv(request({ office_mode: 'specific', office: 'Poway' }));
  assert.equal(env.DMV_TARGET_DATE, undefined);
});

test('an allocated slot beats an earlier one elsewhere', () => {
  // The board chose this slot. Quietly taking an earlier one at another office
  // would hand the applicant an appointment nobody agreed to, and strand theirs.
  const results = [
    { office: 'Poway', status: FOUND, date: new Date(2026, 9, 20), label: null, error: null },
    { office: 'El Cajon', status: FOUND, date: new Date(2026, 9, 3), label: null, error: null },
  ];
  assert.equal(pickBest(results).office, 'El Cajon');
  assert.equal(pickBest(results, { target: { office: 'Poway', date: '2026-10-20' } }).office, 'Poway');
});

test('a vanished allocation falls back to the earliest date', () => {
  const results = [
    { office: 'Poway', status: NO_AVAILABILITY, date: null, label: null, error: null },
    { office: 'El Cajon', status: FOUND, date: new Date(2026, 9, 3), label: null, error: null },
  ];
  assert.equal(pickBest(results, { office: 'Poway', date: '2026-10-20' }).office, 'El Cajon');
});

test('a discovery request needs no applicant and cannot book', () => {
  const env = discoveryRequestToEnv({
    protocol: 'RQP/1', kind: 'discovery.request',
    target: { queue: 'vehicle-registration' },
    offices: ['Poway', 'El Cajon'],
    window: ['2026-10-01', '2026-11-30'],
  });
  assert.equal(env.DMV_OFFICES, 'Poway, El Cajon');
  assert.equal(env.DMV_SERVICE, 'VR');
  assert.equal(env.AUTO_SUBMIT, undefined);   // not false — absent
  assert.equal(env.EMAIL_ADDRESS, undefined);
  assert.equal(env.DMV_LICENSE, undefined);
});

test('a drive-test line cannot be scouted, and says so permanently', () => {
  // Its calendar only opens after a licence number is entered, and a scout has
  // no applicant. Retrying will never change that.
  const error = caught(() => discoveryRequestToEnv({
    protocol: 'RQP/1', kind: 'discovery.request',
    target: { queue: 'drive-test-auto' },
    offices: ['Poway'], window: ['2026-10-01', '2026-11-30'],
  }));
  assert.ok(error instanceof RqpError);
  assert.equal(error.permanent, true);
  assert.match(error.message, /licence details/i);
});

test('a malformed discovery request is rejected, not guessed at', () => {
  const base = {
    protocol: 'RQP/1', kind: 'discovery.request',
    target: { queue: 'vehicle-registration' },
    offices: ['Poway'], window: ['2026-10-01', '2026-11-30'],
  };
  assert.ok(caught(() => discoveryRequestToEnv({ ...base, offices: [] })) instanceof RqpError);
  assert.ok(caught(() => discoveryRequestToEnv({ ...base, window: [] })) instanceof RqpError);
  assert.ok(caught(() => discoveryRequestToEnv({ ...base, kind: 'booking.request' })) instanceof RqpError);
  assert.ok(caught(() => discoveryRequestToEnv({ ...base, protocol: 'RQP/9' })) instanceof RqpError);
});
