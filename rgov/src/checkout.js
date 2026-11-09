/**
 * The booking robot: one campsite, for one stay, put in the person's own
 * Recreation.gov cart and paid for with their own card, as the person would.
 *
 *   1. Ask the availability feed whether the stay is still open — a request,
 *      not a cart: nothing is held for a stay that is already gone.
 *   2. Open the campsite page, signed in as the person (RGOV_STORAGE_STATE).
 *   3. Choose the nights and book; fill in the order details.
 *   4. Proceed to the cart and to payment; fill in the card and billing address.
 *   5. Place the order — the one step that may leave a reservation and a
 *      charge behind (`hooks.onSubmit`, just before it).
 *   6. Read the reservation number off the confirmation page. Without one the
 *      booking is unconfirmed, never booked.
 *
 * A human check, a waiting room or a sign-in page anywhere before step 5 stops
 * the run as a gate, which the app turns into the page opened for its person.
 * One after step 5 stops it too, as unconfirmed: the order may have gone.
 */
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { readCampground, stayFits, addDays } from './availability.js';
import { playwright, makeRunLogger, instrument } from './shared.js';
import * as ui from './selectors.js';

const STEP_SETTLE_MS = 1500;

export const BOOKED = 'BOOKED_SUCCESS';
export const UNCONFIRMED = 'BOOKING_UNCONFIRMED';
export const DECLINED = 'PAYMENT_DECLINED';
export const NO_AVAILABILITY = 'NO_AVAILABILITY';

/** A run stopped by something only the person can deal with. */
export function gateError(message, gate) {
  const error = new Error(message);
  error.gate = gate;
  return error;
}

/** Whether the stay is open, per the feed. Null when the feed could not say. */
export async function stillOpen(config, campground, campsiteId, arrival, nights, { fetchImpl = fetch } = {}) {
  try {
    const sites = await readCampground(config.baseUrl, campground.id, arrival, addDays(arrival, nights - 1), { fetchImpl });
    const site = sites.find((s) => s.campsite_id === String(campsiteId));
    return site ? stayFits(site, arrival, nights) : false;
  } catch {
    return null;
  }
}

/**
 * The first stay any of the campgrounds has, in the order they were given:
 * the preference is the bid's. Within a campground, the earliest arrival.
 */
export async function findStay(config, log, { fetchImpl = fetch } = {}) {
  const results = [];
  const lastNight = addDays(config.endDate, config.nights - 1);
  for (const campground of config.campgrounds) {
    try {
      const sites = await readCampground(config.baseUrl, campground.id, config.startDate, lastNight, { fetchImpl });
      for (let arrival = config.startDate; arrival <= config.endDate; arrival = addDays(arrival, 1)) {
        const site = sites.find((s) => stayFits(s, arrival, config.nights));
        if (site) {
          results.push({ campground: campground.short, status: 'FOUND' });
          return { stay: { campground, campsiteId: site.campsite_id, site: site.site, arrival }, results };
        }
      }
      results.push({ campground: campground.short, status: NO_AVAILABILITY });
    } catch (error) {
      log('CHECK_FAILED', `${campground.short}: ${error.message}`);
      results.push({ campground: campground.short, status: 'ERROR' });
      if (error.gate) throw Object.assign(error, { results });
    }
    await new Promise((r) => setTimeout(r, config.requestDelayMs));
  }
  return { stay: null, results };
}

/** Fill a field a person finds by `label`: a box is typed in, a list is chosen from. */
async function setField(page, label, value, what) {
  const el = await ui.field(page, label, what);
  const tag = await el.evaluate((node) => node.tagName.toLowerCase());
  if (tag === 'select') {
    const wanted = String(value);
    const options = await el.locator('option').allInnerTexts();
    const match = options.find((o) => o.trim() === wanted) ?? options.find((o) => new RegExp(`^${wanted}\\b`, 'i').test(o.trim()));
    if (!match) throw new Error(`${what}: no choice ${JSON.stringify(wanted)} among ${options.join(', ')}`);
    await el.selectOption({ label: match });
  } else {
    await el.fill(String(value));
  }
}

async function chooseEquipment(page, equipment) {
  const el = await ui.inAnyFrame(page, (f) => f.getByLabel(ui.EQUIPMENT), { timeout: 3000 });
  if (!el) return; // a tent-only site asks nothing
  const want = ui.EQUIPMENT_NAMES[equipment] ?? new RegExp(equipment, 'i');
  const options = await el.locator('option').allInnerTexts();
  const match = options.find((o) => want.test(o.trim()));
  if (!match) throw new Error(`Equipment: this campsite takes none like "${equipment}" (it lists ${options.join(', ')})`);
  await el.selectOption({ label: match });
}

async function press(page, name, what) {
  const b = await ui.button(page, name, what);
  await b.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(STEP_SETTLE_MS);
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

/** Stop at anything that is the person's to deal with, before anything is sent. */
async function checkWay(page, step) {
  const gate = await ui.readGate(page, step);
  if (gate) throw gateError(`Stopped at a ${gate.kind.replace(/_/g, ' ')} on Recreation.gov (${step}).`, gate);
  if (await ui.asksToSignIn(page)) {
    throw gateError('Recreation.gov wants the person to sign in.', { kind: 'signin', page_url: page.url(), step });
  }
}

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

/** After the order went: a reservation number, a refusal, a check, or nothing in time. */
async function awaitOutcome(page, config) {
  const deadline = Date.now() + config.confirmationTimeoutMs;
  for (;;) {
    if (page.isClosed()) return { kind: 'nothing', seen: 'the page closed' };
    const text = await bodyText(page);
    const reference = ui.parseConfirmation({ url: page.url(), text });
    if (reference) return { kind: 'booked', reference };
    if (ui.saysDeclined(text)) return { kind: 'declined', text };
    const gate = await ui.readGate(page, 'after placing the order');
    if (gate) return { kind: 'gate', gate };
    if (Date.now() >= deadline) {
      let where = page.url();
      try { where = new URL(where).pathname; } catch { /* keep it */ }
      return { kind: 'nothing', seen: `still on ${where}, no reservation number shown` };
    }
    await page.waitForTimeout(500).catch(() => {});
  }
}

/** Offer a stuck page to the overseer, as the DMV robot does. Null when nobody took it. */
async function overseen(page, hooks, where, trouble, log) {
  if (!hooks.onTrouble || page.isClosed()) return null;
  log('OVERSEER_ASKED', `${trouble.stage}: ${trouble.why}`);
  let outcome;
  try {
    outcome = await hooks.onTrouble(page, trouble);
  } catch (error) {
    log('OVERSEER_FAILED', error.message);
    return null;
  }
  if (!outcome) return null;
  log('OVERSEER_DONE', `${trouble.stage}: ${outcome.status}${outcome.why ? ` — ${outcome.why}` : ''}`);
  if (outcome.status === 'booked' && outcome.confirmation) {
    const reference = String(outcome.confirmation).trim();
    const text = await bodyText(page);
    if (reference.length >= 6 && text.includes(reference)) {
      return { status: BOOKED, ...where, reference, url: page.url(), overseen: true };
    }
    return { status: UNCONFIRMED, ...where, overseen: true, seen: `the overseer said ${reference}, which is not on the page` };
  }
  if (outcome.status === 'gone') return { status: NO_AVAILABILITY, slot_gone: true, ...where, overseen: true };
  if (outcome.status === 'gate') {
    throw gateError(`A human check stopped the booking: ${outcome.why || 'the overseer saw one'}`,
      (await ui.readGate(page, trouble.step)) ?? { kind: 'unknown', page_url: page.url(), step: trouble.step });
  }
  if (outcome.status === 'unconfirmed' || outcome.submitted) {
    return { status: UNCONFIRMED, ...where, overseen: true, seen: outcome.why || 'the overseer could not say' };
  }
  return null;
}

export async function bookStay(context, config, stay, log, hooks = {}) {
  const page = await context.newPage();
  const { booking } = config;
  const departure = addDays(stay.arrival, config.nights);
  const where = { campground: stay.campground.short, campsite_id: stay.campsiteId, site: stay.site,
    arrival: stay.arrival, nights: config.nights };
  const at = { step: 'opening the campsite page', sent: false };
  const step = (name) => { at.step = name; log('STEP', name); };
  try {
    step('opening the campsite page');
    await page.goto(ui.campsiteUrl(config.baseUrl, stay.campsiteId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(STEP_SETTLE_MS);
    await checkWay(page, at.step);
    if (!(await ui.signedIn(page))) {
      throw gateError('The person is not signed in to Recreation.gov in this app.', { kind: 'signin', page_url: page.url(), step: at.step });
    }

    step(`choosing ${stay.arrival} to ${departure}`);
    await (await ui.field(page, ui.CHECK_IN, 'the check-in date')).fill(ui.usDate(stay.arrival));
    await (await ui.field(page, ui.CHECK_OUT, 'the check-out date')).fill(ui.usDate(departure));
    await page.keyboard.press('Tab');
    await press(page, ui.BOOK, 'Book Now');
    await checkWay(page, at.step);
    if (ui.saysGone(await bodyText(page))) {
      log('SLOT_GONE', `${where.campground} site ${stay.site}: gone before it reached the cart`);
      return { status: NO_AVAILABILITY, slot_gone: true, ...where };
    }

    step('filling in the order details');
    await setField(page, ui.OCCUPANTS, booking.partySize, 'the number of occupants');
    const vehicles = await ui.inAnyFrame(page, (f) => f.getByLabel(ui.VEHICLES), { timeout: 2000 });
    if (vehicles) await setField(page, ui.VEHICLES, booking.vehicles, 'the number of vehicles');
    if (booking.equipment) await chooseEquipment(page, booking.equipment);
    if (booking.equipmentLength) {
      const length = await ui.inAnyFrame(page, (f) => f.getByLabel(ui.EQUIPMENT_LENGTH), { timeout: 2000 });
      if (length) await length.fill(String(booking.equipmentLength));
    }
    for (const frame of page.frames()) {
      for (const box of await frame.getByRole('checkbox', { name: ui.ACKNOWLEDGE }).all()) {
        if (!(await box.isChecked())) await box.check();
      }
    }
    await press(page, ui.TO_CART, 'Proceed to Cart');
    await checkWay(page, at.step);

    step('going from the cart to payment');
    const heldUntil = ui.heldUntil(await bodyText(page));
    if (heldUntil) log('HELD', `in the cart until ${heldUntil}`);
    await press(page, ui.TO_PAYMENT, 'Proceed to Payment');
    await checkWay(page, at.step);

    step('filling in the card and billing address');
    await (await ui.field(page, ui.CARD.name, 'the name on the card')).fill(booking.card.name);
    await (await ui.field(page, ui.CARD.number, 'the card number')).fill(booking.card.number);
    await setField(page, ui.CARD.expMonth, booking.card.expMonth, 'the expiry month');
    await setField(page, ui.CARD.expYear, booking.card.expYear, 'the expiry year');
    await (await ui.field(page, ui.CARD.cvc, 'the security code')).fill(booking.card.cvc);
    await (await ui.field(page, ui.BILLING.street, 'the billing street')).fill(booking.billing.street);
    await (await ui.field(page, ui.BILLING.city, 'the billing city')).fill(booking.billing.city);
    await setField(page, ui.BILLING.state, booking.billing.state, 'the billing state');
    await (await ui.field(page, ui.BILLING.zip, 'the billing ZIP code')).fill(booking.billing.zip);
    const pay = await ui.button(page, ui.PAY, 'the button that places the order');
    await checkWay(page, at.step);
    if (config.rehearse) {
      log('REHEARSED', `${where.campground} site ${stay.site}: stopped before paying`);
      return { status: 'REHEARSED', ...where, url: page.url(), held_until: heldUntil };
    }

    step('placing the order');
    hooks.onSubmit?.();
    at.sent = true;
    await pay.click();
    const outcome = await awaitOutcome(page, config);

    if (outcome.kind === 'booked') {
      log('BOOKED_SUCCESS', `${where.campground} site ${stay.site} ${stay.arrival} x${config.nights} ref=${outcome.reference}`);
      const shot = await keepConfirmation(page, config.confirmationShotPath);
      return { status: BOOKED, ...where, reference: outcome.reference, url: page.url(), shot };
    }
    if (outcome.kind === 'declined') {
      log('PAYMENT_DECLINED', `${where.campground} site ${stay.site}`);
      return { status: DECLINED, ...where, cart_url: ui.cartUrl(config.baseUrl), held_until: heldUntil };
    }
    if (outcome.kind === 'gate') {
      // A card check (3-D Secure) or a human check after the order went: the
      // person can finish it on the page, and nobody may send it again.
      log('GATE_AFTER_ORDER', outcome.gate.kind);
      return { status: UNCONFIRMED, ...where, gate: outcome.gate,
        seen: `a ${outcome.gate.kind.replace(/_/g, ' ')} came up after the order was placed` };
    }
    const read = await overseen(page, hooks, where, { stage: 'confirming', why: outcome.seen, step: at.step, readOnly: true }, log)
      .catch(() => null);
    if (read) return read;
    log('BOOKING_UNCONFIRMED', outcome.seen);
    return { status: UNCONFIRMED, ...where, seen: outcome.seen };
  } catch (error) {
    // Stuck before the order went: an overseer may take the page over and
    // finish. A gate is the person's, not an overseer's.
    if (at.sent || error.gate) throw error;
    const took = await overseen(page, hooks, where, { stage: 'booking', why: String(error.message).slice(0, 600),
      step: at.step, wanted: where }, log);
    if (took) return took;
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * One run of the booking robot. `hooks.onSubmit` is called just before the
 * order is placed, the one step that may leave a reservation behind.
 */
export async function run(env = process.env, hooks = {}, { fetchImpl = fetch } = {}) {
  const config = loadConfig(env);
  const runLog = makeRunLogger(config.runLogPath);
  let probe = null;
  const log = (status, detail) => {
    runLog(status, detail);
    if (probe) probe.note(status, detail);
    try { hooks.onStep?.(status, detail); } catch { /* never the problem */ }
  };

  log('START', `campgrounds=${config.campgrounds.map((c) => c.short).join('|')} arrivals=${config.startDate}..${config.endDate} nights=${config.nights} autoSubmit=${config.autoSubmit}`);

  // Which stay, before any browser: the allocated one if there is one, checked
  // against the feed; otherwise the first the feed shows.
  let stay;
  let results = [];
  if (config.target) {
    const t = config.target;
    const open = await stillOpen(config, t.campground, t.campsiteId, t.arrival, config.nights, { fetchImpl });
    if (open === false) {
      log('SLOT_GONE', `${t.campground.short} campsite ${t.campsiteId} ${t.arrival}: the feed shows it taken`);
      return { status: NO_AVAILABILITY, slot_gone: true, campground: t.campground.short, campsite_id: t.campsiteId,
        arrival: t.arrival, nights: config.nights, results };
    }
    stay = { campground: t.campground, campsiteId: t.campsiteId, site: t.site, arrival: t.arrival };
    log('TARGETED', `${t.campground.short} campsite ${t.campsiteId} arriving ${t.arrival}: booking the allocated stay directly`);
  } else {
    ({ stay, results } = await findStay(config, log, { fetchImpl }));
    if (!stay) return { status: NO_AVAILABILITY, results };
  }

  // Checked before anything goes in a cart.
  if (!config.autoSubmit) {
    const best = { campground: stay.campground.short, campsite_id: stay.campsiteId, site: stay.site,
      arrival: stay.arrival, nights: config.nights };
    log('FOUND_AND_STOPPED', `Dry run: ${best.campground} site ${best.site || best.campsite_id} arriving ${best.arrival}. Set AUTO_SUBMIT=true to book.`);
    return { status: 'FOUND_AND_STOPPED', best, results };
  }

  const { chromium } = playwright();
  const browser = await chromium.launch({ headless: config.headless, slowMo: config.debug ? 300 : 0 });
  const forceClose = setTimeout(async () => {
    log('STUCK_OR_TIMEOUT', `Force closed after ${config.timeoutMs / 60000} minutes`);
    if (probe) await probe.stop();
    await browser.close().catch(() => {});
    process.exit(1);
  }, config.timeoutMs);
  try {
    const context = await browser.newContext(config.storageState && fs.existsSync(config.storageState)
      ? { storageState: config.storageState } : {});
    probe = await instrument(context, { dir: config.traceDir, screenshots: config.traceScreenshots, title: 'book yosemite' });
    const booking = await bookStay(context, config, stay, log, hooks);
    return { ...booking, results };
  } catch (error) {
    log('ERROR_OR_STUCK', error.message || 'Unknown error');
    throw error;
  } finally {
    clearTimeout(forceClose);
    if (probe) await probe.stop();
    await browser.close().catch(() => {});
  }
}
