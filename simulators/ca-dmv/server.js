#!/usr/bin/env node
/**
 * A stand-in for the California DMV appointment site.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every interesting behaviour in LineRight Regbot — the reCAPTCHA gate, a job parking
 * for a human, a slot cascading to the next bidder, an idempotent replay — can
 * only be exercised end to end against a site that behaves like DMV's. Testing
 * that against dmv.ca.gov means consuming real public appointments, which is
 * the thing this project is trying not to do. So: a local one, faithful where
 * it matters and honest about where it is not.
 *
 * It has two audiences, and both are real:
 *   * the Playwright robots (this repository's dmq/), which drive it with the
 *     same selectors they use against the real site — see pages.js for the
 *     load-bearing list; and
 *   * a person, because regbot hands an applicant a link and asks them to
 *     finish the booking themselves. The desktop app opens that link in a
 *     browser tab, so the site has to be legible, not just automatable.
 *
 * WHAT IS FAITHFUL
 *   * The URL shapes and the JSON endpoints, including which are gated:
 *     /branches and /services/ answer anyone; /branches/<id>/dates answers
 *     `400 {"params":["token"]}` without a token, exactly as the real one does.
 *   * Token semantics: single-use, TTL-bounded, and bound to the branch they
 *     were minted for. This is what makes the cost/latency argument testable
 *     rather than theoretical — nothing can be pre-warmed or shared.
 *   * The whole flow a person walks: appointment type, office search by city or
 *     ZIP with distances, a month calendar, times, a ten-minute hold, details,
 *     review, a confirmation number, and cancelling or rescheduling with it.
 *   * Offices keep the hours the catalogue says they keep, close on state
 *     holidays, and only some of them run drive tests. See world.js.
 *   * Slots are finite and have capacity. Two bidders racing for one slot
 *     produce one winner and one "no longer available", which is the case the
 *     cascade exists for.
 *   * The calendar is BUSY. Nothing inside `busyDays` exists at all; a near
 *     date appears only when somebody cancels, and a cancellation nobody claims
 *     inside `cancelTtlMs` is gone again.
 *
 * WHAT IS NOT
 *   * The check is not reCAPTCHA. It is a shim with the same *shape* and the
 *     same refusal behaviour. It cannot tell you whether a real solver would
 *     work, and it is not meant to.
 *   * No Qmatic, no rate limiting or IP reputation, no email or SMS, and
 *     MyDMV is a toy: accounts live in memory and are forgotten on restart.
 *   * Every page says it is a stand-in, in the strip and in the footer. That
 *     is deliberate: a page that could be mistaken for dmv.ca.gov would be a
 *     worse fixture, not a better one.
 *
 * RUN
 *   node server.js                          # :8787, gate strict (like live)
 *   TESTSITE_GATE=open node server.js       # auto-issues tokens: happy path
 *   TESTSITE_GATE=off  node server.js       # no gate at all
 *
 * Point the robots at it with DMV_BASE_URL=http://127.0.0.1:8787.
 */
import http from 'http';
import crypto from 'crypto';

import { CSS, SEAL } from './theme.js';
import {
  SERVICES, TIMES, createState, slotsFor, releaseSlot, releaseCancellations, reclaimStale,
  expireHolds, startWorld, holidayName, hoursOn, doesDriveTests, note, key, iso, dayOffset,
  hoursSummary, worldNow, DEMO_ACCOUNT,
} from './world.js';
import {
  shell, homePage, stubPage, appointmentsPage, vehiclePage, credentialsPage,
  locationPage, locationsPage, officePage, datePage, timesPage, detailsPage,
  confirmationPage, cancelPage, apptEditPage, signinPage, accountPage,
} from './pages.js';

// A sitekey that looks like the real one but is obviously not it.
export const SITEKEY = '6LcTESTSITE0000000000000000000000000000';

export {
  createState, slotsFor, releaseSlot, releaseCancellations, reclaimStale, expireHolds,
  startWorld, worldNow, SERVICES, TIMES,
};

// ---------------------------------------------------------------- tokens
export function mintToken(state, branch) {
  const token = '03A' + crypto.randomBytes(48).toString('base64url');
  state.tokens.set(token, { branch, expires: worldNow(state) + state.tokenTtlMs, used: false });
  state.solves++;
  note(state, 'TOKEN_MINTED', `branch=${branch} solves=${state.solves}`);
  return token;
}

/**
 * Spend a token, or say why it cannot be spent.
 *
 * Single-use and branch-bound on purpose: those two properties are what stop a
 * solve being amortised across a sweep, and they are the whole reason a
 * solve-per-office loop cannot keep its cadence.
 */
export function redeemToken(state, token, branch) {
  if (state.gate === 'off') return { ok: true };
  const rec = state.tokens.get(token);
  if (!rec) return { ok: false, why: 'unknown token' };
  if (rec.used) return { ok: false, why: 'token already used' };
  if (worldNow(state) > rec.expires) return { ok: false, why: 'token expired' };
  if (rec.branch && branch && rec.branch !== branch) return { ok: false, why: 'token minted for another branch' };
  rec.used = true;
  return { ok: true };
}

// --------------------------------------------------------------- plumbing
function send(res, code, type, body, headers = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
const html = (res, body, headers) => send(res, 200, 'text/html; charset=utf-8', body, headers);
const redirect = (res, to, headers = {}) => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers });
  res.end();
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const form = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';')
    .map((c) => c.trim()).filter(Boolean)
    .map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}

const sessionOf = (state, req) => state.sessions.get(cookies(req).mydmv) || null;

const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Miles between two offices, rounded the way a website quotes them. */
function milesBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
}

/**
 * Office results for a search term, nearest first.
 *
 * The real site orders by distance from what you typed, which is why "the first
 * card is the nearest" is a rule the bot can rely on for a ZIP search. Doing
 * that here needs an origin: the office at that exact ZIP, failing that the
 * middle of the offices sharing its first three digits, failing that a city or
 * office name. With no origin at all it falls back to catalogue order, and says
 * nothing about distance rather than inventing one.
 */
export function officeResults(state, term, limit = 10) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return [];
  const named = state.offices.filter((o) =>
    o.name.toLowerCase().includes(t) || o.branch.toLowerCase().includes(t) ||
    o.city.toLowerCase().includes(t) || o.zip === t);

  let origin = null;
  if (/^\d{5}$/.test(t)) {
    const exact = state.offices.find((o) => o.zip === t);
    const near = state.offices.filter((o) => o.zip.slice(0, 3) === t.slice(0, 3));
    if (exact) origin = exact;
    else if (near.length) {
      origin = { lat: near.reduce((s, o) => s + o.lat, 0) / near.length,
                 lng: near.reduce((s, o) => s + o.lng, 0) / near.length };
    }
  } else if (named.length) {
    origin = named[0];
  }

  const rest = state.offices.filter((o) => !named.includes(o));
  const withMiles = (list) => list.map((o) => ({
    ...o, miles: origin ? milesBetween(origin, o) : null,
    driveTests: doesDriveTests(state, o),
  }));
  const sorted = origin
    ? withMiles(rest).sort((a, b) => a.miles - b.miles)
    : withMiles(rest);
  // A named match is what the person asked for, so it leads; everything else
  // follows by distance, which is how a ZIP search reads.
  return [...withMiles(named), ...sorted].slice(0, limit);
}

/** Holidays the calendar needs to grey out, for the year either side of today. */
function holidayWindow(now) {
  const out = {};
  for (let i = 0; i <= 400; i += 1) {
    const day = iso(dayOffset(now, i));
    const name = holidayName(day);
    if (name) out[day] = name;
  }
  return out;
}

const askedService = (url) =>
  (url.searchParams.get('service') || url.searchParams.get('option') || 'VR').toUpperCase();
const askedCustomers = (url) =>
  Math.min(4, Math.max(1, Number(url.searchParams.get('customers') || 1) || 1));

// ---------------------------------------------------------------- routes
export function createServer(state = createState()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const session = sessionOf(state, req);
    try {
      // assets and the shims
      if (p === '/portal/assets/dmv.css') {
        return send(res, 200, 'text/css; charset=utf-8', CSS, { 'cache-control': 'max-age=300' });
      }
      if (p === '/portal/assets/seal.svg') {
        return send(res, 200, 'image/svg+xml', SEAL.replace('class="brand__seal" ', ''),
                    { 'cache-control': 'max-age=300' });
      }
      if (p === '/recaptcha/api2/anchor') return send(res, 200, 'text/html', '<html><body>check</body></html>');
      if (p.startsWith('/__admin')) return admin(state, req, res, url);
      if (p === '/__captcha/solve') return solve(state, req, res);
      if (p.startsWith('/portal/wp-json/dmv/v1/appointment')) return api(state, req, res, url);

      // the appointment flow
      if (p === '/portal/appointments') return html(res, appointmentsPage(state, session));
      if (p === '/portal/appointments/select-appointment-type') return typePage(state, res, url, session);
      if (p === '/portal/appointments/select-date') return datePageFor(state, res, url, session);
      if (p === '/portal/appointments/times') return timesPageFor(state, res, url, session);
      if (p === '/portal/appointments/details') return detailsPageFor(state, res, url, session);
      if (p === '/portal/appointments/book') return book(state, req, res, url, session);
      if (p === '/portal/appointments/confirmation') return confirmation(state, res, url, session);
      if (p === '/portal/appointments/cancel') return cancel(state, req, res, url, session);
      if (p === '/portal/appointments/appt-edit' || p === '/portal/appointments/appt-edit/') {
        return html(res, apptEditPage(state, session));
      }
      if (p === '/portal/appointments/appointment.ics') return ics(state, res, url);

      // MyDMV
      if (p === '/portal/mydmv') return mydmv(state, res, session);
      if (p === '/portal/mydmv/signin') return signin(state, req, res);
      if (p === '/portal/mydmv/register') return register(state, req, res);
      if (p === '/portal/mydmv/signout') {
        state.sessions.delete(cookies(req).mydmv);
        return redirect(res, '/portal/', { 'set-cookie': 'mydmv=; Path=/; Max-Age=0' });
      }

      // the rest of the website
      if (p === '/portal/locations') return html(res, locationsPage(state, session, state.offices));
      if (p.startsWith('/portal/field-office/')) {
        const office = state.offices.find((o) => o.slug === p.split('/').pop());
        if (!office) return send(res, 404, 'text/plain', 'unknown office');
        const services = Object.values(SERVICES)
          .filter((s) => s.family !== 'DRIVE_TEST' || doesDriveTests(state, office))
          .map((s) => s.label);
        return html(res, officePage(state, session, office, services));
      }
      if (p === '/portal' || p === '/') return html(res, homePage(state, session));
      if (p.startsWith('/portal/')) {
        const title = p.split('/').pop().replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
        return html(res, stubPage(state, session, title || 'DMV'));
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain', String((err && err.stack) || err));
    }
  });
}

function solve(state, req, res) {
  return readBody(req).then(async (raw) => {
    let branch = '';
    try { branch = JSON.parse(raw || '{}').branch || ''; } catch { /* ignore */ }
    // Latency first: a solve that fails still took the time.
    if (state.solveDelayMs > 0) await wait(state.solveDelayMs);
    if (state.solveFailureRate > 0 && Math.random() < state.solveFailureRate) {
      state.solveFailures++;
      note(state, 'SOLVE_FAILED', `branch=${branch} failures=${state.solveFailures}`);
      return json(res, 503, { error: 'solver could not return a token' });
    }
    json(res, 200, { token: mintToken(state, branch) });
  });
}

// ------------------------------------------------------------ JSON API
async function api(state, req, res, url) {
  const p = url.pathname.replace('/portal/wp-json/dmv/v1/appointment', '').replace(/\/+$/, '');
  // A government portal is not a local fixture: it is a REST route over a
  // database and it answers in tenths of a second, not microseconds.
  await wait(state.apiDelayMs);

  if (p === '/branches' || p === '') {
    return json(res, 200, state.offices.map((o) => ({
      addressZip: o.zip, name: o.branch, addressLine1: o.street, publicId: o.code,
    })));
  }
  if (p === '/services') {
    return json(res, 200, Object.keys(SERVICES).map((code) => ({
      publicEnabled: true, name: code, active: true, publicId: `${code}!testsite`,
    })));
  }
  if (p === '/field-offices') return json(res, 200, state.offices);

  const dates = p.match(/^\/branches\/([^/]+)\/dates$/);
  if (dates) {
    const branch = decodeURIComponent(dates[1]);
    const token = url.searchParams.get('token');
    const service = (url.searchParams.get('services[]') || url.searchParams.get('services') || 'VR').toUpperCase();
    const customers = Math.max(1, Number(url.searchParams.get('numberOfCustomers') || 1) || 1);

    // The gate, in the one place that matters. Same body as the real 400.
    if (state.gate !== 'off' && !token) {
      note(state, 'DATES_REFUSED', `${branch} ${service}: no token`);
      return json(res, 400, {
        code: 'rest_missing_callback_param',
        message: 'Missing parameter(s): token',
        data: { status: 400, params: ['token'] },
      });
    }
    const spend = redeemToken(state, token, branch);
    if (!spend.ok) {
      note(state, 'DATES_REFUSED', `${branch} ${service}: ${spend.why}`);
      return json(res, 400, {
        code: 'rest_invalid_param', message: `Invalid token: ${spend.why}`,
        data: { status: 400, params: ['token'] },
      });
    }
    if (!state.offices.some((o) => o.code === branch)) {
      // The token is spent either way — the gate answers before the lookup
      // does, which is the order that makes a sweep over unknown offices cost
      // real money for nothing.
      note(state, 'DATES_REFUSED', `${branch} ${service}: no such branch`);
      return json(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL' });
    }
    note(state, 'DATES_SERVED', `${branch} ${service}`);
    return json(res, 200, { dates: slotsFor(state, branch, service, worldNow(state), customers) });
  }
  // "View/Cancel Appointment" (/portal/appointments/appt-edit): the live site's
  // two calls, with its shapes. A person's appointments are the ones booked
  // under their first and last name and phone number; each is cancelled by its
  // `apptId` — the live site's own id, which is not the confirmation number. Ungated here: the live site wants a
  // reCAPTCHA token for both, which its page gets as it is used.
  if (p === '/my-appointments' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const mine = state.bookings.filter((b) => sameApplicant(b, body));
    note(state, 'APPOINTMENTS_LISTED', `${mine.length} for ${String(body.lastName || '').trim()}`);
    return json(res, 200, { appt: mine.map((b) => {
      const office = state.offices.find((o) => o.code === b.branch);
      const [y, m, d] = b.date.split('-');
      return { apptId: b.apptId, task: b.service, date: `${m}${d}${y.slice(2)}`,
               time: to24(b.time).replace(':', ''),
               office: { officeId: b.branch, officeName: (office ? office.name : b.branch).toUpperCase(),
                         officeTitle: office ? office.name : b.branch } };
    }) });
  }
  if (p === '/cancel-appointment' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const booking = state.bookings.find((b) => b.apptId === String(body.apptId || '')
      && sameApplicant(b, body));
    if (!booking) {
      return json(res, 200, { code: 'dt_not_found',
        message: 'We couldn&#039;t find that appointment.' });
    }
    dropBooking(state, booking.ref);
    return json(res, 200, { statusCode: 'APPT_CANCELED' });
  }
  return json(res, 404, { code: 'rest_no_route' });
}

/** Whether a booking was made under this first and last name and phone number. */
function sameApplicant(booking, body) {
  const a = booking.applicant || {};
  const same = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
  const digits = (x) => String(x || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return same(a.first, body.firstName) && same(a.last, body.lastName)
    && digits(a.phone) !== '' && digits(a.phone) === digits(body.telNumber);
}

/** "9:40 AM" (how a stand-in booking keeps its time) as "09:40". */
function to24(label) {
  const m = String(label || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
  if (!m) return String(label || '');
  let h = Number(m[1]);
  if (/pm/i.test(m[3] || '') && h < 12) h += 12;
  if (/am/i.test(m[3] || '') && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// ------------------------------------------------------------ HTML flow
function typePage(state, res, url, session) {
  const code = askedService(url);
  const service = SERVICES[code];
  if (!service) return send(res, 404, 'text/plain', `unknown option ${code}`);
  const customers = askedCustomers(url);

  // Drive tests: the vehicle card, then licence + DOB, before any calendar.
  if (service.family === 'DRIVE_TEST' && url.searchParams.get('step') !== 'location') {
    if (url.searchParams.get('step') === 'credentials') {
      return html(res, credentialsPage(state, session, code));
    }
    return html(res, vehiclePage(state, session));
  }
  // A drive test that reached the location step came through the licence form;
  // an empty one means somebody skipped it, which the real site does not allow.
  if (service.family === 'DRIVE_TEST' && url.searchParams.has('dl')
      && !String(url.searchParams.get('dl') || '').trim()) {
    return html(res, credentialsPage(state, session, code,
      'Enter your driver\'s license or permit number to continue.'));
  }

  const term = url.searchParams.get('q') || '';
  const searched = url.searchParams.has('q');
  const cards = searched ? officeResults(state, term) : [];
  return html(res, locationPage(state, session, { code, term, searched, cards, customers }));
}

function datePageFor(state, res, url, session) {
  const branch = url.searchParams.get('branch') || '';
  const code = askedService(url);
  const office = state.offices.find((o) => o.code === branch);
  if (!office || !SERVICES[code]) return send(res, 404, 'text/plain', 'unknown branch');
  return html(res, datePage(state, session, {
    office, code, customers: askedCustomers(url),
    reschedule: url.searchParams.get('reschedule') || '',
    sitekey: SITEKEY, holidays: holidayWindow(worldNow(state)), today: iso(new Date(worldNow(state))),
  }));
}

function timesPageFor(state, res, url, session) {
  const branch = url.searchParams.get('branch') || '';
  const code = askedService(url);
  const date = url.searchParams.get('date') || '';
  const customers = askedCustomers(url);
  const office = state.offices.find((o) => o.code === branch);
  if (!office || !SERVICES[code]) return send(res, 404, 'text/plain', 'unknown branch');
  const day = slotsFor(state, branch, code, worldNow(state), customers).find((d) => d.date === date);
  return html(res, timesPage(state, session, {
    office, code, date, customers, times: day ? day.times : [],
    reschedule: url.searchParams.get('reschedule') || '', sitekey: SITEKEY,
  }));
}

function detailsPageFor(state, res, url, session) {
  const holdId = url.searchParams.get('hold') || '';
  const hold = state.holds.get(holdId);
  if (!hold) {
    return html(res, shell(state, {
      title: 'Your details', session, step: 4, gated: false,
      crumbs: [['Appointments', '/portal/appointments/'], ['Your details', '']],
      body: `<div class="card"><h1>That hold has run out</h1>
        <p>A time is held for ten minutes. Yours has gone back on the calendar — which is what
        would have happened to anybody else's too.</p>
        <p><a class="btn" href="/portal/appointments/">Start again</a></p></div>`,
    }));
  }
  const office = state.offices.find((o) => o.code === hold.branch);
  if (!office) return send(res, 404, 'text/plain', 'unknown branch');
  const prefill = session
    ? { first: session.first, last: session.last, email: session.email, phone: session.phone }
    : {};
  return html(res, detailsPage(state, session, {
    hold, holdId, office, code: hold.service, prefill,
    secondsLeft: Math.max(0, Math.round((hold.expires - worldNow(state)) / 1000)),
  }));
}

async function book(state, req, res, url) {
  const body = JSON.parse((await readBody(req)) || '{}');

  if (url.searchParams.get('stage') === 'hold') {
    const { branch, service, date, time } = body;
    const k = key(branch, service, date, time);
    if (!time || state.taken.has(k)) return json(res, 200, { ok: false });
    // A hold, not a booking: the slot is off the market but not yet confirmed,
    // which is the window a competing bidder can lose in. Walk away and
    // expireHolds puts it back rather than losing it for good.
    state.taken.add(k);
    const id = crypto.randomBytes(8).toString('hex');
    state.holds.set(id, { branch, service, date, time,
      customers: Math.min(4, Math.max(1, Number(body.customers) || 1)),
      reschedule: String(body.reschedule || ''),
      expires: worldNow(state) + state.holdTtlMs });
    note(state, 'SLOT_HELD', `${branch} ${date} ${time}`);
    return json(res, 200, { ok: true, hold: id });
  }

  const h = state.holds.get(body.hold);
  if (!h) return json(res, 200, { ok: false });
  state.holds.delete(body.hold);
  if (state.commitFault === 'taken') {
    // The slot stays taken, by somebody else, and nothing is booked.
    note(state, 'SLOT_TAKEN_BY_RIVAL', `${h.branch} ${h.date} ${h.time}`);
    return json(res, 200, { ok: false });
  }
  const ref = 'TS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  // The live site lists an appointment by an id of its own, 64 hex characters,
  // and not by the confirmation number its confirmation page shows.
  const apptId = crypto.randomBytes(32).toString('hex');
  state.bookings.push({ ref, apptId, branch: h.branch, service: h.service, date: h.date, time: h.time,
    customers: h.customers || 1, sms: Boolean(body.sms),
    applicant: { first: body.first, last: body.last, email: body.email, phone: body.phone },
    at: new Date(worldNow(state)).toISOString() });
  note(state, 'BOOKED', `${h.branch} ${h.date} ${h.time} ref=${ref}`);
  // A reschedule only gives up the old appointment once the new one exists,
  // which is the order that stops somebody ending up with neither.
  if (h.reschedule) dropBooking(state, h.reschedule);
  if (state.commitFault === 'no-reply') {
    // Booked, but the answer never makes it back: the page is left with no
    // confirmation for an appointment that exists.
    note(state, 'REPLY_LOST', ref);
    return send(res, 502, 'text/html', '<html><body><h1>502 Bad Gateway</h1></body></html>');
  }
  return json(res, 200, { ok: true, ref });
}

function confirmation(state, res, url, session) {
  const booking = state.bookings.find((b) => b.ref === (url.searchParams.get('ref') || url.searchParams.get('number')));
  if (!booking) return send(res, 404, 'text/plain', 'unknown confirmation number');
  const office = state.offices.find((o) => o.code === booking.branch);
  return html(res, confirmationPage(state, session, {
    booking, office, fresh: worldNow(state) - Date.parse(booking.at) < 60000 }));
}

/**
 * Give an appointment up. The slot goes straight back on the calendar as a
 * cancellation — which is exactly where the near dates worth racing for come
 * from in the first place.
 */
function dropBooking(state, ref) {
  const at = state.bookings.findIndex((b) => b.ref === ref);
  if (at < 0) return null;
  const [booking] = state.bookings.splice(at, 1);
  state.taken.delete(key(booking.branch, booking.service, booking.date, booking.time));
  releaseSlot(state, { branch: booking.branch, service: booking.service,
                       date: booking.date, time: booking.time });
  note(state, 'BOOKING_CANCELLED', `${booking.ref} ${booking.branch} ${booking.date} ${booking.time}`);
  return booking;
}

async function cancel(state, req, res, url, session) {
  if (req.method !== 'POST') {
    return html(res, cancelPage(state, session, { ref: url.searchParams.get('ref') || '' }));
  }
  const body = await form(req);
  const booking = state.bookings.find((b) => b.ref === String(body.ref || '').trim().toUpperCase());
  const lastOk = booking && String(booking.applicant.last || '').toLowerCase()
    === String(body.last || '').trim().toLowerCase();
  if (!booking || !lastOk) {
    return html(res, cancelPage(state, session, { ref: body.ref || '',
      error: 'We could not find an appointment with that confirmation number and last name.' }));
  }
  if (body.action === 'cancel') {
    dropBooking(state, booking.ref);
    return html(res, cancelPage(state, session, { done: true }));
  }
  const office = state.offices.find((o) => o.code === booking.branch);
  return html(res, cancelPage(state, session, { booking, office }));
}

function ics(state, res, url) {
  const booking = state.bookings.find((b) => b.ref === url.searchParams.get('ref'));
  if (!booking) return send(res, 404, 'text/plain', 'unknown confirmation number');
  const office = state.offices.find((o) => o.code === booking.branch);
  const [, h, m, ap] = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(booking.time) || [];
  const hour = (Number(h) % 12) + (/pm/i.test(ap || '') ? 12 : 0);
  const stamp = `${booking.date.replace(/-/g, '')}T${String(hour).padStart(2, '0')}${m}00`;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DMV stand-in//EN', 'BEGIN:VEVENT',
    `UID:${booking.ref}@testsite.invalid`, `DTSTART:${stamp}`, `DURATION:PT30M`,
    `SUMMARY:DMV — ${SERVICES[booking.service].label}`,
    `LOCATION:${office ? `${office.street}, ${office.city} CA ${office.zip}` : booking.branch}`,
    `DESCRIPTION:Confirmation number ${booking.ref} (stand-in, not a real appointment)`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return send(res, 200, 'text/calendar; charset=utf-8', body,
              { 'content-disposition': `attachment; filename="${booking.ref}.ics"` });
}

// ------------------------------------------------------------------ MyDMV
function mydmv(state, res, session) {
  if (!session) return html(res, signinPage(state, { demo: DEMO_ACCOUNT }));
  const mine = state.bookings.filter((b) =>
    String(b.applicant.email || '').toLowerCase() === session.email.toLowerCase());
  return html(res, accountPage(state, session, {
    bookings: mine, officeOf: (code) => state.offices.find((o) => o.code === code) }));
}

function startSession(state, res, account) {
  const sid = crypto.randomBytes(16).toString('hex');
  state.sessions.set(sid, { email: account.email, first: account.first,
                            last: account.last, phone: account.phone });
  note(state, 'SIGNED_IN', account.email);
  return redirect(res, '/portal/mydmv',
    { 'set-cookie': `mydmv=${sid}; Path=/; HttpOnly; SameSite=Lax` });
}

async function signin(state, req, res) {
  const body = await form(req);
  const account = state.accounts.get(String(body.email || '').trim().toLowerCase());
  if (!account || account.password !== body.password) {
    return html(res, signinPage(state, { demo: DEMO_ACCOUNT, email: body.email || '',
      error: 'That email and password do not match an account.' }));
  }
  return startSession(state, res, account);
}

async function register(state, req, res) {
  const body = await form(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !body.password) {
    return html(res, signinPage(state, { demo: DEMO_ACCOUNT, email,
      error: 'An email and a password are needed to create an account.' }));
  }
  const account = { email, password: String(body.password), first: String(body.first || '').trim(),
                    last: String(body.last || '').trim(), phone: String(body.phone || '').trim() };
  state.accounts.set(email, account);
  return startSession(state, res, account);
}

// ------------------------------------------------------------ admin
async function admin(state, req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/__admin/state') {
    return json(res, 200, {
      gate: state.gate, seed: state.seed, solves: state.solves,
      tokenTtlMs: state.tokenTtlMs, solveDelayMs: state.solveDelayMs,
      solveFailureRate: state.solveFailureRate, solveFailures: state.solveFailures,
      apiDelayMs: state.apiDelayMs, holdTtlMs: state.holdTtlMs, commitFault: state.commitFault,
      drift: state.drift, busyDays: state.busyDays, horizonDays: state.horizonDays,
      cancelIntervalMs: state.cancelIntervalMs, cancelBatch: state.cancelBatch,
      cancelTtlMs: state.cancelTtlMs, reclaimed: state.reclaimed,
      expiredHolds: state.expiredHolds,
      released: [...state.released.values()],
      offices: state.offices.length, bookings: state.bookings,
      taken: [...state.taken], tokensIssued: state.tokens.size, log: state.log.slice(-50),
    });
  }
  if (p === '/__admin/reset') {
    state.tokens.clear(); state.bookings.length = 0; state.taken.clear();
    state.log.length = 0; state.solves = 0; state.solveFailures = 0; state.holds.clear();
    state.released.clear(); state.cancelSeq = 0; state.reclaimed = 0; state.expiredHolds = 0;
    state.sessions.clear();
    return json(res, 200, { ok: true });
  }
  if (p === '/__admin/config') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.gate) state.gate = body.gate;
    if (body.tokenTtlMs !== undefined) state.tokenTtlMs = Number(body.tokenTtlMs);
    if (body.solveDelayMs !== undefined) state.solveDelayMs = Number(body.solveDelayMs);
    if (body.solveFailureRate !== undefined) {
      state.solveFailureRate = Math.min(1, Math.max(0, Number(body.solveFailureRate)));
    }
    if (body.seed) state.seed = String(body.seed);
    if (body.commitFault !== undefined) state.commitFault = String(body.commitFault || '');
    // The site "changing" under the robots (pages.js DRIFTED): '' for as it was.
    if (body.drift !== undefined) state.drift = String(body.drift || '');
    for (const k of ['busyDays', 'horizonDays', 'cancelIntervalMs', 'cancelBatch',
                     'cancelTtlMs', 'holdTtlMs', 'apiDelayMs']) {
      if (body[k] !== undefined) state[k] = Math.max(0, Number(body[k]));
    }
    return json(res, 200, {
      ok: true, gate: state.gate, tokenTtlMs: state.tokenTtlMs,
      solveDelayMs: state.solveDelayMs, solveFailureRate: state.solveFailureRate,
      apiDelayMs: state.apiDelayMs, holdTtlMs: state.holdTtlMs, commitFault: state.commitFault,
      drift: state.drift, busyDays: state.busyDays, horizonDays: state.horizonDays,
      cancelIntervalMs: state.cancelIntervalMs, cancelBatch: state.cancelBatch,
      cancelTtlMs: state.cancelTtlMs,
    });
  }
  // Take a slot out from under whoever is mid-flow: the race the cascade exists
  // for, made deterministic.
  if (p === '/__admin/cancel') {
    const b = JSON.parse((await readBody(req)) || '{}');
    // Name a slot to free that one, or say nothing and take pot luck — which is
    // what a real cancellation is.
    const opened = b.date
      ? [releaseSlot(state, { branch: b.branch, service: b.service || 'VR',
                              date: b.date, time: b.time })].filter(Boolean)
      : releaseCancellations(state, Number(b.count ?? state.cancelBatch));
    return json(res, 200, { ok: true, opened });
  }
  if (p === '/__admin/take') {
    const b = JSON.parse((await readBody(req)) || '{}');
    state.taken.add(key(b.branch, b.service, b.date, b.time));
    note(state, 'SLOT_TAKEN_BY_RIVAL', `${b.branch} ${b.date} ${b.time}`);
    return json(res, 200, { ok: true });
  }
  // What a person would see: the day an office is open, and what it can offer.
  if (p === '/__admin/day') {
    const b = url.searchParams;
    const office = state.offices.find((o) => o.code === b.get('branch'));
    if (!office) return json(res, 404, { error: 'unknown branch' });
    const date = b.get('date') || iso(new Date(worldNow(state)));
    return json(res, 200, {
      office: office.name, date, hours: hoursSummary(office),
      holiday: holidayName(date), open: Boolean(hoursOn(office, date)),
      times: (slotsFor(state, office.code, (b.get('service') || 'VR').toUpperCase())
        .find((d) => d.date === date) || { times: [] }).times,
    });
  }
  return json(res, 404, { error: 'no such admin route' });
}

// ------------------------------------------------------------ main
if (import.meta.url === `file://${process.argv[1]}`) {
  // A person is going to look at this one, so it answers at the speed a
  // website answers rather than the speed a fixture does. Tests keep 0.
  const state = createState({ apiDelayMs: Number(process.env.TESTSITE_API_DELAY_MS ?? 220) });
  const port = Number(process.env.PORT || 8787);
  createServer(state).listen(port, '127.0.0.1', () => {
    console.log(`DMV stand-in on http://127.0.0.1:${port}  gate=${state.gate}  seed=${state.seed}`);
    console.log(`  point the bot at it:  DMV_BASE_URL=http://127.0.0.1:${port}`);
    console.log(`  booked solid for ${state.busyDays} days; backlog to ${state.horizonDays}`);
    console.log(`  ${state.cancelBatch} cancellation(s) every ${state.cancelIntervalMs / 1000}s,`
      + ` each gone again after ${state.cancelTtlMs / 1000}s`);
    console.log(`  offices keep their catalogue hours and close on state holidays`);
    console.log(`  MyDMV sign-in: ${DEMO_ACCOUNT.email} / ${DEMO_ACCOUNT.password}`);
    console.log(`  state: /__admin/state   reset: /__admin/reset`);
    startWorld(state);
  });
}
