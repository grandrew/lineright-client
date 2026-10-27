'use strict';
/**
 * The app is in English, and so are its dates, times and numbers, whatever
 * language the computer is set to: a Russian Mac showed "вт, 6 окт. 2026 г."
 * on a site's page among English words. Every toLocale…String names en-US,
 * and the app starts Chromium in English (its date and time boxes too).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const files = ['ui', 'src'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
  .filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)));

test('every date, time and number the app formats is formatted in English', () => {
  const loose = [];
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/toLocale(?:Date|Time)?String\(([^,)]*)/g)) {
        if (m[1].trim() !== "'en-US'") loose.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(loose, [], 'formatted in the system language');
});

test('Chromium runs in English: its date and time boxes, and what pages ask sites for', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'), /app\.commandLine\.appendSwitch\('lang', 'en-US'\)/);
});

test('the page formats a Russian-looking date in English', () => {
  const page = require('../ui/bookings');
  assert.match(page.atWords(Date.parse('2026-10-26T17:00:00Z')), /^Mon, Oct 26 at \d{1,2}:00 (AM|PM)$/);
});
