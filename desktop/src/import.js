'use strict';
/**
 * What an import takes from a browser, and what it deliberately leaves.
 *
 * Two things are worth moving out of the browser somebody already uses:
 *
 *   their details   The name, email, phone and address they have saved for
 *                   filling forms in — which is exactly what this app's
 *                   profile holds, and what a line asks for before a bid.
 *                   Typing it again from memory is the most tedious minute of
 *                   setting this app up, and it is the one the browser can
 *                   answer.
 *   their sign-ins  The cookies for a booking site. A DMV portal that the
 *                   person is already signed in to in Chrome is a portal this
 *                   app's tab is signed in to, instead of a sign-in page at
 *                   the worst possible moment — with a slot held and a clock
 *                   running.
 *
 * And what is left behind, on purpose:
 *
 *   passwords       The app has never seen one and this is no place to start.
 *                   A sign-in that carries over as a cookie needs no password
 *                   here; a sign-in that does not is one to do in the browser.
 *   payment cards    Nothing in this app asks for one.
 *   history,        There is nowhere to put them. This app is a browser only
 *   bookmarks       while a booking page is open; a bookmark bar it does not
 *                   have is not a thing to import into.
 *
 * The cookie store is read whole, but it is sorted before anybody is asked
 * anything: the booking sites regbot lists are named and counted one by one,
 * and everything else is one line with a number on it. Ticking a booking site
 * is the ordinary case. Ticking the rest is there because a sign-in does not
 * always stay on the site you signed in to — a portal that hands you to an
 * identity provider leaves half of it on a host regbot has never heard of,
 * and the booking page asks you to sign in again with the cookie for it
 * sitting in the browser next door.
 *
 * Reading is not copying. Nothing is written anywhere until the person has
 * seen what there is and pressed the button: everything here reads, reports,
 * and hands back.
 *
 * The browser's own files are never opened. Each database is copied aside
 * first, read from the copy, and the copy deleted — because the browser may
 * be running, and because a file this app opens is a file this app could
 * damage.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chromium = require('./chromium');
const oscrypt = require('./oscrypt');
const sqlite = require('./sqlite');
const { FIELDS } = require('./profile');

/** 1601 to 1970, in seconds: Chromium counts microseconds from the earlier one. */
const EPOCH = 11644473600;

const LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

/**
 * Chromium's field types, for the two newer address tables.
 *
 * The numbers are its own `FieldType` enum; only the ones this profile has a
 * home for are listed. A type not here is a type nothing would be done with.
 */
const FIELD_TYPE = {
  3: 'first_name', 4: 'middle_name', 5: 'last_name', 7: 'full_name',
  9: 'email',
  10: 'phone', 13: 'phone', 14: 'phone',
  30: 'street', 33: 'city', 34: 'state', 35: 'zip', 77: 'street',
};
/** Where two types answer the same field, the more complete one wins. */
const TYPE_RANK = { 77: 3, 30: 2, 14: 3, 13: 2, 10: 1 };

/**
 * Form fields whose values are never taken, whatever they are called
 * elsewhere. The browser's key/value store keeps whatever was typed into a
 * form, card numbers among it, and a rule that guessed wrongly here would put
 * a card number in a passport box.
 */
const NEVER = /(^|_)(card|cardholder|cardnumber|cc|cvv|cvc|csc|security_code|expiry|expiration|exp_date|iban|swift|routing|account_number|password|passwd|pin|otp|token|secret|verification_code|captcha)(_|$)/;

/** Form field names worth taking, by the profile field they answer. */
const FROM_FORMS = [
  ['first_name', /(^|_)(first_name|firstname|fname|given_name|givenname)$/],
  ['middle_name', /(^|_)(middle_name|middlename|mname|additional_name)$/],
  ['last_name', /(^|_)(last_name|lastname|lname|surname|family_name|familyname)$/],
  ['email', /(^|_)(email|e_mail|email_address|emailaddress)$/],
  ['phone', /(^|_)(phone|phone_number|phonenumber|telephone|tel|mobile|mobile_number|cell|cell_phone)$/],
  ['street', /(^|_)(street|street_address|streetaddress|address|address_1|address_line_1|addr1|address_line1)$/],
  ['city', /(^|_)(city|town|locality|address_level_2)$/],
  ['state', /(^|_)(state|province|region|address_level_1)$/],
  ['zip', /(^|_)(zip|zip_code|zipcode|postal_code|postalcode|postcode)$/],
  ['dob', /(^|_)(dob|bday|birthday|birthdate|birth_date|date_of_birth)$/],
  ['dl_number', /(^|_)(dl|dl_number|dlnumber|drivers_license|driver_license|drivers_licence|license_number|licence_number|license_no|licence_no)$/],
  ['ssn', /(^|_)(ssn|social_security|social_security_number)$/],
  ['passport', /(^|_)(passport|passport_number|passport_no)$/],
];

/** `contact.contactFirstName` and `FirstName` alike become `first_name`. */
function normalizeName(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formField(name) {
  const norm = `_${normalizeName(name)}_`;
  if (NEVER.test(norm)) return null;
  for (const [key, pattern] of FROM_FORMS) if (pattern.test(normalizeName(name))) return key;
  return null;
}

/**
 * A value in the shape this profile keeps things in, or nothing.
 *
 * The profile screen validates a date of birth against `MM/DD/YYYY` and types
 * a phone number into a form, so a date the browser kept as `1984-03-02` and
 * a number it kept as `+1 (650) 555-0123` are worth straightening out here
 * rather than being offered in a shape the profile will reject.
 */
function tidy(key, raw) {
  // Horizontal space is collapsed here; a line break survives as far as the
  // street address, which is the one field Chromium can keep two lines in.
  const value = String(raw == null ? '' : raw).trim().replace(/[^\S\r\n]+/g, ' ');
  const flat = value.replace(/\s+/g, ' ');
  if (!flat) return null;
  switch (key) {
    case 'email':
      return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(flat) ? flat.toLowerCase() : null;
    case 'phone': {
      const digits = flat.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;
      if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
      if (digits.length === 10) return digits;
      return flat.startsWith('+') ? `+${digits}` : flat;
    }
    case 'zip':
      return /^\d{5}(-?\d{4})?$/.test(flat) || /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(flat) ? flat : null;
    case 'state':
      return flat.length <= 20 ? flat : null;
    case 'dob': {
      const iso = flat.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
      const us = flat.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
      if (us) return `${us[1].padStart(2, '0')}/${us[2].padStart(2, '0')}/${us[3]}`;
      return null;
    }
    case 'street':
      return value.replace(/\s*[\r\n]+\s*/g, ', ').slice(0, 200);
    default:
      return flat.length <= 120 ? flat : null;
  }
}

/** Collects what each source offers, keeps the best, remembers the rest. */
class Candidates {
  constructor() {
    this.byKey = new Map();
  }

  add(key, raw, { from, score = 0, rank = 0 } = {}) {
    if (!key || !LABELS[key]) return;
    const value = tidy(key, raw);
    if (!value) return;
    const list = this.byKey.get(key) || [];
    const same = list.find((c) => c.value === value);
    if (same) {
      same.score = Math.max(same.score, score);
      same.rank = Math.max(same.rank, rank);
      return;
    }
    list.push({ value, from, score, rank });
    this.byKey.set(key, list);
  }

  /** One row per field, best first, in the order the profile screen shows them. */
  fields() {
    const out = [];
    for (const field of FIELDS) {
      const list = this.byKey.get(field.key);
      if (!list || !list.length) continue;
      list.sort((a, b) => b.rank - a.rank || b.score - a.score || a.value.localeCompare(b.value));
      out.push({
        key: field.key,
        label: field.label,
        secret: Boolean(field.secret),
        value: list[0].value,
        from: list[0].from,
        others: list.slice(1, 4).map((c) => ({ value: c.value, from: c.from })),
      });
    }
    return out;
  }
}

// ------------------------------------------------------------------ details
/**
 * The addresses a browser has saved, across the three shapes Chromium has
 * kept them in: a table per part of an address (until 2023), then
 * `local_addresses` with a row per field type, then `addresses` with the same.
 * A browser upgraded over the years may have more than one of them; whichever
 * are there are read, and the most recently used address wins.
 */
function addressesFrom(db, candidates) {
  let found = 0;
  const modern = [['addresses', 'address_type_tokens'], ['local_addresses', 'local_addresses_type_tokens']];
  for (const [table, tokens] of modern) {
    if (!db.has(table) || !db.has(tokens)) continue;
    const used = new Map();
    for (const row of db.rows(table)) used.set(row.guid, Number(row.use_date) || Number(row.date_modified) || 0);
    const byGuid = new Map();
    for (const row of db.rows(tokens)) {
      const key = FIELD_TYPE[Number(row.type)];
      if (!key || !row.value) continue;
      if (!byGuid.has(row.guid)) byGuid.set(row.guid, []);
      byGuid.get(row.guid).push([key, row.value, TYPE_RANK[Number(row.type)] || 0]);
    }
    for (const [guid, parts] of byGuid) {
      found += 1;
      for (const [key, value, rank] of parts) {
        candidates.add(key, value, { from: 'Saved address', score: used.get(guid) || 0, rank });
      }
    }
  }
  if (db.has('autofill_profiles')) {
    const used = new Map();
    for (const row of db.rows('autofill_profiles')) {
      found += 1;
      const score = Number(row.use_date) || Number(row.date_modified) || 0;
      used.set(row.guid, score);
      const from = 'Saved address';
      candidates.add('street', row.street_address, { from, score, rank: 3 });
      candidates.add('city', row.city, { from, score });
      candidates.add('state', row.state, { from, score });
      candidates.add('zip', row.zipcode, { from, score });
    }
    const side = [
      ['autofill_profile_names', { first_name: 'first_name', middle_name: 'middle_name', last_name: 'last_name', full_name: 'full_name' }],
      ['autofill_profile_emails', { email: 'email' }],
      ['autofill_profile_phones', { phone: 'number' }],
    ];
    for (const [table, columns] of side) {
      if (!db.has(table)) continue;
      for (const row of db.rows(table)) {
        for (const [key, column] of Object.entries(columns)) {
          candidates.add(key, row[column], { from: 'Saved address', score: used.get(row.guid) || 0 });
        }
      }
    }
  }
  return found;
}

/**
 * What the browser remembers of the forms this person has filled in.
 *
 * Weaker than a saved address — it is every value ever typed into a field of
 * that name, most of it stale — so it ranks below one, and only field names
 * on the list above are looked at. It is also the only place a licence number
 * or a date of birth could come from, which no browser keeps as an address.
 */
function formValuesFrom(db, candidates) {
  if (!db.has('autofill')) return 0;
  let found = 0;
  for (const row of db.rows('autofill')) {
    const key = formField(row.name);
    if (!key) continue;
    found += 1;
    candidates.add(key, row.value, {
      from: 'A form you filled in',
      score: (Number(row.count) || 1) + (Number(row.date_last_used) || 0) / 1e12,
    });
  }
  return found;
}

// ------------------------------------------------------------------ cookies
/** The host part of an origin: `https://www.dmv.ca.gov:443` -> `www.dmv.ca.gov`. */
function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return String(origin || '').toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0];
  }
}

/** Does a cookie's host key cover this origin's host? */
function covers(hostKey, host) {
  const key = String(hostKey || '').toLowerCase().replace(/^\./, '');
  if (!key || !host) return false;
  return host === key || host.endsWith(`.${key}`) || key.endsWith(`.${host}`);
}

const SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * The sites to look for, one entry per host.
 *
 * A cookie belongs to a host, not to a port or a path, so two sites on the
 * same host share their cookies and there is no telling them apart — which is
 * what a development machine with six portals on `127.0.0.1` looks like.
 * Rather than showing one of their names and hiding the other, the entry
 * carries both.
 */
function byHost(sites) {
  const out = new Map();
  for (const site of sites) {
    const host = hostOf(site.origin);
    if (!host) continue;
    const already = out.get(host);
    if (!already) out.set(host, { ...site, host, names: [site.name] });
    else if (!already.names.includes(site.name)) already.names.push(site.name);
  }
  return [...out.values()].map((s) => ({ ...s, name: s.names.join(' · ') }));
}

/** One Chromium row as the arguments Electron's cookie store wants. */
function asCookie(row, value) {
  const host = String(row.host_key || '');
  const bare = host.replace(/^\./, '');
  const secure = Boolean(row.is_secure ?? row.secure);
  const path = row.path || '/';
  const cookie = {
    url: `${secure ? 'https' : 'http'}://${bare}${path}`,
    name: row.name,
    value,
    path,
    secure,
    httpOnly: Boolean(row.is_httponly ?? row.httponly),
    sameSite: SAME_SITE[String(row.samesite ?? -1)] || 'unspecified',
  };
  if (host.startsWith('.')) cookie.domain = host;
  const persistent = (row.is_persistent ?? row.has_expires ?? (row.expires_utc ? 1 : 0)) && row.expires_utc;
  if (persistent) cookie.expirationDate = Math.round(Number(row.expires_utc) / 1e6 - EPOCH);
  return cookie;
}

/**
 * The cookies this browser holds for the booking sites regbot knows.
 *
 * Nothing else is looked at: the host has to match one of the origins the
 * server listed, before the value is even decrypted. Ones whose scheme this
 * machine has no key for are counted, not guessed at.
 */
function cookiesFrom(db, { sites = [], keys = {}, platform = process.platform, now = Date.now() } = {}) {
  if (!db.has('cookies')) return { cookies: [], bySite: [], others: { count: 0, hosts: 0 }, locked: 0 };
  const wanted = byHost(sites);
  const counts = new Map(wanted.map((s) => [s.origin, 0]));
  const otherHosts = new Set();
  const cookies = [];
  const legacy = [];
  let locked = 0;
  for (const row of db.rows('cookies')) {
    const expires = Number(row.expires_utc) || 0;
    if (expires && expires / 1e6 - EPOCH < now / 1000) continue;        // long gone
    const site = wanted.find((s) => covers(row.host_key, s.host)) || null;
    const encrypted = row.encrypted_value;
    let value = row.value || '';
    if (!value && encrypted && encrypted.length) {
      const scheme = oscrypt.schemeOf(encrypted);
      if (scheme === 'legacy') { legacy.push([row, site, encrypted]); continue; }
      value = oscrypt.decryptValue(encrypted, { keys, platform, host: row.host_key });
      if (value === null) { locked += 1; continue; }
    }
    if (site) counts.set(site.origin, (counts.get(site.origin) || 0) + 1);
    else otherHosts.add(String(row.host_key || '').replace(/^\./, ''));
    cookies.push({ site: site ? site.origin : null, host: row.host_key, cookie: asCookie(row, value) });
  }
  const bySite = wanted.map((s) => ({ ...s, count: counts.get(s.origin) || 0 })).filter((s) => s.count);
  const others = { count: cookies.filter((c) => !c.site).length, hosts: otherHosts.size };
  return { cookies, bySite, others, locked, legacy };
}

/**
 * The cookies somebody ticked: the booking sites they chose, and — if they
 * asked for it — everything else the browser had.
 *
 * The choosing happens here rather than in the screen because the screen
 * never sees a cookie: it is told how many there are and which site they are
 * for, and hands back what it wants by name.
 */
function chosen(cookies, { origins = [], others = false } = {}) {
  const wanted = new Set(origins);
  return cookies.filter(({ site }) => (site ? wanted.has(site) : others));
}

// --------------------------------------------------------------------- read
/**
 * Copy a database and its write-ahead log aside, and hand back the copy.
 *
 * The log comes too, or a browser that is running right now would look as if
 * it had lost everything it did today: its newest pages are in there and
 * nowhere else.
 */
function copyAside(file, into) {
  const to = path.join(into, path.basename(file));
  fs.copyFileSync(file, to);
  try { fs.chmodSync(to, 0o600); } catch { /* not every filesystem has modes */ }
  try { fs.copyFileSync(`${file}-wal`, `${to}-wal`); } catch { /* not every database has one */ }
  return to;
}

/**
 * Everything one profile of one browser can offer this app.
 *
 * Both halves are attempted whatever happens to the other: a browser whose
 * cookies are sealed still has an address worth having, and a browser with no
 * saved address may still be signed in to the DMV.
 */
async function read(browser, profile, {
  sites = [], platform = process.platform, tmpdir = os.tmpdir(), state = null, exec,
} = {}) {
  const notes = [];
  const scratch = fs.mkdtempSync(path.join(tmpdir, 'regbot-import-'));
  try {
    const candidates = new Candidates();
    let addresses = 0;
    let forms = 0;
    if (profile.has.details) {
      try {
        const db = sqlite.open(copyAside(profile.has.details, scratch));
        addresses = addressesFrom(db, candidates);
        forms = formValuesFrom(db, candidates);
      } catch (err) {
        notes.push(`Could not read the saved details from this browser: ${err.message}`);
      }
    }

    let cookies = { cookies: [], bySite: [], others: { count: 0, hosts: 0 }, locked: 0 };
    let keyNotes = [];
    if (profile.has.cookies) {
      const localState = state || chromium.localState(browser.dir);
      const got = await oscrypt.keysFor(browser, { platform, state: localState, exec });
      keyNotes = got.notes;
      try {
        const db = sqlite.open(copyAside(profile.has.cookies, scratch));
        cookies = cookiesFrom(db, { sites, keys: got.keys, platform });
        if (cookies.legacy && cookies.legacy.length) {
          // Windows before 2020 protected every value on its own.
          const plain = await oscrypt.dpapi(cookies.legacy.map(([, , blob]) => blob), { exec });
          cookies.legacy.forEach(([row, site], i) => {
            if (!plain[i]) { cookies.locked += 1; return; }
            cookies.cookies.push({ site: site ? site.origin : null, host: row.host_key, cookie: asCookie(row, plain[i].toString('utf8')) });
            if (!site) { cookies.others.count += 1; return; }
            const found = cookies.bySite.find((s) => s.origin === site.origin);
            if (found) found.count += 1;
            else cookies.bySite.push({ ...site, count: 1 });
          });
        }
      } catch (err) {
        notes.push(`Could not read the sign-ins from this browser: ${err.message}. `
          + 'Closing the browser and trying again usually settles it.');
      }
    }

    const fields = candidates.fields();
    return {
      browser: { id: browser.id, name: browser.name, dir: browser.dir, known: browser.known },
      profile: { id: profile.id, name: profile.name },
      fields,
      addresses,
      forms,
      cookies: cookies.cookies,
      sites: cookies.bySite,
      others: cookies.others,
      locked: cookies.locked,
      notes: [...notes, ...keyNotes],
    };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
  }
}

/** Every browser on this machine, with its profiles, and nothing read yet. */
function scan(options = {}) {
  return chromium.installed(options).map((browser) => ({
    id: browser.id,
    name: browser.name,
    dir: browser.dir,
    known: browser.known,
    profiles: browser.profiles.map((p) => ({
      id: p.id, name: p.name, details: Boolean(p.has.details), cookies: Boolean(p.has.cookies),
    })),
  }));
}

/**
 * A browser and one of its profiles, by the directory `scan` handed out.
 *
 * The directory is the identity rather than the name, because one machine can
 * have the same browser twice — a Chromium from the distribution and a
 * Chromium from a Snap, each with its own profiles.
 */
function find(dir, profileId, options = {}) {
  const browser = chromium.installed(options).find((b) => b.dir === dir);
  if (!browser) throw new Error('That browser is no longer where it was.');
  const profile = browser.profiles.find((p) => p.id === profileId) || browser.profiles[0];
  if (!profile) throw new Error(`${browser.name} has no profile to import from.`);
  return { browser, profile };
}

module.exports = {
  scan, find, read, cookiesFrom, chosen, byHost, addressesFrom, formValuesFrom, formField, tidy, asCookie,
  covers, hostOf, Candidates, EPOCH,
};
