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
