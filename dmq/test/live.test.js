/**
 * Safe live checks against dmv.ca.gov.
 *
 * These are strictly READ-ONLY. They load public pages and public JSON
 * endpoints and assert that the structures the bot depends on still exist.
 * Nothing here holds, confirms, books or cancels an appointment, and nothing
 * submits personal data. Run with:  LIVE=1 node --test test/live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  APPOINTMENT_TYPE_URL,
  selectButtons,
  vehicleSelectButton,
} from '../src/selectors.js';

const LIVE = process.env.LIVE === '1';
const skip = LIVE ? false : 'set LIVE=1 to run live checks';

const API = 'https://www.dmv.ca.gov/portal/wp-json/dmv/v1';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: APPOINTMENT_TYPE_URL,
};

test('public branches endpoint is reachable and lists field offices', { skip }, async () => {
  const res = await fetch(`${API}/appointment/branches`, { headers: HEADERS });
  assert.equal(res.status, 200);
  const branches = await res.json();
  assert.ok(Array.isArray(branches) && branches.length > 100, `got ${branches.length} branches`);
  for (const b of branches.slice(0, 5)) {
    assert.ok(b.publicId && b.name, 'each branch needs publicId and name');
    assert.match(b.publicId, /^[A-Za-z0-9]+!/, 'publicId keeps the "<id>!<hash>" shape');
  }
});

test('public services endpoint still exposes the drive-test service', { skip }, async () => {
  const res = await fetch(`${API}/appointment/services/`, { headers: HEADERS });
  assert.equal(res.status, 200);
  const services = await res.json();
  const names = services.map((s) => s.name);
  assert.ok(names.includes('DT'), `drive test service missing, saw: ${names.join(', ')}`);
});

test('availability endpoint is reCAPTCHA-gated (token required)', { skip }, async () => {
  // Documents why every pure-HTTP bot in this comparison now fails. If this
  // test ever starts failing, DMV changed the gate and HTTP polling may be
  // viable again.
  const branchesRes = await fetch(`${API}/appointment/branches`, { headers: HEADERS });
  const branches = await branchesRes.json();
  const branch = branches.find((b) => /REDWOOD CITY/i.test(b.name)) ?? branches[0];

  const servicesRes = await fetch(`${API}/appointment/services/`, { headers: HEADERS });
  const dt = (await servicesRes.json()).find((s) => s.name === 'DT');

  const url =
    `${API}/appointment/branches/${branch.publicId}/dates` +
    `?services[]=${dt.publicId}&numberOfCustomers=1`;
  const res = await fetch(url, { headers: HEADERS });

  assert.equal(res.status, 400, 'expected a 400 for a request with no captcha token');
  const body = await res.json();
  assert.equal(body.code, 'rest_missing_callback_param');
  assert.deepEqual(body.data.params, ['token']);
});

test('appointment-type page exposes exactly the expected Select buttons', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(APPOINTMENT_TYPE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const count = await selectButtons(page).count();
  assert.equal(count, 4, `expected 4 Select buttons, found ${count}`);

  for (const vehicle of ['Automobile', 'Commercial', 'Motorcycle']) {
    const button = await vehicleSelectButton(page, vehicle);
    const cardText = await button.evaluate((el) => {
      const card = el.closest('.appointment-reason, article, section, li, div');
      return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
    });
    assert.match(cardText, new RegExp(`^${vehicle}`, 'i'), `${vehicle} button resolved to "${cardText}"`);
  }
});

test('positional selector is fragile: getByText("Select") matches non-buttons', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(APPOINTMENT_TYPE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const loose = await page.getByText('Select').count();
  const real = await selectButtons(page).count();
  assert.ok(
    loose > real,
    `getByText("Select") (${loose}) should match more than the ${real} real buttons, ` +
      'which is why index-based selection drifts'
  );
});

test('selecting Automobile reveals the credential form (no data entered)', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(APPOINTMENT_TYPE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const button = await vehicleSelectButton(page, 'Automobile');
  await button.click();
  await page.waitForTimeout(2000);

  // Read-only assertion: the form exists. We never fill or submit it.
  const body = await page.locator('body').innerText();
  assert.match(body, /Driver.s License or Permit Number/i);
  assert.match(body, /Date of Birth/i);
  assert.match(body, /Make an Appointment/i);
});

// ---------------------------------------------------------------------------
// Multi-service and multi-office checks.
//
// The office-visit services need no licence number, so unlike the drive-test
// flow these can be driven all the way to a real calendar. Still read-only:
// reaching the date picker does not hold anything. A slot is only held at the
// "Confirm" step, which nothing here touches.
// ---------------------------------------------------------------------------

import { SERVICES, appointmentUrl } from '../src/services.js';
import { searchOffices, officeSelectButton, officeCards, officeCardText, selectLocationButtons, readDisplayedMonth, openTimeButtons } from '../src/selectors.js';
import { parseMonthHeading, buildCandidateDates } from '../src/calendar.js';

const OFFICE_VISIT_CODES = ['VR', 'CID', 'RID', 'IBC'];

for (const code of OFFICE_VISIT_CODES) {
  test(`${code} jumps straight to location selection with no credential gate`, { skip }, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(appointmentUrl(SERVICES[code]), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    assert.match(page.url(), /select-location/, `${code} should land on the location page`);

    const body = await page.locator('body').innerText();
    assert.match(body, SERVICES[code].expectDescription, `${code} description changed`);
    assert.doesNotMatch(body, /Driver.s License or Permit Number/i, `${code} must not ask for credentials`);
    assert.ok(await selectLocationButtons(page).count() > 0, `${code} should list offices`);
  });
}

test('drive-test services still sit behind the credential gate', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(appointmentUrl(SERVICES.DT), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  assert.doesNotMatch(page.url(), /select-location/, 'DT must not skip to location selection');
});

test('office search resolves several named offices in one session', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();

  for (const term of ['Poway', 'San Marcos']) {
    const page = await context.newPage();
    await page.goto(appointmentUrl(SERVICES.VR), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await searchOffices(page, term);

    // The button must come from the results list, not the map marker popup.
    const button = await officeSelectButton(page, { term, isZip: false });
    assert.ok(await button.isVisible(), `"${term}" select button not visible`);

    const texts = [];
    const count = await officeCards(page).count();
    for (let i = 0; i < count; i++) texts.push(await officeCardText(officeCards(page).nth(i)));
    assert.ok(
      texts.some((t) => new RegExp(term, 'i').test(t)),
      `search for "${term}" returned cards: ${JSON.stringify(texts)}`
    );
    await page.close();
  }
});

test('a ZIP search returns the nearest office first', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(appointmentUrl(SERVICES.VR), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await searchOffices(page, '92064'); // Poway

  const button = await officeSelectButton(page, { term: '92064', isZip: true });
  assert.ok(await button.isVisible(), 'nearest-office select button not visible');

  const firstCard = await officeCardText(officeCards(page).first());
  assert.match(firstCard, /Poway/i, `92064 should resolve to Poway, got "${firstCard}"`);
});

test('availability is gated: the calendar carries a v2 Invisible check and no token issues to automation', { skip }, async (t) => {
  // Companion to the HTTP-API gate test above. If either of these starts
  // failing, DMV changed the control and automated availability reads may be
  // possible again.
  //
  // The gate is reCAPTCHA v2 Invisible, so the assertions are about v2: the
  // page advertises version 2 and an invisible widget, and — the invariant that
  // actually matters — an automated browser cannot passively obtain a token.
  // (An earlier version of this test called grecaptcha.execute(siteKey,{action})
  // the v3 way, which cannot yield a token against a v2 key and so could never
  // catch the gate opening. This asserts the property, not the API shape.)
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(appointmentUrl(SERVICES.VR), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const diag = await page.evaluate(async () => {
    const root = document.querySelector('#appointments-react-root');
    const siteKey = root?.dataset?.recaptchaKey ?? null;
    const version = root?.dataset?.recaptchaVersion ?? null;
    const anchor = document.querySelector('iframe[src*="/recaptcha/api2/anchor"]');
    const size = anchor ? new URL(anchor.src).searchParams.get('size') : null;
    // Try, the v2 way, to read a token straight out of the rendered widget
    // without a human interacting. A gate that is doing its job yields none.
    let passiveToken = null;
    try {
      const field = document.querySelector('textarea[name="g-recaptcha-response"]');
      passiveToken = field && field.value ? field.value : null;
      if (window.grecaptcha && typeof window.grecaptcha.getResponse === 'function') {
        passiveToken = passiveToken || window.grecaptcha.getResponse() || null;
      }
    } catch (e) {
      passiveToken = 'ERR:' + e;
    }
    return { siteKey, version, size, gotToken: !!(passiveToken && String(passiveToken).length > 40) };
  });

  assert.ok(diag.siteKey, 'the page should still advertise a reCAPTCHA site key');
  assert.equal(diag.version, '2',
    `the appointment app advertises reCAPTCHA version ${diag.version}; it was v2. ` +
      'A change here means the gate — and the code that reads it — may need revisiting.');
  assert.equal(diag.size, 'invisible',
    `the reCAPTCHA widget size is ${diag.size}; it was "invisible".`);
  assert.equal(diag.gotToken, false,
    'an automated browser obtained a reCAPTCHA token passively. The gate has changed ' +
      'and the calendar may now be readable from automation.');
});

test('the calendar therefore never renders, and the bot says so quickly', { skip }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(appointmentUrl(SERVICES.VR), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await searchOffices(page, 'Poway');
  await (await officeSelectButton(page, { term: 'Poway', isZip: false })).click();

  // The flow itself works up to this point; only the date lookup is blocked.
  await page.waitForTimeout(20000);
  const body = await page.locator('body').innerText();
  const openTimes = await openTimeButtons(page).count();

  assert.equal(openTimes, 0, 'expected no open-time buttons while the gate holds');
  assert.match(body, /loading dates/i, 'expected the card to still be loading dates');
});
