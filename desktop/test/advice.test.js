'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const banner = require('../ui/advice');

const radius = {
  bid_id: 2, kind: 'radius', key: '2:radius:15', queue_name: 'Driver licence',
  from_radius: 5, radius_miles: 15, office_name: 'Pleasanton',
  slot_date: '2026-10-20', slot_time: '15:30', miles: 12.4,
};

test('a suggestion is shown, and a turn on the banner hides it', () => {
  assert.equal(banner.visible({ advice: radius, handoffs: [] }, {}), radius);
  assert.equal(banner.visible({ advice: radius, handoffs: [{ job_id: 1 }] }, {}), null);
  assert.equal(banner.visible({ advice: null, handoffs: [] }, {}), null);
  assert.equal(banner.visible({ advice: { kind: 'other', key: 'x' } }, {}), null);
});

// The server's matrix (regbot/advice.py) words its own suggestions.
const reach = {
  bid_id: 2, kind: 'reach', key: '2:reach:2w', queue_name: 'Driver licence',
  title: 'What would have worked',
  text: 'In the last 2 days, 35 openings from Mon Oct 26 to Tue Nov 3 came up at your offices after your bid had stopped taking that late.',
  action: 'Look 2 weeks out', change: { if_passed: '2w' }, if_passed: '2w',
  office_name: 'Santa Clara', slot_date: '2026-10-26', slot_time: '08:00',
};
const best = {
  bid_id: 2, kind: 'config', key: '2:config:v0:5d', title: 'Best bet',
  text: 'Within 10 mi of 95050, anything up to Sun Oct 25 at 12:00, then 5 days more: about 99%.',
  action: 'Use this', change: { preferred_date: '2026-10-25', preferred_time: '12:00', if_passed: '5d' },
  slot_date: '2026-10-25', slot_time: '12:00', chance: 0.99, chance_now: 0,
};

test('a suggestion the site words itself is shown in its words', () => {
  assert.equal(banner.visible({ advice: reach, handoffs: [] }, {}), reach);
  assert.equal(banner.title(reach), 'What would have worked');
  assert.equal(banner.sentence(reach), reach.text);
  assert.equal(banner.actionLabel(reach), 'Look 2 weeks out');
  assert.ok(banner.changes(reach));
  assert.equal(banner.title(radius), 'A better opening', 'one from before keeps its title');
  assert.match(banner.sentence(radius), /Widen the range from 5 to 15 miles/);
  const turns = { bid_id: 2, kind: 'turns', key: '2:turns:2', text: 'Two went unbooked.', action: 'Open Settings', change: null };
  assert.equal(banner.visible({ advice: turns, handoffs: [] }, {}), turns);
  assert.equal(banner.changes(turns), false, 'a setting here, not a change to the bid');
});

test('the best way to ask is its own bar, unless it is the suggestion or closed', () => {
  const doc = { advice: reach, best, handoffs: [] };
  assert.equal(banner.best(doc, {}, reach), best);
  assert.equal(banner.best({ ...doc, best: { ...best, key: reach.key } }, {}, reach), null, 'not twice');
  assert.equal(banner.best({ ...doc, handoffs: [{ job_id: 1 }] }, {}, reach), null, 'a turn owns the banner');
  assert.equal(banner.best(doc, banner.remember({}, best), reach), null);
  const sooner = { ...best, slot_date: '2026-10-23' };
  assert.equal(banner.best({ ...doc, best: sooner }, banner.remember({}, best), reach), sooner,
    'back when what it asks for is two days sooner');
  assert.equal(banner.best({ advice: null, best: null }, {}, null), null);
});

test('a suggestion that drops out of one sync stays up for two minutes', () => {
  const doc = { advice: radius, handoffs: [] };
  const first = banner.hold(doc, null, 1000, {});
  assert.equal(first.advice, radius);
  const gap = banner.hold({ advice: null, handoffs: [] }, first, 1000 + 60 * 1000, {});
  assert.equal(gap.advice, radius);
  assert.equal(gap.doc.advice, radius);
  const gone = banner.hold({ advice: null, handoffs: [] }, first, 1000 + banner.HOLD_MS, {});
  assert.equal(gone.advice, null);
  const closed = banner.hold({ advice: null, handoffs: [] }, first, 1000 + 1000, { '2:radius:15': true });
  assert.equal(closed.advice, null);
  const turn = banner.hold({ advice: radius, handoffs: [{ job_id: 1 }] }, null, 1000, {});
  assert.equal(turn.advice, null);
});

test('closing one suggestion leaves a different one visible', () => {
  const gone = { '2:radius:15': true };
  assert.equal(banner.visible({ advice: radius, handoffs: [] }, gone), null);
  const later = { ...radius, key: '2:radius:25', radius_miles: 25 };
  assert.equal(banner.visible({ advice: later, handoffs: [] }, gone), later);
});

test('the words name the change and the opening, and the button names the change', () => {
  const said = banner.sentence(radius, (iso) => iso);
  assert.match(said, /5 to 15 miles/);
  assert.match(said, /Pleasanton/);
  assert.match(said, /2026-10-20 at 15:30/);
  assert.equal(banner.actionLabel(radius), 'Widen to 15 miles');
  const time = { kind: 'time', if_passed: '5d', from_if_passed: '1d', office_name: 'San Jose', slot_date: '2026-10-23', slot_time: '09:00', miles: 3 };
  assert.match(banner.sentence(time), /5 days/);
  assert.match(banner.sentence(time), /instead of 1 day/);
  assert.equal(banner.actionLabel(time), 'Look 5 days out');
  const offices = { kind: 'offices', radius_miles: 15, from_office: 'Santa Clara', office_name: 'San Jose', slot_date: '2026-10-22', slot_time: '10:00', miles: 8 };
  assert.match(banner.sentence(offices), /within 15 miles of Santa Clara/);
  assert.equal(banner.actionLabel(offices), 'Add offices within 15 miles');
});

const later = {
  bid_id: 2, kind: 'time', key: '2:time:2w', queue_name: 'Driver licence or ID card',
  if_passed: '2w', from_if_passed: '5d', office_name: 'Los Gatos',
  slot_date: '2026-11-03', slot_time: '09:40', miles: 8.2,
};

test('a closed suggestion leaves the nearest-opening bar free', () => {
  const bar = require('../ui/situation');
  const situation = { key: '2:LG:2026-11-03:09:40:t', queue_name: 'Driver licence or ID card', office_name: 'Los Gatos',
    slot_date: '2026-11-03', slot_time: '09:40', outside_reach: true };
  const doc = { advice: later, situation, handoffs: [] };
  const shown = banner.hold(doc, null, 1000, {});
  assert.equal(shown.doc.advice, later, 'a suggestion on the banner holds the second bar back');
  const gone = banner.remember({}, later);
  const painted = banner.hold(doc, null, 1000, gone);
  assert.equal(painted.advice, null);
  assert.equal(painted.doc.advice, null, 'closed, it is not in the sync as painted');
  assert.equal(painted.doc.situation, situation);
  const pace = { key: situation.key, closed: 0, nextAt: 0, open: true };
  assert.equal(bar.visible(painted.doc, pace, 1000).show, situation);
  assert.equal(doc.advice, later, 'the sync itself is left as it came');
});

test('a closed suggestion comes back when the opening it points to is a day sooner', () => {
  const gone = banner.remember({}, later);
  assert.equal(gone[later.key], banner.moment(later));
  assert.equal(banner.visible({ advice: later, handoffs: [] }, gone), null, 'the same, still closed');
  const hours = { ...later, slot_date: '2026-11-02', slot_time: '12:00' };
  assert.equal(banner.visible({ advice: hours, handoffs: [] }, gone), null, '22 hours sooner is not enough');
  const latest = { ...later, slot_date: '2026-11-05' };
  assert.equal(banner.visible({ advice: latest, handoffs: [] }, gone), null, 'later stays closed');
  const sooner = { ...later, office_name: 'San Jose', slot_date: '2026-10-26', slot_time: '10:50' };
  assert.equal(banner.visible({ advice: sooner, handoffs: [] }, gone), sooner, 'eight days sooner comes back');
  const again = banner.remember(gone, sooner);
  assert.equal(banner.visible({ advice: sooner, handoffs: [] }, again), null, 'closed again, at the sooner one');
  assert.equal(banner.visible({ advice: later, handoffs: [] }, again), null);
  const undated = { ...later, slot_date: '' };
  assert.equal(banner.visible({ advice: undated, handoffs: [] }, banner.remember({}, undated)), null);
  assert.equal(banner.visible({ advice: sooner, handoffs: [] }, { [later.key]: true }), null, 'closed with no opening known');
});

test('what is closed is saved with its opening; a bare key saved before is forgotten', () => {
  const gone = banner.remember(banner.remember({}, radius), later);
  const saved = JSON.parse(JSON.stringify(banner.saveGone(gone)));
  assert.deepEqual(saved, [[radius.key, banner.moment(radius)], [later.key, banner.moment(later)]]);
  assert.deepEqual(banner.loadGone(saved), gone);
  assert.deepEqual(banner.loadGone(['2:time:2w']), {}, 'saved before 0.3.8: shown once more');
  assert.deepEqual(banner.loadGone([['2:time:2w', null], 'x', [3, 1], null]), { '2:time:2w': null });
  assert.deepEqual(banner.loadGone({}), {});
  let many = {};
  for (let i = 0; i < 50; i += 1) many = banner.remember(many, { ...radius, key: `2:radius:${i}` });
  assert.equal(Object.keys(many).length, 40);
  assert.ok(many['2:radius:49'] && !('2:radius:9' in many), 'the latest are kept');
});
