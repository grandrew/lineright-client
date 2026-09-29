'use strict';
/**
 * Bringing a browser's details and sign-ins across again: once a week, one click.
 *
 * The first import (import.js) is a careful thing: the person looks inside a
 * browser, sees what it holds, and ticks what to take. After that the browser
 * goes on being where they keep things current — a new phone number saved
 * there, a sign-in to a booking site renewed — and the copy here goes stale.
 * So the app remembers where each import came from and what was taken (never
 * the values: those live in the profile, encrypted), and once a week asks to
 * do the same again, with one button.
 *
 * Doing it again takes the same things from the same places and nothing more:
 * the fields ticked last time, and the sign-ins for the sites ticked last
 * time. It also respects what happened since:
 *
 *   - a field the person changed or cleared on the profile screen is theirs,
 *     and is left alone (profile.js remembers which those are);
 *   - a field that came from another browser is left to that browser;
 *   - a value the browser still offers is kept, even when it is not the
 *     browser's first choice — the person may have picked it out of several;
 *   - a sign-in the app's own browser holds with a later expiry than the one
 *     in the other browser is the fresher, and is kept.
 *
 * How often it asks is the site's to say (its admin panel's `reimport_days` and
 * `reimport_later_hours`, sent on every sync as `apps`): a week, and a day after
 * "Not now", until it says otherwise. The next ask is worked out from when the
 * last import was, each time, so a change on the site applies at once.
 *
 * Everything here is plain logic over what it is handed, so it can be tested
 * without a browser: main.js reads the browsers and sets the cookies.
 */
const { KEYS } = require('./profile');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long after an import the app asks to do it again, until the site says. */
const EVERY_MS = 7 * DAY_MS;
/** How long "Not now" puts it off, until the site says. */
const LATER_MS = DAY_MS;
/** The browsers remembered, newest first. */
const MAX_SOURCES = 4;

/**
 * How often to ask, from what the site said (`{reimport_days, reimport_later_hours}`,
 * or nothing): `every` 0 is not at all.
 */
function schedule(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const days = Number(p.reimport_days);
  const hours = Number(p.reimport_later_hours);
  return {
    every: Number.isFinite(days) && days >= 0 ? days * DAY_MS : EVERY_MS,
    later: Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : LATER_MS,
  };
}

/** A browser profile's identity: its directory, which is what import.find takes. */
const sourceKey = (src) => `${src.dir}|${src.profile}`;

const label = (src) => `${src.name || 'Your browser'}${src.profileName ? ` (${src.profileName})` : ''}`;

function valid(src) {
  return src && typeof src === 'object' && typeof src.dir === 'string' && src.dir
    && typeof src.profile === 'string' && src.profile && Array.isArray(src.fields)
    && Array.isArray(src.origins);
}

/** The browsers imported from, newest first. */
function sources(store) {
  const list = store.get('importSources', []);
  return Array.isArray(list) ? list.filter(valid) : [];
}

/**
 * After an import the person ticked: remember where it came from and what was
 * taken; the next ask is counted from it. An import that took nothing is not
 * one to repeat. The last import from a browser says what to take from it next
 * time.
 */
function remember(store, { dir, profile, name = '', profileName = '', fields = [], origins = [], others = false },
  now = Date.now()) {
  if (!dir || !profile) return null;
  const entry = {
    dir, profile, name: String(name).slice(0, 80), profileName: String(profileName).slice(0, 80),
    fields: [...new Set(fields)].filter((k) => KEYS.has(k)),
    origins: [...new Set(origins)].filter((o) => typeof o === 'string' && o).slice(0, 50),
    others: Boolean(others), at: new Date(now).toISOString(),
  };
  if (!entry.fields.length && !entry.origins.length && !entry.others) return null;
  const rest = sources(store).filter((s) => sourceKey(s) !== sourceKey(entry));
  store.set('importSources', [entry, ...rest].slice(0, MAX_SOURCES));
  store.set('reimportLaterAt', null);
  return entry;
}

/**
 * When to ask next: its interval after the last import, or later if "Not now"
 * put it off. Null when there is nothing to ask about, or the site says not to.
 */
function nextAt(store, policy = null) {
  const { every } = schedule(policy);
  const last = Math.max(...sources(store).map((s) => Date.parse(s.at) || 0), 0);
  if (!last || !every) return null;
  const put = Date.parse(store.get('reimportLaterAt', '') || '');
  return Math.max(last + every, Number.isFinite(put) ? put : 0);
}

/** Whether to ask now: something to re-import, the person has not turned it off, and its time is up. */
function due(store, now = Date.now(), policy = null) {
  if (store.get('reimportRemind', true) === false) return false;
  const at = nextAt(store, policy);
  return at !== null && at <= now;
}

/** "Not now": ask again after the site's while — a day, unless it says otherwise. */
function later(store, now = Date.now(), policy = null) {
  store.set('reimportLaterAt', new Date(now + schedule(policy).later).toISOString());
}

/** Stop re-importing from one browser (the Settings screen), or from all of them. */
function forget(store, key = null) {
  store.set('importSources', key ? sources(store).filter((s) => sourceKey(s) !== key) : []);
}

/** What the screens show. */
function view(store, now = Date.now(), policy = null) {
  const at = nextAt(store, policy);
  return {
    due: due(store, now, policy),
    remind: store.get('reimportRemind', true) !== false,
    at: at === null ? null : new Date(at).toISOString(),
    every_days: schedule(policy).every / DAY_MS,
    sources: sources(store).map((s) => ({
      key: sourceKey(s), name: s.name, profileName: s.profileName, label: label(s),
      fields: s.fields.length, sites: s.origins.length, others: s.others, at: s.at,
    })),
  };
}

/**
 * What taking one browser's fields again would change.
 *
 * @param {object} src      a remembered source
 * @param {Array} fields    what the browser offers now (import.read's `fields`)
 * @param {object} values   the profile's values
 * @param {object} from     where each profile field came from (profile.origins())
 * @returns {{take: object, kept: string[]}} `kept`: fields the browser has something
 *   else for, left alone because the person typed their own
 */
function plan(src, fields, values, from) {
  const key = sourceKey(src);
  const take = {};
  const kept = [];
  for (const f of fields || []) {
    if (!src.fields.includes(f.key) || !f.value) continue;
    const where = from[f.key];
    const have = values[f.key] || '';
    if (where === 'hand' || (have && !where)) {
      // Typed here — or there from before the profile kept track, which is the same.
      if (have && have !== f.value) kept.push(f.key);
      continue;
    }
    if (where && where !== key) continue;
    const offered = [f.value, ...(f.others || []).map((o) => o.value)];
    if (have && offered.includes(have)) continue;
    take[f.key] = f.value;
  }
  return { take, kept };
}

const cookieKey = (domain, where, name) => `${String(domain || '').replace(/^\./, '').toLowerCase()}|${where || '/'}|${name}`;
const expiry = (c) => (typeof c.expirationDate === 'number' ? c.expirationDate : Infinity);

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * The cookies worth setting: the ones the app's own browser does not already
 * hold a fresher copy of. A cookie that expires later was set later — a
 * sign-in renewed — and one with no expiry at all lives only as long as the
 * app does, so it is from today.
 *
 * @param {Array} taking     [{cookie}] as import.chosen returns them
 * @param {Array} existing   the app's own cookies, as Electron's cookies.get returns them
 */
function fresher(taking, existing) {
  const held = new Map();
  for (const c of existing || []) held.set(cookieKey(c.domain, c.path, c.name), expiry(c));
  return (taking || []).filter(({ cookie }) => {
    const have = held.get(cookieKey(cookie.domain || hostOf(cookie.url), cookie.path, cookie.name));
    return have === undefined || expiry(cookie) > have;
  });
}

/**
 * Do every remembered import again.
 *
 * @param {object} opts
 * @param {object} opts.store       the settings (store.js)
 * @param {object} opts.profile     the Profile
 * @param {function} opts.read      (src) => what import.read found in that browser
 * @param {function} opts.cookies   async (taking) => {set, refused, fresher}: puts them in the app's browser
 */
async function run({ store, profile, read, cookies, now = Date.now(), policy = null }) {
  const list = sources(store);
  const values = { ...profile.values() };
  const from = { ...profile.origins() };
  const take = {};
  const origin = {};
  const kept = new Set();
  const out = { updated: [], kept: [], cookies: 0, refused: 0, fresher: 0, done: [], failed: [], notes: [] };
  // Newest first: a field two browsers could answer goes to the one imported from last.
  for (const src of list) {
    let found;
    try {
      found = await read(src);
    } catch (err) {
      out.failed.push({ name: label(src), message: err.message });
      continue;
    }
    const step = plan(src, found.fields, values, from);
    for (const [key, value] of Object.entries(step.take)) {
      take[key] = value;
      origin[key] = sourceKey(src);
      values[key] = value;
      from[key] = sourceKey(src);
    }
    for (const key of step.kept) kept.add(key);
    try {
      const put = await cookies(src, found);
      out.cookies += put.set || 0;
      out.refused += put.refused || 0;
      out.fresher += put.fresher || 0;
    } catch (err) {
      out.notes.push(`${label(src)}: the sign-ins did not come across (${err.message}).`);
    }
    for (const note of found.notes || []) out.notes.push(`${label(src)}: ${note}`);
    out.done.push(label(src));
    src.at = new Date(now).toISOString();
  }
  if (Object.keys(take).length) profile.merge(take, origin);
  out.updated = Object.keys(take);
  out.kept = [...kept];
  store.set('importSources', list);
  // Nothing could be read — a browser gone, or locked: ask again after "Not now"'s
  // while, not a whole interval on. Something was: the next is counted from now.
  if (out.done.length) store.set('reimportLaterAt', null);
  else later(store, now, policy);
  return out;
}

module.exports = {
  remember, due, later, forget, view, plan, fresher, run, sources, sourceKey, label, nextAt, schedule,
  EVERY_MS, LATER_MS, MAX_SOURCES,
};
