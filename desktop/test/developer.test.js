'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, isMock, sitesFor, TEST_ONLY } = require('../src/developer');

const storeOf = (saved = {}) => ({ get: (key, fallback) => (key in saved ? saved[key] : fallback) });

test('developer mode is off unless somebody turned it on', () => {
  assert.deepEqual(resolve({ store: storeOf() }), { on: false, forced: null });
  assert.deepEqual(resolve({ store: storeOf({ developerMode: true }) }), { on: true, forced: null },
    'View → Developer mode, remembered');
  assert.deepEqual(resolve({ store: storeOf({ developerMode: false }) }), { on: false, forced: null });
  assert.deepEqual(resolve({ store: storeOf({ developerMode: 'yes' }) }), { on: false, forced: null },
    'only a real yes counts');
});

test('--developer, or REGBOT_DEVELOPER=1, turns it on for the run, and the menu cannot turn it off', () => {
  assert.deepEqual(resolve({ argv: { developer: true }, store: storeOf() }), { on: true, forced: 'flag' });
  assert.deepEqual(resolve({ argv: { developer: 'true' }, store: storeOf() }), { on: true, forced: 'flag' });
  assert.deepEqual(resolve({ env: { REGBOT_DEVELOPER: '1' }, store: storeOf() }), { on: true, forced: 'flag' });
  assert.deepEqual(resolve({ env: { REGBOT_DEVELOPER: '0' }, store: storeOf() }), { on: false, forced: null });
  assert.deepEqual(resolve({ argv: { developer: 'false' }, store: storeOf({ developerMode: true }) }),
    { on: true, forced: null }, 'not a flag that says no: the remembered choice stands');
});

test('practising on this computer is developer mode, whatever else says', () => {
  assert.deepEqual(resolve({ practice: true, store: storeOf({ developerMode: false }) }), { on: true, forced: 'practice' });
  assert.deepEqual(resolve({ practice: true, argv: { developer: true }, store: storeOf() }), { on: true, forced: 'practice' });
});

test('a made-up site is the one the server says is — or, from an older server, one the robots do not work', () => {
  assert.equal(isMock({ slug: 'helios-arena', connector: 'helios.arena.boxoffice', mock: true }), true);
  assert.equal(isMock({ slug: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', mock: false }), false);
  // The server's word wins over the guess, either way.
  assert.equal(isMock({ connector: 'dmv.ca.gov.qmatic', mock: true }), true);
  assert.equal(isMock({ connector: 'somewhere.new', mock: false }), false);
  // A server from before it said so: only the California DMV is real there.
  assert.equal(isMock({ connector: 'dmv.ca.gov.qmatic' }), false);
  assert.equal(isMock({ connector: 'clinic.meridian.hl7' }), true);
  // Nothing to go on (a position from an older server): not called a test site.
  assert.equal(isMock({ queue_id: 3 }), false);
  assert.equal(isMock(null), false);
});

test('test sites are listed only in developer mode, and marked whenever they are', () => {
  const sites = [
    { slug: 'helios-arena', name: 'Helios Arena', connector: 'helios.arena.boxoffice', mock: true },
    { slug: 'ca-dmv', name: 'California DMV', connector: 'dmv.ca.gov.qmatic', mock: false },
    { slug: 'old-clinic', name: 'Clinic', connector: 'clinic.meridian.hl7' },
  ];
  assert.deepEqual(sitesFor(sites, false).map((s) => [s.slug, s.mock]), [['ca-dmv', false]]);
  assert.deepEqual(sitesFor(sites, true).map((s) => [s.slug, s.mock]),
    [['helios-arena', true], ['ca-dmv', false], ['old-clinic', true]]);
  assert.deepEqual(sitesFor(undefined, true), []);
  assert.equal(sites[2].mock, undefined, 'the server\'s list is not changed under it');
  assert.match(TEST_ONLY, /developer mode/);
});
