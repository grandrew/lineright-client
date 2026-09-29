'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { wipe } = require('../src/reset');

/** A user-data directory as a used app leaves it: its own files beside Chromium's. */
function used() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-reset-'));
  const put = (rel, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put('server/regbot.db');
  put('server/desktop.json', '{"token":"t"}');
  put('server/regbot.env');
  put('server/logs/web.log');
  put('server/bot/rqp-bookings.json');
  put('robots/rqp-bookings.json');
  put('profile.json');
  put('regbot.json');
  put('regbot.json.4242.tmp');
  put('profile.json.17.tmp');
  put('Local State');
  put('Partitions/regbot/Cookies');
  put('notes.txt');
  return dir;
}

test('the server, the robots\' state, the profile and the settings go; Chromium\'s files and strangers stay', () => {
  const dir = used();
  const removed = wipe(dir);
  assert.deepEqual(removed.sort(), ['profile.json', 'profile.json.17.tmp', 'regbot.json', 'regbot.json.4242.tmp', 'robots', 'server']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Local State', 'Partitions', 'notes.txt']);
});

test('what was never made is not reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-reset-'));
  fs.writeFileSync(path.join(dir, 'profile.json'), '{}');
  assert.deepEqual(wipe(dir), ['profile.json']);
  assert.deepEqual(wipe(dir), []);
  assert.deepEqual(wipe(path.join(dir, 'missing')), []);
});

test('a server folder that will not go leaves the profile and settings where they were', () => {
  const dir = used();
  const disk = {
    ...fs,
    rmSync(target, opts) {
      if (path.basename(target) === 'server') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.rmSync(target, opts);
    },
  };
  assert.throws(() => wipe(dir, { disk }), /EBUSY/);
  for (const name of ['server', 'profile.json', 'regbot.json']) assert.ok(fs.existsSync(path.join(dir, name)), name);
});

test('it waits out a file Windows is still letting go of', () => {
  const dir = used();
  const asked = [];
  const disk = { ...fs, rmSync(target, opts) { asked.push(opts); return fs.rmSync(target, opts); } };
  wipe(dir, { disk });
  assert.ok(asked.every((o) => o.force && o.maxRetries >= 5));
});
