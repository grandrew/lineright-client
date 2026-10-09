import path from 'path';
import { getService, DRIVE_TEST, baseUrl } from './services.js';
import { parseOfficeList } from './offices.js';

/**
 * A `YYYY-MM-DD` string as local midnight on that day. Anything else is refused,
 * and so is a day the calendar does not have: `new Date(2026, 1, 30)` would
 * quietly become the 2nd of March, so the date must come back as it went in.
 */
export function parseDateOnly(value, name) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!parts) {
    throw new Error(`${name} is required and must be YYYY-MM-DD (got: ${JSON.stringify(value)})`);
  }
  const [y, m, d] = parts.slice(1).map(Number);
  const date = new Date(y, m - 1, d);
  const same = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join() === [y, m, d].join();
  if (!same) throw new Error(`${name} is not a real calendar date: ${value}`);
  return date;
}

function required(env, name, why = '') {
  const value = env[name];
  if (value === undefined || String(value).trim() === '') {
    throw new Error(`${name} is required${why ? ` ${why}` : ''} but not set.`);
  }
  return String(value).trim();
}

export function loadConfig(env = process.env) {
  const startDate = parseDateOnly(env.DATE_START, 'DATE_START');
  const endDate = parseDateOnly(env.DATE_END, 'DATE_END');

  if (endDate < startDate) {
    throw new Error(`DATE_END (${env.DATE_END}) is before DATE_START (${env.DATE_START})`);
  }

  const service = getService(env.DMV_SERVICE || 'DT');

  // DMV_OFFICES is the multi-office list. DMV_LOCATION_NAME / DMV_ZIP are the
  // older single-office variables and still work.
  const officeSource = env.DMV_OFFICES || env.DMV_LOCATION_NAME || env.DMV_ZIP;
  const offices = parseOfficeList(officeSource);
  if (offices.length === 0) {
    throw new Error('DMV_OFFICES is required: a comma-separated list of office names or ZIP codes, e.g. "Poway,San Marcos,92101"');
  }

  const autoSubmit = env.AUTO_SUBMIT === 'true';

  // Only demand what this run actually needs. A vehicle-registration dry run
  // needs no licence number and no contact details at all.
  const credentials = service.needsCredentials
    ? {
        licenseNumber: required(env, 'DMV_LICENSE', `for ${service.label}`),
        dob: (() => {
          const dob = required(env, 'DMV_DOB', `for ${service.label}`);
          if (!/^\d{2}\/?\d{2}\/?\d{4}$/.test(dob.replace(/\s/g, ''))) {
            throw new Error(`DMV_DOB must look like MM/DD/YYYY (got: ${dob})`);
          }
          return dob;
        })(),
      }
    : { licenseNumber: null, dob: null };

  const contact = autoSubmit
    ? {
        firstName: required(env, 'FIRST_NAME', 'when AUTO_SUBMIT=true'),
        lastName: required(env, 'LAST_NAME', 'when AUTO_SUBMIT=true'),
        email: required(env, 'EMAIL_ADDRESS', 'when AUTO_SUBMIT=true'),
        phone: required(env, 'PHONE_NUMBER', 'when AUTO_SUBMIT=true'),
      }
    : { firstName: null, lastName: null, email: null, phone: null };

  // Set when the caller has already decided which slot this run is for — see
  // the `slot.allocated` block in src/rqp.js. Absent for a plain hunt.
  const target = env.DMV_TARGET_DATE
    ? {
        office: env.DMV_TARGET_OFFICE || null,
        date: env.DMV_TARGET_DATE,
        time: env.DMV_TARGET_TIME || null,
      }
    : null;

  return {
    startDate,
    endDate,
    service,
    offices,
    target,
    ...credentials,
    ...contact,
    headless: env.HEADLESS !== 'false',
    debug: env.DEBUG_MODE === 'true',
    autoSubmit,
    runLogPath: env.RUN_LOG_PATH
      ? path.resolve(env.RUN_LOG_PATH)
      : path.resolve(process.cwd(), 'dmv_bot_run_log.txt'),
    timeoutMs: Number(env.RUN_TIMEOUT_MINUTES || 14) * 60 * 1000,
    // How long to wait for a calendar before declaring it blocked.
    calendarTimeoutMs: Number(env.CALENDAR_TIMEOUT_MS || 30000),
    // How long to wait, after "Schedule appointment", for a confirmation
    // number. Past it the booking is reported as unconfirmed, never as booked.
    confirmationTimeoutMs: Number(env.CONFIRMATION_TIMEOUT_MS || 30000),
    // Where to keep a picture of the confirmation page, for the person to see
    // what the robot saw (the desktop app's booker). None by default.
    confirmationShotPath: env.RQP_CONFIRMATION_SHOT ? path.resolve(env.RQP_CONFIRMATION_SHOT) : null,
    // A token the applicant obtained themselves, passed down from regbot when a
    // parked job resumes. Null on a plain run, which is the common case.
    captchaToken: env.CAPTCHA_TOKEN ? String(env.CAPTCHA_TOKEN).trim() : null,
    // A simulated solving service. See assertSimulatedSolver: loopback only,
    // and only against a loopback appointment site.
    solverUrl: solverUrl(env),
    // Where the appointment site lives. Overridable so a run can be pointed
    // at a local stand-in of the site instead of dmv.ca.gov.
    baseUrl: baseUrl(env),
    // Politeness gap between offices within a run.
    officeDelayMs: Number(env.OFFICE_DELAY_MS || 1500),
  };
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Validate CAPTCHA_SOLVER_URL, or refuse to run.
 *
 * Two conditions, both structural rather than advisory. The solver must be on
 * loopback, so it can only ever be the stand-in's mock farm and never a real
 * solving service; and the appointment site must be on loopback too, so a
 * configuration that would aim bought solves at dmv.ca.gov cannot start. A
 * simulation that can be turned into the real thing by editing one variable is
 * not a simulation.
 */
function solverUrl(env) {
  const url = String(env.CAPTCHA_SOLVER_URL || '').trim();
  if (!url) return null;
  if (!LOOPBACK.test(url)) {
    throw new Error(
      `CAPTCHA_SOLVER_URL must be a loopback address (got ${url}). This setting exists to ` +
      'simulate buying solves against the local stand-in, not to drive a real solving service.');
  }
  if (!LOOPBACK.test(baseUrl(env))) {
    throw new Error(
      'CAPTCHA_SOLVER_URL is set but DMV_BASE_URL is not a local stand-in. Simulated solves ' +
      'are only ever pointed at a simulated site.');
  }
  return url;
}

export { DRIVE_TEST };
