'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults, migrate, VERSION } = require('../src/store');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-store-')), 'regbot.json');
const SITE = { serverUrl: 'https://regbot.example/' };
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the build names the public site, and the app pairs with it unless told otherwise', () => {
  const d = defaults({}, SITE);
  assert.equal(d.serverMode, 'remote');
  assert.equal(d.serverUrl, 'https://regbot.example', 'trailing slash dropped');
  assert.equal(d.token, null);
  assert.equal(d.dmvTarget, 'standin');
  const none = defaults({}, {});
  assert.equal(none.serverMode, 'builtin', 'a build that names no site runs its own');
  assert.equal(none.serverUrl, '');
  assert.equal(defaults({ REGBOT_UPDATE_URL: 'http://up/' }, {}).updateUrl, 'http://up');
  assert.equal(defaults({ REGBOT_SERVER_URL: 'http://elsewhere' }, SITE).serverUrl, 'https://regbot.example',
    'a server named for one run is not a default (server-choice.js)');
});

test('only choices are written: a default follows the build, it is not frozen into the file', () => {
  const file = tmp();
  const store = new Store(file, {}, SITE);
  store.set('suggestImport', false);
  assert.deepEqual(onDisk(file), { v: VERSION, suggestImport: false });
  // The next build names a new address; nobody chose the old one, so everybody moves.
  const moved = new Store(file, {}, { serverUrl: 'https://regbot.example/new' });
  assert.equal(moved.get('serverUrl'), 'https://regbot.example/new');
  assert.equal(moved.chosen('serverUrl'), false);
  moved.set('serverUrl', 'https://mine.example');
  assert.equal(new Store(file, {}, SITE).get('serverUrl'), 'https://mine.example', 'a choice stays');
});

test('a file from before v2 keeps what was chosen and drops what was only ever a default', () => {
  const host = os.hostname();
  assert.deepEqual(migrate({ serverMode: 'builtin', serverUrl: '', token: null, dmvTarget: 'standin',
    updateUrl: '', clientName: host, suggestImport: false }), { suggestImport: false });
  assert.deepEqual(migrate({ serverMode: 'remote', serverUrl: 'https://other.example/', token: 'abc',
    clientName: 'my-laptop' }),
  { serverMode: 'remote', serverUrl: 'https://other.example', token: 'abc', clientName: 'my-laptop',
    tokenServer: 'https://other.example' });
  // Before there was a choice of server at all: an address saved was chosen, unless it was the old default.
  assert.deepEqual(migrate({ serverUrl: 'https://regbot.example', token: 'abc' }),
    { serverUrl: 'https://regbot.example', token: 'abc', serverMode: 'remote', tokenServer: 'https://regbot.example' });
  assert.deepEqual(migrate({ serverUrl: 'http://127.0.0.1:5000/', token: 'dev', clientName: 'box' }),
    { clientName: 'box' }, 'the old development default, and its token, go');
  assert.equal(migrate({ serverMode: 'builtin', dmvTarget: 'live' }).dmvTarget, 'live', 'the real DMV was a choice');

  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ serverMode: 'builtin', serverUrl: '', clientName: host, token: null }));
  const store = new Store(file, {}, SITE);
  assert.equal(store.get('serverMode'), 'remote', 'an install that never chose moves to the public site');
  assert.equal(store.get('serverUrl'), 'https://regbot.example');
});

test('values round-trip through the file, which only this user can read', () => {
  const file = tmp();
  const store = new Store(file, {}, SITE);
  store.set('token', 'abc');
  store.set('tokenServer', 'https://regbot.example');
  const again = new Store(file, {}, SITE);
  assert.equal(again.get('token'), 'abc');
  assert.equal(again.get('tokenServer'), 'https://regbot.example');
  assert.equal(again.get('missing', 'fallback'), 'fallback');
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')).length, 0, 'no half-written file left');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('an unreadable file falls back to defaults instead of crashing', () => {
  const file = tmp();
  fs.writeFileSync(file, '{not json');
  const store = new Store(file, {}, SITE);
  assert.equal(store.get('serverUrl'), 'https://regbot.example');
  store.set('token', 'x');
  assert.equal(onDisk(file).token, 'x');
});

test('delete takes a choice back to the default, and null reads as absent', () => {
  const store = new Store(tmp(), {}, SITE);
  store.set('token', 'x');
  store.set('token', null);
  assert.equal(store.get('token', 'none'), 'none');
  store.set('serverUrl', 'https://mine.example');
  store.delete('serverUrl');
  assert.equal(store.get('serverUrl'), 'https://regbot.example');
  assert.equal(store.chosen('serverUrl'), false);
});
