'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outsideReach, reachEnd, wall } = require('../src/reach');

const pref = wall('2026-10-19', '11:30');

test('five hours from 11:30 ends at 16:30 the same day', () => {
  assert.equal(new Date(reachEnd(pref, '5h')).toISOString(), '2026-10-19T16:30:00.000Z');
});

test('the 29th is outside a five-hour choice and inside two weeks', () => {
  const asked = {
    preferredDate: '2026-10-19', preferredTime: '11:30',
    slotDate: '2026-10-29', slotTime: '14:20',
    nowMs: Date.parse('2026-10-19T19:00:00'),
  };
  assert.equal(outsideReach({ ...asked, code: '5h' }), true);
  assert.equal(outsideReach({ ...asked, code: '1d' }), true);
  assert.equal(outsideReach({ ...asked, code: '5d' }), true);
  assert.equal(outsideReach({ ...asked, code: '2w' }), false);
});

test('thirty minutes later is inside five hours', () => {
  assert.equal(outsideReach({
    preferredDate: '2026-10-19', preferredTime: '11:30', code: '5h',
    slotDate: '2026-10-19', slotTime: '12:00',
    nowMs: Date.parse('2026-10-19T11:40:00'),
  }), false);
});

test('before the moment a later slot is outside and an earlier one is not', () => {
  const early = {
    preferredDate: '2026-10-19', preferredTime: '11:30', code: '5h',
    nowMs: Date.parse('2026-10-19T09:00:00'),
  };
  assert.equal(outsideReach({ ...early, slotDate: '2026-10-19', slotTime: '10:00' }), false);
  assert.equal(outsideReach({ ...early, slotDate: '2026-10-19', slotTime: '12:00' }), true);
});

test('a turn is held to the reach the server sends, which may have widened by itself', () => {
  const { reachFor } = require('../src/reach');
  assert.equal(reachFor({ if_passed: '2w' }, '5d'), '2w', 'widened on the site since it was chosen here');
  assert.equal(reachFor({ if_passed: null }, '5d'), '5d', 'a server that sends none');
  assert.equal(reachFor(undefined, '1d'), '1d');
  assert.equal(reachFor({ if_passed: 'later' }, 'nonsense'), '');
  assert.equal(reachFor(null, undefined), '');
});
