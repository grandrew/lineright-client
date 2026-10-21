'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bar = require('../ui/situation');

const both = {
  bid_id: 2, key: '2:HAY:2026-10-22:08:40:mt', queue_name: 'Driver licence or ID card',
  empty: false, office_name: 'Hayward', slot_date: '2026-10-22', slot_time: '08:40',
  miles: 22.6, radius_miles: 5, accept_until: '2026-10-21 11:30',
  outside_miles: true, outside_reach: true, other_office: false, passed: false,
  can_take: null,
};

const now = 1_000_000;

test('the words name the opening and why it is not taken, and ask for nothing', () => {
  const said = bar.sentence(both, (iso) => iso);
  assert.match(said, /Hayward on 2026-10-22 at 08:40/);
  assert.match(said, /22\.6 mi/);
  assert.match(said, /outside your 5-mile range/);
  assert.match(said, /2026-10-21 at 11:30/);
  assert.match(said, /Nothing you can take is open/);
  assert.doesNotMatch(said, /Widen|Apply|Look /);
});

test('an opening inside the ask is said to be inside it', () => {
  const said = bar.sentence({
    ...both, outside_miles: false, outside_reach: false, key: '2:SC:2026-10-20:16:00:ok',
    office_name: 'Santa Clara', miles: 2.3,
  }, (iso) => iso);
  assert.match(said, /inside your 5-mile range/);
  assert.doesNotMatch(said, /Nothing you can take/);
});

test('a passed opening says so, and names the one they can still take', () => {
  const said = bar.sentence({
    ...both, outside_miles: false, outside_reach: false, passed: true,
    can_take: { office_name: 'San Jose', slot_date: '2026-10-20', slot_time: '16:30', miles: 4.9 },
  }, (iso) => iso);
  assert.match(said, /already passed/);
  assert.match(said, /San Jose on 2026-10-20 at 16:30/);
});

test('an empty line says nothing is open', () => {
  assert.match(bar.sentence({ empty: true, queue_name: 'Driver licence or ID card', key: '2:none' }), /Nothing is open on Driver licence/);
});

test('the bar waits 5 minutes, then 30 minutes, then 5 hours', () => {
  const doc = { situation: both, handoffs: [], advice: null };
  const first = bar.visible(doc, null, now);
  assert.equal(first.show, null);
  assert.equal(first.pace.nextAt, now + bar.GAPS_MS[0]);
  assert.equal(bar.GAPS_MS[0], 5 * 60 * 1000);

  const due = bar.visible(doc, first.pace, first.pace.nextAt);
  assert.equal(due.show, both);

  const after = bar.dismiss(due.pace, due.pace.nextAt);
  assert.equal(after.open, false);
  assert.equal(after.nextAt - due.pace.nextAt, 30 * 60 * 1000);

  const second = bar.visible(doc, after, after.nextAt);
  assert.equal(second.show, both);
  const later = bar.dismiss(second.pace, second.pace.nextAt);
  assert.equal(later.nextAt - second.pace.nextAt, 5 * 60 * 60 * 1000);

  const third = bar.visible(doc, later, later.nextAt);
  const again = bar.dismiss(third.pace, third.pace.nextAt);
  assert.equal(again.nextAt - third.pace.nextAt, 5 * 60 * 60 * 1000);
});

test('a different opening starts the 5 minutes over', () => {
  const doc = { situation: both, handoffs: [] };
  const due = bar.visible(doc, null, now + bar.GAPS_MS[0]);
  const moved = { ...both, key: '2:CAP:2026-10-22:09:30:mt', office_name: 'Capitola' };
  const again = bar.visible({ situation: moved, handoffs: [] }, due.pace, now + bar.GAPS_MS[0]);
  assert.equal(again.show, null);
  assert.equal(again.pace.nextAt, now + bar.GAPS_MS[0] + bar.GAPS_MS[0]);
});

test('a turn or a suggestion hides the notice and does not close it', () => {
  const pace = { key: both.key, closed: 0, nextAt: now, open: true };
  assert.equal(bar.visible({ situation: both, handoffs: [{ job_id: 1 }] }, pace, now).show, null);
  const held = bar.visible({ situation: both, handoffs: [], advice: { key: '2:radius:15' } }, pace, now);
  assert.equal(held.show, null);
  assert.equal(held.pace.open, true);
  assert.equal(bar.visible({ situation: both, handoffs: [], advice: null }, held.pace, now).show, both);
});
