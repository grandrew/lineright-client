/**
 * The process boundary the app and the server's worker use: JSON in on stdin,
 * one RQP/1 envelope out on stdout. The scout runs against the stand-in's feed
 * over real HTTP; the handler in simulate mode. No recreation.gov, no browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startStandin, addCampsite } from './standin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOUT = path.join(HERE, '..', 'bin', 'rqp-scout.js');
const HANDLER = path.join(HERE, '..', 'bin', 'rqp-handler.js');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rgov-'));

function call(script, request, env = {}) {
  return new Promise((resolve, reject) => {
    const dir = scratch();
    const child = execFile(process.execPath, [script], {
      env: { ...process.env, RUN_LOG_PATH: path.join(dir, 'run.log'), RQP_STATE_PATH: path.join(dir, 'bookings.json'), ...env },
    }, (error, stdout, stderr) => {
      if (error && !stdout) return reject(new Error(`${error.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch {
        reject(new Error(`unparseable stdout: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

const TARGET = { site: 'yosemite', connector: 'recreation.gov.camps', queue: 'yosemite-campsite' };
const discovery = (over = {}) => ({ protocol: 'RQP/1', kind: 'discovery.request', target: TARGET,
  campgrounds: ['upper-pines'], window: ['2027-06-28', '2027-07-02'], nights: 2, ...over });

test('scout: open runs across a month boundary come back as offers with the campsite on them', async (t) => {
  const site = await startStandin();
  t.after(() => site.close());
  addCampsite(site.state, { id: '100', site: '044', open: ['2027-06-29', '2027-06-30', '2027-07-01', '2027-07-02'] });
  addCampsite(site.state, { id: '101', site: '045', open: ['2027-06-30'] }); // one night: too short
  const r = await call(SCOUT, discovery(), { RGOV_BASE_URL: site.url, RGOV_REQUEST_DELAY_MS: '0' });
  assert.equal(r.kind, 'discovery.result');
  assert.equal(r.status, 'confirmed');
  assert.equal(r.offers.length, 1);
  assert.deepEqual(
    (({ office_code, office_name, campsite_id, site: s, first_night, last_night, nights }) => ({ office_code, office_name, campsite_id, site: s, first_night, last_night, nights }))(r.offers[0]),
    { office_code: '232447', office_name: 'Upper Pines', campsite_id: '100', site: '044', first_night: '2027-06-29', last_night: '2027-07-02', nights: 4 });
  assert.equal(site.state.requests.filter((p) => p.includes('/availability/')).length, 2, 'June and July, once each');
});

test('scout: told to slow down, it stops the sweep and says so as a gate', async (t) => {
  const site = await startStandin();
  t.after(() => site.close());
  site.state.mode = 'rate-limited';
  const r = await call(SCOUT, discovery({ campgrounds: ['upper-pines', 'lower-pines', 'north-pines'] }),
    { RGOV_BASE_URL: site.url, RGOV_REQUEST_DELAY_MS: '0' });
  assert.equal(r.gate.kind, 'rate_limited');
  assert.equal(r.checked.length, 1, 'no more campgrounds were asked after the first 429');
  assert.equal(site.state.requests.length, 1);
});

test('scout: a bad envelope is an answer, not a crash', async () => {
  assert.equal((await call(SCOUT, 'not json', { RQP_MODE: 'simulate' })).status, 'rejected');
  const r = await call(SCOUT, discovery({ campgrounds: ['Camp 4'] }), { RQP_MODE: 'simulate' });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /not a Yosemite campsite/);
});

const PERSON = { campgrounds: ['Upper Pines'], nights: 2, party_size: 2, first_name: 'Ada', last_name: 'Camper',
  email: 'ada@example.com', phone: '5555550123', card_number: '4242424242424242', card_exp_month: '12',
  card_exp_year: '2030', card_cvc: '123', street: '1 Main St', city: 'Fresno', state: 'CA', zip: '93701' };
const booking = (key = 'job-7') => ({ protocol: 'RQP/1', kind: 'booking.request', idempotency_key: key, target: TARGET,
  slot: { window: ['2027-06-01', '2027-06-03'], allocated: { office_code: '232447', campsite_id: '100', site: '044', date: '2027-06-02', nights: 2 } },
  personal_data: PERSON });

test('handler: a booking is made once; asked again it replays the same reservation', async () => {
  const state = path.join(scratch(), 'bookings.json');
  const env = { RQP_MODE: 'simulate', RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS', RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true' };
  const first = await call(HANDLER, booking(), env);
  assert.equal(first.status, 'confirmed');
  assert.match(first.confirmation, /^\d{10}-1$/);
  const again = await call(HANDLER, booking(), { ...env, RQP_SIMULATE_OUTCOME: 'NO_AVAILABILITY' });
  assert.equal(again.replayed, true);
  assert.equal(again.confirmation, first.confirmation);
});

test('handler: an order placed and never confirmed is never placed again', async () => {
  const state = path.join(scratch(), 'bookings.json');
  const env = { RQP_MODE: 'simulate', RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true' };
  const first = await call(HANDLER, booking(), { ...env, RQP_SIMULATE_OUTCOME: 'BOOKING_UNCONFIRMED' });
  assert.equal(first.status, 'rejected');
  assert.equal(first.unconfirmed, true);
  const again = await call(HANDLER, booking(), { ...env, RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' });
  assert.equal(again.status, 'rejected');
  assert.equal(again.replayed, true);
});

test('handler: a declined card is not recorded, so a new card can try again', async () => {
  const state = path.join(scratch(), 'bookings.json');
  const env = { RQP_MODE: 'simulate', RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true' };
  const declined = await call(HANDLER, booking(), { ...env, RQP_SIMULATE_OUTCOME: 'PAYMENT_DECLINED' });
  assert.equal(declined.status, 'rejected');
  assert.equal(declined.payment_declined, true);
  const retry = await call(HANDLER, booking(), { ...env, RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' });
  assert.equal(retry.status, 'confirmed');
  assert.notEqual(retry.replayed, true);
});

test('handler: without RQP_ALLOW_BOOKING the card is not even read', async () => {
  const r = await call(HANDLER, { ...booking(), personal_data: { campgrounds: ['Upper Pines'], nights: 2 } },
    { RQP_MODE: 'simulate', RQP_SIMULATE_OUTCOME: 'FOUND_AND_STOPPED' });
  assert.equal(r.status, 'unavailable');
  assert.match(r.message, /booking is disabled/);
});
