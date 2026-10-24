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

test('covering the notice does not make the same opening a new notice', () => {
  const pace = { key: both.key, closed: 0, nextAt: now, open: true };
  const first = bar.announced('', both, pace);
  assert.equal(first.log, true);
  const hidden = bar.announced(first.noted, null, pace);
  assert.equal(hidden.log, false);
  assert.equal(hidden.noted, first.noted);
  const back = bar.announced(hidden.noted, both, pace);
  assert.equal(back.log, false);
  const again = bar.announced('', both, { ...pace, closed: 1 });
  assert.equal(again.log, true);
});

test('a turn or a suggestion hides the notice and does not close it', () => {
  const pace = { key: both.key, closed: 0, nextAt: now, open: true };
  assert.equal(bar.visible({ situation: both, handoffs: [{ job_id: 1 }] }, pace, now).show, null);
  const held = bar.visible({ situation: both, handoffs: [], advice: { key: '2:radius:15' } }, pace, now);
  assert.equal(held.show, null);
  assert.equal(held.pace.open, true);
  assert.equal(bar.visible({ situation: both, handoffs: [], advice: null }, held.pace, now).show, both);
});

const sooner = { ...both, key: '2:CAP:2026-10-22:09:30:mt', office_name: 'Capitola', slot_time: '09:30' };

test('an opening that comes back carries on with its own wait', () => {
  const minute = 60 * 1000;
  const a = bar.visible({ situation: both, handoffs: [] }, null, now);
  assert.equal(a.pace.nextAt, now + bar.GAPS_MS[0]);
  const b = bar.visible({ situation: sooner, handoffs: [] }, a.pace, now + 3 * minute);
  assert.equal(b.show, null);
  assert.equal(b.pace.nextAt, now + 3 * minute + bar.GAPS_MS[0], 'a new one waits its own 5 minutes');
  const back = bar.visible({ situation: both, handoffs: [] }, b.pace, now + 4 * minute);
  assert.equal(back.pace.nextAt, now + bar.GAPS_MS[0], 'back where it was, not 5 minutes from now');
  assert.equal(bar.visible({ situation: both, handoffs: [] }, back.pace, now + 5 * minute).show, both);
});

test('while the bar is up, a new nearest opening takes its place at once', () => {
  const up = bar.visible({ situation: both, handoffs: [] }, null, now);
  const due = bar.visible({ situation: both, handoffs: [] }, up.pace, up.pace.nextAt);
  assert.equal(due.show, both);
  const moved = bar.visible({ situation: sooner, handoffs: [] }, due.pace, due.pace.nextAt + 1000);
  assert.equal(moved.show, sooner);
  assert.equal(moved.pace.closed, 0);
});

test('an opening closed and seen again keeps its longer wait', () => {
  const due = bar.visible({ situation: both, handoffs: [] }, { key: both.key, closed: 0, nextAt: now, open: true }, now);
  const closed = bar.dismiss(due.pace, now);
  const other = bar.visible({ situation: sooner, handoffs: [] }, closed, now + 1000);
  assert.equal(other.show, null, 'the bar was closed, so a new one waits');
  const back = bar.visible({ situation: both, handoffs: [] }, other.pace, now + 2000);
  assert.equal(back.show, null);
  assert.equal(back.pace.closed, 1);
  assert.equal(back.pace.nextAt, now + bar.GAPS_MS[1]);
  const seen = JSON.parse(JSON.stringify(back.pace));
  assert.equal(bar.visible({ situation: both, handoffs: [] }, seen, now + bar.GAPS_MS[1]).show, both, 'and it is saved');
});

test('openings changing back and forth are announced once each', () => {
  const a = { key: both.key, closed: 0, nextAt: now, open: true };
  const b = { key: sooner.key, closed: 0, nextAt: now, open: true };
  const first = bar.announced([], both, a);
  const second = bar.announced(first.noted, sooner, b);
  const third = bar.announced(second.noted, both, a);
  assert.deepEqual([first.log, second.log, third.log], [true, true, false]);
  assert.equal(third.mark, `${both.key}:0`);
  assert.equal(bar.announced(third.noted, both, { ...a, closed: 1 }).log, true, 'shown again after a close is news');
  assert.equal(bar.announced('', both, a).log, true, 'a mark saved by an older app is read as one');
});

test('only the latest openings are remembered', () => {
  let pace = null;
  for (let i = 0; i < 40; i += 1) {
    pace = bar.visible({ situation: { ...both, key: `k${i}` }, handoffs: [] }, pace, now + i).pace;
  }
  assert.ok(Object.keys(pace.seen).length <= 24);
  assert.ok(pace.seen.k38 && !pace.seen.k0);
});
