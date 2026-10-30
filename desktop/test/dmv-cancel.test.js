'use strict';
/**
 * The cancel guide (src/dmv-cancel.js), and — with the robots' Playwright —
 * the guide run in a real browser on the DMV simulator's "View/Cancel
 * Appointment" page (simulators/ca-dmv), which keeps the live DMV page's ids
 * and words.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { cancelValues, cancelScript, pickItem, listWords } = require('../src/dmv-cancel');

const STANDIN = path.join(__dirname, '..', '..', 'simulators', 'ca-dmv', 'server.js');
require('./helpers/browsers');
let playwright = null;
try { playwright = require(path.join(__dirname, '..', '..', 'dmq', 'node_modules', 'playwright')); } catch { /* skipped below */ }
const skip = !fs.existsSync(STANDIN) ? `no DMV simulator at ${STANDIN}`
  : !playwright ? 'the robots\' Playwright is not installed (npm ci in dmq)' : false;

test('the details the DMV page asks for, as the page wants them', () => {
  assert.deepEqual(cancelValues({ first_name: ' Ada ', last_name: 'Lovelace', phone: '+1 (555) 555-0123',
    email: 'ada@x.test', dl_number: 'a1234567', dob: '1990-02-03' }),
  { first: 'Ada', last: 'Lovelace', phone: '5555550123', email: 'ada@x.test', dl: 'A1234567', dob: '02/03/1990' });
  assert.equal(cancelValues({ phone: '555-555-0123' }).phone, '5555550123');
  assert.equal(cancelValues({ dob: '02/03/1990' }).dob, '02/03/1990', 'kept as it is when not yyyy-mm-dd');
  assert.deepEqual(cancelValues(null), { first: '', last: '', phone: '', email: '', dl: '', dob: '' });
});

// The live DMV's list, 2026-10-26: its id is its own, not the confirmation number (269303047).
const LIVE = [{ id: '5ca7cbe98572abcec8f4c990bff12208d4474732ec0bcdae4e400978c4d9d8c7',
  text: "SAN JOSE 10/27/26, 10:00 AM, California ID/Driver's License Cancel Appointment" }];
const SAN_JOSE = { confirmation: '269303047', date: '2026-10-27', time: '10:00', office_name: 'San Jose' };
const want = (b) => ({ confirmation: b.confirmation, ...listWords(b.date, b.time), office: b.office_name });

test('the appointment is known on the list by its office, day and time, as the DMV words them', () => {
  assert.deepEqual(listWords('2026-10-27', '10:00'), { day: '10/27/26', at: '10:00 AM' });
  assert.deepEqual(listWords('2026-11-03', '14:20'), { day: '11/03/26', at: '2:20 PM' });
  assert.deepEqual(listWords('2026-11-03', '00:05'), { day: '11/03/26', at: '12:05 AM' });
  assert.deepEqual(pickItem(LIVE, want(SAN_JOSE)), { id: LIVE[0].id });
  assert.deepEqual(pickItem(LIVE, want({ ...SAN_JOSE, time: '11:00' })), {}, 'another time is not it');
  assert.deepEqual(pickItem(LIVE, want({ ...SAN_JOSE, date: '2026-10-28' })), {}, 'nor another day');
  // "1:00 PM" is not "11:00 PM".
  const late = [{ id: 'a', text: 'SAN JOSE 10/27/26, 11:00 PM, x' }];
  assert.deepEqual(pickItem(late, want({ ...SAN_JOSE, time: '13:00' })), {});
  // A site that uses the confirmation number as the id: that one, whatever it says.
  assert.deepEqual(pickItem([{ id: '269303047', text: '' }, ...LIVE], want(SAN_JOSE)), { id: '269303047' });
  // Two on that day at that time: the one at its office, or none at all.
  const two = [...LIVE, { id: 'b', text: "LOS GATOS 10/27/26, 10:00 AM, California ID/Driver's License" }];
  assert.deepEqual(pickItem(two, want(SAN_JOSE)), { id: LIVE[0].id });
  assert.deepEqual(pickItem(two, want({ ...SAN_JOSE, office_name: 'Santa Clara' })), { ambiguous: 2 });
  assert.deepEqual(pickItem([...two, { id: 'c', text: 'SAN JOSE 10/27/26, 10:00 AM, Vehicle registration' }], want(SAN_JOSE)),
    { ambiguous: 3 });
});

test('the guide is for that one appointment, and goes no further than cancelling', () => {
  const script = cancelScript(SAN_JOSE, cancelValues({ first_name: 'Ada', last_name: 'Lovelace', phone: '5555550123' }));
  assert.match(script, /"confirmation":"269303047"/);
  assert.match(script, /"day":"10\/27\/26","at":"10:00 AM","office":"San Jose"/);
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
  const { slotsFor } = await import(pathToFileURL(path.join(path.dirname(STANDIN), 'world.js')).href);
  const office = state.offices.find((o) => o.name === 'Poway');
  const days = slotsFor(state, office.code, 'VR').filter((d) => d.times.length);
  const to24 = (label) => {
    const [, h, m, ap] = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(label);
    return `${String((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)).padStart(2, '0')}:${m}`;
  };
  const book = async (n, first, last, phone) => {
    const held = await post('/portal/appointments/book?stage=hold',
      { branch: office.code, service: 'VR', date: days[n].date, time: days[n].times[0] });
    const ref = (await post('/portal/appointments/book?stage=commit',
      { hold: held.hold, first, last, email: `${first}@example.invalid`, phone })).ref;
    // What My Bookings holds for it: the confirmation number, and where and when.
    return { ref, booking: { confirmation: ref, date: days[n].date, time: to24(days[n].times[0]), office_name: 'Poway' } };
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

  assert.notEqual(state.bookings[0].apptId, state.bookings[0].ref, 'listed by an id of its own, as on the live site');
  assert.equal(await run(adaFirst.booking, ada), 'cancelled');
  assert.deepEqual(state.bookings.map((b) => b.ref).sort(), [adaSecond.ref, grace.ref].sort(), 'only that one');

  assert.equal(await run(grace.booking, ada), 'not-listed', "Grace's is not under Ada's name");
  assert.equal(state.bookings.length, 2);

  assert.equal(await run(adaSecond.booking, { ...ada, phone: '5555550199' }), 'none', 'nothing under another number');
  assert.equal(state.bookings.length, 2);
});
