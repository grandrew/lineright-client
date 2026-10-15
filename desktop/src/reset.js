'use strict';
/**
 * A full reset: what the app keeps on this computer, deleted, so it starts
 * again as it did the first time it was opened.
 *
 * main.js does the parts that need Electron — it stops the server this app
 * runs first, and clears what the tabs and the app's own page stored through
 * Chromium — and this deletes the files: the built-in server's folder (its
 * database, its credentials, its settings file, its logs and the robots'
 * state), the folder of the robots the app runs for the regbot site (their
 * booking replay store and log, robots.js), the app's logs (logbook.js: they
 * hold the pages booked on, and so the person's details), the profile, the
 * app's settings, and its telemetry (telemetry.js).
 *
 * The server's folder goes first. It is the one thing a process can still be
 * holding on Windows, where a service's files are let go a moment after it
 * exits; if it will not go even after waiting, nothing else has gone either,
 * and the app carries on as it was.
 */
const fs = require('node:fs');
const path = require('node:path');

const SERVER = 'server';
const ROBOTS = 'robots';
const LOGS = 'logs';
const FILES = ['profile.json', 'regbot.json', 'telemetry.json'];
// What a crash between writing and renaming leaves (see store.js, profile.js).
const LEFTOVER = /^((profile|regbot)\.json\.\d+\.tmp|telemetry\.json\.tmp)$/;

/**
 * Delete what the app keeps in `dir` (its user data). Returns the names that
 * were there to delete. Anything else in `dir` — Chromium's own files among
 * them, which main.js clears through Chromium — is left alone.
 */
function wipe(dir, { disk = fs } = {}) {
  const removed = [];
  const there = (name) => disk.existsSync(path.join(dir, name));
  for (const folder of [SERVER, ROBOTS, LOGS]) {
    if (!there(folder)) continue;
    disk.rmSync(path.join(dir, folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    removed.push(folder);
  }
  let names = [];
  try { names = disk.readdirSync(dir); } catch { /* no user data at all */ }
  for (const name of [...FILES, ...names.filter((n) => LEFTOVER.test(n))]) {
    if (!there(name)) continue;
    disk.rmSync(path.join(dir, name), { force: true, maxRetries: 10, retryDelay: 200 });
    removed.push(name);
  }
  return removed;
}

module.exports = { wipe, SERVER, ROBOTS, FILES };
