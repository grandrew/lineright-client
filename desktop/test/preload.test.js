'use strict';
/**
 * The window asks the app only for what the bridge lets through (src/preload.js):
 * every call and every event the page uses is on its lists, or the page gets
 * "unknown call" and shows nothing — as the History page did before its calls
 * were added.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const listed = (name) => new Set([...preload.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`))[1]
  .matchAll(/'([a-z-]+:[a-z-]+)'/g)].map((m) => m[1]));
const ui = fs.readdirSync(path.join(ROOT, 'ui')).filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8')).join('\n');

test('every call the page makes is one the bridge lets through', () => {
  const calls = listed('CALLS');
  const used = new Set([...ui.matchAll(/\b(?:api\.call|call)\('([a-z-]+:[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 20);
  assert.deepEqual([...used].filter((c) => !calls.has(c)), []);
});

test('every event the page listens for is one the bridge passes on', () => {
  const events = listed('EVENTS');
  const used = new Set([...ui.matchAll(/\bapi\.on\('([a-z-]+:[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 5);
  assert.deepEqual([...used].filter((e) => !events.has(e)), []);
});
