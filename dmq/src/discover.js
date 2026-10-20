/**
 * Discovery — ask the DMV what slots exist, without committing anyone to one.
 *
 * This is phase 0 of RQP/1 (see the server's protocol.py). regbot's processor runs
 * it before dispatch, records what comes back as `offers`, and only then
 * decides who gets what. The point is that an appointment is a scarce thing:
 * finding out what exists and choosing who receives it are two different jobs,
 * and doing them in one step meant whoever's worker ran first won.
 *
 * Read-only by construction. There is no contact form here, no confirm button
 * and no applicant — a scout cannot book even if asked to, which is why
 * discovery needs none of the double opt-in that booking does.
 *
 * KNOWN BLOCKER
 *   California gates its date lookup behind reCAPTCHA, which does not issue a
 *   token to an automated browser, so against the live site this returns no
 *   offers and says why. See ../README.md. The pipeline either side of it is
 *   real; only the calendar read is shut.
 */
import { chromium } from 'playwright';
import { instrument } from './instrument.js';
import { loadConfig } from './config.js';
import { navigateToLocationSearch, scanCalendar, applySolver, readOpenDay } from './bot.js';
import { to24h, parseTimes, dateKey, toOffer } from './slots.js';
import { searchOffices, officeSelectButton } from './selectors.js';

export { to24h, parseTimes, dateKey, toOffer };

async function scoutOffice(context, config, office, datesPerOffice, log) {
  const page = await context.newPage();
  const offers = [];
  try {
    await applySolver(page, config.solverUrl);
    await navigateToLocationSearch(page, config);
    await searchOffices(page, office.term);

    const button = await officeSelectButton(page, office);
    if (await button.isDisabled().catch(() => false)) {
      log('OFFICE_UNAVAILABLE', `${office.term}: "Select Location" disabled`);
      return { office: office.term, offers, error: null, gate: null };
    }
    await button.click();
    await page.waitForURL(/select-date/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const candidates = await scanCalendar(page, config, log, office.term);
    // Only the first few days per office: the earliest slots are the ones worth
    // competing over, and every extra day costs another page load against a
    // government site that is entitled not to be hammered.
    for (const candidate of candidates.slice(0, datesPerOffice)) {
      const opened = await readOpenDay(page, candidate.index);
      const times = opened.times || [];
      // The times response names the day it loaded. The cell's visible day
      // number can belong to the next month while this month's heading is
      // still on screen, and an offer stored under that heading is the wrong
      // appointment.
      const when = opened.date || candidate.date;
      for (const time of times) {
        const offer = toOffer(office.term, when, time);
        if (offer) offers.push(offer);
      }
      log('DAY_SCOUTED', `${office.term} ${dateKey(when)}: ${times.length} time(s)`);
    }
    return { office: office.term, offers, error: null, gate: null };
  } catch (error) {
    // One unreadable office must not abandon the rest of the sweep — but a
    // human check is not an unreadable office, it is a different outcome, and
    // dropping the gate that waitForCalendar attached turned "the calendar is
    // behind a check" into "there is nothing available". Those are opposite
    // facts and regbot acts on them in opposite ways.
    log('OFFICE_ERROR', `${office.term}: ${error.message}`);
    return { office: office.term, offers, error: error.message, gate: error.gate ?? null };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Sweep every office in `DMV_OFFICES` and return the slots found.
 *
 * Shares one browser context across offices, exactly as a person would keep one
 * window open, and pauses between them.
 */
export async function discover(env = process.env) {
  const config = loadConfig(env);
  const datesPerOffice = Math.max(1, Number(env.DISCOVER_DATES_PER_OFFICE || 2));
  const lines = [];
  let probe = null;
  const log = (tag, message) => {
    const line = `[${new Date().toISOString()}] ${tag}: ${message}`;
    lines.push(line);
    console.error(line);   // stderr: stdout belongs to the envelope
    if (probe) probe.note(tag, message);
  };

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  // What the sweep did on the site, when asked to keep it (instrument.js).
  probe = await instrument(context, { dir: config.traceDir, screenshots: config.traceScreenshots,
    title: `look ${config.service.code}` });
  const offers = [];
  const checked = [];
  try {
    for (const [i, office] of config.offices.entries()) {
      const outcome = await scoutOffice(context, config, office, datesPerOffice, log);
      checked.push({ office: outcome.office, found: outcome.offers.length,
                     error: outcome.error, gate: outcome.gate ?? null });
      offers.push(...outcome.offers);
      // A check this robot has no way through is the same check at every other
      // office on the site, so the rest of the sweep would only wait at it
      // again — the better part of a minute an office, on the computer of the
      // person whose app was asked to look. With a solver each office is a
      // fresh try, and the sweep goes on.
      if (outcome.gate && !config.solverUrl) {
        log('SWEEP_STOPPED', `a human check at ${outcome.office}, and no way through it here`);
        break;
      }
      if (i < config.offices.length - 1) await new Promise((r) => setTimeout(r, config.officeDelayMs));
    }
  } finally {
    await probe.stop();
    await browser.close().catch(() => {});
  }
  // The first gate seen speaks for the sweep: they are all the same check on
  // the same site, and one is all regbot needs to know which outcome this is.
  return { offers, checked, log: lines, gate: checked.find((c) => c.gate)?.gate ?? null };
}
