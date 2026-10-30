/**
 * The bot against the local DMV stand-in.
 *
 * These are the tests that could not exist before the stand-in: they drive the
 * robots' real Playwright code — the real selectors, the real calendar scan, the real
 * booking flow — over HTTP, end to end, without touching dmv.ca.gov and without
 * consuming a public appointment.
 *
 * What they pin, in order:
 *   1. the stand-in gates /dates exactly as DMV does;
 *   2. token semantics (single-use, branch-bound) hold, which is what stops a
 *      solve being amortised across a sweep;
 *   3. a gated browser reports a *gate*, with the markers regbot needs to park
 *      a job — not a generic failure;
 *   4. a token the applicant minted carries through and the calendar opens;
 *   5. a whole booking completes and the slot is then gone for everyone else;
 *   6. a booking DMV does not confirm is never reported as booked.
 *
 * Browser tests need Playwright's chromium. They skip cleanly without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createServer, createState, SITEKEY, mintToken, releaseSlot, worldNow,
} from '../server.js';
import { noPlaywright, robot, robotPackage } from './client.js';

// The HTTP tests are fast and always run. The browser ones drive a real
// Chromium through the robots' own sleeps and take minutes, so they are opt-in
// — `npm run test:robots`, or the long stage of ci/run.sh. They touch no
// network, and they are the only cover the Playwright selectors have. The
// robots are this repository's dmq/ (./client.js finds them).
let browserSkip = process.env.TESTSITE === '1' ? noPlaywright : 'set TESTSITE=1 (or: npm run test:robots)';
const { chromium } = browserSkip ? {} : robotPackage('playwright');
if (!browserSkip) {
  try {
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  } catch {
    browserSkip = 'playwright chromium is not installed';
  }
}
const load = (file) => (browserSkip ? {} : robot(file));
const { loadConfig } = await load('src/config.js');
const {
  navigateToLocationSearch, scanCalendar, readGate, applyCaptchaToken, applySolver, run,
} = await load('src/bot.js');
const { searchOffices, officeSelectButton } = await load('src/selectors.js');
const { outcomeToResult, NACK_FATAL } = await load('src/rqp.js');

const noop = () => {};

/** A running stand-in on an ephemeral port, plus its state and base URL. */
async function startSite(options = {}) {
  const state = createState(options);
  const server = createServer(state);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, server, base, stop: () => new Promise((res) => server.close(res)) };
}

/**
 * A stand-in clock that reads the 10th of next month. A calendar opens on the
 * month it is today, so late in a month the first bookable day is already in
 * the next one, and reaching it costs a check more (one token buys one month —
 * pinned below). The tests about what one token does run mid-month.
 */
function midMonth(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 10, d.getHours(), d.getMinutes()).getTime() - now;
}

function envFor(base, extra = {}, now = Date.now()) {
  // Out to six months on purpose. The stand-in is booked solid for its first
  // `busyDays` (two months by default), so a window that stops at forty days
  // contains nothing at all — which is not a broken fixture, it is what a busy
  // DMV looks like, and a bot that only looks a month ahead sees an empty site.
  // `now` is the site's clock, for a site that keeps its own (clockOffsetMs).
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 180);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    DMV_BASE_URL: base,
    DMV_SERVICE: 'VR',
    DMV_OFFICES: 'ALTURAS',
    DATE_START: iso(start),
    DATE_END: iso(end),
    HEADLESS: 'true',
    CALENDAR_TIMEOUT_MS: '6000',
    RUN_LOG_PATH: '/dev/null',
    ...extra,
  };
}

// ------------------------------------------------------------------ the API
test('the stand-in serves the ungated endpoints and gates /dates like DMV does', async (t) => {
  const site = await startSite();
  t.after(site.stop);

  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  assert.ok(branches.length > 0, 'branches should be public');
  assert.ok(branches[0].publicId && branches[0].name, 'branch rows carry publicId and name');

  const services = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/services/`)).json();
  assert.ok(services.some((s) => s.name === 'VR'), 'services should be public');

  const id = encodeURIComponent(branches[0].publicId);
  const res = await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches/${id}/dates?services[]=VR`);
  assert.equal(res.status, 400);
  // Byte-for-byte the shape the real site returns, because that is what every
  // pure-HTTP bot in REPORT.md died on.
  assert.deepEqual(await res.json(), {
    code: 'rest_missing_callback_param',
    message: 'Missing parameter(s): token',
    data: { status: 400, params: ['token'] },
  });
});

test('a token is single-use and bound to the branch it was minted for', async (t) => {
  const site = await startSite();
  t.after(site.stop);
  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const [a, b] = branches;
  const dates = (id, token) =>
    fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches/${encodeURIComponent(id)}/dates` +
          `?services[]=VR&token=${encodeURIComponent(token)}`);

  const wrongBranch = mintToken(site.state, a.publicId);
  assert.equal((await dates(b.publicId, wrongBranch)).status, 400, 'a token from another branch is refused');

  const good = mintToken(site.state, a.publicId);
  assert.equal((await dates(a.publicId, good)).status, 200, 'the right token opens the calendar');
  assert.equal((await dates(a.publicId, good)).status, 400, 'and cannot be spent twice');
});

// -------------------------------------------------------------- the browser
test('a gated browser reports a gate, with the markers regbot parks on', { skip: browserSkip }, async (t) => {
  const site = await startSite({ gate: 'strict' });
  t.after(site.stop);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const config = loadConfig(envFor(site.base));
  const page = await browser.newPage();
  await navigateToLocationSearch(page, config);
  await searchOffices(page, 'ALTURAS');
  await (await officeSelectButton(page, { term: 'ALTURAS', isZip: false })).click();
  await page.waitForURL(/select-date/, { timeout: 15000 });

  const error = await scanCalendar(page, config, noop, 'ALTURAS').then(
    () => null,
    (err) => err
  );
  assert.ok(error, 'a gated calendar must not look like "no availability"');
  assert.ok(error.gate, 'the failure carries a structured gate, not just prose');
  assert.equal(error.gate.kind, 'recaptcha_v2_invisible');
  assert.equal(error.gate.sitekey, SITEKEY);
  assert.match(error.gate.step, /ALTURAS/);
  assert.match(error.gate.page_url, /select-date/);

  // readGate on its own agrees — this is what ca_dmv turns into CaptchaRequired.
  const gate = await readGate(page, 'looking up dates at ALTURAS');
  assert.equal(gate.extra.size, 'invisible');
});

test('a sweep stops at the first human check it has no way through', { skip: browserSkip }, async (t) => {
  // Every office on the site sits behind the same check. Without a solver the
  // rest of the sweep could only wait at it again, office after office, on the
  // computer of whoever's app the site asked to look.
  const site = await startSite({ gate: 'strict' });
  t.after(site.stop);
  const { discover } = await robot('src/discover.js');
  const sweep = await discover(envFor(site.base, { DMV_OFFICES: 'ALTURAS, ARLETA, ARVIN', OFFICE_DELAY_MS: '0' }));
  assert.deepEqual(sweep.checked.map((c) => c.office), ['ALTURAS'], JSON.stringify(sweep.checked));
  assert.equal(sweep.gate.kind, 'recaptcha_v2_invisible');
  assert.deepEqual(sweep.offers, []);
  assert.ok(sweep.log.some((l) => /SWEEP_STOPPED/.test(l)));
});

test('a knowledge-test re-evaluation gets through its vehicle card and the licence check to a calendar',
  { skip: browserSkip }, async (t) => {
  // KTR has no calendar of its own to jump to: ?option=KTR lands on the same
  // "Choose a vehicle" page as the drive tests, and the real site has a fourth
  // card, Knowledge Test Re-Evaluation, for it. When the stand-in had only
  // three, every knowledge-retest job failed at every office on "Could not
  // find a Select button", three times over.
  const site = await startSite({ gate: 'open', busyDays: 2 });
  t.after(site.stop);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  // Arleta, because a drive-test service is only offered where drive tests are.
  const config = loadConfig(envFor(site.base, {
    DMV_SERVICE: 'KTR', DMV_OFFICES: 'ARLETA', DMV_LICENSE: 'A1234567', DMV_DOB: '01/02/1990',
  }));
  const page = await browser.newPage();
  await navigateToLocationSearch(page, config);

  const reached = new URL(page.url());
  assert.equal(reached.searchParams.get('step'), 'location', 'past the licence check');
  assert.equal(reached.searchParams.get('option'), 'KTR',
    'the card must lead to the re-evaluation, not to the automobile drive test');

  await searchOffices(page, 'ARLETA');
  await (await officeSelectButton(page, { term: 'ARLETA', isZip: false })).click();
  await page.waitForURL(/select-date/, { timeout: 15000 });
  assert.equal(new URL(page.url()).searchParams.get('service'), 'KTR');

  const candidates = await scanCalendar(page, config, noop, 'ARLETA');
  assert.ok(candidates.length > 0, 'a re-evaluation calendar with days on it');
});

test("an applicant's token carries through and opens the calendar", { skip: browserSkip }, async (t) => {
  // busyDays low and the site's clock mid-month on purpose: this test is about
  // a token carrying through, and a calendar whose first month is empty would
  // make it about paging instead — which a test below covers.
  const site = await startSite({ gate: 'strict', busyDays: 2, clockOffsetMs: midMonth() });
  t.after(site.stop);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  // The token a person minted on the appointment page, handed back through
  // regbot and down into the run. Nothing here solves anything.
  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const alturas = branches.find((b) => b.name === 'ALTURAS');
  const token = mintToken(site.state, alturas.publicId);

  const config = loadConfig(envFor(site.base, { CAPTCHA_TOKEN: token }, worldNow(site.state)));
  assert.equal(config.captchaToken, token, 'the token reaches the config');

  const page = await browser.newPage();
  await applyCaptchaToken(page, config.captchaToken);
  await navigateToLocationSearch(page, config);
  await searchOffices(page, 'ALTURAS');
  await (await officeSelectButton(page, { term: 'ALTURAS', isZip: false })).click();
  await page.waitForURL(/select-date/, { timeout: 15000 });

  const candidates = await scanCalendar(page, config, noop, 'ALTURAS');
  assert.ok(candidates.length > 0, 'the same calendar that was shut now lists days');
  assert.ok(candidates[0].date instanceof Date);
});

test('an allocated slot costs exactly one human check', { skip: browserSkip }, async (t) => {
  // The invariant that makes the applicant path usable at all. A reCAPTCHA
  // token is single-use, so if a run reads the calendar twice — once to
  // discover, once to book — one solve is never enough and the person has to
  // be asked twice. The stand-in caught exactly that (DATES_SERVED, then
  // "token already used"), and this pins the fix: when the processor has
  // already allocated a slot, the run books it directly.
  // busyDays low and the site's clock mid-month on purpose: this test is about
  // a token carrying through, and a calendar whose first month is empty would
  // make it about paging instead — which a test below covers.
  const site = await startSite({ gate: 'strict', busyDays: 2, clockOffsetMs: midMonth() });
  t.after(site.stop);

  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const alturas = branches.find((b) => b.name === 'ALTURAS');

  // One read to learn what is on offer (the scout's job in real life), then a
  // fresh token for the applicant — the only one they will be asked for.
  const scoutToken = mintToken(site.state, alturas.publicId);
  const offered = await (await fetch(
    `${site.base}/portal/wp-json/dmv/v1/appointment/branches/${encodeURIComponent(alturas.publicId)}/dates` +
    `?services[]=VR&token=${encodeURIComponent(scoutToken)}`)).json();
  const target = offered.dates[0];

  const solvesBefore = site.state.solves;
  const applicantToken = mintToken(site.state, alturas.publicId);

  const result = await run(envFor(site.base, {
    AUTO_SUBMIT: 'true',
    CAPTCHA_TOKEN: applicantToken,
    DMV_TARGET_OFFICE: 'ALTURAS',
    DMV_TARGET_DATE: target.date,
    FIRST_NAME: 'Avery', LAST_NAME: 'Tester',
    EMAIL_ADDRESS: 'avery@example.invalid', PHONE_NUMBER: '5555550123',
    RUN_TIMEOUT_MINUTES: '3',
  }, worldNow(site.state)));

  assert.equal(result.status, 'BOOKED_SUCCESS', `run ended as ${result.status}`);
  assert.equal(site.state.solves - solvesBefore, 1,
    'booking an already-allocated slot must cost the applicant exactly one check');
  assert.equal(site.state.bookings.length, 1);
  assert.equal(site.state.bookings[0].date, target.date);
});

test('the bot takes a cancellation — the near date the backlog never had',
  { skip: browserSkip }, async (t) => {
  // The realistic case, end to end. Everything inside two months is booked, so
  // the only near slot in existence is one somebody gave up; the bot has to
  // find it among a calendar of far-out dates and take it before it lapses.
  const site = await startSite({ gate: 'open', busyDays: 60, horizonDays: 150,
                                 cancelTtlMs: 600000 });
  t.after(site.stop);

  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const alturas = branches.find((b) => b.name === 'ALTURAS');

  const when = new Date();
  when.setDate(when.getDate() + 9);
  while (when.getDay() === 0 || when.getDay() === 6) when.setDate(when.getDate() + 1);
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`
    + `-${String(when.getDate()).padStart(2, '0')}`;
  const freed = releaseSlot(site.state, { branch: alturas.publicId, service: 'VR',
                                          date, time: '9:00 AM' });
  assert.ok(freed, 'the cancellation should have opened');

  const result = await run(envFor(site.base, {
    AUTO_SUBMIT: 'true',
    DMV_TARGET_OFFICE: 'ALTURAS',
    DMV_TARGET_DATE: date,
    FIRST_NAME: 'Avery', LAST_NAME: 'Tester',
    EMAIL_ADDRESS: 'avery@example.invalid', PHONE_NUMBER: '5555550123',
    RUN_TIMEOUT_MINUTES: '3',
  }));

  assert.equal(result.status, 'BOOKED_SUCCESS', `run ended as ${result.status}`);
  assert.equal(site.state.bookings.length, 1);
  assert.equal(site.state.bookings[0].date, date,
    'it must book the cancellation, not a far-out backlog date');
});

/** Two cancellations on one near weekday at ALTURAS, and the site they are on. */
async function twoFreed(t, times) {
  const site = await startSite({ gate: 'open', busyDays: 60, horizonDays: 150, cancelTtlMs: 600000 });
  t.after(site.stop);
  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const alturas = branches.find((b) => b.name === 'ALTURAS');
  const when = new Date();
  when.setDate(when.getDate() + 9);
  while (when.getDay() === 0 || when.getDay() === 6) when.setDate(when.getDate() + 1);
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`
    + `-${String(when.getDate()).padStart(2, '0')}`;
  for (const time of times) {
    assert.ok(releaseSlot(site.state, { branch: alturas.publicId, service: 'VR', date, time }), `${time} should open`);
  }
  return { site, date };
}

const bookFor = (base, date, time) => run(envFor(base, {
  AUTO_SUBMIT: 'true', DMV_TARGET_OFFICE: 'ALTURAS', DMV_TARGET_DATE: date, DMV_TARGET_TIME: time,
  FIRST_NAME: 'Avery', LAST_NAME: 'Tester', EMAIL_ADDRESS: 'avery@example.invalid', PHONE_NUMBER: '5555550123',
  RUN_TIMEOUT_MINUTES: '3',
}));

test('a slot allocated for a time is booked at that time, not the first one free that day',
  { skip: browserSkip }, async (t) => {
  // The board gave this person 11:00. 9:00 is free too, and a robot that took
  // the first time it saw would book somebody else's slot.
  const { site, date } = await twoFreed(t, ['9:00 AM', '11:00 AM']);
  const result = await bookFor(site.base, date, '11:00');
  assert.equal(result.status, 'BOOKED_SUCCESS', `run ended as ${result.status}`);
  assert.equal(site.state.bookings.length, 1);
  assert.equal(site.state.bookings[0].time, '11:00 AM');
});

test('an allocated time that is no longer listed is gone, and nothing else is booked instead',
  { skip: browserSkip }, async (t) => {
  const { site, date } = await twoFreed(t, ['9:00 AM']);
  const result = await bookFor(site.base, date, '11:00');
  assert.equal(result.status, 'NO_AVAILABILITY');
  assert.equal(result.slot_gone, true);
  assert.equal(site.state.bookings.length, 0);
  assert.equal(outcomeToResult(result).slot_gone, true);
});

test('on a busy calendar one token buys one month, not one search',
  { skip: browserSkip }, async (t) => {
  // The applicant path's real price, and it only appears once the calendar is
  // busy. "Next month" re-fetches /dates, a reCAPTCHA token is single-use, so
  // reaching a backlog three months out costs three checks — not the one the
  // parked-job flow asks the applicant for. Pinned here because it is the
  // number the whole latency argument turns on.
  const site = await startSite({ gate: 'open', busyDays: 70, horizonDays: 150 });
  t.after(site.stop);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const config = loadConfig(envFor(site.base));
  const page = await browser.newPage();
  await navigateToLocationSearch(page, config);
  await searchOffices(page, 'ALTURAS');
  await (await officeSelectButton(page, { term: 'ALTURAS', isZip: false })).click();
  await page.waitForURL(/select-date/, { timeout: 15000 });

  const candidates = await scanCalendar(page, config, noop, 'ALTURAS');

  assert.ok(candidates.length > 0, 'the backlog is reachable, just not this month');
  assert.ok(site.state.solves >= 3,
    `paging to a backlog ${70} days out should cost a check per month, saw ${site.state.solves}`);
  const served = site.state.log.filter((e) => e.kind === 'DATES_SERVED').length;
  assert.equal(served, site.state.solves, 'every check bought exactly one calendar read');
});

test('a bought solve opens the gate the site refused, and is charged per read',
  { skip: browserSkip }, async (t) => {
  // The site is strict — an automated browser gets nothing from it, which is
  // the faithful behaviour and what leaves the real calendar on "Loading
  // dates..." forever. The difference here is that the run has bought a
  // solving service, so it asks the farm instead and pays the farm's latency
  // on every single calendar read.
  const delay = 700;
  const site = await startSite({ gate: 'strict', busyDays: 2, solveDelayMs: delay });
  t.after(site.stop);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const config = loadConfig(envFor(site.base, {
    CAPTCHA_SOLVER_URL: `${site.base}/__captcha/solve`,
  }));
  assert.ok(config.solverUrl, 'the solver has to reach the config');

  const page = await browser.newPage();
  await applySolver(page, config.solverUrl);
  await navigateToLocationSearch(page, config);
  await searchOffices(page, 'ALTURAS');
  await (await officeSelectButton(page, { term: 'ALTURAS', isZip: false })).click();
  await page.waitForURL(/select-date/, { timeout: 15000 });

  const started = Date.now();
  const candidates = await scanCalendar(page, config, noop, 'ALTURAS');
  const elapsed = Date.now() - started;

  assert.ok(candidates.length > 0, 'what the site refused, the farm supplied');
  assert.ok(site.state.solves >= 1, 'and it was bought, not conjured');
  assert.ok(elapsed >= delay,
    `every read waits on the farm: ${elapsed}ms elapsed for ${site.state.solves} solve(s)`);
  assert.equal(site.state.log.filter((e) => e.kind === 'DATES_SERVED').length,
               site.state.solves, 'one purchase, one calendar read — nothing amortises');
});

test('a whole booking completes, and the slot is then gone', { skip: browserSkip }, async (t) => {
  // gate=open so the run is unattended: this test is about the booking path,
  // not the gate, which the two tests above already pin.
  const site = await startSite({ gate: 'open' });
  t.after(site.stop);

  const result = await run(envFor(site.base, {
    AUTO_SUBMIT: 'true',
    FIRST_NAME: 'Avery', LAST_NAME: 'Tester',
    EMAIL_ADDRESS: 'avery@example.invalid', PHONE_NUMBER: '5555550123',
    RUN_TIMEOUT_MINUTES: '3',
  }));

  assert.equal(result.status, 'BOOKED_SUCCESS', `run ended as ${result.status}`);

  const state = await (await fetch(`${site.base}/__admin/state`)).json();
  assert.equal(state.bookings.length, 1, 'exactly one appointment was taken');
  const booking = state.bookings[0];
  assert.equal(booking.applicant.first, 'Avery');
  assert.equal(booking.applicant.email, 'avery@example.invalid');
  assert.match(booking.ref, /^TS-[0-9A-F]{8}$/);
  // The number the site issued, read off its confirmation page: what regbot
  // stores and shows the person, and what they cancel or reschedule with.
  assert.equal(result.reference, booking.ref, 'the run must report the confirmation number the site issued');
  assert.equal(outcomeToResult(result).confirmation, booking.ref);

  // And it is off the market: the slot the bot took is no longer offered.
  const id = encodeURIComponent(booking.branch);
  const token = mintToken(site.state, booking.branch);
  const dates = await (await fetch(
    `${site.base}/portal/wp-json/dmv/v1/appointment/branches/${id}/dates` +
    `?services[]=VR&token=${encodeURIComponent(token)}`)).json();
  const sameDay = (dates.dates || []).find((d) => d.date === booking.date);
  assert.ok(!sameDay || !sameDay.times.includes(booking.time),
    'a booked slot must not still be on offer — this is the race the cascade exists for');
});

/**
 * Book an allocated slot on a stand-in whose final submit goes wrong.
 * Targeted, so it goes straight to the slot: the calendar scan is covered above.
 */
async function bookWithFault(t, commitFault) {
  const site = await startSite({ gate: 'open', busyDays: 2, commitFault });
  t.after(site.stop);
  const branches = await (await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches`)).json();
  const alturas = branches.find((b) => b.name === 'ALTURAS');
  const offered = await (await fetch(
    `${site.base}/portal/wp-json/dmv/v1/appointment/branches/${encodeURIComponent(alturas.publicId)}/dates` +
    `?services[]=VR&token=${encodeURIComponent(mintToken(site.state, alturas.publicId))}`)).json();

  const result = await run(envFor(site.base, {
    AUTO_SUBMIT: 'true',
    DMV_TARGET_OFFICE: 'ALTURAS',
    DMV_TARGET_DATE: offered.dates[0].date,
    FIRST_NAME: 'Avery', LAST_NAME: 'Tester',
    EMAIL_ADDRESS: 'avery@example.invalid', PHONE_NUMBER: '5555550123',
    CONFIRMATION_TIMEOUT_MS: '3000',
    RUN_TIMEOUT_MINUTES: '3',
  }));
  return { site, result };
}

test('a booking whose confirmation never arrives is unconfirmed, not booked',
  { skip: browserSkip }, async (t) => {
  // The case that makes a retry dangerous: the appointment exists, but the
  // reply was lost, so the page never says so. Reporting it as booked would
  // capture the escrow against a made-up number; retrying it would book twice.
  const { site, result } = await bookWithFault(t, 'no-reply');

  assert.equal(result.status, 'BOOKING_UNCONFIRMED', `run ended as ${result.status}`);
  assert.equal(result.reference, undefined);
  assert.equal(site.state.bookings.length, 1, 'the appointment does exist, which is why nothing may retry it');

  const envelope = outcomeToResult(result);
  assert.equal(envelope.status, NACK_FATAL, 'refused outright, so regbot never retries it');
  assert.equal(envelope.unconfirmed, true);
  assert.equal(envelope.confirmation, '');
});

test('a slot lost at the final submit is unconfirmed, not booked', { skip: browserSkip }, async (t) => {
  // Somebody else got the slot between the hold and "Schedule appointment".
  // The stand-in says so, but the bot cannot know a real DMV error page means
  // nothing was booked, so it reports what it saw and claims nothing.
  const { site, result } = await bookWithFault(t, 'taken');

  assert.equal(result.status, 'BOOKING_UNCONFIRMED', `run ended as ${result.status}`);
  assert.equal(site.state.bookings.length, 0);
  assert.match(result.seen, /no longer available/, 'what the page said travels with the result');
  assert.equal(outcomeToResult(result).status, NACK_FATAL);
});
