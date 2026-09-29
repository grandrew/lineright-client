'use strict';
/**
 * The app's settings: a JSON file in the user-data directory.
 *
 * What is in it says what the app is. Which server it uses — the public regbot
 * site the build names, somebody else's at an address, or the one it runs
 * itself for practice — with the token that server issued; which DMV the
 * practice server's robots are pointed at; an optional update feed; a name for
 * this device. No bids, no positions, no personal data: those live in a
 * server's database (or, for the person's details, in profile.json), so losing
 * this file costs a setting or two, and for somebody else's server one sign-in.
 *
 * Only choices are written. The defaults — which server the build names, this
 * machine's name — are worked out every time the file is read and never saved,
 * so a build that names a new address moves everybody who had not chosen one,
 * instead of leaving each install pinned to whatever the default was the day
 * it first saved anything. The file says `"v": 2` for that reason: one written
 * before it saved its defaults along with its choices, and reading it drops the
 * values that were only ever defaults (see `migrate`).
 *
 * A token is kept with the server that issued it (`tokenServer`) and never
 * offered to any other.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** What the build was told: desktop/config.json, read once. Missing is fine. */
function bundled() {
  try {
    return require('../config.json') || {};
  } catch {
    return {};
  }
}

// What config.json used to name before the app had a server of its own: the
// development server. A v1 file that saved it was not choosing somebody else's
// server, only taking the default.
const LEGACY_DEFAULT = 'http://127.0.0.1:5000';
const VERSION = 2;

const trim = (url) => String(url || '').trim().replace(/\/+$/, '');

function defaults(env = process.env, built = bundled()) {
  const site = trim(built.serverUrl);
  return {
    // 'remote': a regbot site at serverUrl — the public one the build names
    // (config.json), or another the person chose — signed in to by code.
    // 'builtin': the regbot server this app runs itself (src/stack.js), for
    // practice. A build that names no site runs its own.
    serverMode: site ? 'remote' : 'builtin',
    serverUrl: site,
    token: null,
    tokenServer: '',
    // Which DMV the practice server's robots talk to: the stand-in it runs
    // ('standin'), or dmv.ca.gov ('live'), which is a choice made on purpose.
    dmvTarget: 'standin',
    updateUrl: trim(env.REGBOT_UPDATE_URL || built.updateUrl),
    clientName: env.REGBOT_CLIENT_NAME || os.hostname(),
  };
}

/**
 * A settings file written before `v: 2`, reduced to what was chosen.
 *
 * Such a file held every default next to every choice, and a default looks
 * exactly like a choice of the same value. These are the ones that can only
 * have been defaults: the built-in server that every install started on, the
 * old development address, the stand-in, this machine's own name, and empty
 * values. A server address saved with no mode at all predates the built-in
 * server, and was a choice unless it was the old default.
 */
function migrate(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'serverMode' && value === 'builtin') continue;
    if (key === 'serverUrl' && trim(value) === LEGACY_DEFAULT && raw.serverMode !== 'remote') continue;
    if (key === 'dmvTarget' && value === 'standin') continue;
    if (key === 'clientName' && value === os.hostname()) continue;
    out[key] = key === 'serverUrl' ? trim(value) : value;
  }
  if (raw && raw.serverMode === undefined && out.serverUrl) out.serverMode = 'remote';
  if (out.serverMode === 'remote' && !out.serverUrl) delete out.serverMode;
  // A token, then, belonged to the server the file was pointed at, if it was
  // pointed at one somebody chose; any other is of no use to anybody.
  if (out.token && out.serverMode === 'remote' && out.serverUrl) out.tokenServer = out.serverUrl;
  else delete out.token;
  return out;
}

class Store {
  constructor(file, env = process.env, built = bundled()) {
    this.file = file;
    this.defaults = defaults(env, built);
    this.saved = {};
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // No file yet, or an unreadable one: defaults stand, and the next set() writes a good one.
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const { v, ...rest } = raw;
      this.saved = v === VERSION ? rest : migrate(rest);
    }
    return this;
  }

  get(key, fallback) {
    const value = key in this.saved ? this.saved[key] : this.defaults[key];
    return value === undefined || value === null ? fallback : value;
  }

  /** Whether the person chose this, rather than it being the default. */
  chosen(key) {
    return key in this.saved;
  }

  set(key, value) {
    this.saved[key] = value;
    this.save();
    return value;
  }

  delete(key) {
    delete this.saved[key];
    this.save();
  }

  all() {
    return { ...this.defaults, ...this.saved };
  }

  /**
   * Write to a sibling file and rename, so a crash mid-write cannot leave half a
   * token; readable by this user only, since a token is a way into an account.
   */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, ...this.saved }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* not a POSIX file system */ }
  }
}

module.exports = { Store, defaults, migrate, bundled, LEGACY_DEFAULT, VERSION };
