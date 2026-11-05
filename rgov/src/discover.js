/**
 * A scout's sweep: the campgrounds it was given, read off the availability
 * feed, turned into offers regbot can match bids against.
 *
 * An offer is one run of consecutive bookable nights at one campsite, as long
 * as the shortest stay the read asked about or longer. It says the run, not
 * every stay that fits in it: five open nights are one offer, and the matcher
 * cuts a two-night stay arriving on any of the first four out of it. The
 * office fields carry the campground, so the matcher places it on the map as
 * it would a DMV office.
 */
import { findCampground } from './catalog.js';
import { campsitesFrom, openRuns, nightsNeeded, readCampground, addDays, FeedGate, sleep } from './availability.js';
import { baseUrl } from './config.js';

/** The fewest places left on any night of `run`, for a campsite booked by the place; null otherwise. */
function spotsLeft(site, run) {
  if (!site.spots.size) return null;
  let least = Infinity;
  for (let night = run.first_night; night <= run.last_night; night = addDays(night, 1)) {
    least = Math.min(least, site.spots.get(night) ?? Infinity);
  }
  return Number.isFinite(least) ? least : null;
}

/** One offer, in the shape regbot's `offers` table expects, with the campsite beside it. */
export function toOffer(campground, site, run) {
  const spots = spotsLeft(site, run);
  return {
    ...(spots === null ? {} : { spots }),
    office_code: campground.id,
    office_name: campground.short,
    office_lat: campground.lat,
    office_lng: campground.lng,
    slot_date: run.first_night,
    slot_time: '',
    campsite_id: site.campsite_id,
    site: site.site,
    loop: site.loop,
    campsite_type: site.campsite_type,
    max_people: site.max_people,
    first_night: run.first_night,
    last_night: run.last_night,
    nights: run.nights,
  };
}

/**
 * The offers one campground's campsites make for arrivals in `window` and
 * stays of at least `nights`. A run that starts before the window still
 * counts, from the window's first night, since a stay may arrive then.
 */
export function offersFor(campground, sites, window, nights) {
  const { first, last } = nightsNeeded(window, nights);
  const offers = [];
  for (const site of sites) {
    for (const run of openRuns(site, first, last)) {
      if (run.nights >= nights) offers.push(toOffer(campground, site, run));
    }
  }
  return offers;
}

export async function discover(env = process.env, { fetchImpl = fetch, log = () => {} } = {}) {
  const base = baseUrl(env);
  const window = [env.DATE_START, env.DATE_END];
  const nights = Number(env.RGOV_NIGHTS || 1);
  const delayMs = Number(env.RGOV_REQUEST_DELAY_MS ?? 1500);
  const campgrounds = String(env.RGOV_CAMPGROUNDS || '').split(',').map((t) => findCampground(t)).filter(Boolean);
  const { first, last } = nightsNeeded(window, nights);

  const offers = [];
  const checked = [];
  let gate = null;
  for (const [i, campground] of campgrounds.entries()) {
    if (i > 0) await sleep(delayMs);
    try {
      const sites = await readCampground(base, campground.id, first, last, { fetchImpl, pace: () => sleep(delayMs) });
      const made = offersFor(campground, sites, window, nights);
      offers.push(...made);
      checked.push({ office: campground.short, campground_id: campground.id, campsites: sites.length, found: made.length, error: null });
      log('CHECKED', `${campground.short}: ${sites.length} campsites, ${made.length} open run(s)`);
    } catch (error) {
      checked.push({ office: campground.short, campground_id: campground.id, found: 0, error: error.message });
      log('CHECK_FAILED', `${campground.short}: ${error.message}`);
      // Asked to slow down, or turned away: every campground is behind the
      // same feed, and the rest of the sweep would only be asking again.
      if (error instanceof FeedGate) {
        gate = error.gate;
        break;
      }
    }
  }
  return { offers, checked, gate };
}

export { campsitesFrom };
