'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchKey, buildFillScript, isBookingPage, originOf, RULES } = require('../src/autofill');

test('fields are recognised by what they say they are, most specific first', () => {
  assert.equal(matchKey({ label: "Driver's License or Permit Number" }), 'dl_number');
  assert.equal(matchKey({ label: 'Date of Birth | MM/DD/YYYY', attr: 'dob' }), 'dob');
  assert.equal(matchKey({ label: 'First Name' }), 'first_name');
  assert.equal(matchKey({ label: 'Last Name' }), 'last_name');
  assert.equal(matchKey({ label: 'Email Address' }), 'email');
  assert.equal(matchKey({ label: 'Phone Number' }), 'phone');
  assert.equal(matchKey({ label: 'Full name as printed in passport' }), 'full_name');
  assert.equal(matchKey({ label: 'Name' }), 'full_name');
  assert.equal(matchKey({ label: 'Social Security Number' }), 'ssn');
  assert.equal(matchKey({ label: 'Passport number' }), 'passport');
  assert.equal(matchKey({ label: 'ZIP' }), 'zip');
  assert.equal(matchKey({ label: 'Reason for the visit' }), null, 'free text is never guessed');
});

test('autocomplete tokens win, then labels, then types, then names', () => {
  assert.equal(matchKey({ autocomplete: 'given-name', label: 'Name' }), 'first_name');
  assert.equal(matchKey({ autocomplete: 'off', label: 'Last Name' }), 'last_name');
  assert.equal(matchKey({ type: 'email' }), 'email');
  assert.equal(matchKey({ type: 'tel', label: 'Contact' }), 'phone');
  assert.equal(matchKey({ attr: 'fname' }), 'first_name');
  assert.equal(matchKey({ attr: 'lastname' }), 'last_name');
  assert.equal(matchKey({ attr: 'ph' }), null, 'an id that says nothing matches nothing');
  assert.equal(matchKey({ attr: 'statement' }), null);
});

test('the page script is self-contained and carries the same rules', () => {
  const script = buildFillScript({ first_name: 'Ada' }, { force: true });
  assert.match(script, /^\(function pageFill\(values, rules, options\)/);
  assert.ok(script.includes('"first_name":"Ada"'));
  assert.ok(script.includes('"force":true'));
  assert.ok(script.includes(JSON.stringify(RULES[0].label)));
  assert.doesNotMatch(script, /require\(/);
  // eslint-disable-next-line no-new-func
  new Function(script); // parses as a program
});

test('only pages the app itself opened for booking are filled', () => {
  const origins = new Set(['http://127.0.0.1:8787']);
  assert.equal(isBookingPage('http://127.0.0.1:8787/portal/appointments/details?hold=1', origins), true);
  assert.equal(isBookingPage('http://127.0.0.1:5000/console', origins), false);
  assert.equal(isBookingPage('not a url', origins), false);
  assert.equal(originOf('https://www.dmv.ca.gov/portal/x'), 'https://www.dmv.ca.gov');
  assert.equal(originOf(''), null);
});
