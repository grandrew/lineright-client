/**
 * RQP/1 adapter — maps regbot queue jobs onto this bot.
 *
 * regbot (the lineright server) is a marketplace for positions in appointment queues. Its
 * worker leases a job, builds a `booking.request` envelope and hands it to the
 * connector named in `sites.connector`. This module is the other half of that
 * seam: envelope in, bot run, `booking.result` envelope out.
 *
 * The protocol itself lives in the server's protocol.py and the connector
 * contract in its connectors/base.py. Both are treated as fixed here.
 */

import { findOffice, resolveOrigin, officesWithin } from './catalog.js';

export const VERSION = 'RQP/1';

export const ACK = 'confirmed';        // booked; regbot captures the escrow
export const NACK_RETRY = 'unavailable'; // transient; retried while attempts remain
export const NACK_FATAL = 'rejected';    // permanent; escrow refunded immediately

export const CONNECTOR_NAME = 'dmv.ca.gov.qmatic';
export const CONNECTOR_DISPLAY = 'California DMV — Qmatic appointment portal';

/**
 * Each regbot line maps to exactly one DMV appointment type. The line is the
 * unit a bidder queues for, so the service comes from the queue slug rather
 * than from applicant-supplied data.
 */
export const SERVICE_BY_QUEUE = {
  'drive-test-auto': 'DT',
  'drive-test-commercial': 'CDL',
  'drive-test-motorcycle': 'MC',
  'knowledge-retest': 'KTR',
  'vehicle-registration': 'VR',
  'real-id': 'RID',
  'license-id': 'CID',
};

export class RqpError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'RqpError';
    this.permanent = permanent;
  }
}

function requireField(personal, key, label) {
  const value = (personal?.[key] ?? '').toString().trim();
  if (!value) {
    // Missing personal data is the applicant's to fix; retrying cannot help.
    throw new RqpError(`${label} is missing from the application.`, { permanent: true });
  }
  return value;
}

export function serviceForQueue(request) {
  const queue = request?.target?.queue ?? '';
  const service = SERVICE_BY_QUEUE[queue];
  if (!service) {
    throw new RqpError(
      `No DMV service mapped for line "${queue}". Known lines: ${Object.keys(SERVICE_BY_QUEUE).join(', ')}.`,
      { permanent: true }
    );
  }
  return service;
}

/**
 * Turn a request envelope into the environment `loadConfig` understands.
 *
 * Booking is opt-in twice over: regbot asking for a booking is not enough, the
 * operator must also set RQP_ALLOW_BOOKING=true. Without it the run is a dry
 * probe, because a confirmed slot here is a real appointment at a government
 * agency under a real licence number.
 */
/**
 * Which offices this applicant will accept, best first.
 *
 * regbot stores the constraint already resolved — the office code, or the
 * origin's coordinates — but this re-derives from the catalogue rather than
 * trusting codes to mean anything here, because it is the office *name* that
 * the DMV search box matches, and only the catalogue knows the public name for
 * a given office.
 *
 * The legacy free-text `offices` field is still accepted so a bid placed before
 * the constraint existed still runs.
 */
export function officesForConstraint(personal = {}) {
  const mode = String(personal.office_mode ?? '').trim().toLowerCase();

  if (mode === 'specific') {
    const typed = personal.office_name ?? personal.office ?? '';
    const office = findOffice(typed);
    if (!office) {
      throw new RqpError(`Unknown DMV office ${JSON.stringify(String(typed))}.`, { permanent: true });
    }
    return [office.name];
  }

  if (mode === 'radius') {
    const radius = Number(personal.radius_miles);
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new RqpError(`Bad search radius ${JSON.stringify(personal.radius_miles)}.`, { permanent: true });
    }
    const lat = Number(personal.origin_lat);
    const lng = Number(personal.origin_lng);
    const origin = Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : resolveOrigin(personal.origin ?? '');
    if (!origin) {
      throw new RqpError(`Could not place ${JSON.stringify(String(personal.origin ?? ''))} on the map.`,
        { permanent: true });
    }
    const hits = officesWithin(origin, radius);
    if (!hits.length) {
      throw new RqpError(`No DMV office within ${radius} miles of the given origin.`, { permanent: true });
    }
    return hits.map((hit) => hit.office.name);
  }

  const legacy = String(personal.offices ?? '').trim();
  if (legacy) return [legacy];

  throw new RqpError('Request carries no office constraint.', { permanent: true });
}

export function requestToEnv(request, env = {}) {
  if (request?.protocol !== VERSION) {
    throw new RqpError(`Unsupported protocol ${JSON.stringify(request?.protocol)}, expected ${VERSION}`, {
      permanent: true,
    });
  }
  if (request?.kind !== 'booking.request') {
    throw new RqpError(`Unsupported envelope kind ${JSON.stringify(request?.kind)}`, { permanent: true });
  }

  const service = serviceForQueue(request);
  const personal = request.personal_data ?? {};
  const window = request.slot?.window ?? [];
  if (!window[0] || !window[1]) {
    throw new RqpError('Request carries no slot window.', { permanent: true });
  }

  let offices = officesForConstraint(personal);

  // The processor may already have decided which slot this bid is getting. Put
  // that office at the front so it is tried first; the rest stay behind it as a
  // fallback, because between allocation and booking the slot can be taken by
  // somebody who walked in off the street.
  const allocated = request.slot?.allocated ?? null;
  if (allocated?.office_name) {
    const target = findOffice(allocated.office_name)?.name ?? allocated.office_name;
    offices = [target, ...offices.filter((name) => name !== target)];
  }

  const out = {
    DMV_SERVICE: service,
    DMV_OFFICES: offices.join(', '),
    DATE_START: window[0],
    DATE_END: window[1],
    AUTO_SUBMIT: env.RQP_ALLOW_BOOKING === 'true' ? 'true' : 'false',
    HEADLESS: env.HEADLESS ?? 'true',
    RUN_LOG_PATH: env.RUN_LOG_PATH ?? './dmv_bot_run_log.txt',
  };

  if (allocated?.date) {
    out.DMV_TARGET_DATE = allocated.date;
    if (allocated.time) out.DMV_TARGET_TIME = allocated.time;
    if (allocated.office_name) out.DMV_TARGET_OFFICE = allocated.office_name;
  }

  // A token the applicant minted themselves, present only when a job that
  // parked at a human check is being resumed. Carrying it is what closes that
  // loop: regbot collects it, the bot hands it to the page that asked.
  const suppliedToken = request.captcha?.token;
  if (suppliedToken) out.CAPTCHA_TOKEN = String(suppliedToken);

  // Drive-test lines cannot show a calendar without identifying the applicant.
  if (['DT', 'CDL', 'MC', 'KTR'].includes(service)) {
    out.DMV_LICENSE = requireField(personal, 'dl_number', 'Driver licence or permit number');
    out.DMV_DOB = requireField(personal, 'dob', 'Date of birth');
  }

  if (out.AUTO_SUBMIT === 'true') {
    out.FIRST_NAME = requireField(personal, 'first_name', 'First name');
    out.LAST_NAME = requireField(personal, 'last_name', 'Last name');
    out.EMAIL_ADDRESS = requireField(personal, 'email', 'Email address');
    out.PHONE_NUMBER = requireField(personal, 'phone', 'Phone number');
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

/**
 * Map a bot outcome onto a result envelope.
 *
 * NO_AVAILABILITY is transient on purpose: the whole premise is that
 * cancellations appear, so the next attempt may well find one. It is only after
 * regbot exhausts `max_attempts` that the bid fails and the escrow is refunded.
 *
 * A booking is `confirmed` only with the confirmation number DMV showed for it.
 * That number is what regbot stores and shows the person, and the only thing
 * they can cancel or reschedule with, so there is no making one up.
 */
export function outcomeToResult(outcome, { latencyMs, booking } = {}) {
  const extra = latencyMs === undefined ? {} : { latency_ms: latencyMs };
  const offices = (outcome?.results ?? []).map((r) => ({
    office: r.office,
    status: r.status,
    date: r.date ? toDateOnly(r.date) : null,
  }));
  if (offices.length) extra.offices = offices;
  // A run blocked at a human check reports it here, not just in prose, so the
  // connector can raise CaptchaRequired rather than let it look transient.
  if (outcome?.gate) extra.gate = outcome.gate;

  switch (outcome?.status) {
    case 'BOOKED_SUCCESS': {
      const confirmation = booking ?? outcome.reference;
      if (!confirmation) return unconfirmed(outcome, extra, 'no confirmation number was read');
      return result(
        ACK,
        `Booked ${toDateOnly(outcome.date)} at ${outcome.time} — ${outcome.office}. ` +
          `DMV confirmation number ${confirmation}.`,
        { ...extra, confirmation, booked_date: toDateOnly(outcome.date) }
      );
    }

    case 'BOOKING_UNCONFIRMED':
      return unconfirmed(outcome, extra, outcome.seen);

    case 'FOUND_AND_STOPPED':
      // A slot exists but this run was a probe. Transient: once booking is
      // enabled the next attempt can take it.
      return result(
        NACK_RETRY,
        `Found ${toDateOnly(outcome.best.date)} at ${outcome.best.office}, but booking is disabled ` +
          '(set RQP_ALLOW_BOOKING=true to let the connector book).',
        { ...extra, found_date: toDateOnly(outcome.best.date), found_office: outcome.best.office }
      );

    case 'NO_AVAILABILITY':
      // Sent for one slot, and it is not there: said plainly, so whoever sent
      // the robot can take it off the board instead of handing it on.
      if (outcome.slot_gone) {
        return result(NACK_RETRY, 'The allocated slot is no longer listed.', { ...extra, slot_gone: true });
      }
      return result(NACK_RETRY, 'No appointment available in the requested window.', extra);

    default:
      return result(NACK_RETRY, `Unrecognised bot outcome ${JSON.stringify(outcome?.status)}.`, extra);
  }
}

export function errorToResult(error, { latencyMs } = {}) {
  const extra = latencyMs === undefined ? {} : { latency_ms: latencyMs };
  const permanent = error instanceof RqpError && error.permanent;
  // A captcha gate travels as structured data, not just prose in `message`.
  // regbot turns it into a third outcome -- the job parks and its applicant is
  // asked to clear the check -- so losing it here would turn a solvable gate
  // back into three pointless retries and a refund.
  if (error?.gate) extra.gate = error.gate;
  return result(permanent ? NACK_FATAL : NACK_RETRY, error.message, extra);
}

export function toDateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A booking was submitted and DMV never showed a confirmation for it.
 *
 * Nobody knows whether the appointment exists, and the two ways to be wrong
 * are not equal. Retrying can book the person twice. Not retrying at worst
 * refunds somebody whose appointment did go through. So this is `rejected`,
 * the one verdict regbot never retries: `unavailable` would be, and so would
 * any new status, because regbot/connectors/ca_dmv.py downgrades a status it
 * does not know to `unavailable`.
 *
 * `unconfirmed` marks it. The handler's replay store keys on it, so a
 * redelivered job gets this verdict back instead of running again, and
 * ca_dmv.py holds it to `rejected`. The message goes on the person's bid, so it
 * says what to check before booking again.
 */
function unconfirmed(outcome, extra, seen) {
  const date = toDateOnly(outcome.date);
  const attempted = { office: outcome.office ?? null, date, time: outcome.time ?? null };
  return result(
    NACK_FATAL,
    `The booking at ${outcome.office} on ${date} at ${outcome.time} was sent to DMV, but DMV ` +
      'showed no confirmation, so it may or may not have gone through. It was not tried again, ' +
      'so that you are not booked twice. Look for a confirmation email from DMV before booking again.',
    { ...extra, unconfirmed: true, attempted, ...(seen ? { seen } : {}) }
  );
}


// ============================================================ discovery (phase 0)
/**
 * Map a `discovery.request` onto the bot's environment.
 *
 * Deliberately narrow next to requestToEnv: a scout gets a service, a list of
 * offices and a window, and nothing else. No applicant, no credentials, no
 * contact details, and AUTO_SUBMIT is not merely false but absent — there is
 * nothing here a browser could use to book with even by mistake.
 */
export function discoveryRequestToEnv(request, env = {}) {
  if (request?.protocol !== VERSION) {
    throw new RqpError(`Unsupported protocol ${JSON.stringify(request?.protocol)}, expected ${VERSION}`, {
      permanent: true,
    });
  }
  if (request?.kind !== 'discovery.request') {
    throw new RqpError(`Unsupported envelope kind ${JSON.stringify(request?.kind)}`, { permanent: true });
  }

  const service = serviceForQueue(request);
  if (['DT', 'CDL', 'MC', 'KTR'].includes(service)) {
    // The calendar for these opens only after a licence number and date of
    // birth are entered, and a scout has no applicant to identify. Such lines
    // are meant to stay on the older dispatch; reaching here means regbot let
    // one through, which will not fix itself on a retry.
    throw new RqpError(
      `The ${service} calendar cannot be read without an applicant's licence details, so this line cannot be scouted.`,
      { permanent: true });
  }

  const offices = Array.isArray(request.offices)
    ? request.offices.map((o) => String(o).trim()).filter(Boolean)
    : [];
  if (!offices.length) throw new RqpError('Discovery request names no offices.', { permanent: true });

  const window = request.window ?? [];
  if (!window[0] || !window[1]) {
    throw new RqpError('Discovery request carries no window.', { permanent: true });
  }

  return {
    DMV_SERVICE: service,
    DMV_OFFICES: offices.join(', '),
    DATE_START: window[0],
    DATE_END: window[1],
    HEADLESS: env.HEADLESS ?? 'true',
    RUN_LOG_PATH: env.RUN_LOG_PATH ?? './dmv_scout_run_log.txt',
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

/** Turn a discovery sweep into an envelope regbot can record. */
export function offersToResult({ offers = [], checked = [], gate = null }, { latencyMs } = {}) {
  const blocked = checked.filter((c) => c.error).length;
  const message = offers.length
    ? `Found ${offers.length} slot(s) across ${checked.length} office(s).`
    : gate
      ? `Blocked at a human check: ${blocked} of ${checked.length} office(s) could not be read.`
      : blocked
        ? `No slots readable: ${blocked} of ${checked.length} office(s) failed. ${checked.find((c) => c.error)?.error ?? ''}`.trim()
        : `No availability at ${checked.length} office(s).`;
  return discoveryResult(ACK, message, {
    offers,
    checked,
    // A gate is a third outcome, not a failure: regbot can answer it with a
    // provider, whereas an empty calendar is simply empty. Losing this here is
    // what made ca_dmv.discover's gate branch unreachable.
    ...(gate ? { gate } : {}),
    ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
  });
}

/**
 * A discovery failure.
 *
 * Transient by default — not seeing a calendar today says nothing about
 * tomorrow, and there is no escrow riding on a scout. A permanent one means the
 * request itself is wrong (a line that cannot be scouted at all), and repeating
 * it will not help; regbot records no offers either way, but the envelope
 * should say which it was.
 */
export function discoveryErrorToResult(error, { latencyMs } = {}) {
  const status = error?.permanent ? NACK_FATAL : NACK_RETRY;
  return discoveryResult(status, error?.message || 'Discovery failed.', {
    ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
    ...(error?.gate ? { gate: error.gate } : {}),
  });
}
