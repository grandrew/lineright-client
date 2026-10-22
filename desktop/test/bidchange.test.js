'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const change = require('../ui/bidchange');

const coins = (n) => `⧗${Number(n).toLocaleString()}`;
const mine = {
  bid_id: 5, amount: 160, preferred_date: '2026-10-20', preferred_time: '11:30', if_passed: '1d',
  place: { office_mode: 'radius', origin: '95050', origin_label: '95050', radius_miles: 5 },
};

test('the office choices start with the bid as it is, and only ever widen it', () => {
  const ranges = change.placeChoices(mine.place);
  assert.equal(ranges[0].value, '');
  assert.equal(ranges[0].fields, null);
  assert.match(ranges[0].label, /Within 5 miles of 95050 \(as now\)/);
  assert.deepEqual(ranges.slice(1).map((c) => c.fields.radius_miles), [10, 15, 25, 40, 60, 100, 150, 250]);
  const named = change.placeChoices({ office_mode: 'specific', office: 'Poway', office_name: 'Poway' });
  assert.match(named[0].label, /Only Poway \(as now\)/);
  assert.deepEqual(named[1].fields, { office_mode: 'radius', origin: 'Poway', radius_miles: 5 });
  assert.match(named[1].label, /Poway, and any office within 5 miles of it/);
  assert.equal(change.placeChoices(null).length, 1, 'any office is as wide as it gets');
});

test('the reach goes out from where it is, and an old bid with none is left alone', () => {
  assert.deepEqual(change.reachChoices('1d').map((c) => c.value), ['1d', '5d', '2w', '1mo', '6mo']);
  assert.match(change.reachChoices('1d')[0].label, /Within 1 day \(as now\)/);
  assert.deepEqual(change.reachChoices(null), []);
});

test('only what differs from the bid is sent', () => {
  const as = { place: '', date: mine.preferred_date, time: mine.preferred_time, reach: '1d', amount: 160 };
  assert.deepEqual(change.body(as, mine), {});
  assert.deepEqual(change.body({ ...as, place: '15' }, mine), { fields: { radius_miles: 15 } });
  assert.deepEqual(change.body({ ...as, date: '2026-10-28', reach: '5d', amount: 71 }, mine),
    { preferred_date: '2026-10-28', if_passed: '5d', amount: 71 });
  assert.deepEqual(change.body({ ...as, amount: 'x' }, mine), {}, 'not a number is not an amount');
  assert.equal(change.shapeKey({ ...as, amount: 71 }), change.shapeKey(as), 'the amount alone needs no new quote');
  assert.notEqual(change.shapeKey({ ...as, place: '15' }), change.shapeKey(as));
});

test('the Save button says what it will do', () => {
  const as = { place: '', date: mine.preferred_date, time: mine.preferred_time, reach: '1d', amount: 160 };
  assert.equal(change.saveLabel(as, mine, coins), 'Nothing changed yet');
  assert.equal(change.saveLabel({ ...as, amount: 71 }, mine, coins), 'Lower to ⧗71 · ⧗89 back');
  assert.equal(change.saveLabel({ ...as, amount: 200 }, mine, coins), 'Raise to ⧗200 · +⧗40');
  assert.equal(change.saveLabel({ ...as, place: '25', amount: 100 }, mine, coins), 'Save the change · ⧗60 back');
  assert.equal(change.saveLabel({ ...as, reach: '2w' }, mine, coins), 'Save the change');
});

test('how soon, and what each amount buys, in a few words', () => {
  assert.equal(change.duration(50), 'about a minute');
  assert.equal(change.duration(600), 'about 10 minutes');
  assert.equal(change.duration(3 * 3600 + 600), 'about 3 hours');
  assert.equal(change.duration(3 * 86400), 'about 3 days');
  assert.equal(change.soon({ turns: 3, first_turn_s: 600, likely_s: 600, fitting: 40 }), 'likely booked in about 10 minutes');
  assert.equal(change.soon({ turns: 3, first_turn_s: 600, likely_s: 4200, fitting: 40 }), 'first turn in about 10 minutes, likely booked in about an hour'.replace('about an hour', change.duration(4200)));
  assert.match(change.soon({ turns: 1, first_turn_s: 600, likely_s: 600, fitting: 2, thin: true }), /few openings seen/);
  assert.equal(change.soon({ turns: 0, fitting: 0 }), 'no opening that fits was seen lately');
  assert.equal(change.soon({ turns: 0, fitting: 9 }, 28), 'no turn in the next 28 days');
  const opt = (label, standing) => ({ label, standing: { rivals_ahead: 2, ...standing } });
  assert.equal(change.title(opt('current')), 'As now');
  assert.equal(change.title(opt('first', { rivals_ahead: 0 })), 'First for your offices');
  assert.equal(change.title(opt('less', { rivals_ahead: 0 })), 'First, for less');
  assert.equal(change.title(opt('less')), '2 ahead for your offices, for less');
  assert.equal(change.title(opt('out')), 'None of your offices offers this line');
  assert.equal(change.title(opt('more', { rivals_ahead: 1 })), '1 ahead for your offices');
  assert.equal(change.deltaText(-89, coins), '⧗89 back');
  assert.equal(change.deltaText(16, coins), '+⧗16');
  assert.equal(change.deltaText(0, coins), '');
});
