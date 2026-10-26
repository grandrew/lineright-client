'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bar = require('../ui/widened');

const one = {
  key: 'w:7', bid_id: 2, queue_id: 7, queue_name: 'Driver licence or ID card',
  from_if_passed: '5d', if_passed: '2w', until: '2026-11-03 11:30', at: '2026-10-25T18:31:00Z',
};

test('each widening is a row until it is closed', () => {
  const doc = { widened: [one, { ...one, key: 'w:6', from_if_passed: '1d', if_passed: '5d' }], handoffs: [] };
  assert.deepEqual(bar.visible(doc, []).map((w) => w.key), ['w:7', 'w:6']);
  const gone = bar.remember([], 'w:7');
  assert.deepEqual(bar.visible(doc, gone).map((w) => w.key), ['w:6']);
  assert.deepEqual(bar.visible({ ...doc, handoffs: [{ job_id: 1 }] }, []), [], 'a turn owns the banner');
  assert.deepEqual(bar.visible({}, []), []);
  assert.deepEqual(bar.visible({ widened: [null, { key: '' }, one] }, []).map((w) => w.key), ['w:7']);
  const many = { widened: Array.from({ length: 6 }, (_, i) => ({ ...one, key: `w:${i}` })) };
  assert.equal(bar.visible(many, []).length, bar.SHOWN);
});

test('closed ones are kept, the latest forty', () => {
  let gone = [];
  for (let i = 0; i < 45; i += 1) gone = bar.remember(gone, `w:${i}`);
  assert.equal(gone.length, 40);
  assert.equal(gone[39], 'w:44');
  assert.deepEqual(bar.remember(['w:1', 'w:2'], 'w:1'), ['w:2', 'w:1'], 'closing again moves it last');
  assert.deepEqual(bar.loadGone(['w:1', 3, '', null, 'w:2']), ['w:1', 'w:2']);
  assert.deepEqual(bar.loadGone({}), []);
});

test('it says what changed and up to when', () => {
  const said = bar.sentence(one, (d) => `<${d}>`);
  assert.match(said, /^Driver licence or ID card: its time passed with nothing booked/);
  assert.match(said, /looks 2 weeks past your time instead of 5 days/);
  assert.match(said, /up to <2026-11-03> at 11:30/);
  assert.match(said, /keeps widening each day/);
});

test('it says how likely a booking is now, when the site says', () => {
  const said = bar.sentence({ ...one, chance: 0.99, chance_until: '2026-11-03 11:30' }, (d) => `<${d}>`);
  assert.match(said, /— about 99% chance of an appointment by <2026-11-03>\./);
  assert.equal(bar.chance({ ...one, chance: 0.01 }), 'under 5% chance of an appointment');
  assert.equal(bar.chance(one), '');
});
