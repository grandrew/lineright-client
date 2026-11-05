import path from 'path';
import { findCampground } from './catalog.js';

/**
 * Where Recreation.gov lives. Overridable so the robots can be pointed at a
 * local stand-in of the site (`RGOV_BASE_URL=http://127.0.0.1:8788`, see
 * test/standin.mjs) and driven end to end — feed, cart, payment and all —
 * without touching recreation.gov or anybody's card. Defaults to the real site.
 */
export const DEFAULT_BASE_URL = 'https://www.recreation.gov';

export function baseUrl(env = process.env) {
  return String(env.RGOV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

export function isLoopback(url) {
  return LOOPBACK.test(String(url || ''));
}

function required(env, name, why = '') {
  const value = env[name];
  if (value === undefined || String(value).trim() === '') {
    throw new Error(`${name} is required${why ? ` ${why}` : ''} but not set.`);
  }
  return String(value).trim();
}

function day(env, name) {
  const value = required(env, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a real YYYY-MM-DD date (got: ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Everything a booking run needs, validated before a browser opens. Only what
 * the run needs is demanded: a dry probe asks for no card and no contact.
 */
export function loadConfig(env = process.env) {
  const startDate = day(env, 'DATE_START');
  const endDate = day(env, 'DATE_END');
  if (endDate < startDate) throw new Error(`DATE_END (${endDate}) is before DATE_START (${startDate})`);

  const campgrounds = String(env.RGOV_CAMPGROUNDS || '').split(',').map((t) => t.trim()).filter(Boolean)
    .map((term) => {
      const campground = findCampground(term);
      if (!campground) throw new Error(`Unknown campground in RGOV_CAMPGROUNDS: ${term}`);
      return campground;
    });
  if (!campgrounds.length) throw new Error('RGOV_CAMPGROUNDS is required: facility ids or names, comma-separated.');

  const nights = Number(env.RGOV_NIGHTS || 0);
  if (!Number.isInteger(nights) || nights < 1) throw new Error('RGOV_NIGHTS must be a whole number of nights.');

  const autoSubmit = env.AUTO_SUBMIT === 'true';

  const target = env.RGOV_TARGET_CAMPSITE
    ? {
        campground: findCampground(required(env, 'RGOV_TARGET_CAMPGROUND', 'with RGOV_TARGET_CAMPSITE')),
        campsiteId: String(env.RGOV_TARGET_CAMPSITE).trim(),
        site: String(env.RGOV_TARGET_SITE || '').trim(),
        arrival: day(env, 'RGOV_TARGET_ARRIVAL'),
      }
    : null;
  if (target && !target.campground) throw new Error(`Unknown RGOV_TARGET_CAMPGROUND: ${env.RGOV_TARGET_CAMPGROUND}`);

  const booking = autoSubmit
    ? {
        partySize: Number(required(env, 'RGOV_PARTY_SIZE', 'when AUTO_SUBMIT=true')),
        vehicles: Number(env.RGOV_VEHICLES ?? 1),
        equipment: String(env.RGOV_EQUIPMENT || 'tent'),
        equipmentLength: env.RGOV_EQUIPMENT_LENGTH ? Number(env.RGOV_EQUIPMENT_LENGTH) : null,
        contact: {
          firstName: required(env, 'FIRST_NAME', 'when AUTO_SUBMIT=true'),
          lastName: required(env, 'LAST_NAME', 'when AUTO_SUBMIT=true'),
          email: required(env, 'EMAIL_ADDRESS', 'when AUTO_SUBMIT=true'),
          phone: required(env, 'PHONE_NUMBER', 'when AUTO_SUBMIT=true'),
        },
        card: {
          name: required(env, 'CARD_NAME', 'when AUTO_SUBMIT=true'),
          number: required(env, 'CARD_NUMBER', 'when AUTO_SUBMIT=true'),
          expMonth: required(env, 'CARD_EXP_MONTH', 'when AUTO_SUBMIT=true'),
          expYear: required(env, 'CARD_EXP_YEAR', 'when AUTO_SUBMIT=true'),
          cvc: required(env, 'CARD_CVC', 'when AUTO_SUBMIT=true'),
        },
        billing: {
          street: required(env, 'BILLING_STREET', 'when AUTO_SUBMIT=true'),
          city: required(env, 'BILLING_CITY', 'when AUTO_SUBMIT=true'),
          state: required(env, 'BILLING_STATE', 'when AUTO_SUBMIT=true'),
          zip: required(env, 'BILLING_ZIP', 'when AUTO_SUBMIT=true'),
        },
      }
    : null;

  return {
    startDate,
    endDate,
    campgrounds,
    nights,
    target,
    booking,
    autoSubmit,
    baseUrl: baseUrl(env),
    // The person's own Recreation.gov sign-in, as the app hands it over: a
    // Playwright storage-state file with the site's cookies and nothing else.
    // Without one the run reaches the sign-in page, and stops there as a gate.
    storageState: env.RGOV_STORAGE_STATE ? path.resolve(env.RGOV_STORAGE_STATE) : null,
    headless: env.HEADLESS !== 'false',
    debug: env.DEBUG_MODE === 'true',
    runLogPath: env.RUN_LOG_PATH ? path.resolve(env.RUN_LOG_PATH) : path.resolve(process.cwd(), 'rgov_bot_run_log.txt'),
    timeoutMs: Number(env.RUN_TIMEOUT_MINUTES || 14) * 60 * 1000,
    // How long, after the order is placed, to wait for a reservation number.
    confirmationTimeoutMs: Number(env.CONFIRMATION_TIMEOUT_MS || 45000),
    confirmationShotPath: env.RQP_CONFIRMATION_SHOT ? path.resolve(env.RQP_CONFIRMATION_SHOT) : null,
    traceDir: env.RQP_TRACE_DIR ? path.resolve(env.RQP_TRACE_DIR) : null,
    traceScreenshots: env.RQP_TRACE_SCREENSHOTS === '1',
    requestDelayMs: Number(env.RGOV_REQUEST_DELAY_MS ?? 1500),
    // A rehearsal: the whole flow, cart and payment form filled, stopping short
    // of the button that pays. For checking these robots against the live site
    // by hand, with a person watching (HEADLESS=false) and a stay they want —
    // the campsite stays in their cart for its hold. Only ever from the
    // environment of a run started by hand; no envelope can ask for it.
    rehearse: env.RGOV_REHEARSE === 'true',
  };
}
