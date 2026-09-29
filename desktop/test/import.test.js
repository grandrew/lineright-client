'use strict';
/**
 * What an import takes out of a browser, against real browser databases
 * (test/fixtures — see scripts/make-import-fixtures.js).
 *
 * The two that matter most are the negatives: a card number in the browser's
 * key/value store must not come out as a passport number, and a cookie for a
 * site that has nothing to do with regbot must not be read at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/sqlite');
const { pbkdf2 } = require('../src/oscrypt');
const {
  read, cookiesFrom, chosen, addressesFrom, formValuesFrom, formField, tidy, asCookie, covers, hostOf, Candidates,
} = require('../src/import');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const SITES = [
  { slug: 'ca-dmv', name: 'California DMV', origin: 'https://dmv.example.gov' },
  { slug: 'passports', name: 'Passports', origin: 'https://passports.example.gov' },
];
/** What a Linux browser with no keyring encrypts with, which the fixture used. */
const KEYS = { v10: pbkdf2('peanuts', 1) };

test('a saved address becomes profile fields, the most-used one first', () => {
  const candidates = new Candidates();
  const found = addressesFrom(open(fixture('web-data.db')), candidates);
  assert.equal(found, 2);
  const fields = Object.fromEntries(candidates.fields().map((f) => [f.key, f.value]));
  assert.equal(fields.first_name, 'Ada', 'the address she uses beats the one from 2023');
  assert.equal(fields.middle_name, 'Byron');
  assert.equal(fields.last_name, 'Lovelace');
  assert.equal(fields.email, 'ada@example.com');
  assert.equal(fields.city, 'Poway');
  assert.equal(fields.state, 'CA');
  assert.equal(fields.zip, '92064');
  assert.equal(fields.street, '12 Marylebone Road');
  assert.equal(fields.phone, '6505550123', 'a number is left in the shape a form wants');
  // The older address is not thrown away: it is the second thing offered.
  const email = candidates.fields().find((f) => f.key === 'email');
  assert.deepEqual(email.others.map((o) => o.value), ['augusta@example.org']);
  assert.equal(email.from, 'Saved address');
});

test('the address tables Chromium used until 2023 are read the same way', () => {
  const candidates = new Candidates();
  assert.equal(addressesFrom(open(fixture('web-data-legacy.db')), candidates), 1);
  const fields = Object.fromEntries(candidates.fields().map((f) => [f.key, f.value]));
  assert.deepEqual(fields, {
    first_name: 'Ada', middle_name: 'Byron', last_name: 'Lovelace',
    email: 'ada@example.com', phone: '6505550123',
    street: '12 Marylebone Road', city: 'Poway', state: 'CA', zip: '92064',
  });
});

test('what was typed into forms fills the gaps an address cannot', () => {
  const candidates = new Candidates();
  formValuesFrom(open(fixture('web-data.db')), candidates);
  const fields = Object.fromEntries(candidates.fields().map((f) => [f.key, f.value]));
  // No browser keeps a licence number or a date of birth as an address.
  assert.equal(fields.dl_number, 'X9912345');
  assert.equal(fields.dob, '12/10/1815', 'a date is turned into the shape the profile asks for');
  assert.equal(fields.phone, '6505550199');
  assert.equal(fields.email, 'ada@example.com');
});

test('a card number is never offered as anything', () => {
  const candidates = new Candidates();
  formValuesFrom(open(fixture('web-data.db')), candidates);
  const everything = JSON.stringify(candidates.fields());
  assert.doesNotMatch(everything, /4111111111111111|A B LOVELACE/, 'no card number, no cardholder name');
  assert.equal(candidates.fields().some((f) => f.value === '123'), false, 'and no CVV');
  assert.equal(candidates.fields().find((f) => f.key === 'passport'), undefined);
  assert.equal(formField('cardNumber'), null);
  assert.equal(formField('cc-number'), null);
  assert.equal(formField('card_holder_name'), null);
  assert.equal(formField('cvv'), null);
  assert.equal(formField('password'), null);
  assert.equal(formField('searchQuery'), null);
  // And the names that are worth taking still are, however they are written.
  assert.equal(formField('contact.contactFirstName'), 'first_name');
  assert.equal(formField('billing_postal_code'), 'zip');
  assert.equal(formField('emailAddress'), 'email');
});

test('a value is offered in the shape the profile keeps things, or not at all', () => {
  assert.equal(tidy('email', ' ADA@Example.com '), 'ada@example.com');
  assert.equal(tidy('email', 'not an email'), null);
  assert.equal(tidy('phone', '+1 (650) 555-0123'), '6505550123');
  assert.equal(tidy('phone', '+44 20 7946 0958'), '+442079460958');
  assert.equal(tidy('phone', '12'), null);
  assert.equal(tidy('dob', '1815-12-10'), '12/10/1815');
  assert.equal(tidy('dob', '3/2/1984'), '03/02/1984');
  assert.equal(tidy('dob', 'sometime in December'), null);
  assert.equal(tidy('zip', '92064-1234'), '92064-1234');
  assert.equal(tidy('zip', 'not a zip code at all'), null);
  assert.equal(tidy('street', '12 Marylebone Road\nFlat 3'), '12 Marylebone Road, Flat 3');
  assert.equal(tidy('first_name', '   '), null);
});

test('the booking sites are named and counted, everything else is one line with a number', () => {
  const found = cookiesFrom(open(fixture('cookies.db')), { sites: SITES, keys: KEYS, platform: 'linux' });
  const names = found.cookies.map((c) => c.cookie.name).sort();
  assert.deepEqual(names, ['BIG', 'BOUND', 'PRIVATE', 'SESSION', 'flow', 'plain_one']);
  assert.ok(!names.includes('LAST_YEAR'), 'one that expired in 2020 is not worth carrying');
  assert.equal(found.locked, 0);
  assert.deepEqual(found.bySite.map((s) => [s.name, s.count]), [['California DMV', 5]]);
  assert.deepEqual(found.others, { count: 1, hosts: 1 }, 'the cookie for somewhere else is counted, not named');
  // Current Chromium binds a value to its domain by putting the hash of the
  // host key in front of it; that comes off, and a value without one is left
  // exactly as it was.
  assert.equal(found.cookies.find((c) => c.cookie.name === 'BOUND').cookie.value, 'bound-to-this-domain');
  const session = found.cookies.find((c) => c.cookie.name === 'SESSION').cookie;
  assert.equal(session.value, 'the-session-token');
  assert.equal(session.domain, '.dmv.example.gov');
  assert.equal(session.url, 'https://dmv.example.gov/');
  assert.equal(session.secure, true);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, 'lax');
  assert.ok(session.expirationDate > Date.now() / 1000);
  assert.equal(found.cookies.find((c) => c.cookie.name === 'plain_one').cookie.value, 'no-encryption-here',
    'a value the browser never encrypted is taken as it stands');
  assert.equal(found.cookies.find((c) => c.cookie.name === 'BIG').cookie.value.length, 3209);
});

test('nothing is copied but what was ticked', () => {
  const { cookies } = cookiesFrom(open(fixture('cookies.db')), { sites: SITES, keys: KEYS, platform: 'linux' });
  const dmv = ['https://dmv.example.gov'];
  assert.deepEqual(chosen(cookies, { origins: dmv }).map((c) => c.cookie.name).sort(),
    ['BIG', 'BOUND', 'SESSION', 'flow', 'plain_one'], 'the booking site alone leaves the rest behind');
  assert.deepEqual(chosen(cookies, { origins: dmv, others: true }).length, 6, 'and everything means everything');
  assert.deepEqual(chosen(cookies, { others: true }).map((c) => c.cookie.name), ['PRIVATE'],
    'the rest without the booking site is just the rest');
  assert.deepEqual(chosen(cookies, {}), [], 'ticking nothing copies nothing');
  assert.deepEqual(chosen(cookies, { origins: ['https://nowhere.example'] }), []);
});

test('cookies this machine has no key for are counted, not guessed at', () => {
  const found = cookiesFrom(open(fixture('cookies.db')), { sites: SITES, keys: {}, platform: 'linux' });
  assert.equal(found.locked, 5, 'the five encrypted ones, wherever they are for');
  assert.deepEqual(found.cookies.map((c) => c.cookie.name), ['plain_one'], 'the one that was never encrypted');
  assert.deepEqual(found.bySite.map((s) => [s.name, s.count]), [['California DMV', 1]]);
  assert.deepEqual(found.others, { count: 0, hosts: 0 });
});

test('two sites on one host share their cookies, and both are named', () => {
  const { byHost } = require('../src/import');
  const local = [
    { slug: 'ca-dmv', name: 'California DMV', origin: 'http://127.0.0.1:8787' },
    { slug: 'consulate', name: 'Vandenberg Consulate', origin: 'http://127.0.0.1:5000/portal' },
    { slug: 'far', name: 'Somewhere Else', origin: 'https://example.gov' },
  ];
  assert.deepEqual(byHost(local).map((s) => s.name), ['California DMV · Vandenberg Consulate', 'Somewhere Else']);
  assert.deepEqual(byHost(local).map((s) => s.host), ['127.0.0.1', 'example.gov']);
});

test('a host key covers the site, its parent and its subdomains, and nothing else', () => {
  assert.equal(covers('.dmv.example.gov', 'www.dmv.example.gov'), true);
  assert.equal(covers('www.dmv.example.gov', 'www.dmv.example.gov'), true);
  assert.equal(covers('book.dmv.example.gov', 'dmv.example.gov'), true);
  assert.equal(covers('.example.gov.uk', 'www.dmv.example.gov'), false);
  assert.equal(covers('', 'www.dmv.example.gov'), false);
  assert.equal(hostOf('https://www.dmv.example.gov:443/appointments'), 'www.dmv.example.gov');
  assert.equal(hostOf('www.dmv.example.gov/x'), 'www.dmv.example.gov');
});

test('a session cookie carries no expiry, and an insecure one no https', () => {
  const base = { host_key: 'x.example', name: 'n', path: '/', samesite: -1, is_secure: 0, is_httponly: 0, expires_utc: 0, is_persistent: 0 };
  const session = asCookie(base, 'v');
  assert.equal(session.expirationDate, undefined);
  assert.equal(session.url, 'http://x.example/');
  assert.equal(session.domain, undefined, 'a host-only cookie stays host-only');
  // The column names Chromium used before 2018, which some profiles still have.
  const old = asCookie({ ...base, is_secure: undefined, secure: 1, is_httponly: undefined, httponly: 1 }, 'v');
  assert.equal(old.secure, true);
  assert.equal(old.httpOnly, true);
});

test('reading a profile leaves the browser\'s own files alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-import-'));
  const asProfile = {};
  for (const [key, name] of [['details', 'web-data.db'], ['cookies', 'cookies.db']]) {
    asProfile[key] = path.join(dir, name);
    fs.copyFileSync(fixture(name), asProfile[key]);
  }
  const before = Object.values(asProfile).map((f) => fs.statSync(f).mtimeMs);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-scratch-'));
  const found = await read(
    { id: 'chrome', name: 'Google Chrome', product: 'Chrome', dir, known: true },
    { id: 'Default', name: 'Ada', has: asProfile },
    { sites: SITES, platform: 'linux', tmpdir, exec: async () => null },
  );
  assert.equal(found.browser.name, 'Google Chrome');
  assert.equal(found.profile.name, 'Ada');
  assert.equal(found.addresses, 2);
  assert.ok(found.forms >= 4);
  assert.equal(found.fields.find((f) => f.key === 'first_name').value, 'Ada');
  assert.equal(found.fields.find((f) => f.key === 'dl_number').secret, true);
  assert.equal(found.cookies.length, 6, 'the browser has no keyring here, so every "peanuts" value opens');
  assert.deepEqual(found.sites.map((s) => s.name), ['California DMV']);
  assert.deepEqual(found.others, { count: 1, hosts: 1 });
  assert.deepEqual(Object.values(asProfile).map((f) => fs.statSync(f).mtimeMs), before, 'nothing was written to');
  assert.deepEqual(fs.readdirSync(tmpdir), [], 'and the copies it read are gone');
});

test('a browser with nothing in it is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-import-'));
  const found = await read(
    { id: 'chromium', name: 'Chromium', product: 'Chromium', dir, known: true },
    { id: 'Default', name: 'Default', has: {} },
    { sites: SITES, platform: 'linux', tmpdir: dir, exec: async () => null },
  );
  assert.deepEqual(found.fields, []);
  assert.deepEqual(found.cookies, []);
  assert.deepEqual(found.notes, []);
});

test('a database that cannot be read is reported, not thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-import-'));
  const broken = path.join(dir, 'Web Data');
  fs.writeFileSync(broken, 'the browser was in the middle of something');
  const found = await read(
    { id: 'chrome', name: 'Google Chrome', product: 'Chrome', dir, known: true },
    { id: 'Default', name: 'Ada', has: { details: broken } },
    { sites: SITES, platform: 'linux', tmpdir: dir, exec: async () => null },
  );
  assert.deepEqual(found.fields, []);
  assert.match(found.notes[0], /Could not read the saved details/);
});
