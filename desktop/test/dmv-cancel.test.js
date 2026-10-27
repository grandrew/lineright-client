'use strict';
/**
 * The cancel guide (src/dmv-cancel.js), and — with a lineright-server checkout
 * beside this one (or LINERIGHT_SERVER_DIR) and the robots' Playwright — the
 * guide run in a real browser on the stand-in's "View/Cancel Appointment"
 * page, which keeps the live DMV page's ids and words.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { cancelValues, cancelScript } = require('../src/dmv-cancel');

const SERVER = path.resolve(process.env.LINERIGHT_SERVER_DIR || path.join(__dirname, '..', '..', '..', 'lineright-server'));
const STANDIN = path.join(SERVER, 'testsite', 'server.js');
let playwright = null;
try { playwright = require(path.join(__dirname, '..', '..', 'dmq', 'node_modules', 'playwright')); } catch { /* skipped below */ }
const skip = !fs.existsSync(STANDIN) ? `no lineright-server checkout at ${SERVER} (or LINERIGHT_SERVER_DIR)`
  : !playwright ? 'the robots\' Playwright is not installed (npm ci in dmq)' : false;

test('the details the DMV page asks for, as the page wants them', () => {
  assert.deepEqual(cancelValues({ first_name: ' Ada ', last_name: 'Lovelace', phone: '+1 (555) 555-0123',
    email: 'ada@x.test', dl_number: 'a1234567', dob: '1990-02-03' }),
  { first: 'Ada', last: 'Lovelace', phone: '5555550123', email: 'ada@x.test', dl: 'A1234567', dob: '02/03/1990' });
  assert.equal(cancelValues({ phone: '555-555-0123' }).phone, '5555550123');
  assert.equal(cancelValues({ dob: '02/03/1990' }).dob, '02/03/1990', 'kept as it is when not yyyy-mm-dd');
  assert.deepEqual(cancelValues(null), { first: '', last: '', phone: '', email: '', dl: '', dob: '' });
});

test('the guide is for that one confirmation number, and goes no further than cancelling', () => {
  const script = cancelScript('269303047', cancelValues({ first_name: 'Ada', last_name: 'Lovelace', phone: '5555550123' }));
  assert.match(script, /"confirmation":"269303047"/);
  assert.match(script, /data-appt-id/);
  assert.match(script, /#delete-confirmation/);
  assert.doesNotMatch(script, /schedule appointment|create an appointment/i, 'it never books');
  new Function(`return ${script}`); // eslint-disable-line no-new-func
});

test('on the View/Cancel page it cancels that appointment and leaves the others', { skip, timeout: 120000 }, async (t) => {
  const { createServer, createState } = await import(pathToFileURL(STANDIN).href);
  const state = createState({ officeCount: 0, gate: 'off' });
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (where, body) => (await fetch(base + where, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const { slotsFor } = await import(pathToFileURL(path.join(SERVER, 'testsite', 'world.js')).href);
  const office = state.offices.find((o) => o.name === 'Poway');
  const days = slotsFor(state, office.code, 'VR').filter((d) => d.times.length);
  const book = async (n, first, last, phone) => {
    const held = await post('/portal/appointments/book?stage=hold',
      { branch: office.code, service: 'VR', date: days[n].date, time: days[n].times[0] });
    return (await post('/portal/appointments/book?stage=commit',
      { hold: held.hold, first, last, email: `${first}@example.invalid`, phone })).ref;
  };
  const adaFirst = await book(0, 'Ada', 'Lovelace', '5555550123');
  const adaSecond = await book(1, 'Ada', 'Lovelace', '5555550123');
  const grace = await book(2, 'Grace', 'Hopper', '5555550188');

  const browser = await playwright.chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const ada = cancelValues({ first_name: 'Ada', last_name: 'Lovelace', phone: '(555) 555-0123' });
  const run = async (confirmation, values) => {
    await page.goto(`${base}/portal/appointments/appt-edit`);
    return page.evaluate(cancelScript(confirmation, values, { timeoutMs: 30000 }));
  };

  assert.equal(await run(adaFirst, ada), 'cancelled');
  assert.deepEqual(state.bookings.map((b) => b.ref).sort(), [adaSecond, grace].sort(), 'only that one');

  assert.equal(await run(grace, ada), 'not-listed', "Grace's is not under Ada's name");
  assert.equal(state.bookings.length, 2);

  assert.equal(await run(adaSecond, { ...ada, phone: '5555550199' }), 'none', 'nothing under another number');
  assert.equal(state.bookings.length, 2);
});
