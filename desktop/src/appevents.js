'use strict';
/**
 * The events this app adds to the site's history, and which events its person
 * has closed on the bar (ui/events.js).
 *
 * The site words what happened to bids, turns, bookings and credits. What only
 * this computer knows goes here: today, an update it cannot install by itself.
 * A Mac's app is signed ad hoc, with no Apple Developer ID, so macOS refuses
 * every update ("Code signature … did not pass validation"), and the app stays
 * on the version first installed unless its person replaces it by hand. That
 * failure used to go only into the log.
 *
 * Kept in the store: `appEvents` (the newest KEEP) and `eventsClosed` (the
 * keys closed with ×, the newest KEEP_CLOSED).
 */
const KEEP = 30;
const KEEP_CLOSED = 300;
/** What macOS says when an update is not signed the way the running app is. */
const UNSIGNED = /code signature|did not pass validation|code requirement|code failed to satisfy/i;

class AppEvents {
  /** @param {object} opts.store the app's store (get, set) */
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
  }

  list() {
    const raw = this.store.get('appEvents', []);
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.key === 'string') : [];
  }

  /** Adds an event, or leaves the one with its key as it was: the first sight is when it happened. */
  add(event) {
    const list = this.list();
    if (list.some((e) => e.key === event.key)) return false;
    list.push({ at: new Date(this.now()).toISOString(), significant: true, ...event });
    this.store.set('appEvents', list.slice(-KEEP));
    return true;
  }

  closed() {
    const raw = this.store.get('eventsClosed', []);
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : [];
  }

  close(key) {
    const keys = this.closed().filter((k) => k !== key);
    keys.push(String(key));
    this.store.set('eventsClosed', keys.slice(-KEEP_CLOSED));
  }

  view() {
    return { app: this.list(), closed: this.closed() };
  }
}

/** Whether an update error is macOS refusing an update this app cannot install by itself. */
function needsManualUpdate(platform, message) {
  return platform === 'darwin' && UNSIGNED.test(String(message || ''));
}

/**
 * The event that says to update a Mac's app by hand: where the new version is,
 * and the four steps. `site` is the LineRight site's address; the download
 * page there starts the right disk image for the Mac's CPU and shows each step
 * with pictures.
 */
function manualUpdate({ version = '', site = '', arch = process.arch } = {}) {
  const page = site ? `${site}/download/${arch === 'arm64' ? 'mac' : 'mac-intel'}`
    : 'https://github.com/grandrew/lineright-client/releases/latest';
  const named = version ? `LineRight Regbot ${version}` : 'A new LineRight Regbot';
  return {
    key: `update-manual:${version || 'new'}`,
    kind: 'update_manual', tone: 'warn', action: 'download', url: page, version,
    title: 'Update this app by hand',
    text: `${named} is out, but this Mac cannot install it by itself: the app is not signed with an Apple `
      + 'Developer ID yet. It takes a minute, and your sign-in, profile and bids are kept. Do it when no turn is under way.',
    steps: [
      'Download it with the button. It saves a disk image (.dmg).',
      'Quit LineRight Regbot (LineRight Regbot menu → Quit).',
      'Open the downloaded file, drag LineRight Regbot onto Applications, and choose Replace.',
      'Open it from Applications. If macOS stops it, go to System Settings → Privacy & Security and choose Open Anyway.',
    ],
  };
}

module.exports = { AppEvents, needsManualUpdate, manualUpdate, KEEP, KEEP_CLOSED };
