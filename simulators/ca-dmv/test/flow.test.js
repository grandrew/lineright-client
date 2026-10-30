/**
 * The stand-in's own behaviour, over HTTP and without a browser.
 *
 * robots.test.js drives the Playwright robots through it and is slow and opt-in;
 * this one is neither, so it can afford to pin the parts a bot never touches
 * but a person does — holding a slot, giving it up again, cancelling with a
 * confirmation number, signing in — and the parts a bot touches so hard that
 * getting them wrong is expensive.
 *
 * The one to read twice is "the times page prints no clock time that is not
 * bookable". The booking flow reads every h:mm AM on that page as a slot, so
 * an office-hours line there sends the bot clicking at 5:00 PM and losing the
 * appointment it had held. That is a one-line mistake to make in markup and
 * this is the only thing that would catch it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createServer, createState, slotsFor, releaseSlot, expireHolds, officeResults, mintToken,
} from '../server.js';
import { hoursOn, holidayName, doesDriveTests, iso, dayOffset } from '../world.js';
import { noRobots, robot } from './client.js';

// The robots' own service map (dmq/), for the one test that holds
// the stand-in's pages to it.
const { SERVICES: BOT_SERVICES, DRIVE_TEST } = noRobots ? {} : await robot('src/services.js');

async function startSite(options = {}) {
  const state = createState({ officeCount: 0, ...options });
  const server = createServer(state);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.text() };
  };
  const post = async (path, body, headers = {}) => {
    const res = await fetch(base + path, { method: 'POST', redirect: 'manual', headers, body });
    return { status: res.status, headers: res.headers, body: await res.text() };
  };
  const json = async (path, body) => JSON.parse((await post(path, JSON.stringify(body),
    { 'content-type': 'application/json' })).body);
  return { state, base, get, post, json, stop: () => new Promise((r) => server.close(r)) };
}

const poway = (state) => state.offices.find((o) => o.name === 'Poway');

/** The first day this office really has something, and what it has. */
function firstOpening(state, branch, service = 'VR') {
  const [day] = slotsFor(state, branch, service);
  return day;
}

// ------------------------------------------------------------------ search
test('an office search orders by distance, with what you asked for first', async (t) => {
  const site = await startSite();
  t.after(site.stop);

  const byZip = officeResults(site.state, '92064');
  assert.equal(byZip[0].name, 'Poway', 'the office at that ZIP leads');
  const miles = byZip.slice(1).map((o) => o.miles);
  assert.deepEqual(miles, [...miles].sort((a, b) => a - b), 'the rest are nearest-first');
  assert.ok(miles[0] < 40, `the nearest office to 92064 should be close, got ${miles[0]} miles`);

  const byName = officeResults(site.state, 'ALTURAS');
  assert.equal(byName[0].name, 'Alturas', 'a named office leads its own results');

  assert.deepEqual(officeResults(site.state, ''), [], 'an empty search asks for nothing');
});

// -------------------------------------------------------------- the world
test('an office offers nothing on a day it is shut, or on a state holiday', async (t) => {
  const site = await startSite({ busyDays: 1, horizonDays: 200 });
  t.after(site.stop);
  const alturas = site.state.offices.find((o) => o.name === 'Alturas');
  assert.deepEqual(Object.keys(alturas.hours).sort(), ['thu', 'tue'],
    'the catalogue says Alturas opens twice a week — the rest of this test rests on it');

  const days = slotsFor(site.state, alturas.code, 'VR').map((d) => d.date);
  assert.ok(days.length > 0, 'it does open sometimes');
  for (const day of days) {
    const weekday = new Date(`${day}T00:00:00`).getDay();
    assert.ok(weekday === 2 || weekday === 4, `${day} is not a Tuesday or a Thursday`);
    assert.equal(holidayName(day), null, `${day} is a holiday and the office is shut`);
    assert.ok(hoursOn(alturas, day), `${day} should be a day it opens`);
  }
});

test('an office that opens at nine has no eight o\'clock', async (t) => {
  const site = await startSite({ busyDays: 1, horizonDays: 200 });
  t.after(site.stop);
  // Wednesdays open an hour late almost everywhere in the catalogue.
  const office = site.state.offices.find((o) => (o.hours.wed || [])[0] === '09:00');
  assert.ok(office, 'the catalogue should have a late-opening Wednesday somewhere');
  for (const day of slotsFor(site.state, office.code, 'VR')) {
    if (new Date(`${day.date}T00:00:00`).getDay() !== 3) continue;
    assert.ok(!day.times.includes('8:00 AM'),
      `${day.date} is a Wednesday at ${office.name}, which opens at nine`);
  }
});

test('drive tests happen where drive tests happen, and stop earlier in the day', async (t) => {
  const site = await startSite({ busyDays: 1, horizonDays: 200 });
  t.after(site.stop);
  const without = site.state.offices.find((o) => !doesDriveTests(site.state, o));
  assert.ok(without, 'some offices do not run drive tests');
  assert.deepEqual(slotsFor(site.state, without.code, 'DT'), [],
    'and those offer no drive-test appointments at all');

  const with_ = site.state.offices.find((o) => doesDriveTests(site.state, o));
  const late = slotsFor(site.state, with_.code, 'DT').flatMap((d) => d.times);
  assert.ok(late.length, 'an office that does run them has some');
  assert.ok(!late.includes('3:00 PM'), 'the last drive test of the day is earlier than the counter');
});

test('a slot that cannot take three people is not offered to three people', async (t) => {
  const site = await startSite({ busyDays: 1, horizonDays: 200 });
  t.after(site.stop);
  const code = poway(site.state).code;
  const one = slotsFor(site.state, code, 'VR', Date.now(), 1).flatMap((d) => d.times);
  const three = slotsFor(site.state, code, 'VR', Date.now(), 3).flatMap((d) => d.times);
  assert.ok(one.length > three.length, `${one.length} slots for one, ${three.length} for three`);
});

// ------------------------------------------------------------ holding on
test('holding a slot takes it off the market, and letting go puts it back', async (t) => {
  const site = await startSite({ gate: 'off', holdTtlMs: 40 });
  t.after(site.stop);
  const office = poway(site.state);
  const day = firstOpening(site.state, office.code);
  const body = { branch: office.code, service: 'VR', date: day.date, time: day.times[0] };

  const held = await site.json('/portal/appointments/book?stage=hold', body);
  assert.ok(held.ok && held.hold, 'the first person gets the hold');

  const second = await site.json('/portal/appointments/book?stage=hold', body);
  assert.equal(second.ok, false, 'and the second is told it is gone — the race the cascade exists for');

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expireHolds(site.state), 1, 'an abandoned hold lapses');
  assert.equal(site.state.expiredHolds, 1);
  const again = await site.json('/portal/appointments/book?stage=hold', body);
  assert.ok(again.ok, 'and the slot is on sale again rather than lost for good');
});

test('a lapsed hold sends you back to the start rather than to a blank form', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const page = await site.get('/portal/appointments/details?hold=nothing-like-this');
  assert.equal(page.status, 200);
  assert.match(page.body, /hold has run out/i);
});

// ------------------------------------------------------- booking and after
async function bookOne(site, { first = 'Ada', last = 'Lovelace',
                               email = 'ada@example.invalid' } = {}) {
  const office = poway(site.state);
  const day = firstOpening(site.state, office.code);
  const held = await site.json('/portal/appointments/book?stage=hold',
    { branch: office.code, service: 'VR', date: day.date, time: day.times[0] });
  const done = await site.json('/portal/appointments/book?stage=commit',
    { hold: held.hold, first, last, email, phone: '5555550123' });
  return { ...done, office, date: day.date, time: day.times[0] };
}

test('a booking gets a confirmation page, a calendar file, and its own slot', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const booked = await bookOne(site);
  assert.match(booked.ref, /^TS-[0-9A-F]{8}$/);

  const page = await site.get(`/portal/appointments/confirmation?ref=${booked.ref}`);
  assert.match(page.body, new RegExp(booked.ref));
  assert.match(page.body, /Your appointment is confirmed/i);
  assert.match(page.body, /What to bring/i);

  const ics = await site.get(`/portal/appointments/appointment.ics?ref=${booked.ref}`);
  assert.match(ics.body, /BEGIN:VCALENDAR/);
  assert.match(ics.body, new RegExp(`DTSTART:${booked.date.replace(/-/g, '')}T\\d{6}`));

  const left = slotsFor(site.state, booked.office.code, 'VR').find((d) => d.date === booked.date);
  assert.ok(!left || !left.times.includes(booked.time), 'a booked slot is off the calendar');
});

test('a site that changed says other words where the robots look, and a person still gets through', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const office = poway(site.state);
  const day = firstOpening(site.state, office.code);
  const times = `/portal/appointments/times?branch=${encodeURIComponent(office.code)}&service=VR&date=${day.date}`;
  assert.match((await site.get(times)).body, />Confirm</);
  const held = await site.json('/portal/appointments/book?stage=hold',
    { branch: office.code, service: 'VR', date: day.date, time: day.times[0] });
  const details = `/portal/appointments/details?hold=${held.hold}`;
  assert.match((await site.get(details)).body, /First Name/);

  await site.json('/__admin/config', { drift: 'labels,offices,confirmation' });
  assert.equal(site.state.drift, 'labels,offices,confirmation');
  const changed = (await site.get(details)).body;
  for (const gone of ['First Name', 'Last Name', 'Email Address', 'Phone Number', '>Continue<', 'Schedule appointment']) {
    assert.ok(!changed.includes(gone), `"${gone}" is said another way now`);
  }
  for (const now of ['Given name', 'Family name', 'Mobile number', 'Review my details', 'Book this appointment']) {
    assert.ok(changed.includes(now), now);
  }
  assert.match((await site.get(times)).body, />Hold this time</);
  assert.match(changed, /confirmation\?number=/, 'the number travels as ?number= now');
  const search = await site.get('/portal/appointments/select-appointment-type?option=VR&q=Poway');
  assert.match(search.body, /Choose this office/);
  assert.ok(!search.body.includes('Select Location'));

  const done = await site.json('/portal/appointments/book?stage=commit',
    { hold: held.hold, first: 'Ada', last: 'Lovelace', email: 'ada@example.invalid', phone: '5555550123' });
  const page = await site.get(`/portal/appointments/confirmation?number=${done.ref}`);
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(done.ref));
  assert.match(page.body, /Booking reference/);
  assert.ok(!new RegExp(`confirmation\\s*(?:number|no|code|#)[^<]{0,40}${done.ref}`, 'i').test(page.body),
    'no "confirmation number" beside it for the robot to find');

  await site.json('/__admin/config', { drift: '' });
  assert.match((await site.get(times)).body, />Confirm</, 'and back as it was');
});

test('cancelling needs the name it was booked under, and gives the slot back', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const booked = await bookOne(site);
  const urlencoded = { 'content-type': 'application/x-www-form-urlencoded' };

  const wrong = await site.post('/portal/appointments/cancel',
    `ref=${booked.ref}&last=Somebody`, urlencoded);
  assert.match(wrong.body, /could not find an appointment/i);
  assert.equal(site.state.bookings.length, 1, 'and nothing was cancelled');

  const found = await site.post('/portal/appointments/cancel',
    `ref=${booked.ref}&last=lovelace`, urlencoded);
  assert.match(found.body, /Cancel appointment/, 'the right name finds it, case and all');

  const done = await site.post('/portal/appointments/cancel',
    `ref=${booked.ref}&last=Lovelace&action=cancel`, urlencoded);
  assert.match(done.body, /cancelled/i);
  assert.equal(site.state.bookings.length, 0);

  const back = slotsFor(site.state, booked.office.code, 'VR').find((d) => d.date === booked.date);
  assert.ok(back && back.times.includes(booked.time),
    'the slot goes straight back on the calendar, which is where near dates come from');
});

test('View/Cancel Appointment lists them by name and phone, each by an id of its own, and cancels one, as the live site does', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const booked = await bookOne(site);
  const other = await bookOne(site, { first: 'Grace', last: 'Hopper', email: 'grace@example.invalid' });
  const API = '/portal/wp-json/dmv/v1/appointment';

  // The page the desktop app's cancel guide walks: the live site's ids and words.
  const page = await site.get('/portal/appointments/appt-edit');
  for (const marker of ['id="appointment-info-form"', 'id="first-name"', 'id="last-name"',
    'id="phone-number"', 'View Appointment', 'id="delete-confirmation"', 'Keep Appointment',
    'Your appointment has been canceled.', 'You currently have no appointments available.',
    'btn--appt-cancel', 'appointment-current__list-item', 'data-appt-id']) {
    assert.ok(page.body.includes(marker), `the page has ${marker}`);
  }
  const confirmation = await site.get(`/portal/appointments/confirmation?ref=${booked.ref}`);
  assert.match(confirmation.body, /href="\/portal\/appointments\/appt-edit">View\/Cancel Appointment/);

  const mine = await site.json(`${API}/my-appointments`,
    { firstName: 'ada', lastName: 'LOVELACE', telNumber: '555-555-0123', token: '' });
  assert.equal(mine.appt.length, 1, 'only hers, whatever the case');
  const hers = site.state.bookings.find((b) => b.ref === booked.ref);
  assert.equal(mine.appt[0].apptId, hers.apptId);
  assert.match(mine.appt[0].apptId, /^[0-9a-f]{64}$/, "the live site's own id, as it sends it");
  assert.notEqual(mine.appt[0].apptId, booked.ref, 'not the confirmation number');
  const [y, m, d] = booked.date.split('-');
  assert.equal(mine.appt[0].date, `${m}${d}${y.slice(2)}`, 'MMDDYY, as the live site sends it');
  assert.match(mine.appt[0].time, /^\d{4}$/, 'HHmm');
  assert.deepEqual([mine.appt[0].office.officeName, mine.appt[0].office.officeTitle], ['POWAY', 'Poway']);
  assert.deepEqual((await site.json(`${API}/my-appointments`,
    { firstName: 'Ada', lastName: 'Lovelace', telNumber: '5555550199' })).appt, [],
  'another phone number lists nothing');

  const theirs = site.state.bookings.find((b) => b.ref === other.ref).apptId;
  const wrong = await site.json(`${API}/cancel-appointment`,
    { apptId: theirs, firstName: 'Ada', lastName: 'Lovelace', telNumber: '5555550123' });
  assert.equal(wrong.code, 'dt_not_found', "somebody else's number does not cancel theirs");
  assert.equal(site.state.bookings.length, 2);

  assert.equal((await site.json(`${API}/cancel-appointment`,
    { apptId: booked.ref, firstName: 'Ada', lastName: 'Lovelace', telNumber: '5555550123' })).code, 'dt_not_found',
  'the confirmation number is not what it is cancelled by');
  const done = await site.json(`${API}/cancel-appointment`,
    { apptId: hers.apptId, firstName: 'Ada', lastName: 'Lovelace', telNumber: '5555550123' });
  assert.equal(done.statusCode, 'APPT_CANCELED');
  assert.deepEqual(site.state.bookings.map((b) => b.ref), [other.ref]);
  const back = slotsFor(site.state, booked.office.code, 'VR').find((day) => day.date === booked.date);
  assert.ok(back && back.times.includes(booked.time), 'the slot goes back on the calendar');
});

test('rescheduling holds the new appointment before letting the old one go', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const first = await bookOne(site);
  const office = poway(site.state);
  const day = slotsFor(site.state, office.code, 'VR')
    .find((d) => d.times.length && `${d.date}|${d.times[0]}` !== `${first.date}|${first.time}`);

  const held = await site.json('/portal/appointments/book?stage=hold',
    { branch: office.code, service: 'VR', date: day.date, time: day.times[0],
      reschedule: first.ref });
  assert.equal(site.state.bookings.length, 1,
    'the old appointment is still yours while the new one is only held');

  const moved = await site.json('/portal/appointments/book?stage=commit',
    { hold: held.hold, first: 'Ada', last: 'Lovelace', email: 'ada@example.invalid',
      phone: '5555550123' });
  assert.ok(moved.ok);
  assert.equal(site.state.bookings.length, 1, 'and afterwards there is one, not two');
  assert.equal(site.state.bookings[0].ref, moved.ref);
  const freed = slotsFor(site.state, office.code, 'VR').find((d) => d.date === first.date);
  assert.ok(freed && freed.times.includes(first.time), 'the appointment given up is on offer again');
});

// --------------------------------------------------------------- the pages
test('the times page prints no clock time that is not bookable', async (t) => {
  // The booking flow reads every "h:mm AM" in the body as a slot to try. An
  // office-hours line on this page would have it clicking 5:00 PM.
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const office = poway(site.state);
  const day = firstOpening(site.state, office.code);

  const page = await site.get(`/portal/appointments/times?branch=${
    encodeURIComponent(office.code)}&service=VR&date=${day.date}`);
  const text = page.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const printed = [...new Set((text.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/gi) || [])
    .map((s) => s.replace(/\s+/g, ' ').trim()))];
  assert.ok(printed.length, 'the page does show its times');
  for (const time of printed) {
    assert.ok(day.times.includes(time), `${time} is printed but is not a slot you can book`);
  }
});

test('the calendar is never rendered by the server, so a gated read stays gated', async (t) => {
  // The month heading arrives with the dates or not at all. Server-rendering it
  // would turn "we were not allowed to look" into "there is nothing here",
  // which is the difference between parking a job and dropping it.
  const site = await startSite({ gate: 'strict' });
  t.after(site.stop);
  const office = poway(site.state);
  const page = await site.get(`/portal/appointments/select-date?branch=${
    encodeURIComponent(office.code)}&service=VR`);
  const markup = page.body.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  assert.match(markup, /Loading dates\.\.\./);
  assert.ok(!/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/
    .test(markup), 'no month heading before the dates are paid for');
  assert.ok(!/Open Times/.test(markup), 'and no days either');
});

test('every page says it is a stand-in', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const office = poway(site.state);
  for (const path of ['/portal/', '/portal/appointments/', '/portal/locations',
                      `/portal/appointments/select-appointment-type?option=VR&q=${office.zip}`,
                      `/portal/appointments/select-date?branch=${encodeURIComponent(office.code)}&service=VR`,
                      '/portal/mydmv']) {
    const page = await site.get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.body, /Local stand-in/, `${path} must say what it is`);
    assert.match(page.body, /not\s+the California DMV/i, `${path} must say what it is not`);
  }
});

test('the gate markers are on the pages the bot reads them from', async (t) => {
  const site = await startSite({ gate: 'strict' });
  t.after(site.stop);
  const office = poway(site.state);
  const page = await site.get(`/portal/appointments/select-date?branch=${
    encodeURIComponent(office.code)}&service=VR`);
  assert.match(page.body, /id="appointments-react-root"/);
  assert.match(page.body, /data-recaptcha-version="2"/);
  assert.match(page.body, /recaptcha\/api2\/anchor\?size=invisible/);
  assert.match(page.body, /I'm not a robot/);
});

test('the vehicle page has a card for every drive test the bot books, and it leads there', { skip: noRobots }, async (t) => {
  // The bot picks a drive test by the heading of its card (vehicleType in
  // src/services.js), whatever ?option= it arrived with. A card it cannot find
  // fails that line at every office; one that leads to the wrong code books
  // the wrong test.
  const site = await startSite();
  t.after(site.stop);
  const driveTests = Object.values(BOT_SERVICES).filter((s) => s.family === DRIVE_TEST);
  const want = Object.fromEntries(driveTests.map((s) => [s.vehicleType, s.code]));
  for (const { code } of driveTests) {
    const page = await site.get(`/portal/appointments/select-appointment-type?option=${code}`);
    const cards = Object.fromEntries(page.body.split('class="appointment-reason').slice(1)
      .map((card) => [card.match(/<h3>([^<]*)<\/h3>/)?.[1],
                      card.match(/option=(\w+)&amp;step=credentials/)?.[1]]));
    assert.deepEqual(cards, want, `the page ?option=${code} lands on`);
  }
});

// ------------------------------------------------------------------ MyDMV
test('MyDMV signs you in, fills your details in, and lists what you booked', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const urlencoded = { 'content-type': 'application/x-www-form-urlencoded' };

  const bad = await site.post('/portal/mydmv/signin',
    'email=applicant@example.invalid&password=not-it', urlencoded);
  assert.match(bad.body, /do not match an account/i);

  const ok = await site.post('/portal/mydmv/signin',
    'email=applicant@example.invalid&password=dmv-stand-in', urlencoded);
  assert.equal(ok.status, 302);
  const cookie = String(ok.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mydmv=/);

  const booked = await bookOne(site, { email: 'applicant@example.invalid' });
  const account = await (await fetch(`${site.base}/portal/mydmv`, { headers: { cookie } })).text();
  assert.match(account, /Hi, Jordan/);
  assert.match(account, new RegExp(booked.ref), 'your own appointments are listed');

  const held = await site.json('/portal/appointments/book?stage=hold', {
    branch: poway(site.state).code, service: 'VR',
    ...(() => { const d = firstOpening(site.state, poway(site.state).code); 
                return { date: d.date, time: d.times[0] }; })(),
  });
  const details = await (await fetch(
    `${site.base}/portal/appointments/details?hold=${held.hold}`, { headers: { cookie } })).text();
  assert.match(details, /value="Jordan"/, 'a signed-in person does not retype their own name');
  assert.match(details, /value="applicant@example.invalid"/);
});

// -------------------------------------------------------------------- API
test('the JSON API answers the customer count it was asked about', async (t) => {
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  const office = poway(site.state);
  const dates = async (n) => {
    const token = mintToken(site.state, office.code);
    const res = await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches/${
      encodeURIComponent(office.code)}/dates?services[]=VR&numberOfCustomers=${n}&token=${token}`);
    return (await res.json()).dates;
  };
  const one = (await dates(1)).flatMap((d) => d.times).length;
  const three = (await dates(3)).flatMap((d) => d.times).length;
  assert.ok(one > three, `a party of three has fewer options: ${one} vs ${three}`);
});

test('a slot somebody gave up shows on the calendar until it lapses', async (t) => {
  const site = await startSite({ gate: 'off', cancelTtlMs: 40 });
  t.after(site.stop);
  const office = poway(site.state);
  const soon = iso(dayOffset(Date.now(), 3));
  const rec = releaseSlot(site.state, { branch: office.code, service: 'VR',
                                        date: soon, time: '9:00 AM' });
  assert.ok(rec, 'the cancellation opened');
  const now = slotsFor(site.state, office.code, 'VR').find((d) => d.date === soon);
  assert.ok(now && now.times.includes('9:00 AM'), 'a near date the backlog never had');
  const later = slotsFor(site.state, office.code, 'VR', Date.now() + 60)
    .find((d) => d.date === soon);
  assert.ok(!later, 'and gone again once somebody else took it');
});

test('a branch this site does not have is a 404, not invented availability', async (t) => {
  // It used to generate a plausible backlog for any string at all, which is a
  // fixture quietly answering a question the real site would refuse — and it
  // hid a caller passing the wrong thing as a branch id.
  const site = await startSite({ gate: 'off' });
  t.after(site.stop);
  assert.deepEqual(slotsFor(site.state, 'not-an-office', 'VR'), []);

  const res = await fetch(`${site.base}/portal/wp-json/dmv/v1/appointment/branches/` +
    `not-an-office/dates?services[]=VR`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'rest_no_route');

  for (const path of ['/portal/appointments/select-date?branch=not-an-office&service=VR',
                      '/portal/appointments/times?branch=not-an-office&service=VR&date=2026-11-23',
                      '/portal/appointments/details?hold=nope-not-a-hold']) {
    const page = await site.get(path);
    assert.ok(page.status === 404 || /hold has run out/i.test(page.body),
      `${path} answered ${page.status}`);
  }
});
