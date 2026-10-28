'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const opts = require('../ui/options');

const PLACE = ['office_mode', 'office', 'origin', 'radius_miles'];
const option = {
  key: 'v1:2026-10-28T09:00:1d', label: 'Best bet', place: { office_mode: 'radius', origin: '95050', radius_miles: 15 },
  place_text: 'Within 15 mi of 95050', preferred_date: '2026-10-28', preferred_time: '09:00', if_passed: '1d',
  until: '2026-10-29 09:00', chance: 0.91, likely_by: '2026-10-25 06:00',
};

test('the draft sent is the form: its place, date, time, reach and amount', () => {
  const draft = opts.body({
    office_mode: 'radius', origin: '95050', radius_miles: '10', office: undefined, first_name: 'Ann',
    preferred_date: '2026-10-27', preferred_time: '17:00', if_passed: '1d', amount: '45',
  }, PLACE);
  assert.deepEqual(draft, {
    fields: { office_mode: 'radius', origin: '95050', radius_miles: '10' },
    preferred_date: '2026-10-27', preferred_time: '17:00', if_passed: '1d', amount: 45,
  });
  assert.equal(opts.key(draft), opts.key(JSON.parse(JSON.stringify(draft))), 'the same draft is asked once');
  assert.equal(opts.body({ soonest: true }, PLACE).soonest, true, 'and whether it books the soonest in its reach');
  assert.equal(opts.body({ soonest: false }, PLACE).soonest, false);
  assert.notEqual(opts.key(opts.body({ soonest: true }, PLACE)), opts.key(opts.body({}, PLACE)));
});

test('an option that books the soonest says how far, not when its moment passes', () => {
  const d = opts.describe({ ...option, soonest: true }, undefined, Date.parse('2026-10-24T12:00:00'));
  assert.equal(d.asks, 'the soonest opening up to 2026-10-29, 09:00');
});

test('the end of a reach, as the site counts it', () => {
  assert.equal(opts.reachEnd('2026-10-29', '09:00', '1d'), '2026-10-30 09:00');
  assert.equal(opts.reachEnd('2026-10-29', '15:10', '5h'), '2026-10-29 20:10');
  assert.equal(opts.reachEnd('2026-10-29', '09:00', '2w'), '2026-11-12 09:00');
  assert.equal(opts.reachEnd('2026-01-31', '09:00', '1mo'), '2026-02-28 09:00', 'a calendar month');
  assert.equal(opts.reachEnd('2026-08-31', '09:00', '6mo'), '2027-02-28 09:00');
  assert.equal(opts.reachEnd('2026-10-29', '', '1d'), '');
  assert.equal(opts.reachEnd('2026-10-29', '09:00', 'never'), '');
});

test('chances are said roughly, and coloured by how sure', () => {
  assert.equal(opts.chance(0.91), 'about 91%');
  assert.equal(opts.chance(0.02), 'under 5%');
  assert.equal(opts.chance(undefined), 'under 5%');
  assert.deepEqual([opts.tone(0.9), opts.tone(0.6), opts.tone(0.1)], ['ok', 'warn', 'bad']);
});

test('one option, in words', () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime();
  const d = opts.describe(option, (date) => `[${date}]`, now);
  assert.equal(d.label, 'Best bet');
  assert.equal(d.place, 'Within 15 mi of 95050');
  assert.equal(d.asks, 'anything up to [2026-10-28], 09:00, then 1 day more');
  assert.equal(d.chance, 'about 91%');
  assert.equal(d.by, 'of an appointment by [2026-10-29], 09:00');
  assert.equal(d.likely, 'likely booked within a day');
  assert.equal(opts.likely('2026-10-24 15:00', now), 'likely booked within hours');
  assert.equal(opts.likely('2026-10-28 12:00', now), 'likely booked within 4 days');
  assert.equal(opts.likely(null, now), '');
});

test('using one fills the date, time, reach, and its place when it has one', () => {
  assert.deepEqual(opts.apply(option), {
    preferred_date: '2026-10-28', preferred_time: '09:00', if_passed: '1d',
    office_mode: 'radius', origin: '95050', radius_miles: 15,
  });
  assert.deepEqual(opts.apply({ ...option, place: null }), {
    preferred_date: '2026-10-28', preferred_time: '09:00', if_passed: '1d',
  });
});

test('what they are worked out from, and when it is rough', () => {
  assert.match(opts.basis({ basis: { days: 7, openings: 198 } }), /198 openings seen on this line in the last 7 days/);
  assert.match(opts.basis({ basis: { days: 7, openings: 1, rough: true } }), /1 opening seen.*rough/);
});
