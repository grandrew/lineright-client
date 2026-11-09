/**
 * The Recreation.gov booking robot (../../../rgov), end to end, in a real
 * browser, against this stand-in: campsite page, order details, cart, payment
 * and the confirmation, and each way a booking can end short of one. Nothing
 * here goes near recreation.gov. Needs Playwright's Chromium (`npx playwright
 * install chromium` in ../../dmq), so it is opt-in: `npm run test:robots`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startStandin, addCampsite, SESSION, DECLINED_CARD } from '../standin.mjs';

const skip = process.env.RGOV_SIM === '1' ? false : 'set RGOV_SIM=1 (or: npm run test:robots; needs Playwright Chromium)';
const { run } = await import('../../../rgov/src/checkout.js');

function envFor(site, { signedIn = true, ...over } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgov-e2e-'));
  const storage = path.join(dir, 'state.json');
  if (signedIn) {
    fs.writeFileSync(storage, JSON.stringify({ cookies: [{ ...SESSION, domain: '127.0.0.1', path: '/', expires: -1,
      httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  }
  return {
    RGOV_BASE_URL: site.url, RGOV_STORAGE_STATE: storage, RGOV_REQUEST_DELAY_MS: '0', RUN_LOG_PATH: path.join(dir, 'run.log'),
    RQP_CONFIRMATION_SHOT: path.join(dir, 'confirmation.png'), CONFIRMATION_TIMEOUT_MS: '3000',
    DATE_START: '2027-06-01', DATE_END: '2027-06-03', RGOV_CAMPGROUNDS: '232447', RGOV_NIGHTS: '2',
    RGOV_TARGET_CAMPGROUND: '232447', RGOV_TARGET_CAMPSITE: '100', RGOV_TARGET_SITE: '044', RGOV_TARGET_ARRIVAL: '2027-06-02',
    AUTO_SUBMIT: 'true', RGOV_PARTY_SIZE: '4', RGOV_VEHICLES: '1', RGOV_EQUIPMENT: 'tent',
    FIRST_NAME: 'Ada', LAST_NAME: 'Camper', EMAIL_ADDRESS: 'ada@example.com', PHONE_NUMBER: '5555550123',
    CARD_NAME: 'Ada Camper', CARD_NUMBER: '4242424242424242', CARD_EXP_MONTH: '12', CARD_EXP_YEAR: '2030', CARD_CVC: '123',
    BILLING_STREET: '1 Main St', BILLING_CITY: 'Fresno', BILLING_STATE: 'CA', BILLING_ZIP: '93701',
    ...over,
  };
}

async function standin(t, mode = null) {
  const site = await startStandin();
  t.after(() => site.close());
  addCampsite(site.state, { id: '100', site: '044', open: ['2027-06-02', '2027-06-03'] });
  site.state.mode = mode;
  return site;
}

test('books the allocated stay and reads the reservation number off the confirmation', { skip }, async (t) => {
  const site = await standin(t);
  let submitted = 0;
  const env = envFor(site);
  const out = await run(env, { onSubmit: () => { submitted += 1; } });
  assert.equal(out.status, 'BOOKED_SUCCESS', JSON.stringify(out));
  assert.equal(out.reference, '1234567890-1');
  assert.equal(submitted, 1);
  assert.equal(site.state.orders.length, 1);
  assert.deepEqual((({ campsite_id, arrival, nights, occupants, equipment }) => ({ campsite_id, arrival, nights, occupants, equipment }))(site.state.orders[0]),
    { campsite_id: '100', arrival: '2027-06-02', nights: 2, occupants: 4, equipment: 'Tent' });
  assert.ok(fs.existsSync(env.RQP_CONFIRMATION_SHOT));
});

test('a dry probe finds the stay and stops before anything goes in a cart', { skip }, async (t) => {
  const site = await standin(t);
  const out = await run(envFor(site, { AUTO_SUBMIT: 'false' }));
  assert.equal(out.status, 'FOUND_AND_STOPPED');
  assert.equal(site.state.holds.length, 0);
  assert.ok(!site.state.requests.some((p) => p.startsWith('GET /camping/')), 'no page was opened');
});

test('a stay the feed shows taken is gone, without opening a page', { skip }, async (t) => {
  const site = await standin(t);
  site.state.campsites['100'].nights['2027-06-03'] = 'Reserved';
  const out = await run(envFor(site));
  assert.equal(out.status, 'NO_AVAILABILITY');
  assert.equal(out.slot_gone, true);
  assert.ok(!site.state.requests.some((p) => p.includes('/camping/')));
});

test('taken between the feed and the cart is gone too, and nothing is paid', { skip }, async (t) => {
  const site = await standin(t, 'gone-at-cart');
  const out = await run(envFor(site));
  assert.equal(out.status, 'NO_AVAILABILITY');
  assert.equal(out.slot_gone, true);
  assert.equal(site.state.orders.length, 0);
});

test('not signed in is a gate for the person, before any cart', { skip }, async (t) => {
  const site = await standin(t);
  await assert.rejects(run(envFor(site, { signedIn: false })), (e) => e.gate?.kind === 'signin');
  assert.equal(site.state.holds.length, 0);
});

test('a waiting room is a gate: the robot never waits it out or works round it', { skip }, async (t) => {
  const site = await standin(t, 'waiting-room');
  await assert.rejects(run(envFor(site)), (e) => e.gate?.kind === 'waiting_room');
  assert.equal(site.state.holds.length, 0);
});

test('a declined card is reported with the cart it is still held in', { skip }, async (t) => {
  const site = await standin(t);
  const out = await run(envFor(site, { CARD_NUMBER: DECLINED_CARD }));
  assert.equal(out.status, 'PAYMENT_DECLINED');
  assert.equal(out.cart_url, `${site.url}/cart`);
  assert.equal(out.held_until, '7:14 AM');
  assert.equal(site.state.orders.length, 0);
});

test('a rehearsal fills everything in and stops short of paying', { skip }, async (t) => {
  const site = await standin(t);
  let submitted = 0;
  const out = await run(envFor(site, { RGOV_REHEARSE: 'true' }), { onSubmit: () => { submitted += 1; } });
  assert.equal(out.status, 'REHEARSED');
  assert.equal(submitted, 0);
  assert.equal(site.state.holds.length, 1, 'it is in the cart');
  assert.equal(site.state.orders.length, 0, 'and nothing was paid');
});

test('an order that never shows a reservation number is unconfirmed, never booked', { skip }, async (t) => {
  const site = await standin(t, 'silent');
  const out = await run(envFor(site));
  assert.equal(out.status, 'BOOKING_UNCONFIRMED');
  assert.match(out.seen, /no reservation number/);
});
