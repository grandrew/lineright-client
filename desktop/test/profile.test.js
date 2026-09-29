'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Profile, clean, values, FIELDS } = require('../src/profile');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-profile-')), 'profile.json');

/** A stand-in for Electron's safeStorage: reversible, and it can be "unavailable". */
function fakeSafe({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => (available ? 'gnome_libsecret' : 'basic_text'),
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => { const t = b.toString(); if (!t.startsWith('enc:')) throw new Error('bad'); return t.slice(4); },
  };
}

test('unknown keys are dropped, blanks are dropped, and the full name is derived', () => {
  assert.deepEqual(clean({ first_name: ' Ada ', last_name: 'Lovelace', junk: 'x', phone: '' }), { first_name: 'Ada', last_name: 'Lovelace' });
  assert.deepEqual(values({ first_name: 'Ada', middle_name: 'K', last_name: 'Lovelace' }).full_name, 'Ada K Lovelace');
  assert.equal(values({ email: 'a@b' }).full_name, undefined);
  assert.ok(FIELDS.some((f) => f.key === 'ssn' && f.secret));
});

test('with a keychain the file is encrypted, and reads back', () => {
  const file = tmp();
  const p = new Profile(file, fakeSafe());
  assert.equal(p.view().filled, 0);
  p.set({ first_name: 'Ada', ssn: '123-45-6789' }, { autofill: false });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.enc, 'safeStorage');
  assert.doesNotMatch(JSON.stringify(raw), /Ada|6789/, 'nothing readable on disk');
  assert.equal(raw.autofill, false);
  const again = new Profile(file, fakeSafe());
  assert.deepEqual(again.data, { first_name: 'Ada', ssn: '123-45-6789' });
  assert.equal(again.encrypted, true);
  assert.equal(again.autofill, false);
  assert.equal(again.view().backend, 'gnome_libsecret');
});

test('without a keychain the file is plain and the view says so', () => {
  const file = tmp();
  const p = new Profile(file, fakeSafe({ available: false }));
  p.set({ last_name: 'Lovelace' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.enc, 'plain');
  assert.deepEqual(raw.data, { last_name: 'Lovelace' });
  const v = new Profile(file, fakeSafe({ available: false })).view();
  assert.equal(v.encrypted, false);
  assert.equal(v.available, false);
  assert.match(v.backend, /basic_text/);
  // And with no safeStorage at all (tests, odd builds) it still works.
  assert.deepEqual(new Profile(file, null).data, { last_name: 'Lovelace' });
});

test('an encrypted file on a machine without that keychain is reported, not lost silently', () => {
  const file = tmp();
  new Profile(file, fakeSafe()).set({ first_name: 'Ada' });
  const p = new Profile(file, fakeSafe({ available: false }));
  assert.deepEqual(p.data, {});
  assert.match(p.view().error, /keychain/);
  p.set({ first_name: 'Ada' });
  assert.equal(p.view().error, null);
});

test('clear removes the file', () => {
  const file = tmp();
  const p = new Profile(file, null);
  p.set({ email: 'a@b' });
  assert.ok(fs.existsSync(file));
  p.clear();
  assert.ok(!fs.existsSync(file));
  assert.equal(p.view().filled, 0);
});

test('each field remembers where it came from, kept encrypted with the values', () => {
  const file = tmp();
  const p = new Profile(file, fakeSafe());
  p.merge({ email: 'ada@example.com', phone: '6505550100', ssn: '123-45-6789' }, '/chrome|Default');
  p.merge({ city: 'Poway' }, { city: '/edge|Default' });
  p.set({ ...p.data, phone: '6505550142', ssn: '' });
  assert.deepEqual(p.origins(), { email: '/chrome|Default', phone: 'hand', ssn: 'hand', city: '/edge|Default' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /chrome|edge|hand|ssn/, 'which fields there are is not readable on disk either');
  const again = new Profile(file, fakeSafe());
  assert.deepEqual(again.origins(), p.origins(), 'a field cleared by hand stays marked after a restart');
  assert.deepEqual(again.data, { email: 'ada@example.com', phone: '6505550142', city: 'Poway' });
  again.merge({ phone: '6505550199' }, '/chrome|Default');
  assert.equal(again.origins().phone, '/chrome|Default', 'an import the person asks for takes it back');
  again.clear();
  assert.deepEqual(new Profile(file, fakeSafe()).origins(), {});
});

test('saving the profile screen unchanged changes nobody\'s origin', () => {
  const p = new Profile(tmp(), fakeSafe());
  p.merge({ email: 'ada@example.com' }, '/chrome|Default');
  p.set({ ...p.data }, { autofill: false });
  assert.deepEqual(p.origins(), { email: '/chrome|Default' });
});

test('a profile written before origins were kept still reads, and says nothing of where it came from', () => {
  for (const [enc, body] of [['safeStorage', (d) => fakeSafe().encryptString(JSON.stringify(d)).toString('base64')], ['plain', (d) => d]]) {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ v: 1, enc, autofill: true, data: body({ first_name: 'Ada', email: 'ada@example.com' }) }));
    const p = new Profile(file, fakeSafe());
    assert.deepEqual(p.data, { first_name: 'Ada', email: 'ada@example.com' }, enc);
    assert.deepEqual(p.origins(), {}, enc);
  }
});

test('without a keychain the origins are as plain as the values, and say so the same way', () => {
  const file = tmp();
  const p = new Profile(file, fakeSafe({ available: false }));
  p.merge({ email: 'ada@example.com' }, '/chrome|Default');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.enc, 'plain');
  assert.deepEqual(raw.from, { email: '/chrome|Default' });
  assert.deepEqual(new Profile(file, fakeSafe({ available: false })).origins(), { email: '/chrome|Default' });
});
