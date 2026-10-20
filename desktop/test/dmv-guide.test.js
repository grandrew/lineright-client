'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isoFromCell, guideScript } = require('../src/dmv-guide');

test('a glued full date is still December 1', () => {
  assert.equal(isoFromCell('December 1, 20261Open Times'), '2026-12-01');
  assert.equal(isoFromCell('November 3, 2026 3 Open Times'), '2026-11-03');
});

test('the guide names the office, the date and the time, and does not confirm', () => {
  const script = guideScript({ office_name: 'Santa Clara', date: '2026-12-01', time: '08:10' });
  assert.match(script, /Santa Clara/);
  assert.match(script, /2026-12-01/);
  assert.match(script, /08:10/);
  assert.match(script, /select location/i);
  assert.doesNotMatch(script, /schedule appointment/i);
  assert.doesNotMatch(script, /Confirm/);
});
