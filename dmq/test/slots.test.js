import test from 'node:test';
import assert from 'node:assert/strict';
import { to24h, parseTimes, dateKey, toOffer } from '../src/slots.js';

test('to24h converts the clock format DMV renders', () => {
  assert.equal(to24h('10:30 AM'), '10:30');
  assert.equal(to24h('1:05 PM'), '13:05');
  assert.equal(to24h('12:00 AM'), '00:00');   // midnight is hour 0, not 12
  assert.equal(to24h('12:30 PM'), '12:30');   // noon stays 12
  assert.equal(to24h('9:00 a.m.'), '09:00');
});

test('to24h accepts a 24-hour clock time from the times API', () => {
  assert.equal(to24h('08:00'), '08:00');
  assert.equal(to24h('14:20'), '14:20');
  assert.equal(to24h('00:00'), '00:00');
  assert.equal(to24h('23:59'), '23:59');
});

test('to24h rejects anything that is not a clock time', () => {
  for (const bad of ['13:00 PM', '0:30 AM', '10:75 AM', '24:00', 'noon', '', null]) {
    assert.equal(to24h(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('parseTimes pulls distinct times out of a slot page, in order', () => {
  const body = 'Choose an appointment time 1:05 PM 8:00 AM 8:00 AM 10:30 AM';
  assert.deepEqual(parseTimes(body), ['08:00', '10:30', '13:05']);
  assert.deepEqual(parseTimes('nothing here'), []);
  assert.deepEqual(parseTimes(''), []);
  assert.deepEqual(parseTimes('["08:00","14:20","08:00"]'), ['08:00', '14:20']);
  // "08:00 AM" must not be counted again as the bare "08:00" inside it.
  assert.deepEqual(parseTimes('08:00 AM 14:20'), ['08:00', '14:20']);
  assert.deepEqual(parseTimes('13:00 PM'), []);
});

test('dateKey uses local calendar parts, not UTC', () => {
  // A late-evening local date would roll forward a day under toISOString, which
  // would hand the applicant an appointment on the wrong day.
  const late = new Date(2026, 9, 3, 23, 30);
  assert.equal(dateKey(late), '2026-10-03');
  assert.equal(dateKey('2026-10-03'), '2026-10-03');
});

test('an offer carries everything the matcher needs to place it', () => {
  const offer = toOffer('Poway', new Date(2026, 9, 3), '10:20');
  assert.equal(offer.office_name, 'Poway');
  assert.equal(offer.slot_date, '2026-10-03');
  assert.equal(offer.slot_time, '10:20');
  assert.ok(offer.office_code);
  assert.equal(typeof offer.office_lat, 'number');
  assert.equal(typeof offer.office_lng, 'number');
});

test('an offer is resolvable by the booking name too', () => {
  assert.equal(toOffer('HOLLYWOOD COLE', '2026-10-03', '09:00').office_name, 'Hollywood');
});

test('an unplaceable office yields no offer rather than a half-built one', () => {
  // Nobody bidding by radius could ever win an offer with no coordinates, so a
  // partial offer is worse than none.
  assert.equal(toOffer('Atlantis', '2026-10-03', '09:00'), null);
  assert.equal(toOffer('Poway', '2026-10-03', null), null);
});
