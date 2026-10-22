'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CLOSE_AFTER_MS, lineOf, keptBecause, spare, spareFor, closeNow } = require('../src/turntabs');

// A turn that went to somebody else, its page read since and nothing on it.
const unused = { live: false, touched: false, booking: false, bookedByHand: false, booked: false,
  confirmationOpen: false, looked: true, shows: false };

test('a line is its queue, and without one the site and the line\'s name', () => {
  assert.equal(lineOf({ queue_id: 9, queue_name: 'REAL ID', site_slug: 'ca-dmv' }), 'queue:9');
  assert.equal(lineOf({ queue_id: 0 }), 'queue:0');
  assert.equal(lineOf({ site_slug: 'ca-dmv', queue_slug: 'real-id', queue_name: 'REAL ID' }), 'ca-dmv:real-id');
  assert.equal(lineOf({ site_slug: 'ca-dmv', queue_name: 'REAL ID' }), 'ca-dmv:REAL ID');
  assert.equal(lineOf(null), '');
});

test('the page of a turn that is over and went unused is spare', () => {
  assert.equal(keptBecause(unused), null);
  assert.equal(spare(unused), true);
});

test('a turn\'s page stays while the turn is going, once the person used it, and while a robot books under it', () => {
  assert.equal(keptBecause({ ...unused, live: true }), 'live');
  assert.equal(keptBecause({ ...unused, touched: true }), 'used');
  assert.equal(keptBecause({ ...unused, booking: true }), 'booking');
  // Used counts for good, however the turn ended.
  assert.equal(spare({ ...unused, touched: true, booked: true, confirmationOpen: true }), false);
});

test('a page showing a booking confirmation stays', () => {
  assert.equal(keptBecause({ ...unused, bookedByHand: true }), 'confirmation');
  assert.equal(keptBecause({ ...unused, shows: true }), 'confirmation');
  // Not read since the turn ended (or since its last load): not known to show none.
  assert.equal(keptBecause({ ...unused, looked: false }), 'unread');
});

test('a turn the robot booked keeps its page unless the DMV\'s confirmation is open in a tab of its own', () => {
  assert.equal(keptBecause({ ...unused, booked: true, confirmationOpen: false }), 'confirmation');
  assert.equal(keptBecause({ ...unused, booked: true, confirmationOpen: true }), null);
});

test('the next turn on a line takes that line\'s spare tab — the one whose turn ended last — and no other', () => {
  const tabs = [
    { id: 1, line: 'queue:9', endedAt: 1000, facts: unused },
    { id: 2, line: 'queue:9', endedAt: 3000, facts: unused },
    { id: 3, line: 'queue:9', endedAt: 5000, facts: { ...unused, touched: true } },
    { id: 4, line: 'queue:9', endedAt: null, facts: { ...unused, live: true } },
    { id: 5, line: 'queue:10', endedAt: 9000, facts: unused },
  ];
  assert.equal(spareFor(tabs, 'queue:9').id, 2);
  assert.equal(spareFor(tabs, 'queue:10').id, 5);
  assert.equal(spareFor(tabs, 'queue:11'), null);
  assert.equal(spareFor(tabs, ''), null);
  assert.equal(spareFor([{ id: 6, line: 'queue:12', endedAt: 1, facts: { ...unused, looked: false } }], 'queue:12'), null);
});

test('a spare tab closes a quarter of an hour after its turn, and not while it is the page on screen', () => {
  assert.equal(CLOSE_AFTER_MS, 15 * 60000);
  const ended = 1_000_000;
  const tab = { facts: unused, endedAt: ended };
  assert.equal(closeNow(tab, ended + CLOSE_AFTER_MS - 1), false);
  assert.equal(closeNow(tab, ended + CLOSE_AFTER_MS), true);
  assert.equal(closeNow({ ...tab, onScreen: true }, ended + 10 * CLOSE_AFTER_MS), false);
  assert.equal(closeNow({ ...tab, facts: { ...unused, touched: true } }, ended + 10 * CLOSE_AFTER_MS), false);
  assert.equal(closeNow({ ...tab, endedAt: null }, ended + 10 * CLOSE_AFTER_MS), false);
  assert.equal(closeNow(tab, ended + 5000, 5000), true, 'how long is the caller\'s to say');
});
