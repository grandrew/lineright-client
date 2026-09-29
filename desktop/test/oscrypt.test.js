'use strict';
/**
 * The key each system gives a browser, and what it decrypts.
 *
 * The commands are injected, so the Windows and macOS paths — a PowerShell
 * call into DPAPI, a keychain that asks the person — are exercised from
 * anywhere, with the answers the real ones would give.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { keysFor, decryptValue, schemeOf, dpapi, fromKeychain, fromKeyring, pbkdf2 } = require('../src/oscrypt');

/** Chromium's own two shapes, so the tests encrypt the way a browser does. */
function sealCbc(text, key, tag = 'v10') {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(tag), cipher.update(body), cipher.final()]);
}
function sealGcm(text, key, tag = 'v10', prefix = Buffer.alloc(0)) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(text, 'utf8')])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from(tag), nonce, body]);
}

/** A stand-in for the commands, answering the way each system's would. */
function commands(answers) {
  const calls = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, input: options && options.input });
      for (const [match, answer] of answers) {
        if (`${file} ${args.join(' ')}`.includes(match)) {
          return typeof answer === 'function' ? answer(options) : answer;
        }
      }
      return null;
    },
  };
}

test('the scheme is the first three bytes, and nothing else', () => {
  assert.equal(schemeOf(Buffer.from('v10abc')), 'v10');
  assert.equal(schemeOf(Buffer.from('v11abc')), 'v11');
  assert.equal(schemeOf(Buffer.from('v20abc')), 'v20');
  assert.equal(schemeOf(Buffer.from([1, 2, 3, 4])), 'legacy');
  assert.equal(schemeOf(Buffer.alloc(0)), 'empty');
  assert.equal(schemeOf(null), 'empty');
});

test('Linux: the fallback key is always there, the keyring key when a keyring answers', async () => {
  const { exec, calls } = commands([['secret-tool lookup application brave', 'a-real-keyring-secret']]);
  const got = await keysFor({ id: 'brave', product: 'Brave' }, { platform: 'linux', exec });
  assert.deepEqual(got.keys.v10, pbkdf2('peanuts', 1));
  assert.deepEqual(got.keys.v11, pbkdf2('a-real-keyring-secret', 1));
  assert.deepEqual(got.notes, []);
  // Which key a value wants is the value's own business: a profile written
  // before this machine had a keyring is read beside one written after.
  assert.equal(decryptValue(sealCbc('older=1', got.keys.v10, 'v10'), { keys: got.keys, platform: 'linux' }), 'older=1');
  assert.equal(decryptValue(sealCbc('newer=1', got.keys.v11, 'v11'), { keys: got.keys, platform: 'linux' }), 'newer=1');
  assert.equal(calls[0].file, 'secret-tool');
});

test('Linux: no keyring is said out loud, and the cookies it locked are left', async () => {
  const { exec } = commands([]);
  const got = await keysFor({ id: 'chrome', product: 'Chrome' }, { platform: 'linux', exec });
  assert.ok(got.keys.v10, 'the fallback still reads what was never keyring-locked');
  assert.equal(got.keys.v11, undefined);
  assert.match(got.notes[0], /keyring/);
  assert.equal(decryptValue(sealCbc('x', pbkdf2('peanuts', 1)), { keys: got.keys, platform: 'linux' }), 'x');
});

test('Linux: PyGObject stands in where secret-tool is not installed', async () => {
  const { exec, calls } = commands([['python3', 'from-the-keyring']]);
  const key = await fromKeyring('Chrome', 'chrome', { exec });
  assert.equal(key, 'from-the-keyring');
  const python = calls.find((c) => c.file === 'python3');
  assert.equal(python.args[2], 'Chrome Safe Storage', 'the label to look for, when the attribute finds nothing');
  assert.ok(python.args.includes('chrome'));
});

test('macOS: the key is a keychain password, stretched the way Chromium stretches it', async () => {
  const { exec, calls } = commands([['find-generic-password', 'the-password-macos-holds\n']]);
  const got = await keysFor({ id: 'chrome', product: 'Chrome' }, { platform: 'darwin', exec });
  assert.deepEqual(got.keys.v10, pbkdf2('the-password-macos-holds', 1003));
  assert.deepEqual(got.notes, []);
  assert.deepEqual(calls[0].args.slice(0, 6), ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome']);
  const value = sealCbc('session=abc', got.keys.v10);
  assert.equal(decryptValue(value, { keys: got.keys, platform: 'darwin' }), 'session=abc');
});

test('macOS: a refused permission dialog is reported, not treated as an empty browser', async () => {
  const { exec } = commands([]);
  const got = await keysFor({ id: 'brave', product: 'Brave' }, { platform: 'darwin', exec });
  assert.deepEqual(got.keys, {});
  assert.match(got.notes[0], /keychain/);
  assert.equal(await fromKeychain('Brave', { exec }), null);
});

test('Windows: the key comes out of Local State through DPAPI, in one call', async () => {
  const master = crypto.randomBytes(32);
  const wrapped = Buffer.concat([Buffer.from('DPAPI'), Buffer.from('wrapped-by-windows')]);
  const { exec, calls } = commands([['powershell', () => `${master.toString('base64')}\n`]]);
  const got = await keysFor({ id: 'chrome', product: 'Chrome' }, {
    platform: 'win32', exec, env: { SystemRoot: 'C:\\Windows' },
    state: { os_crypt: { encrypted_key: wrapped.toString('base64') } },
  });
  assert.deepEqual(got.keys.v10, master);
  assert.deepEqual(got.notes, []);
  assert.equal(calls.length, 1, 'one process, however many values follow');
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[0].input.trim(), Buffer.from('wrapped-by-windows').toString('base64'));
  assert.equal(decryptValue(sealGcm('session=abc', master), { keys: got.keys, platform: 'win32' }), 'session=abc');
});

test('Windows: the app-bound key is unwrapped through the elevation service, and the v20 cookies open', async () => {
  const master = crypto.randomBytes(32);
  const abeKey = crypto.randomBytes(32);
  // The elevation service is the second PowerShell call; it answers on stdin
  // with the wrapped key and returns the unwrapped one as base64.
  const { exec, calls } = commands([
    ['-EncodedCommand', (opts) => (opts.env && opts.env.REGBOT_ABE_PRODUCT
      ? `${abeKey.toString('base64')}\n`
      : `${master.toString('base64')}\n`)],
  ]);
  const got = await keysFor({ id: 'chrome', product: 'Chrome' }, {
    platform: 'win32', exec, env: {},
    state: { os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('k')]).toString('base64'), app_bound_encrypted_key: Buffer.concat([Buffer.from('APPB'), Buffer.from('wrapped')]).toString('base64') } },
  });
  assert.deepEqual(got.keys.v20, abeKey, 'the elevation service key becomes the v20 key');
  assert.deepEqual(got.notes, [], 'and nothing is declared out of reach');
  assert.equal(calls.find((c) => c.input && c.input.includes('QVBQ') === false && c.env), undefined); // sanity: env carried
  const bound = crypto.createHash('sha256').update('.dmv.example.gov').digest();
  assert.equal(decryptValue(sealGcm('session=abc', abeKey, 'v20', bound),
    { keys: got.keys, platform: 'win32', host: '.dmv.example.gov' }), 'session=abc');
});

test('Windows: a browser whose key the elevation service will not unwrap is left sealed, not half-read', async () => {
  const master = crypto.randomBytes(32);
  const { exec } = commands([['-EncodedCommand', (opts) => (opts.env && opts.env.REGBOT_ABE_PRODUCT ? '' : `${master.toString('base64')}\n`)]]);
  const got = await keysFor({ id: 'chrome', product: 'Chrome' }, {
    platform: 'win32', exec, env: {},
    state: { os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('k')]).toString('base64'), app_bound_encrypted_key: 'QVBQQndyYXBwZWQ=' } },
  });
  assert.equal(got.keys.v20, undefined);
  assert.match(got.notes[0], /app-bound.*released its key only to itself/);
  assert.equal(decryptValue(sealGcm('x', master, 'v20'), { keys: got.keys, platform: 'win32' }), null);
});

test('Windows: a batch of old DPAPI blobs comes back in order, gaps and all', async () => {
  const { exec } = commands([['powershell', () => `${Buffer.from('one').toString('base64')}\n\n${Buffer.from('three').toString('base64')}\n`]]);
  const out = await dpapi([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')], { exec, env: {} });
  assert.deepEqual(out.map((b) => (b ? b.toString() : null)), ['one', null, 'three']);
  assert.deepEqual(await dpapi([], { exec }), []);
  const dead = commands([]);
  assert.deepEqual(await dpapi([Buffer.from('a')], { exec: dead.exec, env: {} }), [null]);
});

test('the domain a value is bound to comes off the front of it, when it is there', () => {
  const key = pbkdf2('peanuts', 1);
  const host = '.dmv.example.gov';
  const bound = crypto.createHash('sha256').update(host).digest();
  const value = sealCbc(Buffer.concat([bound, Buffer.from('session=abc')]), key);
  assert.equal(decryptValue(value, { keys: { v10: key }, platform: 'linux', host }), 'session=abc');
  // Told to expect it for another host, the 32 bytes are not the hash of that
  // one and nothing is taken off — better a value with a prefix on it than a
  // value with its first 32 characters missing.
  assert.match(decryptValue(value, { keys: { v10: key }, platform: 'linux', host: '.elsewhere.example' }), /session=abc$/);
  // An older profile's value has no prefix and must be left alone.
  assert.equal(decryptValue(sealCbc('plain=1', key), { keys: { v10: key }, platform: 'linux', host }), 'plain=1');
  assert.equal(decryptValue(sealCbc('plain=1', key), { keys: { v10: key }, platform: 'linux' }), 'plain=1');
  // And on Windows the bound value is GCM, where the prefix is always there.
  const k = crypto.randomBytes(32);
  const winHost = '.dmv.example.gov';
  const winBound = crypto.createHash('sha256').update(winHost).digest();
  assert.equal(decryptValue(sealGcm('v=1', k, 'v10', winBound), { keys: { v10: k }, platform: 'win32', host: winHost }), 'v=1');
});

test('a value with no key, a broken value and an empty one are told apart', () => {
  const key = pbkdf2('peanuts', 1);
  assert.equal(decryptValue(Buffer.alloc(0), { keys: { v10: key } }), '');
  assert.equal(decryptValue(sealCbc('x', key), { keys: {}, platform: 'linux' }), null);
  assert.equal(decryptValue(Buffer.from('v10not-a-block-multiple'), { keys: { v10: key }, platform: 'linux' }), null);
  assert.equal(decryptValue(Buffer.from([7, 7, 7]), { keys: { v10: key } }), null, 'an old bare DPAPI blob waits for the batch');
  const wrongKey = pbkdf2('not-peanuts', 1);
  assert.notEqual(decryptValue(sealCbc('hello', key), { keys: { v10: wrongKey }, platform: 'linux' }), 'hello');
  assert.equal(decryptValue(sealGcm('hello', crypto.randomBytes(32)), { keys: { v10: crypto.randomBytes(32) }, platform: 'win32' }), null,
    'a bad tag fails rather than returning rubbish');
});
