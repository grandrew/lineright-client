'use strict';
/**
 * What a line asks for against what the profile holds.
 *
 * This is the rule that decides whether a bid can be placed and whether a
 * booking page is opened, so the cases worth pinning are the two ways it could
 * be wrong: letting somebody bid on a line whose form the app cannot fill in,
 * and — the one that would be worse — refusing a bid over a field no profile
 * could ever hold. Five of the six seeded sites ask for something of that kind
 * (a fan-club number, an insurance member id), so a rule that demanded
 * everything would make them unbiddable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const needs = require('../src/needs');

const DMV = [
  { key: 'dl_number', label: 'Driver licence or permit number', sensitive: true },
  { key: 'dob', label: 'Date of birth', sensitive: true },
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'email', label: 'Email for the DMV confirmation', required: true, sensitive: true },
  { key: 'phone', label: 'Mobile number', required: true, sensitive: true },
];
const FULL = { first_name: 'Ada', last_name: 'Lovelace', dob: '12/10/1815',
               dl_number: 'A1234567', email: 'ada@example.test', phone: '5555550123' };

test('an empty profile is missing everything the line can keep for you', () => {
  const missing = needs.missing(DMV, {});
  assert.deepEqual(missing.map((f) => f.key),
    ['dl_number', 'dob', 'first_name', 'last_name', 'email', 'phone']);
  assert.equal(needs.ready(DMV, {}), false);
});

test('a filled profile is ready, whatever the site called the fields', () => {
  assert.equal(needs.ready(DMV, FULL), true);
  assert.equal(needs.ready([{ key: 'licence_no', label: 'Driving licence number' },
                            { key: 'date_of_birth', label: 'Date of birth' },
                            { key: 'mobile', label: 'Mobile for the reminder SMS' }], FULL), true,
    'licence_no, date_of_birth and mobile are the same three fields under other names');
});

test('a field nothing here could hold never blocks anything', () => {
  // Helios asks for a fan club member number and Meridian for an insurance id.
  // The person types those on the site's own form; the app has nowhere to keep
  // them, so requiring them would simply make those lines unbiddable.
  const helios = [{ key: 'full_name', label: 'Name on the membership', required: true },
                  { key: 'member_id', label: 'Fan club member number', required: true },
                  { key: 'ticket_ref', label: 'Ticket reference', required: true }];
  assert.deepEqual(needs.missing(helios, FULL), []);
  assert.deepEqual(needs.status(helios, FULL).map((f) => f.state), ['held', 'on-form', 'on-form']);
});

test('a full name is held as the two fields it is made of', () => {
  const field = [{ key: 'full_name', label: 'Full name as printed in passport', required: true }];
  assert.equal(needs.ready(field, { first_name: 'Ada' }), false, 'half a name is not a name');
  assert.equal(needs.ready(field, { first_name: 'Ada', last_name: 'Lovelace' }), true);
  assert.equal(needs.ready(field, { full_name: 'Ada Lovelace' }), true, 'or the derived one');
});

test('blank and whitespace are not answers', () => {
  assert.equal(needs.ready(DMV, { ...FULL, phone: '   ' }), false);
  assert.equal(needs.ready(DMV, { ...FULL, email: '' }), false);
});

test('it says what is wanted in a sentence a person can read', () => {
  const missing = needs.missing(DMV, { first_name: 'Ada', last_name: 'Lovelace' });
  assert.equal(needs.phrase(missing),
    'driver licence or permit number, date of birth, email for the dmv confirmation and mobile number');
  assert.equal(needs.phrase(needs.missing([DMV[2]], {})), 'first name');
  assert.equal(needs.phrase([]), '');
});

test('nothing asked for is nothing to ask about', () => {
  assert.deepEqual(needs.missing([], FULL), []);
  assert.deepEqual(needs.missing(undefined, {}), []);
  assert.equal(needs.ready([], {}), true);
});
