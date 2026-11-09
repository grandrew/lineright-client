/**
 * RQP/1 adapter — maps regbot's Yosemite line onto these robots.
 *
 * The envelopes are the DMV robots' (../../dmq/src/rqp.js), so the server's
 * worker and the desktop app handle both alike: a scout gets a
 * `discovery.request` and answers `discovery.result`, a booking gets a
 * `booking.request` and answers `booking.result`, and the statuses mean the
 * same. What differs is what a slot is. At the DMV it is an office, a day and a
 * time; here it is a campsite, the night of arrival and how many nights. The
 * office fields stay — `office_code` is the campground's facility id,
 * `office_name` its name — so the matcher can place an offer on the map as it
 * does an office, and the campsite rides beside them.
 */
import { findCampground, campgroundsOfKind, campgroundsWithin } from './catalog.js';

export const VERSION = 'RQP/1';

export const ACK = 'confirmed';          // booked; regbot captures the escrow
export const NACK_RETRY = 'unavailable'; // transient; retried while attempts remain
export const NACK_FATAL = 'rejected';    // permanent; escrow refunded immediately

export const CONNECTOR_NAME = 'recreation.gov.camps';
export const CONNECTOR_DISPLAY = 'Recreation.gov — Yosemite National Park campgrounds';

/** The longest stay Yosemite's campgrounds take in the summer season, and so the longest a bid may ask for. */
export const MAX_NIGHTS = 14;

/**
 * Each regbot line is one kind of campsite. The kind decides which campgrounds
 * a bid on it may name: a family-site bid never gets a horse site, and Camp 4,
 * booked by the place a week ahead, is a line of its own.
 */
export const LINES = {
  'yosemite-campsite': { kind: 'family', label: 'Yosemite campsite' },
  'yosemite-camp-4': { kind: 'walk-in', label: 'Camp 4 (walk-in)' },
  'yosemite-horse-camp': { kind: 'horse', label: 'Yosemite horse campsite' },
};

export class RqpError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'RqpError';
    this.permanent = permanent;
  }
}

export function lineFor(request) {
  const queue = request?.target?.queue ?? '';
  const line = LINES[queue];
  if (!line) {
    throw new RqpError(`No Yosemite line "${queue}". Known lines: ${Object.keys(LINES).join(', ')}.`, { permanent: true });
  }
  return { queue, ...line };
}

function requireField(personal, key, label) {
  const value = (personal?.[key] ?? '').toString().trim();
  if (!value) throw new RqpError(`${label} is missing from the application.`, { permanent: true });
  return value;
}

function wholeNumber(value, label, { min = 1, max = 99 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RqpError(`${label} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)}).`, { permanent: true });
  }
  return n;
}

/** A card number as digits, if it passes the Luhn check every card number does. */
export function cardDigits(raw) {
  const digits = String(raw ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0 ? digits : null;
}

/** Month and four-digit year of a card's expiry, refused if it has passed. */
export function cardExpiry(month, year, now = new Date()) {
  const m = Number(month);
  let y = Number(year);
  if (y >= 0 && y < 100) y += 2000;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) return null;
  const end = new Date(y, m, 1); // the first of the month after: a card works through its month
  if (end <= now) return null;
  return { month: String(m).padStart(2, '0'), year: String(y) };
}

/**
 * Which campgrounds this bid will take, best first, as catalogue records.
 *
 *   specific  the campgrounds named, in the order named
 *   area      every campground of the line's kind in one area of the park
 *   radius    every one within so many miles of a point, nearest first
 *   any       every campground of the line's kind
 *
 * A campground of another kind is refused rather than dropped: a bid that
 * names a horse camp on the family line was placed wrong, and quietly booking
 * it something else would be worse.
 */
export function campgroundsForConstraint(line, personal = {}) {
  const mode = String(personal.campground_mode ?? 'specific').trim().toLowerCase();

  if (mode === 'specific') {
    const named = Array.isArray(personal.campgrounds)
      ? personal.campgrounds
      : String(personal.campgrounds ?? personal.campground ?? '').split(',');
    const out = [];
    for (const term of named.map((t) => String(t).trim()).filter(Boolean)) {
      const campground = findCampground(term);
      if (!campground) throw new RqpError(`Unknown Yosemite campground ${JSON.stringify(term)}.`, { permanent: true });
      if (campground.kind !== line.kind) {
        throw new RqpError(`${campground.name} is not a ${line.label} campground.`, { permanent: true });
      }
      if (!out.includes(campground)) out.push(campground);
    }
    if (!out.length) throw new RqpError('Request names no campground.', { permanent: true });
    return out;
  }

  if (mode === 'area') {
    const hits = campgroundsOfKind(line.kind, { area: personal.area });
    if (!hits.length) throw new RqpError(`No ${line.label} campground in ${JSON.stringify(personal.area)}.`, { permanent: true });
    return hits;
  }

  if (mode === 'radius') {
    const radius = Number(personal.radius_miles);
    const origin = { lat: Number(personal.origin_lat), lng: Number(personal.origin_lng) };
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new RqpError(`Bad search radius ${JSON.stringify(personal.radius_miles)}.`, { permanent: true });
    }
    const hits = campgroundsWithin(origin, radius, { kind: line.kind });
    if (!hits.length) throw new RqpError(`No ${line.label} campground within ${radius} miles.`, { permanent: true });
    return hits.map((hit) => hit.campground);
  }

  if (mode === 'any') return campgroundsOfKind(line.kind);

  throw new RqpError(`Unknown campground constraint ${JSON.stringify(mode)}.`, { permanent: true });
}

function checkWindow(window, what) {
  const ok = Array.isArray(window) && /^\d{4}-\d{2}-\d{2}$/.test(window[0] ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(window[1] ?? '');
  if (!ok) throw new RqpError(`${what} carries no arrival window.`, { permanent: true });
  if (window[1] < window[0]) throw new RqpError(`${what}'s arrival window ends before it starts.`, { permanent: true });
  return window;
}

function checkEnvelope(request, kind) {
  if (request?.protocol !== VERSION) {
    throw new RqpError(`Unsupported protocol ${JSON.stringify(request?.protocol)}, expected ${VERSION}`, { permanent: true });
  }
  if (request?.kind !== kind) {
    throw new RqpError(`Unsupported envelope kind ${JSON.stringify(request?.kind)}`, { permanent: true });
  }
}

/**
 * Turn a request envelope into the environment `loadConfig` understands.
 *
 * Booking is opt-in twice over, as at the DMV: regbot asking for a booking is
 * not enough, the process must also be started with RQP_ALLOW_BOOKING=true.
 * Without it the run is a dry probe that finds the campsite and stops before
 * anything goes in a cart. With it, the run pays — with the card the person
 * keeps in the app's profile — so the card is checked here, before a browser
 * opens, and a card that cannot work ends the bid rather than an attempt.
 */
export function requestToEnv(request, env = {}) {
  checkEnvelope(request, 'booking.request');
  const line = lineFor(request);
  const personal = request.personal_data ?? {};
  const window = checkWindow(request.slot?.window, 'Request');

  let campgrounds = campgroundsForConstraint(line, personal);
  const allocated = request.slot?.allocated ?? null;
  const nights = wholeNumber(allocated?.nights ?? personal.nights, 'Nights', { max: MAX_NIGHTS });

  const out = {
    RGOV_QUEUE: line.queue,
    RGOV_KIND: line.kind,
    DATE_START: window[0],
    DATE_END: window[1],
    RGOV_NIGHTS: String(nights),
    AUTO_SUBMIT: env.RQP_ALLOW_BOOKING === 'true' ? 'true' : 'false',
    HEADLESS: env.HEADLESS ?? 'true',
    RUN_LOG_PATH: env.RUN_LOG_PATH ?? './rgov_bot_run_log.txt',
  };

  // The campsite the processor allocated: booked directly, and nothing else.
  // Its campground goes first in the list for a run that has to look again.
  if (allocated?.campsite_id) {
    const campground = findCampground(allocated.office_code ?? allocated.office_name ?? '');
    if (!campground) {
      throw new RqpError(`Allocated campground ${JSON.stringify(allocated.office_code ?? allocated.office_name)} is not in the catalogue.`, { permanent: true });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(allocated.date ?? ''))) {
      throw new RqpError('The allocated campsite carries no arrival date.', { permanent: true });
    }
    campgrounds = [campground, ...campgrounds.filter((c) => c.id !== campground.id)];
    Object.assign(out, {
      RGOV_TARGET_CAMPGROUND: campground.id,
      RGOV_TARGET_CAMPSITE: String(allocated.campsite_id),
      RGOV_TARGET_SITE: String(allocated.site ?? ''),
      RGOV_TARGET_ARRIVAL: String(allocated.date),
    });
  }
  out.RGOV_CAMPGROUNDS = campgrounds.map((c) => c.id).join(',');

  if (out.AUTO_SUBMIT === 'true') {
    // A rehearsal is asked for by whoever starts the process, never by regbot.
    if (env.RGOV_REHEARSE === 'true') out.RGOV_REHEARSE = 'true';
    out.RGOV_PARTY_SIZE = String(wholeNumber(personal.party_size, 'Party size', { max: line.kind === 'walk-in' ? 6 : 8 }));
    out.RGOV_VEHICLES = String(wholeNumber(personal.vehicles ?? 1, 'Vehicles', { min: 0, max: 2 }));
    out.RGOV_EQUIPMENT = String(personal.equipment ?? 'tent').trim().toLowerCase();
    if (personal.equipment_length_ft) {
      out.RGOV_EQUIPMENT_LENGTH = String(wholeNumber(personal.equipment_length_ft, 'Equipment length', { max: 45 }));
    }
    out.FIRST_NAME = requireField(personal, 'first_name', 'First name');
    out.LAST_NAME = requireField(personal, 'last_name', 'Last name');
    out.EMAIL_ADDRESS = requireField(personal, 'email', 'Email address');
    out.PHONE_NUMBER = requireField(personal, 'phone', 'Phone number');

    const card = cardDigits(requireField(personal, 'card_number', 'Card number'));
    if (!card) throw new RqpError('The card number in the profile is not a valid card number.', { permanent: true });
    const expiry = cardExpiry(requireField(personal, 'card_exp_month', 'Card expiry month'),
      requireField(personal, 'card_exp_year', 'Card expiry year'));
    if (!expiry) throw new RqpError('The card in the profile has expired.', { permanent: true });
    const cvc = requireField(personal, 'card_cvc', 'Card security code');
    if (!/^\d{3,4}$/.test(cvc)) throw new RqpError('The card security code must be 3 or 4 digits.', { permanent: true });
    Object.assign(out, {
      CARD_NAME: String(personal.card_name || `${out.FIRST_NAME} ${out.LAST_NAME}`).trim(),
      CARD_NUMBER: card,
      CARD_EXP_MONTH: expiry.month,
      CARD_EXP_YEAR: expiry.year,
      CARD_CVC: cvc,
      BILLING_STREET: requireField(personal, 'street', 'Billing street address'),
      BILLING_CITY: requireField(personal, 'city', 'Billing city'),
      BILLING_STATE: requireField(personal, 'state', 'Billing state'),
      BILLING_ZIP: requireField(personal, 'zip', 'Billing ZIP code'),
    });
  }

  return out;
}

export function result(status, message, extra = {}) {
  return {
    protocol: VERSION,
    kind: 'booking.result',
    status,
    message,
    confirmation: '',
    connector: CONNECTOR_DISPLAY,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };
}

function stayWords(outcome) {
  const nights = Number(outcome.nights) || 1;
  return `site ${outcome.site || outcome.campsite_id} at ${outcome.campground}, arriving ${outcome.arrival}, ${nights} night${nights === 1 ? '' : 's'}`;
}

/**
 * Map a robot outcome onto a result envelope. A booking is `confirmed` only
 * with the reservation number Recreation.gov showed for it: that number is what
 * the person changes or cancels it with, and there is no making one up.
 */
export function outcomeToResult(outcome, { latencyMs, booking } = {}) {
  const extra = latencyMs === undefined ? {} : { latency_ms: latencyMs };
  const checked = (outcome?.results ?? []).map((r) => ({ office: r.campground, status: r.status }));
  if (checked.length) extra.offices = checked;
  if (outcome?.gate) extra.gate = outcome.gate;
  if (outcome?.overseen) extra.overseen = true;

  switch (outcome?.status) {
    case 'BOOKED_SUCCESS': {
      const confirmation = booking ?? outcome.reference;
      if (!confirmation) return unconfirmed(outcome, extra, 'no reservation number was read');
      if (outcome.url) extra.confirmation_url = outcome.url;
      if (outcome.shot) extra.confirmation_shot = outcome.shot;
      return result(ACK,
        `Booked ${stayWords(outcome)}. Recreation.gov reservation ${confirmation}.`,
        { ...extra, confirmation, booked_date: outcome.arrival, nights: Number(outcome.nights) || null,
          campsite_id: outcome.campsite_id ?? null });
    }

    case 'BOOKING_UNCONFIRMED':
      return unconfirmed(outcome, extra, outcome.seen);

    case 'PAYMENT_DECLINED':
      // Nothing was bought: the card was refused before the order went
      // through. Trying the same card again is pointless; the campsite sits in
      // the person's cart until the hold runs out, for them to pay another way.
      return result(NACK_FATAL,
        `Recreation.gov declined the card for ${stayWords(outcome)}. Nothing was charged. `
          + (outcome.held_until ? `It is held in your Recreation.gov cart until ${outcome.held_until}: pay there with another card to keep it.`
            : 'Update the card in the app before your next turn.'),
        { ...extra, payment_declined: true, ...(outcome.cart_url ? { cart_url: outcome.cart_url } : {}),
          ...(outcome.held_until ? { held_until: outcome.held_until } : {}) });

    case 'REHEARSED':
      return result(NACK_RETRY,
        `Rehearsal: reached the payment step for ${stayWords(outcome)} and stopped before paying. Nothing was charged`
          + (outcome.held_until ? `; it is in the Recreation.gov cart until ${outcome.held_until}.` : '.'),
        { ...extra, rehearsed: true, ...(outcome.held_until ? { held_until: outcome.held_until } : {}) });

    case 'FOUND_AND_STOPPED':
      return result(NACK_RETRY,
        `Found ${stayWords(outcome.best)}, but booking is disabled (set RQP_ALLOW_BOOKING=true to let the connector book).`,
        { ...extra, found_date: outcome.best.arrival, found_office: outcome.best.campground });

    case 'NO_AVAILABILITY':
      if (outcome.slot_gone) {
        return result(NACK_RETRY, 'The allocated campsite is no longer available for those nights.', { ...extra, slot_gone: true });
      }
      return result(NACK_RETRY, 'No campsite available for those nights in the requested window.', extra);

    default:
      return result(NACK_RETRY, `Unrecognised robot outcome ${JSON.stringify(outcome?.status)}.`, extra);
  }
}

export function errorToResult(error, { latencyMs } = {}) {
  const extra = latencyMs === undefined ? {} : { latency_ms: latencyMs };
  const permanent = error instanceof RqpError && error.permanent;
  if (error?.gate) extra.gate = error.gate;
  return result(permanent ? NACK_FATAL : NACK_RETRY, error?.message || 'The booking failed.', extra);
}

/**
 * The order went to Recreation.gov and no reservation number came back. It may
 * exist, and the person may have been charged; trying again may book and charge
 * them twice. So this is `rejected`, the one verdict regbot never retries.
 */
function unconfirmed(outcome, extra, seen) {
  const attempted = { office: outcome.campground ?? null, campsite_id: outcome.campsite_id ?? null,
    date: outcome.arrival ?? null, nights: Number(outcome.nights) || null };
  return result(NACK_FATAL,
    `The order for ${stayWords(outcome)} was sent to Recreation.gov, but no reservation number was shown, `
      + 'so it may or may not have gone through. It was not tried again, so that you are not booked or charged twice. '
      + 'Look in your Recreation.gov reservations and email before booking again.',
    { ...extra, unconfirmed: true, attempted, ...(seen ? { seen } : {}) });
}

// ============================================================ discovery
/**
 * Map a `discovery.request` onto the scout's environment: which campgrounds,
 * which arrivals, the shortest stay worth reporting. No applicant, no card, no
 * sign-in: a scout reads a public feed and has nothing to book with.
 */
export function discoveryRequestToEnv(request, env = {}) {
  checkEnvelope(request, 'discovery.request');
  const line = lineFor(request);
  const named = Array.isArray(request.campgrounds) ? request.campgrounds
    : Array.isArray(request.offices) ? request.offices : [];
  const campgrounds = [];
  for (const term of named.map((t) => String(t).trim()).filter(Boolean)) {
    const campground = findCampground(term);
    if (!campground) throw new RqpError(`Unknown Yosemite campground ${JSON.stringify(term)}.`, { permanent: true });
    if (campground.kind !== line.kind) throw new RqpError(`${campground.name} is not a ${line.label} campground.`, { permanent: true });
    if (!campgrounds.includes(campground)) campgrounds.push(campground);
  }
  if (!campgrounds.length) throw new RqpError('Discovery request names no campgrounds.', { permanent: true });
  const window = checkWindow(request.window, 'Discovery request');
  const nights = wholeNumber(request.nights ?? 1, 'Nights', { max: MAX_NIGHTS });
  return {
    RGOV_QUEUE: line.queue,
    RGOV_KIND: line.kind,
    RGOV_CAMPGROUNDS: campgrounds.map((c) => c.id).join(','),
    DATE_START: window[0],
    DATE_END: window[1],
    RGOV_NIGHTS: String(nights),
    RUN_LOG_PATH: env.RUN_LOG_PATH ?? './rgov_scout_run_log.txt',
  };
}

export function discoveryResult(status, message, extra = {}) {
  return {
    protocol: VERSION,
    kind: 'discovery.result',
    status,
    message,
    connector: CONNECTOR_DISPLAY,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    offers: [],
    checked: [],
    ...extra,
  };
}

export function offersToResult({ offers = [], checked = [], gate = null }, { latencyMs } = {}) {
  const failed = checked.filter((c) => c.error).length;
  const campsites = new Set(offers.map((o) => o.campsite_id)).size;
  const message = offers.length
    ? `Found ${campsites} campsite(s) with open nights across ${checked.length} campground(s).`
    : gate
      ? `Stopped: ${gate.kind === 'rate_limited' ? 'Recreation.gov asked for fewer requests' : 'Recreation.gov turned the request away'} `
        + `after ${checked.length - failed} of ${checked.length} campground(s).`
      : failed
        ? `No openings readable: ${failed} of ${checked.length} campground(s) failed. ${checked.find((c) => c.error)?.error ?? ''}`.trim()
        : `No openings at ${checked.length} campground(s).`;
  return discoveryResult(ACK, message, {
    offers,
    checked,
    ...(gate ? { gate } : {}),
    ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
  });
}

export function discoveryErrorToResult(error, { latencyMs } = {}) {
  return discoveryResult(error?.permanent ? NACK_FATAL : NACK_RETRY, error?.message || 'Discovery failed.', {
    ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
    ...(error?.gate ? { gate: error.gate } : {}),
  });
}
