'use strict';
/**
 * Developer mode: what the app shows only to the people who work on it.
 *
 * Off, as every copy starts, the app is the public one: it pairs with the
 * LineRight Regbot site the build names (config.json) and lists the booking
 * sites there that are real. On, it also has:
 *
 *   - test sites: made up for demos, practice and tests, which a development
 *     or practice server lists beside the real ones. The server says which
 *     (`mock` on a site, a line and a position), and the app marks each as a
 *     test site wherever it shows one;
 *   - the servers that are not the public site — Practice on this computer
 *     (which needs a lineright-server checkout) and another server at an
 *     address — and an update feed of its own;
 *   - Chromium's developer tools, in the View menu.
 *
 * `--developer` (or REGBOT_DEVELOPER=1) turns it on for one run; View →
 * Developer mode turns it on or off and remembers. Practice on this computer
 * is developer mode through and through, so while the app practises it is on,
 * whatever else says.
 *
 * Pure, so the rules are tested without Electron: `store` is anything with
 * `get(key)` (src/store.js).
 */
const { CONNECTORS } = require('./robots');

function resolve({ argv = {}, env = {}, store, practice = false }) {
  if (practice) return { on: true, forced: 'practice' };
  if (argv.developer === true || argv.developer === 'true' || env.REGBOT_DEVELOPER === '1') {
    return { on: true, forced: 'flag' };
  }
  return { on: store.get('developerMode', false) === true, forced: null };
}

/**
 * Whether a site — or a line, or a position: anything carrying `mock` or a
 * `connector` — is a made-up one. The server says so. One from before it did
 * lists its made-up sites on booking systems this app's robots do not work,
 * which on such a server is every one but the California DMV's.
 */
function isMock(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.mock === 'boolean') return item.mock;
  if (typeof item.connector !== 'string') return false;
  return !CONNECTORS.includes(item.connector);
}

/** The sites to list: each marked, and the made-up ones only in developer mode. */
function sitesFor(sites, on) {
  return (Array.isArray(sites) ? sites : [])
    .map((site) => ({ ...site, mock: isMock(site) }))
    .filter((site) => on || !site.mock);
}

/** Why a test site's page does not open, outside developer mode. */
const TEST_ONLY = 'That is a test site, made up for demos and tests. The app shows test sites only in developer mode (View → Developer mode).';

module.exports = { resolve, isMock, sitesFor, TEST_ONLY };
