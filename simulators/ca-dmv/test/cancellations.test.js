/**
 * The stand-in's calendar: booked solid, and cancellations as the only way in.
 *
 * This is the shape of the problem the whole project is about. A DMV that has
 * openings next week is not interesting — anybody can have one. A DMV whose
 * next opening is in November, where near dates exist only because somebody
 * cancelled and only until somebody else takes it, is the thing bots compete
 * over, and it is the only calendar against which a latency budget means
 * anything at all.
 *
 * No browser and no timers here: the world is driven by calling it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createState, slotsFor, releaseSlot, releaseCancellations, reclaimStale,
} from '../server.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-21T12:00:00Z');   // a Monday, so dates are stable

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysOut = (date, now = NOW) =>
  Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(iso(now) + 'T00:00:00Z')) / DAY);

/** Every (branch, service) the state can offer, flattened. */
function everything(state, now = NOW) {
  const out = [];
  for (const office of state.offices) {
    for (const service of ['VR', 'RID', 'CID', 'DT']) {
      for (const day of slotsFor(state, office.code, service, now)) {
        for (const time of day.times) out.push({ branch: office.code, service, ...day, time });
      }
    }
  }
  return out;
}

// =========================================================== booked solid
test('the office has nothing at all inside the busy horizon', () => {
  const state = createState({ busyDays: 60, horizonDays: 150 });
  const near = everything(state).filter((s) => daysOut(s.date) < 60);
  assert.deepEqual(near, [], 'a busy DMV has no near dates until somebody cancels');
});

test('the backlog does exist, just out past the horizon', () => {
  const state = createState({ busyDays: 60, horizonDays: 150 });
  const all = everything(state);
  assert.ok(all.length > 0, 'there has to be something bookable out there');
  assert.ok(all.every((s) => daysOut(s.date) >= 60 && daysOut(s.date) <= 150));
});

test('how busy it is, is a knob', () => {
  const soon = createState({ busyDays: 3, horizonDays: 40 });
  assert.ok(everything(soon).some((s) => daysOut(s.date) < 10));
});

// ========================================================== cancellations
test('a cancellation opens a date the backlog would never have offered', () => {
  const state = createState({ busyDays: 60, horizonDays: 150, cancelTtlMs: 60000 });
  let opened = [];
  // The date is random across the window, so ask until one lands up close.
  for (let i = 0; i < 400 && !opened.length; i++) {
    opened = releaseCancellations(state, 1, NOW).filter((r) => daysOut(r.date) < 60);
  }
  assert.ok(opened.length, 'no near cancellation in 400 tries — the spread is wrong');
  const near = opened[0];
  const offered = slotsFor(state, near.branch, near.service, NOW).find((d) => d.date === near.date);
  assert.ok(offered, 'a cancellation must show up in the calendar');
  assert.ok(offered.times.includes(near.time));
});

test('cancellations land across the whole window, not just next week', () => {
  const state = createState({ busyDays: 60, horizonDays: 150, cancelTtlMs: 600000 });
  const opened = releaseCancellations(state, 120, NOW);
  const spread = opened.map((r) => daysOut(r.date));
  assert.ok(Math.min(...spread) < 30, 'nothing near: cancellations are not worth racing for');
  assert.ok(Math.max(...spread) > 100, 'nothing far: the window is not being used');
});

test('one seed, one world', () => {
  const a = createState({ seed: 'fixed' });
  const b = createState({ seed: 'fixed' });
  assert.deepEqual(releaseCancellations(a, 5, NOW).map((r) => `${r.branch}|${r.date}|${r.time}`),
                   releaseCancellations(b, 5, NOW).map((r) => `${r.branch}|${r.date}|${r.time}`));
});

// ================================================================ the race
test('a cancellation nobody claims is gone again, once', () => {
  const state = createState({ cancelTtlMs: 30000 });
  const [slot] = releaseCancellations(state, 1, NOW);
  assert.equal(reclaimStale(state, NOW + 1000), 0, 'not yet — it is still on offer');
  assert.equal(reclaimStale(state, NOW + 31000), 1, 'past its life, somebody else took it');
  assert.equal(reclaimStale(state, NOW + 31000), 0, 'and it is not reported twice');
  assert.equal(state.reclaimed, 1);
  assert.deepEqual(slotsFor(state, slot.branch, slot.service, NOW + 31000)
    .find((d) => d.date === slot.date)?.times.includes(slot.time) ?? false, false);
});

test('a lapsed cancellation stops being offered the moment it lapses', () => {
  // Not when reclaimStale happens to run: a slot the calendar still advertises
  // after its life has ended is one a bot would spend a solve on for nothing.
  const state = createState({ cancelTtlMs: 30000 });
  const [slot] = releaseCancellations(state, 1, NOW);
  const shown = (now) => slotsFor(state, slot.branch, slot.service, now)
    .find((d) => d.date === slot.date)?.times.includes(slot.time) ?? false;
  assert.equal(shown(NOW + 29000), true);
  assert.equal(shown(NOW + 31000), false);
});

test('a time given up again after its last cancellation lapsed opens again', () => {
  // The world sweeps lapsed cancellations away now and then; the same time given
  // up again before the sweep comes round is a new cancellation all the same.
  const state = createState({ cancelTtlMs: 30000 });
  const [slot] = releaseCancellations(state, 1, NOW);
  const shown = (now) => slotsFor(state, slot.branch, slot.service, now)
    .find((d) => d.date === slot.date)?.times.includes(slot.time) ?? false;
  assert.equal(shown(NOW + 31000), false, 'lapsed');
  assert.ok(releaseSlot(state, slot, NOW + 60000), 'released again before any sweep');
  assert.equal(shown(NOW + 61000), true);
  assert.equal(state.reclaimed, 1, 'the lapsed one is counted, once');
  assert.equal(reclaimStale(state, NOW + 61000), 0);
  assert.equal(releaseSlot(state, slot, NOW + 62000), null, 'not twice while it is on offer');
});

test('a cancellation somebody booked is not counted as lost', () => {
  const state = createState({ cancelTtlMs: 30000 });
  const [slot] = releaseCancellations(state, 1, NOW);
  state.taken.add(`${slot.branch}|${slot.service}|${slot.date}|${slot.time}`);
  assert.equal(reclaimStale(state, NOW + 31000), 0);
  assert.equal(state.reclaimed, 0, 'we got it — nobody else took it from us');
});

test('a booked slot never comes back, cancellation or backlog', () => {
  const state = createState({ busyDays: 60, horizonDays: 150 });
  const one = everything(state)[0];
  state.taken.add(`${one.branch}|${one.service}|${one.date}|${one.time}`);
  const again = slotsFor(state, one.branch, one.service, NOW).find((d) => d.date === one.date);
  assert.equal(again?.times.includes(one.time) ?? false, false);
});

// ================================================================= offices
test('how much of the catalogue the stand-in serves is a knob', () => {
  // Twelve is fine for a test and wrong for a run. The catalogue is
  // alphabetical, so the first twelve are Alturas to Blythe — and a board of
  // San Diego bidders matches none of them, fails at office selection, never
  // reaches a calendar and buys no tokens. That looks exactly like "the gate
  // held" and is not, which cost a twenty-minute run once.
  assert.equal(createState({}).offices.length, 12, 'the cheap default is unchanged');
  const all = createState({ officeCount: 0 });
  assert.ok(all.offices.length > 100, '0 means the whole catalogue');
  assert.ok(all.offices.some((o) => o.name === 'Poway'), 'including the ones people bid for');
});
