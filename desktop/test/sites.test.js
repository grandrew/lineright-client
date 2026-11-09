'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { siteOf, siteWords, connectorOf } = require('../src/sites');

const camp = { robot: { base_url: 'https://www.recreation.gov', request: { target: { connector: 'recreation.gov.camps' } } } };

test('a turn says its site by its robot\'s connector; a booking by its own, or its page\'s host', () => {
  assert.equal(siteOf(camp).key, 'rgov');
  assert.equal(connectorOf(camp), 'recreation.gov.camps');
  assert.equal(siteOf({ connector: 'recreation.gov.camps' }).key, 'rgov');
  assert.equal(siteOf({ manage_url: 'https://www.recreation.gov/camping/reservations/0123456789' }).key, 'rgov');
  assert.equal(siteOf({ open_url: 'https://www.dmv.ca.gov/portal/appointments/' }).key, 'dmv');
  assert.equal(siteOf('recreation.gov.camps').name, 'Recreation.gov');
});

test('anything that says neither is the DMV\'s, as everything was before there were two', () => {
  for (const of of [null, undefined, {}, { manage_url: 'not a url' }, { connector: 'tickets.example' },
    { manage_url: 'https://recreation.gov.example/x' }, 'dmv.ca.gov.qmatic']) {
    assert.equal(siteOf(of).key, 'dmv', JSON.stringify(of));
  }
  assert.equal(connectorOf({}), '');
});

test('what the renderer gets is the words, not the robots\' wiring', () => {
  assert.deepEqual(siteWords(camp), { key: 'rgov', name: 'Recreation.gov', Name: 'Recreation.gov', their: "Recreation.gov's",
    thing: 'reservation' });
  assert.equal(siteWords({}).thing, 'appointment');
});
