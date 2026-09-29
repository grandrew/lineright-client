'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prefillFromUrl } = require('../src/portal');

test('a times page carries the office, service and date', () => {
  assert.deepEqual(prefillFromUrl('http://127.0.0.1:8787/portal/appointments/times?branch=POWAY%203&service=rid&date=2026-10-06'),
    { office_code: 'POWAY 3', service: 'RID', slot_date: '2026-10-06' });
});

test('a calendar page carries the office only', () => {
  assert.deepEqual(prefillFromUrl('https://www.dmv.ca.gov/portal/appointments/select-date?branch=X&service=VR'),
    { office_code: 'X', service: 'VR' });
});

test('anything else is nothing to prefill', () => {
  assert.deepEqual(prefillFromUrl('http://127.0.0.1:5000/console'), {});
  assert.deepEqual(prefillFromUrl('http://x/portal/appointments/times?date=next-week'), {});
  assert.deepEqual(prefillFromUrl('not a url'), {});
  assert.deepEqual(prefillFromUrl(null), {});
});
