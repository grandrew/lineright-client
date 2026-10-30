/**
 * Differences between this stand-in and the California DMV appointment site.
 *
 * Each test below is the behaviour the stand-in does not have yet. They are
 * marked `todo` so `npm test` stays green, and each one fails: the assertion
 * error is the discrepancy. When a test starts passing, drop its `todo`.
 *
 * Checked against the live site on 2026-10-13, read only: nothing submitted,
 * no personal data, nothing past the office list (the calendar is behind
 * reCAPTCHA).
 *
 *   The appointment document, fetched and rendered in a browser
 *     https://www.dmv.ca.gov/portal/appointments/select-appointment-type/
 *     and the same chrome on https://www.dmv.ca.gov/portal/appointments/
 *   The appointment app that document boots
 *     https://www.dmv.ca.gov/portal/wp-content/themes/dmv/dist/js/appointment-app.js
 *     (that day: ?ver=154e2d2b91942b9c6ed3)
 *
 * The bundle's routes, under basename `portal/appointments`, are
 * `/select-appointment-type`, `/select-location/:page` (with `/select-location`
 * redirected to `/select-location/A`), `/select-date`, `/select-info`,
 * `/appt-confirm`, `/appt-edit` and `/error`. Its analytics number the steps:
 * Select Location 2, Select Date 3, Select Time 4, Confirm Date and Time 5,
 * Customer Info 6, Appointment Preview 7, Appointment Scheduled 8. The flow
 * keeps its state in the page, not the address: /select-location,
 * /select-location/A and /select-info loaded cold all land on
 * /select-appointment-type. This server keeps office search on
 * select-appointment-type and the details form on /details.
 *
 * In the browser, ?option=VR passes through /select-location/undefined and
 * ends on /select-location/A, with #inputKeyWord and one Select Location per
 * office card; ?option=DT stays on the type page. The bare type page is headed
 * "Schedule Your Appointment" and has four Select controls, in this order:
 * KNOWLEDGE TEST RE-EVALUATION (in capitals), Automobile, Commercial,
 * Motorcycle. Each is `<label for=CODE><span>name</span><span class="btn
 * btn-secondary">Select</span></label>` on a hidden checkbox (AKTE, DT, CDL,
 * MC). Above them is a list of office-visit services, and no office search.
 *
 * Once the map has drawn, every office in the list also has a marker popup:
 * `div.dmv-marker-popup` with the office's name, its address, and
 * `a.dmv-marker-popup__link` "Select Location" (no href, aria-label "Select
 * the <name> Location"). That is the second hit `dmq/src/selectors.js`
 * (`officeCards`) scopes away. It does carry the address, whatever the
 * comment there says.
 *
 * Not asserted here. The success view is in the bundle but has not been seen
 * rendered: on /appt-confirm, the heading "Appointment Scheduled", "Thank you
 * for scheduling an appointment. See you soon!", and `p.appt-id-text` reading
 * "Confirmation #: <apptId>". The address carries no reference; dmq's
 * `parseConfirmation` reads that label from the page text. Service Advisor
 * ("Skip the Visit") is a third block on the landing page, left out as well.
 *
 * Get in Line is commented out for now, at the bottom of this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer, createState, slotsFor } from '../server.js';

const GAP = 'not implemented on the stand-in yet';

async function startSite(options = {}) {
  const state = createState({ officeCount: 0, ...options });
  const server = createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, url: res.url, body: await res.text() };
  };
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  return {
    state, base, get, post,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Assert against a whole document without dumping it into the failure. */
function has(html, re, message) {
  assert.ok(re.test(html), message);
}
function lacks(html, re, message) {
  assert.ok(!re.test(html), message);
}

// ------------------------------------------------------------------- the gaps
test('the bare type page is the scheduler front door, with four Select buttons', { todo: GAP }, async (t) => {
  // Live: headed "Schedule Your Appointment", four Select controls,
  // KNOWLEDGE TEST RE-EVALUATION first, then Automobile, Commercial and
  // Motorcycle, and no office search. dmq/test/live.test.js counts the same
  // four. askedService() in server.js defaults a missing option to VR, so this
  // server answers with the office search instead.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type');
  has(page.body, /Schedule Your Appointment/, 'the type page has no "Schedule Your Appointment" heading');
  for (const vehicle of ['Knowledge Test Re-Evaluation', 'Automobile', 'Commercial', 'Motorcycle']) {
    has(page.body, new RegExp(vehicle, 'i'), `the type page does not offer ${vehicle}`);
  }
  const selects = page.body.match(/class="btn[^"]*"[^>]*>\s*Select\s*</gi) || [];
  assert.equal(selects.length, 4, `expected 4 Select buttons, found ${selects.length}`);
  lacks(page.body, /id="inputKeyWord"/, 'a missing option is served as the office search');
});

test('an office-visit option ends on select-location/A', { todo: GAP }, async (t) => {
  // Live: ?option=VR ends on /select-location/A, with the search box and a
  // Select Location per office; ?option=DT stays on the type page.
  // dmq/test/live.test.js asserts the same for VR, CID, RID, IBC and DT. The
  // live page moves in the browser; a stand-in can redirect, which is what
  // fetch() sees. The search box and Select Location stay, because those are
  // what dmq/src/selectors.js drives. This server answers with the search at
  // select-appointment-type?option=VR and never moves.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type?option=VR');
  assert.match(new URL(page.url).pathname, /\/select-location\/A$/, page.url);
  has(page.body, /id="inputKeyWord"/, 'the location page lost #inputKeyWord');
  has(page.body, /Select Location/, 'the location page lost Select Location');

  const drive = await site.get('/portal/appointments/select-appointment-type?option=DT');
  assert.doesNotMatch(new URL(drive.url).pathname, /\/select-location(?:\/|$)/, drive.url);
});

test('a step loaded with no service chosen goes back to the type page', { todo: GAP }, async (t) => {
  // Live: the flow keeps its state in the page, so /select-location,
  // /select-location/A and /select-info loaded cold all land on
  // /select-appointment-type. The bundle's redirect from /select-location to
  // /select-location/A only applies once a service is chosen. This server has
  // none of these routes, so /portal/ falls through to the scenery stub.
  const site = await startSite();
  t.after(site.stop);
  for (const path of [
    '/portal/appointments/select-location',
    '/portal/appointments/select-location/A',
    '/portal/appointments/select-info',
  ]) {
    const page = await site.get(path);
    assert.match(new URL(page.url).pathname, /\/select-appointment-type\/?$/, `${path} ended on ${page.url}`);
    lacks(page.body, /this page is\s+scenery/i, `${path} is the scenery stub`);
  }
});

test('the details step lives at select-info', { todo: GAP }, async (t) => {
  // The bundle routes the details form ("Customer Info", step 6) at
  // /select-info, after /select-date. Not seen rendered: the calendar before
  // it is behind reCAPTCHA. The times page here sends the browser to
  // /portal/appointments/details?hold= (pages.js, timesPage), and server.js
  // serves the form from that path. The hold in the address is this server's
  // way of carrying the flow; the live page keeps it in memory.
  const site = await startSite();
  t.after(site.stop);
  const office = site.state.offices.find((o) => o.name === 'Poway');
  const day = slotsFor(site.state, office.code, 'VR')[0];
  assert.ok(day, 'Poway has a bookable day in this world');
  const held = JSON.parse((await site.post('/portal/appointments/book?stage=hold', {
    branch: office.code, service: 'VR', date: day.date, time: day.times[0],
  })).body);
  assert.equal(held.ok, true, 'the hold itself is not the gap');

  const times = await site.get(`/portal/appointments/times?branch=${
    encodeURIComponent(office.code)}&service=VR&date=${day.date}`);
  has(times.body, /select-info/, 'the times page never sends the browser to select-info');
  lacks(times.body, /\/portal\/appointments\/details/,
    'the times page still posts the details form to /details');

  const info = await site.get(`/portal/appointments/select-info?hold=${encodeURIComponent(held.hold)}`);
  has(info.body, /First Name/, 'select-info is not the details form');
  lacks(info.body, /this page is\s+scenery/i, 'select-info is the scenery stub');
});

test('office results carry the map marker\'s second Select Location', { todo: GAP }, async (t) => {
  // Live: once the map has drawn, each office in the list also has a
  // div.dmv-marker-popup with its name, its address and
  // a.dmv-marker-popup__link "Select Location" (no href, aria-label "Select
  // the <name> Location"). Four offices listed, eight Select Locations.
  // dmq/src/selectors.js officeCards() looks only inside
  // li.location-results__list-item for that reason. This server renders the
  // list only (pages.js locationPage).
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type?option=VR&q=Poway');
  has(page.body, /Poway/, 'the Poway search returned no Poway card');
  const total = (page.body.match(/Select Location/g) || []).length;
  const cards = page.body.split(/<li[^>]*location-results__list-item/i).slice(1);
  const inCards = cards.reduce((n, card) => {
    const item = card.split('</li>')[0];
    return n + (item.match(/Select Location/g) || []).length;
  }, 0);
  assert.ok(cards.length > 0, 'the search returned no office cards');
  const popups = (page.body.match(/class="dmv-marker-popup(?:\s[^"]*)?"/g) || []).length;
  assert.equal(popups, cards.length, `${popups} marker popup(s) for ${cards.length} office card(s)`);
  assert.equal(total, inCards * 2,
    `Select Location appears ${total} time(s), ${inCards} of them inside result cards; ` +
    'the live page has one more per office, on its marker');
  const named = page.body.match(/aria-label="Select the [^"]+ Location"/g) || [];
  assert.equal(named.length, cards.length, 'the marker links are not named after their office');
});

// --------------------------------------------- Get in Line, not for now
//
// Commented out on 2026-10-13. Get in Line is the DMV's same-day walk-in line
// (Qmatic), not an appointment; nothing in LineRight books one, and the live
// page had it switched off that day. What these tests say about the live site
// was checked then and holds:
//   - the root carries data-disable-get-in-line="1", data-is-business-hours="1"
//     and data-qmatic-url="https://mt-cadmvoas.us.qmatic.cloud/branches";
//   - the bundle draws the block only for !disableGetInLine && isBusinessHours
//     && qMaticUrl: "Get in Line at My Local DMV Office", "Ready to do your DMV
//     business in person right now?", a.btn.btn-primary.get-in-line-submit
//     "Get in Line" (target _blank, rel noreferrer, href = data-qmatic-url),
//     then "Schedule Your Appointment". The condition does not look at the
//     option, so it would show on a drive-test page too;
//   - the header menu links "Get in Line Now" to
//     https://mt-cadmvoas-secondary.us.qmatic.cloud/ and "Schedule Appointment"
//     to /portal/appointments/.
// /portal/get-in-line is a route made up here for a local line page; the live
// site has none. To bring these back, remove the comment markers.
/*
function rootAttrs(html) {
  const tag = html.match(/<div[^>]*id="appointments-react-root"[^>]*>/i);
  return tag ? tag[0] : '';
}

function attr(tag, name) {
  const found = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return found ? found[1] : null;
}

// Anchors whose visible text is exactly `label`, tag included.
function linksNamed(html, label) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.toLowerCase() === label.toLowerCase()) out.push(match[1]);
  }
  return out;
}

function sameOrigin(href, base) {
  try {
    return new URL(href, base).host === new URL(base).host;
  } catch {
    return false;
  }
}

test('get in line stays hidden while the appointment root disables it', async (t) => {
  // Live default: data-disable-get-in-line="1", and the bundle then does not
  // render get-in-line-submit. pages.js already stamps the flag.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type');
  const root = rootAttrs(page.body);
  assert.equal(attr(root, 'data-disable-get-in-line'), '1');
  assert.equal(page.body.includes('get-in-line-submit'), false);
});

test('the appointment root publishes business hours and a line url on this server', { todo: GAP }, async (t) => {
  // The live root always publishes data-is-business-hours and data-qmatic-url,
  // including when get-in-line is disabled. The url is what the Get in Line
  // link opens. Here it must be this server: the stand-in must not send a
  // browser to mt-cadmvoas.us.qmatic.cloud. pages.js currently sets
  // data-qmatic-url="http://127.0.0.1/qmatic-not-simulated" and has no
  // data-is-business-hours.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type');
  const root = rootAttrs(page.body);
  assert.ok(attr(root, 'data-is-business-hours'), 'data-is-business-hours is missing');
  const qmatic = attr(root, 'data-qmatic-url');
  assert.ok(qmatic, 'data-qmatic-url is missing');
  assert.equal(sameOrigin(qmatic, site.base), true, `${qmatic} is not on this stand-in`);
  assert.equal(/qmatic\.cloud|dmv\.ca\.gov/i.test(qmatic), false, qmatic);
});

test('get in line renders only when the live page would show it, and stays here', { todo: GAP }, async (t) => {
  // createState({ getInLine: true }) is the switch this stand-in does not
  // have yet (TESTSITE_GET_IN_LINE=1 would be the same). It has to clear
  // data-disable-get-in-line, set data-is-business-hours="1", and point
  // data-qmatic-url at this server's line page.
  const site = await startSite({ getInLine: true });
  t.after(site.stop);
  const page = await site.get('/portal/appointments/select-appointment-type');
  const root = rootAttrs(page.body);
  assert.notEqual(attr(root, 'data-disable-get-in-line'), '1');
  assert.equal(attr(root, 'data-is-business-hours'), '1');
  has(page.body, /Get in Line at My Local DMV Office/, 'the Get in Line heading is missing');
  has(page.body, /Ready to do your DMV business in person right now\?/,
    'the Get in Line description is missing');
  has(page.body, /Schedule Your Appointment/, '"Schedule Your Appointment" is missing below it');

  const [attrs] = linksNamed(page.body, 'Get in Line');
  assert.ok(attrs, 'no "Get in Line" link');
  assert.match(attrs, /get-in-line-submit/);
  assert.match(attrs, /target="_blank"/);
  const href = (attrs.match(/\bhref="([^"]*)"/i) || [])[1];
  assert.ok(href, 'the Get in Line link has no href');
  assert.equal(sameOrigin(href, site.base), true, `${href} leaves the stand-in`);
  assert.equal(/qmatic\.cloud|dmv\.ca\.gov/i.test(href), false, href);
});

test('the header offers Get in Line Now and Schedule Appointment, both on this server', { todo: GAP }, async (t) => {
  // The theme's header menu on the live appointment pages, not the React block:
  //   "Get in Line Now" → https://mt-cadmvoas-secondary.us.qmatic.cloud/
  //   "Schedule Appointment" → /portal/appointments/
  // pages.js header() has neither. A stand-in link must stay on this origin.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/appointments/');
  const line = linksNamed(page.body, 'Get in Line Now');
  const schedule = linksNamed(page.body, 'Schedule Appointment');
  assert.equal(line.length, 1, `expected one "Get in Line Now", found ${line.length}`);
  assert.equal(schedule.length, 1, `expected one "Schedule Appointment", found ${schedule.length}`);
  const lineHref = (line[0].match(/\bhref="([^"]*)"/i) || [])[1];
  const scheduleHref = (schedule[0].match(/\bhref="([^"]*)"/i) || [])[1];
  assert.equal(sameOrigin(lineHref, site.base), true, lineHref);
  assert.equal(/qmatic\.cloud|dmv\.ca\.gov/i.test(lineHref), false, lineHref);
  assert.match(scheduleHref, /^\/portal\/appointments\/?$/);
});

test('the line url is a same-day queue, not the appointment calendar', { todo: GAP }, async (t) => {
  // data-qmatic-url on the live page is the Qmatic branches app, a different
  // page from the scheduler: you join an office's line for today. This server
  // has no such page; /portal/get-in-line would be the local one, and today it
  // is the scenery stub.
  const site = await startSite();
  t.after(site.stop);
  const page = await site.get('/portal/get-in-line');
  assert.equal(page.status, 200);
  lacks(page.body, /this page is\s+scenery/i, '/portal/get-in-line is the scenery stub');
  has(page.body, /Get in Line/, 'the line page does not offer Get in Line');
  has(page.body, /Poway|Alturas/, 'the line page lists no office');
  lacks(page.body, /Loading dates/i, 'the line page is the appointment calendar');
  lacks(page.body, /id="inputKeyWord"/, 'the line page is the office search');
});
*/
