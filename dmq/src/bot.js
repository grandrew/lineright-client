import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { makeRunLogger } from './runlog.js';
import { instrument } from './instrument.js';
import { parseTimes, to24h, dateKey } from './slots.js';
import { DRIVE_TEST } from './services.js';
import { buildCandidateDates, parseMonthHeading, shouldAdvanceMonth, dateFromCellText } from './calendar.js';
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
    const button = buttons.nth(i);
    const text = (await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    // textContent keeps the full date the live cell paints in a visually hidden
    // span. innerText drops that span, and the visible day number plus the
    // month heading then names the wrong month.
    const full = (await button.evaluate((el) => el.textContent || '').catch(() => ''))
      .replace(/\s+/g, ' ').trim();
    const className = await button.evaluate((el) => el.className || '').catch(() => '');
    labels.push({ text, full, className, index: i });
  }
  return labels;
}

function cellIsoDate(text) {
  const date = dateFromCellText(text);
  return date ? dateKey(date) : null;
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
 * A picture of the confirmation page, kept where `file` says, for the person to
 * see what the robot saw: the number, and the page around it. Returns the file,
 * or null. Never throws — the booking is made by now, whatever comes of this.
 */
async function keepConfirmation(page, file) {
  if (!file) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true, timeout: 10000 });
    return file;
  } catch {
    return null;
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

const DAY_TIMES_TIMEOUT_MS = 20000;

/**
 * A locator that becomes visible only once a day's times have been drawn.
 *
 * On dmv.ca.gov the dialog heading is in the first paint, while `#loading-gif`
 * is still up and the labels are not. The stand-in has no dialog: its times
 * are buttons, and an empty day says "No times are available."
 */
function drawnTimes(page) {
  const dialog = page.locator('#time-selector');
  return dialog.locator('label.appt-dialog-time__label')
    .or(dialog.locator('.appt-dialog-times__no-times'))
    .or(page.locator('button.time'))
    .or(page.getByText(/no times are available/i));
}

function tidyLabels(texts) {
  return texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The clock labels on the open day, after they have actually been drawn. */
export async function readShownTimeLabels(page, timeout = DAY_TIMES_TIMEOUT_MS) {
  await drawnTimes(page).first().waitFor({ state: 'visible', timeout });
  const dialog = page.locator('#time-selector');
  if (await dialog.isVisible().catch(() => false)) {
    return tidyLabels(await dialog.locator('label.appt-dialog-time__label').allInnerTexts());
  }
  const buttons = page.locator('button.time');
  if (await buttons.count()) return tidyLabels(await buttons.allInnerTexts());
  return [];
}

function onCalendar(page) {
  try {
    return /\/select-date\b/.test(new URL(page.url()).pathname);
  } catch {
    return false;
  }
}

async function overlayOpen(page) {
  if (await page.locator('#appointments-dialog-root.overlay-active').count()) return true;
  return page.locator('.dialog-overlay').isVisible().catch(() => false);
}

/**
 * The live time dialog is portaled. Cancel can hide `#time-selector` and
 * leave `.dialog-overlay` inside `#appointments-dialog-root.overlay-active`
 * covering the calendar. The day buttons underneath stay Playwright-visible,
 * so the next Open Times click waits out its timeout on that overlay.
 * Overlay click and Escape are how the page itself closes that layer.
 */
async function dismissOverlay(page) {
  const overlay = page.locator('.dialog-overlay');
  if (!(await overlayOpen(page)) && !(await overlay.count())) return;
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click({ timeout: 2000 }).catch(() => {});
  }
  if (await overlayOpen(page)) await page.keyboard.press('Escape').catch(() => {});
  const root = page.locator('#appointments-dialog-root.overlay-active');
  if (await root.count()) await root.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  // Cancel can drop `overlay-active` and leave `.dialog-overlay` in the DOM,
  // where Playwright no longer calls it visible and the next Open Times click
  // still lands on it. The times have already been read. The leftover layer
  // is not the calendar.
  if (await overlay.count()) {
    await page.evaluate(() => {
      document.querySelectorAll('.dialog-overlay').forEach((el) => el.remove());
      const host = document.getElementById('appointments-dialog-root');
      if (!host) return;
      host.classList.remove('overlay-active');
      if (!host.querySelector('#time-selector')) host.replaceChildren();
    }).catch(() => {});
  }
}

/**
 * Leave the time list and land back on the calendar.
 *
 * The live time list is `#time-selector` on the same `/select-date` document.
 * Its Cancel button (`aria-label="Close this dialog window"`) only closes
 * that dialog. Browser Back is a history step from `/select-date` to the
 * office list, which is why the next day's Open Times click then waits until
 * it times out. The stand-in does navigate to `/times`, and there the way
 * back is the calendar link (history Back if that link is absent).
 */
async function returnToCalendar(page) {
  const dialog = page.locator('#time-selector');
  if (await dialog.isVisible().catch(() => false)) {
    const close = dialog.getByRole('button', { name: /close this dialog window/i });
    if (await close.count()) await close.click({ timeout: 2000 }).catch(() => {});
    if (await dialog.isVisible().catch(() => false)) await page.keyboard.press('Escape').catch(() => {});
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  // The dialog node can already be gone, or never counted as visible, while
  // the overlay is still the thing under the cursor.
  await dismissOverlay(page);
  if (await overlayOpen(page)) {
    throw new Error('The time dialog overlay is still covering the calendar');
  }
  if (onCalendar(page)) {
    await openTimeButtons(page).first().waitFor({ state: 'visible', timeout: 5000 });
    return;
  }

  const back = page.getByRole('link', { name: /back to the calendar/i });
  if (await back.count()) {
    await Promise.all([
      page.waitForURL(/\/select-date\b/, { timeout: 15000 }),
      back.click(),
    ]);
  } else {
    await Promise.all([
      page.waitForURL(/\/select-date\b/, { timeout: 15000 }),
      page.goBack(),
    ]);
  }
  await openTimeButtons(page).first().waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Remember the page's own `/times` response.
 *
 * That body is a JSON array of 24-hour clock times, and its `date` query is
 * the day those times belong to. The stand-in has no such request; this only
 * listens, and a day is never held open waiting for one that will not come.
 */
function attachTimesCapture(page) {
  let pending = 0;
  let captured = null;
  let notify = () => {};
  const ready = new Promise((resolve) => { notify = resolve; });
  const onResponse = (response) => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (!/\/times\b/.test(url.pathname) || !response.ok()) return;
    const rawDate = url.searchParams.get('date') || '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    pending += 1;
    response.json().then((body) => {
      if (!Array.isArray(body)) return;
      const times = [];
      for (const item of body) {
        const t = to24h(typeof item === 'string' ? item : '');
        if (t && !times.includes(t)) times.push(t);
      }
      times.sort();
      captured = { date, times };
      notify();
    }).catch(() => {}).finally(() => { pending -= 1; });
  };
  page.on('response', onResponse);
  return {
    stop() { page.off('response', onResponse); },
    waitForBody(ms) {
      return Promise.race([
        ready,
        new Promise((resolve) => { setTimeout(resolve, ms); }),
      ]);
    },
    async settle(ms) {
      // The label can be on screen before the times body has been read, and
      // the stand-in never requests one. Wait out `ms` for a body, and return
      // as soon as it has been read so a page with no such request only pays
      // the grace once.
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (captured && pending === 0) return captured;
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const extra = Date.now() + 500;
      while (pending > 0 && Date.now() < extra) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      return captured;
    },
  };
}

/**
 * Open one day's times, read them, and come back to the calendar.
 *
 * Returns `{ times, date }`. `times` are 24-hour `HH:MM` strings, earliest
 * first. `date` is `YYYY-MM-DD` from the times response when the page asked
 * for one, otherwise from the full date on the cell, otherwise null. An
 * explicit empty day returns no times. A scout stops here: it never clicks
 * Confirm.
 */
export async function readOpenDay(page, index) {
  const capture = attachTimesCapture(page);
  try {
    await dismissOverlay(page);
    const button = openTimeButtons(page).nth(index);
    const cellDate = cellIsoDate(await button.evaluate((el) => el.textContent || '').catch(() => ''));
    await button.click({ timeout: 8000 });
    const labelsPromise = readShownTimeLabels(page).catch(() => []);
    const winner = await Promise.race([
      labelsPromise.then((value) => ({ kind: 'labels', value })),
      capture.waitForBody(DAY_TIMES_TIMEOUT_MS).then(() => ({ kind: 'body' })),
    ]);
    const fromNetwork = await capture.settle(750);
    const labels = fromNetwork
      ? []
      : (winner.kind === 'labels' ? winner.value : await labelsPromise);
    const times = fromNetwork ? fromNetwork.times : parseTimes(labels.join('\n'));
    const date = (fromNetwork && fromNetwork.date) || cellDate || null;
    await returnToCalendar(page);
    return { times, date };
  } finally {
    capture.stop();
  }
}

async function bookAt(context, config, office, log, hooks = {}) {
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

    const capture = attachTimesCapture(page);
    let choices = [];
    try {
      await openTimeButtons(page).nth(target.index).click();
      // The heading is on the page while the times are still loading, so it is
      // not the signal that a slot can be read. Same wait the scout uses.
      const rawLabels = await readShownTimeLabels(page);
      const fromNetwork = await capture.settle(750);
      const parsed = [];
      for (const label of rawLabels) {
        const time = to24h(label.trim());
        if (time) parsed.push({ label: label.trim(), time });
      }
      const networkTimes = (fromNetwork && fromNetwork.times) || [];
      // Allocated a time, the robot books that time and no other. The live
      // label can read "Invalid Date" while the times response still lists
      // "14:20"; the label's position in that list is the button to press.
      if (office.time) {
        const hit = parsed.find((item) => item.time === office.time);
        if (hit) choices = [{ label: hit.label }];
        else if (networkTimes.includes(office.time)) {
          choices = [{ index: networkTimes.indexOf(office.time), label: office.time }];
        }
      } else if (parsed.length) {
        choices = parsed.map((item) => ({ label: item.label }));
      } else {
        choices = networkTimes.map((time, index) => ({ index, label: time }));
      }
    } finally {
      capture.stop();
    }
    if (office.time && choices.length === 0) {
      return gone(`${office.date.toDateString()} ${office.time} no longer listed`);
    }
    if (choices.length === 0) return { status: NO_AVAILABILITY };

    let booked = null;
    for (const slot of choices) {
      if (slot.index !== undefined) {
        await page.locator('#time-selector label.appt-dialog-time__label').nth(slot.index).click();
      } else {
        await page
          .getByText(new RegExp(`^${slot.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))
          .first()
          .click();
      }
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
      booked = slot.label;
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
    // Said before the form goes, so a run that dies after it is known to have
    // perhaps booked (bin/rqp-handler.js, idempotency.js).
    await hooks.onSubmit?.();
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
    // Where the confirmation is, and what it looked like, for the person.
    const url = page.url();
    const shot = await keepConfirmation(page, config.confirmationShotPath);
    return { status: 'BOOKED_SUCCESS', date: office.date, time: booked, office: office.office, reference, url, shot };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * One run of the bot. `hooks.onSubmit` is called just before the booking form
 * is sent, the one step that may leave an appointment behind.
 */
export async function run(env = process.env, hooks = {}) {
  const config = loadConfig(env);
  const runLog = makeRunLogger(config.runLogPath);
  // What the run did on the site, when asked to keep it (instrument.js); the
  // run log's steps go in among its network, so each reads in the other's light.
  let probe = null;
  const log = (status, detail) => {
    runLog(status, detail);
    if (probe) probe.note(status, detail);
  };

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.debug ? 300 : 0,
  });

  const forceClose = setTimeout(async () => {
    log('STUCK_OR_TIMEOUT', `Force closed after ${config.timeoutMs / 60000} minutes`);
    if (probe) await probe.stop();
    await browser.close().catch(() => {});
    process.exit(1);
  }, config.timeoutMs);

  // One context for the whole run: the offices share a session, which is both
  // faster and less odd-looking than a cold browser per office.
  const context = await browser.newContext();
  probe = await instrument(context, { dir: config.traceDir, screenshots: config.traceScreenshots,
    title: `${config.autoSubmit ? 'book' : 'look'} ${config.service.code}` });

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
      const booking = await bookAt(context, config, { office, term: office, date, time: config.target.time }, log, hooks);
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

    const booking = await bookAt(context, config, best, log, hooks);
    return { ...booking, best, results };
  } catch (error) {
    log('ERROR_OR_STUCK', error.message || 'Unknown error');
    throw error;
  } finally {
    clearTimeout(forceClose);
    await probe.stop();
    await browser.close().catch(() => {});
  }
}
