import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { makeRunLogger } from './runlog.js';
import { to24h } from './slots.js';
import { DRIVE_TEST } from './services.js';
import { buildCandidateDates, parseMonthHeading, shouldAdvanceMonth } from './calendar.js';
import {
  appointmentUrl,
  vehicleSelectButton,
  searchOffices,
  officeSelectButton,
  readDisplayedMonth,
  openTimeButtons,
  parseConfirmation,
} from './selectors.js';
import { FOUND, NO_AVAILABILITY, ERROR, officeResult, summarize, formatSummary } from './offices.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a page is given to settle after a step that loads the next one. */
const STEP_SETTLE_MS = 3000;

/** Fill the textbox a person finds by `label`, once the page has shown it. */
async function typeInto(page, label, value) {
  const box = page.getByRole('textbox', { name: label });
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await box.fill(value);
}

/** Press the button a person finds by `label`, then (unless `settle` is off) give the next page time to come. */
async function press(page, label, { settle = true } = {}) {
  await page.getByRole('button', { name: label }).click();
  if (settle) await page.waitForTimeout(STEP_SETTLE_MS);
}

/**
 * Get from a fresh page to the office-search screen for the configured service.
 *
 * Office-visit services (VR, CID, RID, IBC) land there directly from
 * ?option=<CODE>. Drive tests do not: the option code preselects nothing, so
 * the vehicle card still has to be clicked and DMV then demands a licence
 * number and date of birth before it will show any availability.
 */
export async function navigateToLocationSearch(page, config) {
  await page.goto(appointmentUrl(config.service, config.baseUrl), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (config.service.family !== DRIVE_TEST) return;

  const selectButton = await vehicleSelectButton(page, config.service.vehicleType);
  await selectButton.click();

  // The drive-test calendars open only for the applicant's own licence.
  await typeInto(page, /driver's license or permit/i, config.licenseNumber);
  await typeInto(page, /date of birth/i, config.dob);
  await press(page, /make an appointment/i);
}

async function collectDayLabels(page) {
  const buttons = openTimeButtons(page);
  const count = await buttons.count();
  const labels = [];
  for (let i = 0; i < count; i++) {
    const text = (await buttons.nth(i).innerText().catch(() => '')).trim();
    labels.push({ text, index: i });
  }
  return labels;
}

/**
 * Put a token the applicant obtained in front of the page before it loads.
 *
 * Two channels, because there are two consumers. `g-recaptcha-response` is the
 * real one — it is the field reCAPTCHA itself fills and the site reads, so this
 * is where a token belongs on dmv.ca.gov. The window global is for a local
 * stand-in of the site, whose shim checks it first: an init script runs
 * before the document exists, so there is no textarea to write to yet.
 *
 * This does not defeat anything. It carries a token a person already minted
 * through to the page that asked for it.
 */
/**
 * Point this page's token minting at a solving service.
 *
 * Every calendar read asks for a token, so every calendar read is a purchase:
 * one solve per office, per month paged, at whatever latency the service has.
 * That is the cost model the whole project argues about, and wiring it makes it
 * a measurement instead of an estimate.
 *
 * `loadConfig` will not accept a solver that is not on loopback, and will not
 * accept one at all unless the run is pointed at a local stand-in. This is a
 * simulation of buying solves, and it is kept structurally unable to be
 * anything else.
 */
export async function applySolver(page, solverUrl) {
  if (!solverUrl) return;
  // An init script, so it is in place before the page's own shim runs and can
  // consult it. The page mints; we only say where from.
  await page.addInitScript((url) => { window.__solverUrl = url; }, solverUrl);
}

export async function applyCaptchaToken(page, token) {
  if (!token) return;
  await page.addInitScript((value) => {
    window.__suppliedCaptchaToken = value;
    const plant = () => {
      const field = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (field) field.value = value;
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', plant);
    } else {
      plant();
    }
  }, token);
}

/**
 * Read the page's own description of its captcha gate.
 *
 * The appointment app publishes both of these on its React root, so there is no
 * need to guess: `data-recaptcha-key` is the sitekey the token must be minted
 * against and `data-recaptcha-version` says which product is in use. Reading
 * them rather than hardcoding them means a DMV key rotation is picked up for
 * free, and a version change surfaces as a changed envelope instead of a silent
 * behaviour difference.
 *
 * Note the version marker matters: as of 2026-09 this is reCAPTCHA **v2
 * Invisible** (size=invisible, with a bframe that escalates to an image
 * challenge), not v3. A v3-style grecaptcha.execute(siteKey, {action}) call
 * against it never resolves -- which is a different failure from being blocked,
 * and was previously misread as one.
 */
/** The office a step description names, so a provider can bind a token to it. */
function officeOf(step) {
  const at = /\bat\s+(.+)$/i.exec(String(step || ''));
  return at ? at[1].trim() : '';
}

export async function readGate(page, step = '') {
  const data = await page
    .evaluate(() => {
      const root = document.querySelector('#appointments-react-root');
      const frame = document.querySelector('iframe[src*="/recaptcha/api2/anchor"]');
      const size = frame ? new URL(frame.src).searchParams.get('size') : null;
      return {
        sitekey: root?.dataset?.recaptchaKey || '',
        version: root?.dataset?.recaptchaVersion || '',
        size: size || '',
      };
    })
    .catch(() => ({ sitekey: '', version: '', size: '' }));

  const kind =
    data.version === '2'
      ? data.size === 'invisible'
        ? 'recaptcha_v2_invisible'
        : 'recaptcha_v2'
      : data.version
        ? `recaptcha_v${data.version}`
        : 'recaptcha_unknown';

  return { kind, sitekey: data.sitekey, page_url: page.url(), step,
           extra: { size: data.size, office: officeOf(step) } };
}

/**
 * Wait for the calendar to actually render.
 *
 * The date list is fetched only after the page obtains a reCAPTCHA token, which
 * an automated browser does not get, so the card sits on "Loading dates..."
 * forever. Detect that explicitly instead of burning the run's whole timeout
 * budget on it -- and report it as a *gate*, with the sitekey and page URL the
 * token would have to be minted against, rather than as a generic failure. The
 * queue treats a gate as a third outcome: the job parks and its applicant is
 * asked to clear the check themselves. See regbot/captcha/.
 */
async function waitForCalendar(page, config, officeTerm = '') {
  const deadline = Date.now() + config.calendarTimeoutMs;

  while (Date.now() < deadline) {
    if (await openTimeButtons(page).count()) return;
    if (await readDisplayedMonth(page)) return; // calendar rendered, just nothing open
    await page.waitForTimeout(1000);
  }

  const stillLoading = await page.getByText(/loading dates/i).first().isVisible().catch(() => false);
  if (stillLoading) {
    const step = officeTerm ? `looking up dates at ${officeTerm}` : 'looking up appointment dates';
    const error = new Error(
      `Calendar never loaded after ${config.calendarTimeoutMs / 1000}s (stuck on "Loading dates..."). ` +
        'DMV gates the date lookup behind reCAPTCHA, so availability cannot be read by an ' +
        'automated browser alone. See README "Known blocker".'
    );
    error.gate = await readGate(page, step);
    throw error;
  }
  throw new Error(`Calendar did not render within ${config.calendarTimeoutMs / 1000}s`);
}

export async function scanCalendar(page, config, log, officeTerm) {
  await waitForCalendar(page, config, officeTerm);

  let monthsChecked = 0;
  while (monthsChecked < 12) {
    const headingText = await readDisplayedMonth(page);
    const displayedMonth = parseMonthHeading(headingText);
    if (!displayedMonth) {
      throw new Error(`Could not read the calendar month heading (saw: ${JSON.stringify(headingText)})`);
    }

    const dayLabels = await collectDayLabels(page);
    log('MONTH_SCANNED', `${officeTerm} ${headingText} openDays=${dayLabels.length}`);

    const candidates = buildCandidateDates({
      dayLabels,
      displayedMonth,
      startDate: config.startDate,
      endDate: config.endDate,
    });
    if (candidates.length > 0) return candidates;

    if (!shouldAdvanceMonth({ displayedMonth, endDate: config.endDate })) return [];

    const next = page.getByRole('button', { name: /next month|next/i }).first();
    if (!(await next.isVisible().catch(() => false))) return [];
    await next.click();
    await page.waitForTimeout(2000);
    monthsChecked++;
  }
  return [];
}

async function checkOffice(context, config, office, log) {
  const page = await context.newPage();
  try {
    await applyCaptchaToken(page, config.captchaToken);
    await applySolver(page, config.solverUrl);
    await navigateToLocationSearch(page, config);
    await searchOffices(page, office.term);

    const button = await officeSelectButton(page, office);
    if (await button.isDisabled().catch(() => false)) {
      log('OFFICE_UNAVAILABLE', `${office.term}: "Select Location" disabled`);
      return officeResult(office, NO_AVAILABILITY);
    }
    await button.click();

    await page.waitForURL(/select-date/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const candidates = await scanCalendar(page, config, log, office.term);
    if (candidates.length === 0) {
      log('NO_AVAILABILITY', `${office.term}: nothing in window`);
      return officeResult(office, NO_AVAILABILITY);
    }

    const earliest = candidates[0];
    log('DATE_FOUND', `${office.term}: ${earliest.date.toDateString()} (${earliest.label})`);
    return officeResult(office, FOUND, { date: earliest.date, label: earliest.label });
  } catch (error) {
    // One bad office must not abandon the rest of the run. A captcha gate is
    // still carried through on the result, though: it is the difference between
    // "this office has nothing" and "we were not allowed to look", and only the
    // second one is worth parking a job for.
    log('OFFICE_ERROR', `${office.term}: ${error.message}`);
    return officeResult(office, ERROR, { error: error.message, gate: error.gate ?? null });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Wait for the page to show a confirmation number, and return it.
 *
 * Returns null when none appears in time, or when the page dies waiting. It
 * never throws: by the time this runs the booking has been submitted, and a
 * throw would be read upstream as "try again".
 */
async function waitForConfirmation(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (page.isClosed()) return null;
    const text = await page.locator('body').innerText().catch(() => '');
    const reference = parseConfirmation({ url: page.url(), text });
    if (reference) return reference;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500).catch(() => {});
  }
}

/**
 * Where a booking that never confirmed was left, for the log and the person.
 * The page's own error text if it shows any, which is the part worth reading.
 */
async function describeUnconfirmed(page) {
  let where = page.url();
  try {
    where = new URL(where).pathname;
  } catch {
    // keep the raw URL
  }
  const said = await page
    .locator('[role="alert"], .field-error, .error')
    .allInnerTexts()
    .catch(() => []);
  const message = said.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 200);
  return message ? `still on ${where}, which said "${message}"` : `still on ${where}, no confirmation shown`;
}

async function bookAt(context, config, office, log) {
  const page = await context.newPage();
  try {
    await applyCaptchaToken(page, config.captchaToken);
    await applySolver(page, config.solverUrl);
    await navigateToLocationSearch(page, config);
    await searchOffices(page, office.office ?? office.term);
    const button = await officeSelectButton(page, {
      term: office.office ?? office.term,
      isZip: /^\d{5}$/.test(office.office ?? office.term),
    });
    await button.click();
    await page.waitForURL(/select-date/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const candidates = await scanCalendar(page, config, log, office.office ?? office.term);
    const target = candidates.find((c) => c.date.getTime() === office.date.getTime());
    // An allocated slot that is not there is gone: say so, so it is taken off
    // the board rather than handed to the next person to find the same page.
    const gone = (why) => {
      log('SLOT_GONE', `${office.office}: ${why}`);
      return { status: NO_AVAILABILITY, slot_gone: true, office: office.office, date: office.date };
    };
    if (!target) return gone(`${office.date.toDateString()} no longer listed`);

    await openTimeButtons(page).nth(target.index).click();
    await page
      .getByRole('heading', { name: /choose an appointment time/i })
      .waitFor({ state: 'visible', timeout: 20000 });

    const bodyText = await page.locator('body').innerText();
    const listed = [...new Set((bodyText.match(/\b\d{1,2}:\d{2}\s?(AM|PM)\b/gi) || []).map((s) => s.trim()))];
    // Allocated a time, the robot books that time and no other: the person was
    // given one slot, and the board's allocation is of that one. A hunt, with
    // no time given, takes the first that holds.
    const slots = office.time ? listed.filter((label) => to24h(label) === office.time) : listed;
    if (office.time && slots.length === 0) {
      return gone(`${office.date.toDateString()} ${office.time} no longer listed`);
    }
    if (slots.length === 0) return { status: NO_AVAILABILITY };

    let booked = null;
    for (const slot of slots) {
      await page
        .getByText(new RegExp(`^${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))
        .first()
        .click();
      await page.waitForTimeout(1000);

      const confirm = page.getByRole('button', { name: /^confirm$/i }).first();
      if (!(await confirm.isVisible().catch(() => false))) continue;
      if (await confirm.isDisabled().catch(() => true)) continue;

      await confirm.click();
      await page.waitForTimeout(3000);

      const after = await page.locator('body').innerText();
      if (/unavailable|no longer available|not available/i.test(after)) {
        await page.getByRole('button', { name: /^cancel$/i }).first().click().catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }
      booked = slot;
      break;
    }
    if (!booked) {
      if (office.time) return gone(`${office.date.toDateString()} ${office.time} was taken as it was chosen`);
      return { status: NO_AVAILABILITY };
    }

    await page.getByRole('textbox', { name: /first name/i }).fill(config.firstName);
    await page.getByRole('textbox', { name: /last name/i }).fill(config.lastName);
    await page.getByRole('textbox', { name: /email address/i }).fill(config.email);
    await page.getByRole('textbox', { name: /phone number/i }).fill(config.phone);
    await press(page, /^continue$/i);
    // The last step: the confirmation is waited for below, not a fixed while.
    await press(page, /schedule appointment/i, { settle: false });

    // From here on an appointment may exist whatever the page says, so nothing
    // below may throw: an error would reach regbot as transient and be retried,
    // which is how one person ends up booked twice. Either DMV shows a number
    // or the booking is unconfirmed.
    const where = `${office.office} ${office.date.toDateString()} ${booked}`;
    const reference = await waitForConfirmation(page, config.confirmationTimeoutMs);
    if (!reference) {
      const seen = await describeUnconfirmed(page);
      log('BOOKING_UNCONFIRMED', `${where}: ${seen}`);
      return { status: 'BOOKING_UNCONFIRMED', date: office.date, time: booked, office: office.office, seen };
    }

    log('BOOKED_SUCCESS', `${where} ref=${reference}`);
    return { status: 'BOOKED_SUCCESS', date: office.date, time: booked, office: office.office, reference };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function run(env = process.env) {
  const config = loadConfig(env);
  const log = makeRunLogger(config.runLogPath);

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.debug ? 300 : 0,
  });

  const forceClose = setTimeout(async () => {
    log('STUCK_OR_TIMEOUT', `Force closed after ${config.timeoutMs / 60000} minutes`);
    await browser.close().catch(() => {});
    process.exit(1);
  }, config.timeoutMs);

  // One context for the whole run: the offices share a session, which is both
  // faster and less odd-looking than a cold browser per office.
  const context = await browser.newContext();

  try {
    log('START', `service=${config.service.code} offices=${config.offices.map((o) => o.term).join('|')} window=${config.startDate.toDateString()}..${config.endDate.toDateString()} autoSubmit=${config.autoSubmit}`);

    // When the processor has already picked the slot, the discovery pass is
    // worse than redundant. Each calendar read costs one human check, and a
    // reCAPTCHA token is single-use — so scanning first to learn what we were
    // already told spends the applicant's only token and leaves none for the
    // booking itself. Found by the local stand-in: DATES_SERVED, then
    // DATES_REFUSED "token already used". Go straight to the slot.
    if (config.autoSubmit && config.target?.date) {
      const office = config.target.office || config.offices[0]?.term;
      const date = new Date(`${config.target.date}T00:00:00`);
      log('TARGETED', `${office} ${config.target.date}${config.target.time ? ` ${config.target.time}` : ''}: booking the allocated slot directly`);
      const booking = await bookAt(context, config, { office, term: office, date, time: config.target.time }, log);
      return { ...booking, results: [] };
    }

    const results = [];
    for (const [i, office] of config.offices.entries()) {
      results.push(await checkOffice(context, config, office, log));
      if (i < config.offices.length - 1) await sleep(config.officeDelayMs);
    }

    const { best, found, errored } = summarize(results, { target: config.target });
    log('SUMMARY', `checked=${results.length} found=${found} errors=${errored}`);
    console.log(formatSummary(results));

    if (!best) {
      // Nothing found. If the reason was a gate rather than an empty calendar,
      // say so: regbot parks on a gate and merely retries a genuine empty.
      const gate = results.find((r) => r.gate)?.gate ?? null;
      return { status: NO_AVAILABILITY, results, ...(gate ? { gate } : {}) };
    }

    // Checked before anything that holds a slot server-side.
    if (!config.autoSubmit) {
      log('FOUND_AND_STOPPED', `Dry run: ${best.office} on ${best.date.toDateString()}. Set AUTO_SUBMIT=true to book.`);
      return { status: 'FOUND_AND_STOPPED', best, results };
    }

    const booking = await bookAt(context, config, best, log);
    return { ...booking, best, results };
  } catch (error) {
    log('ERROR_OR_STUCK', error.message || 'Unknown error');
    throw error;
  } finally {
    clearTimeout(forceClose);
    await browser.close().catch(() => {});
  }
}
