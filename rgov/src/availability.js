/**
 * Reading Recreation.gov's availability feed — the same one the campground
 * page's calendar draws from:
 *
 *   GET /api/camps/availability/campground/<facility id>/month?start_date=<YYYY-MM>-01T00:00:00.000Z
 *
 * One answer per campground per month, with every campsite and, for each night
 * of the month, what it is: `Available`, `Reserved`, `NYR` (not yet released),
 * `Not Reservable`, `Closed`, `Open` (first come, first served) and a few more.
 * Only `Available` can be booked.
 *
 * It needs no sign-in, no browser and no human check, which is the difference
 * from the DMV: looking costs one small request a month a campground, and the
 * person whose computer looks is asked for nothing of theirs. So the requests
 * say who they are (USER_AGENT), are spaced (`delayMs`), and a sweep that is
 * told to slow down or is turned away stops there and says so, as a gate —
 * never tries again from another address or under another name.
 *
 * The pure half (months, nights, runs) is kept apart from the fetching so it
 * can be tested, and the scout's simulate mode used, with no network at all.
 */

export const USER_AGENT = 'LineRightRegbot-rgov/1.0 (+https://lineright.org; open queue for scarce public bookings)';

/** The night a feed key is for: '2027-03-01T00:00:00Z' -> '2027-03-01'. */
export function nightOf(key) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(key || ''));
  return m ? m[1] : null;
}

/** 'YYYY-MM-DD' plus `n` days, on the calendar rather than the clock: no time zone can move it. */
export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Nights from `a` to `b`: addDays(a, nightsBetween(a, b)) === b. */
export function nightsBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/** The first of every month that has a night in [first, last]: what has to be fetched. */
export function monthsCovering(first, last) {
  const months = [];
  let at = `${first.slice(0, 7)}-01`;
  while (at <= last) {
    months.push(at);
    const [y, m] = at.split('-').map(Number);
    at = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return months;
}

export function monthUrl(base, facilityId, month) {
  const start = encodeURIComponent(`${month}T00:00:00.000Z`);
  return `${String(base).replace(/\/+$/, '')}/api/camps/availability/campground/${facilityId}/month?start_date=${start}`;
}

/**
 * One campground's months, joined into one record per campsite: what the
 * campsite is, and each night's status. Campsites hidden from the public, and
 * any that are not for staying overnight, are left out: nobody can book them.
 */
export function campsitesFrom(months) {
  const sites = new Map();
  for (const month of months) {
    for (const raw of Object.values(month?.campsites ?? {})) {
      if (!raw || raw.hide_external) continue;
      if (raw.type_of_use && raw.type_of_use !== 'Overnight') continue;
      const id = String(raw.campsite_id);
      let site = sites.get(id);
      if (!site) {
        site = {
          campsite_id: id,
          site: String(raw.site ?? ''),
          loop: String(raw.loop ?? ''),
          campsite_type: String(raw.campsite_type ?? ''),
          reserve_type: String(raw.campsite_reserve_type ?? ''),
          min_people: Number(raw.min_num_people) || 0,
          max_people: Number(raw.max_num_people) || null,
          nights: new Map(),
          spots: new Map(),
        };
        sites.set(id, site);
      }
      for (const [key, status] of Object.entries(raw.availabilities ?? {})) {
        const night = nightOf(key);
        if (night) site.nights.set(night, String(status));
      }
      // Some campsites are booked by the place rather than the site — Camp 4's
      // walk-in sites are — and say how many places are left each night.
      for (const [key, count] of Object.entries(raw.quantities ?? {})) {
        const night = nightOf(key);
        if (night) site.spots.set(night, Number(count) || 0);
      }
    }
  }
  return [...sites.values()];
}

export const AVAILABLE = 'Available';

/** Whether a campsite can be booked for `night`. */
export function openOn(site, night) {
  if (site.nights.get(night) !== AVAILABLE) return false;
  return !site.spots.has(night) || site.spots.get(night) > 0;
}

/**
 * The runs of consecutive bookable nights a campsite has inside [first, last],
 * each `{ first_night, last_night, nights }`. A run is what a stay is cut from:
 * five open nights hold a two-night stay arriving on any of the first four.
 */
export function openRuns(site, first, last) {
  const runs = [];
  let start = null;
  let prev = null;
  for (let night = first; night <= last; night = addDays(night, 1)) {
    if (openOn(site, night)) {
      if (start === null) start = night;
      prev = night;
      continue;
    }
    if (start !== null) runs.push({ first_night: start, last_night: prev, nights: nightsBetween(start, prev) + 1 });
    start = null;
  }
  if (start !== null) runs.push({ first_night: start, last_night: prev, nights: nightsBetween(start, prev) + 1 });
  return runs;
}

/** Whether a stay arriving `arrival` for `nights` nights fits a campsite as the feed shows it. */
export function stayFits(site, arrival, nights) {
  for (let i = 0; i < nights; i += 1) {
    if (!openOn(site, addDays(arrival, i))) return false;
  }
  return true;
}

/**
 * The first nights of the arrival window, and the last night a stay may use.
 * A window of arrivals 1–3 July for two nights needs the nights of 1–4 July.
 */
export function nightsNeeded(window, nights) {
  return { first: window[0], last: addDays(window[1], Math.max(1, nights) - 1) };
}

export class FeedGate extends Error {
  constructor(message, gate) {
    super(message);
    this.name = 'FeedGate';
    this.gate = gate;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one month of one campground. A 429 or a page that is not the feed is a
 * gate: the site asked for less, or does not want this, and the sweep stops.
 */
export async function fetchMonth(base, facilityId, month, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const url = monthUrl(base, facilityId, month);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`${facilityId} ${month.slice(0, 7)}: ${error.name === 'AbortError' ? 'no answer in time' : error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const type = String(res.headers.get('content-type') || '');
  if (res.status === 429) {
    throw new FeedGate('Recreation.gov asked this computer to slow down.', {
      kind: 'rate_limited', page_url: url, step: `availability ${facilityId} ${month.slice(0, 7)}`,
      extra: { retry_after: res.headers.get('retry-after') || null },
    });
  }
  if (res.status === 403 || (res.ok && !type.includes('json'))) {
    throw new FeedGate('Recreation.gov turned this computer away from its availability feed.', {
      kind: 'blocked', page_url: url, step: `availability ${facilityId} ${month.slice(0, 7)}`,
      extra: { status: res.status, content_type: type },
    });
  }
  if (!res.ok) throw new Error(`${facilityId} ${month.slice(0, 7)}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Every month one campground needs for [first, last], joined into campsites.
 * `pace` is awaited between requests, so a sweep is spaced across campgrounds
 * as well as months.
 */
export async function readCampground(base, facilityId, first, last, { fetchImpl = fetch, pace = async () => {} } = {}) {
  const months = [];
  for (const [i, month] of monthsCovering(first, last).entries()) {
    if (i > 0) await pace();
    months.push(await fetchMonth(base, facilityId, month, { fetchImpl }));
  }
  return campsitesFrom(months);
}

export { sleep };
