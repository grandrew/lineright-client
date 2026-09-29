'use strict';
/**
 * The person's own details, kept on their own machine.
 *
 * Name, date of birth, licence number, Social Security number, contact and
 * address: what a booking form asks for. None of it is ever sent to the
 * regbot server — a bid carries only where and when — and the only thing
 * that reads it is the autofill that types it into a booking page the app
 * opened (see autofill.js).
 *
 * Stored in one file in the user-data directory, encrypted with Electron's
 * safeStorage where the OS offers a keychain (macOS Keychain, Windows DPAPI,
 * a Linux keyring). Where it does not — a bare Linux session with no keyring
 * — the file says so and the profile screen tells the person, rather than
 * pretending a base64 string is protection.
 *
 * Each field also remembers where it came from: typed here by hand, or taken
 * from a browser (which one, as reimport.js names it). A weekly re-import
 * refreshes what came from a browser and leaves what the person typed alone.
 * That is kept with the values, encrypted with them: which fields a profile
 * holds is itself something about the person.
 */
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = [
  { key: 'first_name', label: 'First name', group: 'name', autocomplete: 'given-name' },
  { key: 'middle_name', label: 'Middle name', group: 'name', autocomplete: 'additional-name' },
  { key: 'last_name', label: 'Last name', group: 'name', autocomplete: 'family-name' },
  { key: 'dob', label: 'Date of birth', group: 'identity', placeholder: 'MM/DD/YYYY', autocomplete: 'bday', pattern: '^\\d{2}/\\d{2}/\\d{4}$', hint: 'Month, day, year — as US forms ask for it.' },
  { key: 'ssn', label: 'Social Security number', group: 'identity', placeholder: '123-45-6789', secret: true, pattern: '^\\d{3}-?\\d{2}-?\\d{4}$', hint: 'Only typed into a field that asks for it by name.' },
  { key: 'dl_number', label: 'Driver licence or permit number', group: 'identity', placeholder: 'X1234567', secret: true, hint: 'California: one letter and seven digits.' },
  { key: 'passport', label: 'Passport number', group: 'identity', secret: true },
  { key: 'email', label: 'Email', group: 'contact', type: 'email', autocomplete: 'email' },
  { key: 'phone', label: 'Phone', group: 'contact', type: 'tel', autocomplete: 'tel', placeholder: '5555550123' },
  { key: 'street', label: 'Street address', group: 'address', autocomplete: 'address-line1' },
  { key: 'city', label: 'City', group: 'address', autocomplete: 'address-level2' },
  { key: 'state', label: 'State', group: 'address', autocomplete: 'address-level1', placeholder: 'CA' },
  { key: 'zip', label: 'ZIP code', group: 'address', autocomplete: 'postal-code', placeholder: '92064' },
];
const KEYS = new Set(FIELDS.map((f) => f.key));
const GROUPS = [
  ['name', 'Name'], ['identity', 'Identity'], ['contact', 'Contact'], ['address', 'Address'],
];

/** Keep only known keys, as trimmed strings. */
function clean(data) {
  const out = {};
  for (const f of FIELDS) {
    const v = data && data[f.key];
    if (v === undefined || v === null) continue;
    const text = String(v).trim();
    if (text) out[f.key] = text;
  }
  return out;
}

/** What autofill types: the stored fields plus the ones derived from them. */
function values(data) {
  const out = clean(data);
  const full = [out.first_name, out.middle_name, out.last_name].filter(Boolean).join(' ');
  if (full) out.full_name = full;
  return out;
}

/**
 * Where each field came from: 'hand', or the key of the browser it was taken
 * from. A browser's mark belongs to a value and goes with it; 'hand' is kept for
 * a field cleared by hand too, so a re-import does not fill it in again.
 */
function cleanFrom(from, data) {
  const out = {};
  for (const f of FIELDS) {
    const where = from && from[f.key];
    if (typeof where !== 'string' || !where) continue;
    if ((data && data[f.key]) || where === 'hand') out[f.key] = where.slice(0, 400);
  }
  return out;
}

class Profile {
  /**
   * @param {string} file where it lives
   * @param {object} [safeStorage] Electron's, or nothing (then the file is plain and says so)
   */
  constructor(file, safeStorage = null) {
    this.file = file;
    this.safe = safeStorage;
    this.data = {};
    this.from = {};
    this.autofill = true;
    this.encrypted = false;
    this.backend = 'none';
    this.load();
  }

  get available() {
    try {
      return Boolean(this.safe && this.safe.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  describeBackend() {
    if (!this.safe) return 'none';
    try {
      if (typeof this.safe.getSelectedStorageBackend === 'function') {
        const b = this.safe.getSelectedStorageBackend();
        return this.available ? b : `${b} (unavailable)`;
      }
    } catch { /* not linux */ }
    return this.available ? 'os-keychain' : 'none';
  }

  load() {
    this.backend = this.describeBackend();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return this;   // no file yet
    }
    if (!raw || typeof raw !== 'object') return this;
    this.autofill = raw.autofill !== false;
    try {
      // Version 1 kept the values alone; version 2 keeps them with where each came from.
      let body;
      if (raw.enc === 'safeStorage') {
        if (!this.available) throw new Error('the keychain that encrypted this profile is not available');
        body = JSON.parse(this.safe.decryptString(Buffer.from(raw.data, 'base64')));
        this.encrypted = true;
      } else {
        body = raw.v === 2 ? { data: raw.data, from: raw.from } : raw.data;
        this.encrypted = false;
      }
      const two = raw.v === 2 && body && typeof body === 'object';
      this.data = clean(two ? body.data : body);
      this.from = cleanFrom(two ? body.from : {}, this.data);
    } catch (err) {
      this.data = {};
      this.from = {};
      this.error = err.message;
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let body;
    this.from = cleanFrom(this.from, this.data);
    if (this.available && Object.keys(this.data).length) {
      body = { v: 2, enc: 'safeStorage', autofill: this.autofill,
        data: this.safe.encryptString(JSON.stringify({ data: this.data, from: this.from })).toString('base64') };
      this.encrypted = true;
    } else {
      body = { v: 2, enc: 'plain', autofill: this.autofill, data: this.data, from: this.from };
      this.encrypted = false;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.error = null;
    return this;
  }

  /**
   * Add or replace some fields and leave the rest alone.
   *
   * What an import does: the person picked a name and an email out of their
   * browser, and a licence number they typed in here last week is not to be
   * lost because it was not among them. `from` says where they came from: one
   * browser's key for all of them, or a key per field.
   */
  merge(data, from = null) {
    const taken = clean(data);
    this.data = clean({ ...this.data, ...taken });
    for (const key of Object.keys(taken)) {
      const where = typeof from === 'string' ? from : from && from[key];
      if (where) this.from[key] = where;
    }
    return this.save();
  }

  /**
   * The whole profile as the person saved it on the profile screen. A field
   * whose value they changed, or cleared, is theirs from now on: typed by hand,
   * and no re-import touches it.
   */
  set(data, { autofill } = {}) {
    const before = this.data;
    this.data = clean(data);
    for (const f of FIELDS) {
      if ((before[f.key] || '') !== (this.data[f.key] || '')) this.from[f.key] = 'hand';
    }
    if (typeof autofill === 'boolean') this.autofill = autofill;
    return this.save();
  }

  /** Where each field came from: 'hand', or the key of the browser it was taken from. */
  origins() {
    return { ...this.from };
  }

  clear() {
    this.data = {};
    this.from = {};
    try { fs.unlinkSync(this.file); } catch { /* nothing to remove */ }
    this.encrypted = false;
    this.error = null;
    return this;
  }

  /** What autofill needs: values plus the derived full name. */
  values() {
    return values(this.data);
  }

  /** What the profile screen shows: the data, and how it is kept. */
  view() {
    return {
      data: { ...this.data }, autofill: this.autofill, encrypted: this.encrypted,
      backend: this.backend, available: this.available, file: this.file,
      error: this.error || null, fields: FIELDS, groups: GROUPS,
      filled: FIELDS.filter((f) => this.data[f.key]).length,
    };
  }
}

module.exports = { Profile, FIELDS, GROUPS, KEYS, clean, values };
