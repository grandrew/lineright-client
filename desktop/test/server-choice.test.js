'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../src/server-choice');

/** A store with these values and nothing else. */
const store = (values = {}) => ({ get: (key) => values[key] });
const SITE = 'https://regbot.example';

test('by default the app pairs with the site the build names, using the token that site issued', () => {
  const choice = resolve({ store: store({ serverMode: 'remote', serverUrl: `${SITE}/`, token: 'tok', tokenServer: SITE }) });
  assert.deepEqual(choice, { mode: 'remote', url: SITE, token: 'tok', forced: false });
});

test('a token is never offered to a server that did not issue it', () => {
  const choice = resolve({ store: store({ serverMode: 'remote', serverUrl: SITE, token: 'tok', tokenServer: 'https://other.example' }) });
  assert.equal(choice.token, null);
  assert.equal(resolve({ store: store({ serverMode: 'remote', serverUrl: SITE, token: 'tok' }) }).token, null,
    'nor one that says nothing of where it came from');
});

test('with no site named and none chosen, the app runs its own', () => {
  assert.deepEqual(resolve({ store: store({ serverMode: 'builtin', serverUrl: '' }) }),
    { mode: 'builtin', url: '', token: null, forced: false });
  assert.equal(resolve({ store: store({ serverMode: 'remote', serverUrl: '' }) }).mode, 'builtin');
});

test('--server is for this run: the saved token goes with it only if that server issued it', () => {
  const saved = store({ serverMode: 'remote', serverUrl: SITE, token: 'tok', tokenServer: SITE });
  assert.deepEqual(resolve({ argv: { server: 'http://127.0.0.1:15000/' }, store: saved }),
    { mode: 'remote', url: 'http://127.0.0.1:15000', token: null, forced: true });
  assert.equal(resolve({ argv: { server: SITE }, store: saved }).token, 'tok');
  assert.equal(resolve({ env: { REGBOT_SERVER_URL: 'http://x' }, store: saved }).url, 'http://x');
  assert.equal(resolve({ env: { REGBOT_SERVER_URL: 'http://x', REGBOT_CLIENT_TOKEN: 'run' }, store: saved }).token, 'run',
    'a token named for the run goes with the server named for it');
  assert.equal(resolve({ argv: { server: 'http://a' }, env: { REGBOT_SERVER_URL: 'http://b' }, store: saved }).url,
    'http://a', 'the command line over the environment');
});

test('--practice is the app\'s own server for this run, whatever else is said', () => {
  const saved = store({ serverMode: 'remote', serverUrl: SITE, token: 'tok', tokenServer: SITE });
  const practice = { mode: 'builtin', url: '', token: null, forced: true };
  assert.deepEqual(resolve({ argv: { practice: true }, store: saved }), practice);
  assert.deepEqual(resolve({ argv: { practice: true, server: 'http://x' }, store: saved }), practice);
  assert.deepEqual(resolve({ env: { REGBOT_SERVER_MODE: 'builtin' }, store: saved }), practice);
});
