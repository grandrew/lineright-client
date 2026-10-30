/**
 * Every page the stand-in serves.
 *
 * The markup is here rather than in server.js because there is a lot of it and
 * because it has one hard constraint: the robots (this repository's dmq/)
 * drive these pages with the selectors they use against dmv.ca.gov, so
 * anything they reach by role, label or class is load-bearing and marked
 * below. Everything else — the masthead, the steps, the office cards, the
 * confirmation page — exists so that
 * a person handed this site in the desktop app's browser tab can actually read
 * it and finish a booking, which is the other half of what it is for.
 *
 * Load-bearing, do not rename:
 *   the "Choose a vehicle" card headings, one per drive test, each with a
 *     .btn "Select": the bot picks a card by its opening text
 *   "Driver's License or Permit Number" / "Date of Birth" / "Make an Appointment"
 *   #inputKeyWord                  the office search box
 *   li.location-results__list-item each office result
 *   "Select Location"              the button on an office card
 *   "<day> Open Times"             the accessible name of an open calendar day
 *   "Next month"                   paging the calendar (and it costs a token)
 *   "Choose an appointment time"   the heading the booking flow waits for
 *   the plain "9:00 AM" text of a time button, and Confirm / Cancel
 *   "First Name" / "Last Name" / "Email Address" / "Phone Number" labels
 *   "Continue" and "Schedule appointment"
 *   #appointments-react-root + the recaptcha anchor iframe (the gate markers)
 *
 * And one rule that is easy to break by accident: the times page must contain
 * no clock time other than the bookable slots. The bot reads every "h:mm AM"
 * on that page as a slot, so an office-hours line there sends it clicking at
 * 5:00 PM. Hours belong on the office card and the confirmation, not there.
 */
import { SEAL } from './theme.js';
import { SERVICES, hoursSummary } from './world.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = ['Appointment type', 'Location', 'Date &amp; time', 'Your details', 'Confirmation'];

/**
 * The load-bearing words, and what they become once the site has "changed"
 * (state.drift: a comma-separated list of the changes below, '' for none).
 *
 * A real booking site changes under its robots now and then — a button
 * renamed, a label reworded, the confirmation laid out anew — and the robot,
 * which looks for the old words, stops. The desktop app's AI oversight is what
 * takes over then (desktop/src/overseer.js), and this is how
 * that is tried without waiting for the DMV to change something:
 *   'labels'        the time's Confirm, the details form's labels, Continue and
 *                   Schedule appointment say something else
 *   'offices'       "Select Location" does
 *   'confirmation'  the confirmation page calls the number a booking reference,
 *                   and its address carries it as ?number=, so the robot sees
 *                   no confirmation number at all
 * A person reading the page finds their way as before.
 */
const WORDS = {
  selectLocation: 'Select Location', confirm: 'Confirm', first: 'First Name', last: 'Last Name',
  email: 'Email Address', phone: 'Phone Number', continue: 'Continue', schedule: 'Schedule appointment',
};
const DRIFTED = {
  labels: { confirm: 'Hold this time', first: 'Given name', last: 'Family name', email: 'Email',
    phone: 'Mobile number', continue: 'Review my details', schedule: 'Book this appointment' },
  offices: { selectLocation: 'Choose this office' },
};

/** Which of the changes above this site has made. */
export function drifted(state, change) {
  return String((state && state.drift) || '').split(',').map((d) => d.trim()).includes(change);
}

/** A load-bearing word as the site says it now. */
export function say(state, key) {
  for (const change of String((state && state.drift) || '').split(',')) {
    const words = DRIFTED[change.trim()];
    if (words && words[key]) return words[key];
  }
  return WORDS[key];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** '2026-10-08' -> 'Thursday, October 8, 2026'. */
export function longDate(date) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** A phone number for the footer and the office cards: a made-up one, as everything here is. */
export const PHONE = '1-800-555-0133';

// ------------------------------------------------------------------ chrome
function steps(current) {
  if (!current) return '';
  return `<ol class="steps">${STEPS.map((label, i) => {
    const state = i + 1 === current ? 'is-current' : i + 1 < current ? 'is-done' : '';
    return `<li class="${state}"><b>${i + 1 < current ? '✓' : i + 1}</b>${label}</li>`;
  }).join('')}</ol>`;
}

function header(state, session) {
  const account = session
    ? `<a href="/portal/mydmv">Hi, ${esc(session.first || 'there')}</a>
       <a href="/portal/mydmv/signout">Sign out</a>`
    : '<a href="/portal/mydmv">Sign in to MyDMV</a>';
  return `
<a class="skip" href="#main">Skip to main content</a>
<div class="ca-strip"><div class="wrap">
  <span class="ca-strip__gov">CA.gov</span>
  <span class="ca-strip__badge">Local stand-in</span>
  <span class="small">Nothing here is a real appointment</span>
  <span class="ca-strip__right"><a href="/portal/">English</a>${account}</span>
</div></div>
<header class="masthead"><div class="wrap">
  <a class="brand" href="/portal/">${SEAL}
    <span><span class="brand__state">State of California</span>
    <span class="brand__dept">Department of Motor Vehicles</span></span></a>
  <form class="masthead__search" action="/portal/search" method="get" role="search">
    <input type="search" name="q" aria-label="Search dmv.ca.gov" placeholder="Search">
    <button class="btn sec" type="submit">Search</button>
  </form>
</div></header>
<nav class="mainnav" aria-label="Main"><div class="wrap">
  <a href="/portal/driver-licenses">Driver's Licenses &amp; IDs</a>
  <a href="/portal/vehicle-registration">Vehicle Registration</a>
  <a class="is-current" href="/portal/appointments/">Appointments</a>
  <a href="/portal/online-services">Online Services</a>
  <a href="/portal/locations">Locations</a>
</div></nav>`;
}

function footer() {
  const cols = [
    ['Appointments', [['Make an appointment', '/portal/appointments/'],
      ['Cancel or reschedule', '/portal/appointments/cancel'],
      ['Find an office', '/portal/locations']]],
    ['Popular', [['Driver\'s licenses', '/portal/driver-licenses'],
      ['Vehicle registration', '/portal/vehicle-registration'],
      ['REAL ID', '/portal/appointments/select-appointment-type?option=RID']]],
    ['MyDMV', [['Sign in', '/portal/mydmv'], ['My appointments', '/portal/mydmv']]],
  ];
  return `<footer class="footer"><div class="wrap">
  <div class="footer__cols">
    ${cols.map(([head, links]) => `<div><h3>${head}</h3><ul>${
      links.map(([label, href]) => `<li><a href="${href}">${label}</a></li>`).join('')
    }</ul></div>`).join('')}
    <div><h3>Contact</h3><ul><li>${PHONE}</li><li>Mon–Fri, 8 a.m.–5 p.m.</li></ul></div>
  </div>
  <p class="footer__note">This is a local stand-in used to test appointment software. It is not
  the California DMV, it books nothing, and every office, slot and confirmation number on it is
  made up.</p>
</div></footer>`;
}

/**
 * The gate shim, shaped like the real thing.
 *
 * bot.js readGate() reads the sitekey and version off the React root and the
 * size off the anchor iframe, so both have to be here and say what the real
 * page says. The refusal is the behaviour that matters: in `strict` an
 * automated browser gets no token, and the calendar sits on "Loading dates..."
 * exactly as dmv.ca.gov does.
 */
function gate(state, sitekey, branch) {
  return `
<div id="appointments-react-root"
     data-recaptcha-key="${sitekey}"
     data-recaptcha-version="2"
     data-qmatic-url="http://127.0.0.1/qmatic-not-simulated"
     data-disable-get-in-line="1"></div>
<iframe title="reCAPTCHA" style="display:none"
        src="/recaptcha/api2/anchor?size=invisible&amp;badge=bottomright&amp;k=${sitekey}"></iframe>
<textarea name="g-recaptcha-response" style="display:none"></textarea>
<script>
 // Defined before any page body runs: the calendar's own script calls
 // __mintToken() on load, so a shim declared after <main> would not exist yet.
 window.__GATE = ${JSON.stringify(state.gate)};
 window.__BRANCH = ${JSON.stringify(branch)};
 // Stands in for grecaptcha. The only behaviour that matters is the refusal:
 // an automated browser gets nothing, which is what leaves the real calendar
 // stuck on "Loading dates..." forever.
 window.__mintToken = async function () {
   const supplied = window.__suppliedCaptchaToken ||
     (document.querySelector('textarea[name="g-recaptcha-response"]') || {}).value;
   if (supplied && String(supplied).length > 20) return supplied;
   if (window.__GATE === 'off') return 'no-gate';
   // A run that has bought a solving service asks the farm rather than the
   // site, and pays the farm's latency on every single read. src/bot.js sets
   // __solverUrl, and only ever to a loopback address.
   if (window.__solverUrl) {
     const f = await fetch(window.__solverUrl, { method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ branch: window.__BRANCH }) }).catch(() => null);
     return f && f.ok ? (await f.json()).token : null;
   }
   if (window.__GATE === 'strict' && navigator.webdriver) return null;
   const r = await fetch('/__captcha/solve', {
     method: 'POST', headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ branch: window.__BRANCH }),
   });
   if (!r.ok) return null;
   return (await r.json()).token;
 };
</script>`;
}

/**
 * A whole page.
 *
 * `step` draws the progress bar, `crumbs` the breadcrumb, and `branch` binds
 * the gate shim to the office whose calendar this is — tokens are branch-bound,
 * so a page that forgets it mints one that will be refused.
 */
export function shell(state, { title, body, step = 0, crumbs = [], session = null,
                               branch = '', sitekey = '', gated = true } = {}) {
  const trail = [['DMV', '/portal/'], ...crumbs];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | California DMV (stand-in)</title>
<link rel="stylesheet" href="/portal/assets/dmv.css">
<link rel="icon" href="/portal/assets/seal.svg">
</head>
<body>
${header(state, session)}
${gated ? gate(state, sitekey, branch) : ''}
<main id="main"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb">${trail.map(([label, href], i) =>
    (i ? '<span>›</span>' : '') + (href ? `<a href="${href}">${esc(label)}</a>` : esc(label))
  ).join('')}</nav>
  ${steps(step)}
  ${body}
</div></main>
${footer()}
</body></html>`;
}

// ------------------------------------------------------------------- pages
export function homePage(state, session) {
  const tiles = [
    ['Make an appointment', '/portal/appointments/', 'Office visits and drive tests at a field office.'],
    ['Cancel or reschedule', '/portal/appointments/cancel', 'You need your confirmation number.'],
    ['Find an office', '/portal/locations', 'Addresses, hours and what each office does.'],
    ['MyDMV', '/portal/mydmv', 'Sign in to see your appointments.'],
  ];
  return shell(state, {
    title: 'Home', session, gated: false,
    body: `
    <div class="card">
      <h1>California Department of Motor Vehicles</h1>
      <p class="lead">Most things can be done online. Some still need an appointment.</p>
      <div class="grid-2">${tiles.map(([h, href, p]) => `
        <a class="card card--tight" href="${href}" style="display:block;text-decoration:none">
          <h3>${h}</h3><p class="muted small" style="margin:0">${p}</p></a>`).join('')}
      </div>
    </div>
    <div class="notice"><strong>This is a stand-in.</strong> It behaves like the DMV appointment
    system so that software can be tested against it without taking appointments away from
    people. No booking made here is real.</div>`,
  });
}

export function stubPage(state, session, title) {
  return shell(state, {
    title, session, gated: false, crumbs: [[title, '']],
    body: `<div class="card"><h1>${esc(title)}</h1>
      <p>The stand-in implements the appointment system and nothing else, so this page is
      scenery. Everything that works lives under
      <a href="/portal/appointments/">Appointments</a>.</p></div>`,
  });
}

/** The front door of the appointment system: office visit, or drive test. */
export function appointmentsPage(state, session) {
  const office = Object.entries(SERVICES).filter(([, s]) => s.family === 'OFFICE_VISIT');
  return shell(state, {
    title: 'Appointments', session, step: 1, crumbs: [['Appointments', '']],
    body: `
    <div class="card">
      <h1>Make an appointment</h1>
      <p class="lead">Choose what you are coming in for. You can hold one appointment at a time.</p>
      <div class="grid-2">
        ${office.map(([code, s]) => `
        <div class="appointment-reason card card--tight">
          <h3>${esc(s.label)}</h3>
          <p class="muted small">${esc(s.blurb)}</p>
          <a class="btn" href="/portal/appointments/select-appointment-type?option=${code}">Select</a>
        </div>`).join('')}
        <div class="appointment-reason card card--tight">
          <h3>Drive test</h3>
          <p class="muted small">Behind-the-wheel test. You will need your permit or licence number.</p>
          <a class="btn" href="/portal/appointments/select-appointment-type?option=DT">Select</a>
        </div>
      </div>
    </div>
    <div class="card card--tight">
      <h3>Already have an appointment?</h3>
      <p class="muted small" style="margin:0">
        <a href="/portal/appointments/cancel">Cancel or reschedule it</a> with your confirmation
        number. Cancelling puts the slot back for somebody else.</p>
    </div>`,
  });
}

/**
 * Drive tests: pick the vehicle class first, the way the real site does. The
 * headings are SERVICES[code].vehicle, which is what the bot matches on.
 */
export function vehiclePage(state, session) {
  const cards = [
    ['DT', 'Class C — cars, pickups and vans.'],
    ['CDL', 'Class A or B — you must bring the vehicle.'],
    ['MC', 'Class M — bring your own motorcycle and helmet.'],
    ['KTR', 'Retake a knowledge test by appointment.'],
  ];
  return shell(state, {
    title: 'Drive test', session, step: 1,
    crumbs: [['Appointments', '/portal/appointments/'], ['Drive test', '']],
    body: `
    <div class="card">
      <h1>Choose a vehicle</h1>
      <p class="lead">A drive test is booked against the class of licence you are testing for.</p>
      <div class="grid-2">
        ${cards.map(([code, blurb]) => `
        <div class="appointment-reason card card--tight">
          <h3>${esc(SERVICES[code].vehicle)}</h3>
          <p class="muted small">${blurb}</p>
          <button class="btn" onclick="location.href='/portal/appointments/select-appointment-type?option=${code}&amp;step=credentials'">Select</button>
        </div>`).join('')}
      </div>
    </div>`,
  });
}

/** And then the licence check, before any availability is shown. */
export function credentialsPage(state, session, code, error = '') {
  const service = SERVICES[code];
  return shell(state, {
    title: 'Drive test — your licence', session, step: 1,
    crumbs: [['Appointments', '/portal/appointments/'], ['Drive test', '']],
    body: `
    <div class="card">
      <h1>${esc(service.label)}</h1>
      <p class="lead">Enter your permit or licence details. We check them before showing you
      any availability.</p>
      ${error ? `<div class="notice notice--warn"><strong>${esc(error)}</strong></div>` : ''}
      <form method="get" action="/portal/appointments/select-appointment-type">
        <input type="hidden" name="option" value="${esc(code)}">
        <input type="hidden" name="step" value="location">
        <label for="dl">Driver's License or Permit Number</label>
        <p class="hint">One letter and seven numbers, as printed on your card.</p>
        <input id="dl" name="dl" aria-label="Driver's License or Permit Number"
               autocomplete="off" required>
        <label for="dob">Date of Birth</label>
        <input id="dob" name="dob" aria-label="Date of Birth" placeholder="MM/DD/YYYY"
               autocomplete="bday" required>
        <div class="actions"><button class="btn" type="submit">Make an Appointment</button></div>
      </form>
    </div>`,
  });
}

/**
 * Office search and results.
 *
 * `cards` is prepared by the server (it knows distances); this only lays it
 * out. The list keeps li.location-results__list-item and a "Select Location"
 * button per card because that is what the bot reaches for.
 */
export function locationPage(state, session, { code, term, searched, cards, customers }) {
  const service = SERVICES[code];
  const results = !searched ? '' : cards.length ? `
    <p class="muted small">${cards.length} office${cards.length === 1 ? '' : 's'}${
      term ? ` for “${esc(term)}”` : ''}${cards[0].miles != null ? ', nearest first' : ''}.</p>
    <ul class="results">${cards.map((o) => `
      <li class="location-results__list-item office">
        <div class="office__main">
          <h3 class="office__name">${esc(o.name)}${o.miles
            ? `<span class="office__miles">${o.miles} mi away</span>` : ''}</h3>
          <address>${esc(o.street)}<br>${esc(o.city)}, CA ${esc(o.zip)}</address>
          <p class="office__meta">${esc(hoursSummary(o))}</p>
          <p class="office__meta">${PHONE} · <a href="/portal/field-office/${esc(o.slug)}">Office details</a></p>
        </div>
        <div class="office__side">
          <button class="btn" onclick="location.href='/portal/appointments/select-date?branch=${
            encodeURIComponent(o.code)}&amp;service=${esc(code)}&amp;customers=${customers}'">${esc(say(state, 'selectLocation'))}</button>
          ${o.driveTests === false
            ? '<span class="tag">No drive tests here</span>' : ''}
        </div>
      </li>`).join('')}</ul>`
    : `<div class="notice notice--warn">No offices matched “${esc(term)}”. Try a city or a
       five-digit ZIP code.</div>`;

  return shell(state, {
    title: `${service.label} — find an office`, session, step: 2,
    crumbs: [['Appointments', '/portal/appointments/'], [service.label, '']],
    body: `
    <div class="card">
      <h1>Find a DMV office</h1>
      <p class="lead">${esc(service.label)} ·
        <a href="/portal/appointments/">Change appointment type</a></p>
      <form method="get" action="/portal/appointments/select-appointment-type">
        <input type="hidden" name="option" value="${esc(code)}">
        ${service.family === 'DRIVE_TEST' ? '<input type="hidden" name="step" value="location">' : ''}
        <div class="row">
          <div>
            <label for="inputKeyWord">Search by city or ZIP</label>
            <input id="inputKeyWord" name="q" value="${esc(term)}"
                   aria-label="Search by city or ZIP" placeholder="e.g. Poway or 92064">
          </div>
          <div style="flex:0 0 200px">
            <label for="customers">Number of customers</label>
            <select id="customers" name="customers" aria-label="Number of customers">
              ${[1, 2, 3, 4].map((n) => `<option value="${n}"${
                n === customers ? ' selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="actions"><button class="btn" type="submit">Search</button></div>
      </form>
      ${results}
    </div>`,
  });
}

/** One office, the way the real site has a page per field office. */
export function officePage(state, session, office, services) {
  const rows = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day, i) => {
    const span = (office.hours || {})[day];
    const name = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i];
    return `<li><span class="k">${name}</span><span class="v">${
      span ? `${span[0]} – ${span[1]}` : 'Closed'}</span></li>`;
  }).join('');
  return shell(state, {
    title: `${office.name} field office`, session, gated: false,
    crumbs: [['Locations', '/portal/locations'], [office.name, '']],
    body: `
    <div class="card">
      <h1>${esc(office.name)} field office</h1>
      <div class="row">
        <div>
          <address>${esc(office.street)}<br>${esc(office.city)}, CA ${esc(office.zip)}</address>
          <p class="office__meta">${PHONE}</p>
          <p class="muted small">${office.lat.toFixed(4)}, ${office.lng.toFixed(4)}</p>
          <a class="btn" href="/portal/appointments/">Make an appointment</a>
        </div>
        <div>
          <h3>Office hours</h3>
          <ul class="summary">${rows}</ul>
          <p class="muted small">Closed on state holidays.</p>
        </div>
      </div>
    </div>
    <div class="card card--tight">
      <h3>What you can do here</h3>
      <p class="muted small" style="margin:0">${services.map(esc).join(' · ')}</p>
    </div>`,
  });
}

export function locationsPage(state, session, offices) {
  return shell(state, {
    title: 'Find an office', session, gated: false, crumbs: [['Locations', '']],
    body: `
    <div class="card">
      <h1>Field offices</h1>
      <p class="lead">${offices.length} offices are running in this stand-in.</p>
      <ul class="results">${offices.map((o) => `
        <li class="location-results__list-item office">
          <div class="office__main">
            <h3 class="office__name"><a href="/portal/field-office/${esc(o.slug)}">${esc(o.name)}</a></h3>
            <address>${esc(o.street)}, ${esc(o.city)} ${esc(o.zip)}</address>
            <p class="office__meta">${esc(hoursSummary(o))}</p>
          </div>
        </li>`).join('')}</ul>
    </div>`,
  });
}

// ---------------------------------------------------------------- calendar
/**
 * The calendar: a month grid that appears only once the dates have been paid
 * for.
 *
 * Three things here are deliberate and easy to undo by accident.
 *
 * Nothing is server-rendered. The heading and the day buttons are written by
 * the script after /dates answers, which is what leaves a gated browser on
 * "Loading dates..." forever — the behaviour the whole captcha argument rests
 * on. A server-rendered month heading would quietly turn "we were not allowed
 * to look" into "there is nothing here".
 *
 * A month change clears the grid *and* the heading before fetching, and puts
 * both back together when the data lands. The old version left the previous
 * month on screen while the next one loaded, so a reader that looked during
 * that window got this month's heading with next month's buttons about to
 * replace them — and a bot that then clicked "the second open day" clicked
 * whatever had taken that position. Rendering atomically removes the window.
 *
 * Paging costs a token, because it costs a request. That is the price the
 * project argues about and it has to be real here.
 */
export function datePage(state, session, { office, code, customers, reschedule,
                                           sitekey, holidays, today }) {
  const service = SERVICES[code];
  const openWeekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    .map((d, i) => ((office.hours || {})[d] ? i : -1)).filter((i) => i >= 0);

  const body = `
    <div class="card">
      <h1>${esc(office.name)}</h1>
      <p class="lead">${esc(service.label)} · ${customers} customer${customers === 1 ? '' : 's'} ·
        <a href="/portal/appointments/select-appointment-type?option=${esc(code)}${
          service.family === 'DRIVE_TEST' ? '&amp;step=location' : ''}">Change location</a></p>
      ${reschedule ? `<div class="notice">You are rescheduling appointment
        <strong>${esc(reschedule)}</strong>. Your current appointment is kept until you
        finish booking the new one.</div>` : ''}
      <p class="muted small">${esc(office.street)}, ${esc(office.city)} ${esc(office.zip)} ·
        ${esc(hoursSummary(office))}</p>

      <div id="gatebox" class="gatebox" hidden>
        <p class="small" style="margin:0 0 8px">Confirm you are a person to see available dates.</p>
        <div class="recaptcha">
          <button type="button" id="humanCheck" class="recaptcha__box">
            <span class="recaptcha__tick" aria-hidden="true"></span>I'm not a robot</button>
          <span class="recaptcha__logo">reCAPTCHA<span>Privacy · Terms</span></span>
        </div>
        <p id="checkState" class="small muted" style="margin:8px 0 0"></p>
      </div>

      <div id="calendar" class="calendar" aria-live="polite">
        <p id="loading" class="calendar__loading"><span class="spinner"></span>Loading dates...</p>
      </div>
      <div class="legend">
        <span><i class="swatch swatch--open"></i>Open — pick a day</span>
        <span><i class="swatch swatch--none"></i>Nothing left</span>
        <span><i class="swatch day--closed" style="width:14px;height:14px"></i>Office closed</span>
      </div>
    </div>
    <script>
      var BRANCH=${JSON.stringify(office.code)}, SERVICE=${JSON.stringify(code)};
      var CUSTOMERS=${JSON.stringify(String(customers))}, RESCHEDULE=${JSON.stringify(reschedule || '')};
      var OPEN_DAYS=${JSON.stringify(openWeekdays)}, HOLIDAYS=${JSON.stringify(holidays)};
      var TODAY=${JSON.stringify(today)};
      var monthOffset=0, busy=false, dates=null;
      var MONTHS=['January','February','March','April','May','June','July','August',
                  'September','October','November','December'];

      function shownMonth(){ var n=new Date(TODAY+'T12:00:00'); return new Date(n.getFullYear(), n.getMonth()+monthOffset, 1); }
      function pad(n){ return (n<10?'0':'')+n; }
      function isoOf(y,m,d){ return y+'-'+pad(m+1)+'-'+pad(d); }

      function loading(text){
        document.getElementById('calendar').innerHTML =
          '<p id="loading" class="calendar__loading"><span class="spinner"></span>'+text+'</p>';
      }

      function render(){
        var shown=shownMonth(), y=shown.getFullYear(), m=shown.getMonth();
        var open={};
        (dates||[]).forEach(function(d){
          var dt=new Date(d.date+'T00:00:00');
          if(dt.getMonth()===m && dt.getFullYear()===y) open[dt.getDate()]=d.times.length;
        });
        var total=new Date(y,m+1,0).getDate(), lead=new Date(y,m,1).getDay();
        var cells=[], i;
        for(i=0;i<lead;i++) cells.push('<td></td>');
        for(i=1;i<=total;i++){
          var date=isoOf(y,m,i), weekday=new Date(y,m,i).getDay();
          var shut=HOLIDAYS[date]||OPEN_DAYS.indexOf(weekday)<0, past=date<TODAY;
          if(open[i]){
            cells.push('<td><button class="day day--open" aria-label="'+i+' Open Times" '+
              'onclick="go(\\''+date+'\\')">'+i+
              '<span class="day__count">'+open[i]+(open[i]===1?' time':' times')+'</span></button></td>');
          } else if(shut){
            cells.push('<td><span class="day day--closed" title="'+
              (HOLIDAYS[date]||'Closed')+'">'+i+'</span></td>');
          } else {
            cells.push('<td><span class="day day--none"'+(past?' title="In the past"':'')+'>'+i+'</span></td>');
          }
        }
        while(cells.length%7) cells.push('<td></td>');
        var rows='';
        for(i=0;i<cells.length;i+=7) rows+='<tr>'+cells.slice(i,i+7).join('')+'</tr>';
        var count=Object.keys(open).length;
        document.getElementById('calendar').innerHTML =
          '<div class="calendar__head">'+
            '<button class="calendar__nav" id="prevMonth"'+(monthOffset?'':' disabled')+
              ' onclick="page(-1)">‹ Previous month</button>'+
            '<h2 class="calendar__month">'+MONTHS[m]+' '+y+'</h2>'+
            '<button class="calendar__nav" id="nextMonth" onclick="page(1)">Next month ›</button>'+
          '</div>'+
          '<table class="calendar__grid"><thead><tr>'+
            ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(d){return '<th>'+d+'</th>';}).join('')+
          '</tr></thead><tbody>'+rows+'</tbody></table>'+
          '<p class="muted small" style="margin-top:12px">'+
            (count? count+' day'+(count===1?'':'s')+' with openings this month.'
                  : 'No openings this month. Try the next one.')+'</p>';
      }

      window.go=function(date){
        location.href='/portal/appointments/times?branch='+encodeURIComponent(BRANCH)+
          '&service='+SERVICE+'&date='+date+'&customers='+CUSTOMERS+
          (RESCHEDULE?'&reschedule='+encodeURIComponent(RESCHEDULE):'');
      };
      window.page=function(step){
        if(busy) return;
        monthOffset=Math.max(0,monthOffset+step);
        // Every month is a fresh /dates call, and /dates costs a token.
        load();
      };

      async function fetchDates(token){
        var u='/portal/wp-json/dmv/v1/appointment/branches/'+encodeURIComponent(BRANCH)+
              '/dates?services[]='+SERVICE+'&numberOfCustomers='+CUSTOMERS+
              (token && token!=='no-gate' ? '&token='+encodeURIComponent(token) : '');
        var r=await fetch(u);
        if(!r.ok) return null;
        return (await r.json()).dates||[];
      }

      async function load(){
        busy=true;
        loading('Loading dates...');
        var token=await window.__mintToken();
        if(!token){ document.getElementById('gatebox').hidden=false; busy=false; return; }
        var got=await fetchDates(token);
        busy=false;
        if(!got){ return; }              // refused: the page stays on "Loading dates..."
        dates=got;
        render();
      }

      document.getElementById('humanCheck').addEventListener('click', async function(){
        var box=document.getElementById('humanCheck');
        box.classList.add('is-working');
        document.getElementById('checkState').textContent='Checking…';
        var r=await fetch('/__captcha/solve',{method:'POST',
          headers:{'content-type':'application/json'},body:JSON.stringify({branch:BRANCH})});
        if(!r.ok){ document.getElementById('checkState').textContent='That did not work. Try again.';
                   box.classList.remove('is-working'); return; }
        var token=(await r.json()).token;
        box.classList.remove('is-working'); box.classList.add('is-done');
        document.getElementById('checkState').textContent='Verified.';
        var got=await fetchDates(token);
        if(got){ dates=got; document.getElementById('gatebox').hidden=true; render(); }
      });

      load();
    </script>`;

  return shell(state, {
    title: `${office.name} — choose a date`, session, step: 3, branch: office.code, sitekey,
    crumbs: [['Appointments', '/portal/appointments/'],
             [service.label, `/portal/appointments/select-appointment-type?option=${code}`],
             [office.name, '']],
    body,
  });
}

/**
 * The times for one day.
 *
 * Nothing on this page may print a clock time that is not bookable: the
 * booking flow reads every "h:mm AM" in the body as a slot. That is why the
 * office hours, which belong on a page like this, are not on it.
 */
export function timesPage(state, session, { office, code, date, times, customers,
                                            reschedule, sitekey }) {
  const service = SERVICES[code];
  const morning = times.filter((t) => /AM$/.test(t));
  const afternoon = times.filter((t) => /PM$/.test(t));
  const group = (label, list) => !list.length ? '' : `
    <fieldset class="times"><legend>${label}</legend>
      <div class="times__list">${list.map((t) => `
        <button type="button" class="time" aria-pressed="false"
                onclick="pick(this,'${esc(t)}')">${esc(t)}</button>`).join('')}</div>
    </fieldset>`;

  const body = `
    <div class="card">
      <h2>Choose an appointment time</h2>
      <p class="lead">${esc(office.name)} · ${esc(longDate(date))} ·
        ${esc(service.label)}${customers > 1 ? ` · ${customers} customers` : ''}</p>
      ${times.length ? `${group('Morning', morning)}${group('Afternoon', afternoon)}
        <p class="muted small">Times are Pacific. We hold your choice for ten minutes while
        you fill in your details.</p>` : `<div class="notice notice--warn">
        <strong>No times are available.</strong> Somebody may have taken the last one. Pick
        another day.</div>`}
      <div class="actions">
        <button class="btn" id="confirm" disabled>${esc(say(state, 'confirm'))}</button>
        <button class="btn sec" id="cancel">Cancel</button>
        <a href="/portal/appointments/select-date?branch=${encodeURIComponent(office.code)}&amp;service=${
          esc(code)}&amp;customers=${customers}">Back to the calendar</a>
      </div>
      <p id="msg" class="field-error"></p>
    </div>
    <script>
      var chosen=null;
      window.pick=function(el,t){
        chosen=t;
        Array.prototype.forEach.call(document.querySelectorAll('.time'),function(b){
          b.setAttribute('aria-pressed', b===el ? 'true':'false'); });
        document.getElementById('confirm').disabled=false;
      };
      document.getElementById('cancel').onclick=function(){
        chosen=null;
        Array.prototype.forEach.call(document.querySelectorAll('.time'),function(b){
          b.setAttribute('aria-pressed','false'); });
        document.getElementById('confirm').disabled=true;
        document.getElementById('msg').textContent='';
      };
      document.getElementById('confirm').onclick=async function(){
        var r=await fetch('/portal/appointments/book?stage=hold',{method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({branch:${JSON.stringify(office.code)},
            service:${JSON.stringify(code)}, date:${JSON.stringify(date)}, time:chosen,
            customers:${JSON.stringify(customers)},
            reschedule:${JSON.stringify(reschedule || '')}})});
        var d=await r.json();
        if(!d.ok){ document.getElementById('msg').textContent=
          'That time is no longer available. Please choose another.'; return; }
        location.href='/portal/appointments/details?hold='+encodeURIComponent(d.hold);
      };
    </script>`;

  return shell(state, {
    title: `Choose a time — ${office.name}`, session, step: 3, branch: office.code, sitekey,
    crumbs: [['Appointments', '/portal/appointments/'], [office.name,
      `/portal/appointments/select-date?branch=${encodeURIComponent(office.code)}&service=${code}`],
      ['Times', '']],
    body,
  });
}

/** Your details, then a review, then the booking. */
export function detailsPage(state, session, { hold, holdId, office, code, prefill, secondsLeft }) {
  const service = SERVICES[code];
  const extra = [];
  for (let i = 2; i <= (hold.customers || 1); i++) {
    extra.push(`<label for="c${i}">Customer ${i} — full name</label>
      <input id="c${i}" name="c${i}" aria-label="Customer ${i} full name">`);
  }
  const body = `
    <div class="hold"><span aria-hidden="true">⏱</span>
      <span>This appointment is held for you for <b id="left">10:00</b>.</span></div>
    <div class="row">
      <div class="card">
        <h1>Your details</h1>
        <p class="lead">We use these to send your confirmation.</p>
        <form id="f" novalidate>
          <label for="fn">${esc(say(state, 'first'))}</label>
          <input id="fn" aria-label="${esc(say(state, 'first'))}" autocomplete="given-name"
                 value="${esc(prefill.first || '')}" required>
          <label for="ln">${esc(say(state, 'last'))}</label>
          <input id="ln" aria-label="${esc(say(state, 'last'))}" autocomplete="family-name"
                 value="${esc(prefill.last || '')}" required>
          <label for="em">${esc(say(state, 'email'))}</label>
          <input id="em" type="email" aria-label="${esc(say(state, 'email'))}" autocomplete="email"
                 value="${esc(prefill.email || '')}" required>
          <label for="ph">${esc(say(state, 'phone'))}</label>
          <input id="ph" type="tel" aria-label="${esc(say(state, 'phone'))}" autocomplete="tel"
                 value="${esc(prefill.phone || '')}" required>
          ${extra.join('')}
          <label class="checkbox"><input type="checkbox" id="sms" checked>
            <span>Text me a reminder the day before.</span></label>
          <p id="err" class="field-error"></p>
          <div class="actions"><button class="btn" type="button" id="continue">${esc(say(state, 'continue'))}</button></div>
        </form>
        <div id="review" style="display:none">
          <h2>Check your details</h2>
          <ul class="summary" id="reviewList"></ul>
          <div class="actions">
            <button class="btn" id="schedule">${esc(say(state, 'schedule'))}</button>
            <button class="btn sec" id="edit">Edit</button>
          </div>
        </div>
        <p id="out" class="field-error"></p>
      </div>
      <div style="flex:0 0 320px">
        <div class="card card--tight">
          <h3>Your appointment</h3>
          <ul class="summary">
            <li><span class="k">Service</span><span class="v">${esc(service.label)}</span></li>
            <li><span class="k">Office</span><span class="v">${esc(office.name)}</span></li>
            <li><span class="k">Date</span><span class="v">${esc(longDate(hold.date))}</span></li>
            <li><span class="k">Time</span><span class="v">${esc(hold.time)}</span></li>
            <li><span class="k">Customers</span><span class="v">${hold.customers || 1}</span></li>
          </ul>
          <p class="muted small" style="margin:10px 0 0">${esc(office.street)},
            ${esc(office.city)} ${esc(office.zip)}</p>
        </div>
      </div>
    </div>
    <script>
      var left=${JSON.stringify(secondsLeft)};
      function tick(){
        var m=Math.floor(left/60), s=left%60;
        document.getElementById('left').textContent=m+':'+(s<10?'0':'')+s;
        if(left<=0){ document.getElementById('out').textContent=
          'Your hold has run out. Please choose a time again.'; return; }
        left--; setTimeout(tick,1000);
      }
      tick();
      function val(id){ return document.getElementById(id).value.trim(); }
      document.getElementById('continue').onclick=function(){
        var problems=[];
        if(!val('fn')) problems.push('first name');
        if(!val('ln')) problems.push('last name');
        if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(val('em'))) problems.push('a valid email address');
        if(val('ph').replace(/\\D/g,'').length<10) problems.push('a ten-digit phone number');
        if(problems.length){
          document.getElementById('err').textContent='Please enter '+problems.join(', ')+'.';
          return;
        }
        document.getElementById('err').textContent='';
        document.getElementById('reviewList').innerHTML=
          [['Name',val('fn')+' '+val('ln')],['Email',val('em')],['Phone',val('ph')],
           ['Reminder',document.getElementById('sms').checked?'Text message':'None']]
          .map(function(p){return '<li><span class="k">'+p[0]+'</span><span class="v">'+
            p[1].replace(/[<>&]/g,'')+'</span></li>';}).join('');
        document.getElementById('f').style.display='none';
        document.getElementById('review').style.display='block';
      };
      document.getElementById('edit').onclick=function(){
        document.getElementById('review').style.display='none';
        document.getElementById('f').style.display='block';
      };
      document.getElementById('schedule').onclick=async function(){
        var r=await fetch('/portal/appointments/book?stage=commit',{method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({hold:${JSON.stringify(holdId)},
            first:val('fn'), last:val('ln'), email:val('em'), phone:val('ph'),
            sms:document.getElementById('sms').checked})});
        var d=await r.json();
        if(!d.ok){ document.getElementById('out').textContent=
          'That appointment is no longer available.'; return; }
        // Kept for anything reading the page rather than following it.
        document.getElementById('out').textContent=${drifted(state, 'confirmation')
          ? "'Booked. Your reference is on the next page.'"
          : "'Appointment confirmed. Confirmation number '+d.ref"};
        location.href='/portal/appointments/confirmation?${drifted(state, 'confirmation') ? 'number' : 'ref'}='+encodeURIComponent(d.ref);
      };
    </script>`;

  return shell(state, {
    title: 'Your details', session, step: 4, branch: office.code,
    crumbs: [['Appointments', '/portal/appointments/'], ['Your details', '']],
    body,
  });
}

export function confirmationPage(state, session, { booking, office, fresh }) {
  const service = SERVICES[booking.service];
  const bring = service.family === 'DRIVE_TEST'
    ? ['Your permit or licence', 'A registered, insured vehicle in safe condition',
       'Proof of insurance for that vehicle', 'A licensed driver 18 or older to come with you']
    : ['Photo identification', 'Proof of your Social Security number',
       'Two documents showing California residency', 'A way to pay the fee'];
  return shell(state, {
    title: 'Appointment confirmed', session, step: 5, gated: false,
    crumbs: [['Appointments', '/portal/appointments/'], ['Confirmation', '']],
    body: `
    <div class="notice notice--good"><strong>${fresh ? 'Your appointment is confirmed.'
      : 'This appointment is confirmed.'}</strong> ${drifted(state, 'confirmation')
      ? 'Keep your booking reference: you will need it at the office.'
      : 'Bring the confirmation number with you.'}</div>
    <div class="row">
      <div class="card">
        <h1>Appointment details</h1>
        ${drifted(state, 'confirmation') ? '<p class="small muted" style="margin:0">Booking reference</p>' : ''}
        <p class="ref">${esc(booking.ref)}</p>
        <ul class="summary">
          <li><span class="k">Service</span><span class="v">${esc(service.label)}</span></li>
          <li><span class="k">Office</span><span class="v">${esc(office ? office.name : booking.branch)}</span></li>
          <li><span class="k">Address</span><span class="v">${office
            ? `${esc(office.street)}, ${esc(office.city)} ${esc(office.zip)}` : ''}</span></li>
          <li><span class="k">Date</span><span class="v">${esc(longDate(booking.date))}</span></li>
          <li><span class="k">Time</span><span class="v">${esc(booking.time)}</span></li>
          <li><span class="k">Name</span><span class="v">${esc(
            `${booking.applicant.first || ''} ${booking.applicant.last || ''}`.trim())}</span></li>
          <li><span class="k">Email</span><span class="v">${esc(booking.applicant.email || '')}</span></li>
        </ul>
        <div class="actions">
          <a class="btn" href="/portal/appointments/appointment.ics?ref=${encodeURIComponent(booking.ref)}">Add to calendar</a>
          <a class="btn sec" href="/portal/appointments/cancel?ref=${encodeURIComponent(booking.ref)}">Cancel or reschedule</a>
          <a class="btn sec" href="/portal/appointments/appt-edit">View/Cancel Appointment</a>
        </div>
        <p class="muted small">The real site would email this to
          ${esc(booking.applicant.email || 'you')}. The stand-in sends nothing.</p>
      </div>
      <div style="flex:0 0 320px">
        <div class="card card--tight">
          <h3>What to bring</h3>
          <ul class="summary">${bring.map((b) => `<li><span class="v">${esc(b)}</span></li>`).join('')}</ul>
        </div>
        <div class="card card--tight">
          <h3>Arriving</h3>
          <p class="muted small" style="margin:0">Come ten minutes early and check in at the
          kiosk. ${office ? esc(hoursSummary(office)) : ''}</p>
        </div>
      </div>
    </div>`,
  });
}

export function cancelPage(state, session, { ref = '', booking = null, office = null,
                                             error = '', done = false } = {}) {
  const lookup = `
    <form method="post" action="/portal/appointments/cancel">
      <label for="ref">Confirmation Number</label>
      <input id="ref" name="ref" aria-label="Confirmation Number" value="${esc(ref)}"
             placeholder="TS-1A2B3C4D" required>
      <label for="last">Last Name</label>
      <input id="last" name="last" aria-label="Last Name" autocomplete="family-name" required>
      <div class="actions"><button class="btn" type="submit">Find my appointment</button></div>
    </form>`;

  const found = booking ? `
    <ul class="summary">
      <li><span class="k">Confirmation</span><span class="v">${esc(booking.ref)}</span></li>
      <li><span class="k">Service</span><span class="v">${esc(SERVICES[booking.service].label)}</span></li>
      <li><span class="k">Office</span><span class="v">${esc(office ? office.name : booking.branch)}</span></li>
      <li><span class="k">Date</span><span class="v">${esc(longDate(booking.date))}</span></li>
      <li><span class="k">Time</span><span class="v">${esc(booking.time)}</span></li>
    </ul>
    <form method="post" action="/portal/appointments/cancel">
      <input type="hidden" name="ref" value="${esc(booking.ref)}">
      <input type="hidden" name="last" value="${esc(booking.applicant.last || '')}">
      <input type="hidden" name="action" value="cancel">
      <div class="actions">
        <button class="btn" type="submit">Cancel appointment</button>
        <a class="btn sec" href="/portal/appointments/select-date?branch=${
          encodeURIComponent(booking.branch)}&amp;service=${esc(booking.service)}&amp;reschedule=${
          encodeURIComponent(booking.ref)}">Reschedule</a>
      </div>
    </form>
    <p class="muted small">Cancelling puts this slot straight back on the calendar, where
    somebody who has been refreshing the page all morning will take it.</p>` : '';

  return shell(state, {
    title: 'Cancel or reschedule', session, gated: false,
    crumbs: [['Appointments', '/portal/appointments/'], ['Cancel or reschedule', '']],
    body: `
    <div class="card">
      <h1>Cancel or reschedule</h1>
      ${done ? `<div class="notice notice--good"><strong>That appointment is cancelled.</strong>
        The slot has gone back on the calendar.</div>
        <p><a href="/portal/appointments/">Make another appointment</a></p>`
      : `${error ? `<div class="notice notice--warn"><strong>${esc(error)}</strong></div>` : ''}
         ${booking ? found : `<p class="lead">Enter the confirmation number from your email and
         the last name it was booked under.</p>${lookup}`}`}
    </div>`,
  });
}

/**
 * "View/Cancel Appointment", as the live site has it at /portal/appointments/appt-edit
 * (its confirmation page links there): a first and last name and a phone number
 * list the person's appointments, each with "Cancel Appointment", which asks
 * "Are you sure…?" in a dialog before it cancels. The ids, classes and words
 * the live page uses are kept, because the desktop app's cancel guide
 * (desktop/src/dmv-cancel.js) finds its way by them:
 *   #appointment-info-form, #first-name, #last-name, #email, #phone-number,
 *   "View Appointment", .appointment-current__list-item[data-appt-id] (the
 *   live site's own 64-character id, not the confirmation number) saying the
 *   office in capitals and "10/27/26, 10:00 AM, <service>",
 *   .btn--appt-cancel, #delete-confirmation, "Cancel Appointment",
 *   "Keep Appointment", "Your appointment has been canceled.",
 *   "You currently have no appointments available."
 */
export function apptEditPage(state, session) {
  const pre = session || {};
  return shell(state, {
    title: 'View or cancel an appointment', session, gated: false,
    crumbs: [['Appointments', '/portal/appointments/'], ['View or cancel', '']],
    body: `
    <div class="card">
      <h1>Appointments</h1>
      <form id="appointment-info-form" class="appointment-info-form">
        <h2 class="heading heading-5">View Your Appointment Information</h2>
        <p class="muted small">* Required fields</p>
        <label for="first-name">First Name<span class="dmv-input__required-symbol">*</span></label>
        <input type="text" id="first-name" name="first-name" placeholder="Enter your first name"
               maxlength="25" required value="${esc(pre.first || '')}">
        <label for="last-name">Last Name<span class="dmv-input__required-symbol">*</span></label>
        <input type="text" id="last-name" name="last-name" placeholder="Enter your last name"
               maxlength="25" required value="${esc(pre.last || '')}">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" placeholder="sample@email.com" maxlength="50">
        <label for="phone-number">Phone Number<span class="dmv-input__required-symbol">*</span></label>
        <input type="tel" id="phone-number" name="phone-number" placeholder="123-456-7890"
               pattern="[0-9]{3}-[0-9]{3}-[0-9]{4}" maxlength="12" required>
        <div class="actions">
          <button class="btn" type="submit">View Appointment</button>
          <button class="btn sec" type="button" id="info-cancel">Cancel</button>
        </div>
        <p id="msg" class="field-error"></p>
      </form>
    </div>
    <div id="appointment-current" class="card appointment-current" hidden>
      <h2 class="heading heading-3">Current Appointments</h2>
      <p id="canceled" hidden>Your appointment has been canceled.</p>
      <div id="js-location-result-list" class="appointment-current__list"></div>
      <p id="none" hidden>You currently have no appointments available.</p>
    </div>
    <div id="delete-confirmation" class="card" role="dialog" aria-labelledby="dc-title" hidden>
      <h2 id="dc-title">Cancel Appointment</h2>
      <p>Are you sure you want to cancel? Once you cancel your information will not be saved.</p>
      <div class="appt-dialog-form__buttons actions">
        <button type="button" class="btn btn-primary btn--small" id="dc-yes">Cancel Appointment</button>
        <button type="button" class="btn sec btn-secondary btn--small" id="dc-no" aria-label="Close this dialog window">Keep Appointment</button>
      </div>
    </div>
    <script>
      (function () {
        var API = '/portal/wp-json/dmv/v1/appointment';
        var TASKS = ${JSON.stringify(Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.label])))};
        var form = document.getElementById('appointment-info-form');
        var phone = document.getElementById('phone-number');
        var list = document.getElementById('js-location-result-list');
        var current = document.getElementById('appointment-current');
        var dialog = document.getElementById('delete-confirmation');
        var chosen = null, who = null;
        function masked(v) {
          var d = String(v || '').replace(/\D/g, '').slice(0, 10);
          if (d.length < 4) return d;
          if (d.length < 7) return d.slice(0, 3) + '-' + d.slice(3);
          return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
        }
        phone.addEventListener('input', function () { phone.value = masked(phone.value); });
        function hm(t) {
          var h = Number(t.slice(0, 2)), m = t.slice(2, 4);
          return (h % 12 || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
        }
        function draw(appts) {
          list.innerHTML = '';
          appts.forEach(function (a) {
            var item = document.createElement('div');
            item.className = 'appointment-current__list-item';
            item.setAttribute('data-appt-id', a.apptId);
            var when = a.date.slice(0, 2) + '/' + a.date.slice(2, 4) + '/' + a.date.slice(4, 6);
            item.innerHTML = '<div class="appintment-current__list-itemCurrent"><h3 class="heading heading-5"></h3>'
              + '<p class="appointment-current__list-itemOffice"></p></div>'
              + '<button type="button" class="btn btn-link btn--appt-cancel">Cancel Appointment</button>';
            item.querySelector('h3').textContent = a.office.officeName;
            item.querySelector('p').textContent = when + ', ' + hm(a.time) + ', ' + (TASKS[a.task] || a.task);
            item.querySelector('button').addEventListener('click', function (e) {
              e.preventDefault(); chosen = a; dialog.hidden = false;
            });
            list.appendChild(item);
          });
          document.getElementById('none').hidden = appts.length > 0;
          current.hidden = false;
        }
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!form.reportValidity()) return;
          who = { firstName: document.getElementById('first-name').value,
                  lastName: document.getElementById('last-name').value,
                  telNumber: phone.value.replace(/\D/g, ''), token: '' };
          fetch(API + '/my-appointments', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(who) })
            .then(function (r) { return r.json(); })
            .then(function (body) { draw(Array.isArray(body.appt) ? body.appt : body.appt ? [body.appt] : []); });
        });
        document.getElementById('dc-no').addEventListener('click', function () { chosen = null; dialog.hidden = true; });
        document.getElementById('dc-yes').addEventListener('click', function () {
          if (!chosen) return;
          var a = chosen;
          fetch(API + '/cancel-appointment', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apptId: a.apptId, task: a.task, firstName: who.firstName,
              lastName: who.lastName, telNumber: who.telNumber, officeId: a.office.officeId,
              officeName: a.office.officeName, token: '' }) })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              dialog.hidden = true; chosen = null;
              if (body.statusCode === 'APPT_CANCELED') {
                var item = document.querySelector('[data-appt-id="' + a.apptId + '"]');
                if (item) item.remove();
                document.getElementById('canceled').hidden = false;
              } else {
                document.getElementById('msg').textContent = body.message || 'The appointment tool is experiencing technical difficulties.';
              }
            });
        });
      })();
    </script>`,
  });
}

// ----------------------------------------------------------------- MyDMV
export function signinPage(state, { error = '', email = '', demo }) {
  return shell(state, {
    title: 'Sign in to MyDMV', gated: false, crumbs: [['MyDMV', '']],
    body: `
    <div class="row">
      <div class="card">
        <h1>Sign in to MyDMV</h1>
        ${error ? `<div class="notice notice--warn"><strong>${esc(error)}</strong></div>` : ''}
        <form method="post" action="/portal/mydmv/signin">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email"
                 value="${esc(email)}" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <div class="actions"><button class="btn" type="submit">Sign in</button></div>
        </form>
        <p class="muted small">This stand-in keeps accounts in memory and forgets them when it
        stops. Sign in with <strong>${esc(demo.email)}</strong> / <strong>${esc(demo.password)}</strong>,
        or make one up below.</p>
      </div>
      <div class="card">
        <h2>Create an account</h2>
        <form method="post" action="/portal/mydmv/register">
          <label for="rf">First Name</label>
          <input id="rf" name="first" autocomplete="given-name" required>
          <label for="rl">Last Name</label>
          <input id="rl" name="last" autocomplete="family-name" required>
          <label for="re">Email</label>
          <input id="re" name="email" type="email" autocomplete="email" required>
          <label for="rp">Phone Number</label>
          <input id="rp" name="phone" type="tel" autocomplete="tel">
          <label for="rw">Password</label>
          <input id="rw" name="password" type="password" autocomplete="new-password" required>
          <div class="actions"><button class="btn sec" type="submit">Create account</button></div>
        </form>
      </div>
    </div>`,
  });
}

export function accountPage(state, session, { bookings, officeOf }) {
  return shell(state, {
    title: 'MyDMV', session, gated: false, crumbs: [['MyDMV', '']],
    body: `
    <div class="card">
      <h1>Hi, ${esc(session.first)}</h1>
      <p class="lead">${esc(session.email)}</p>
      <h2>Your appointments</h2>
      ${bookings.length ? `<ul class="summary">${bookings.map((b) => {
        const office = officeOf(b.branch);
        return `<li>
          <span class="k">${esc(longDate(b.date))}<br>${esc(b.time)}</span>
          <span class="v">${esc(SERVICES[b.service].label)} at ${esc(office ? office.name : b.branch)}<br>
            <a class="small" href="/portal/appointments/confirmation?ref=${
              encodeURIComponent(b.ref)}">${esc(b.ref)}</a></span></li>`;
      }).join('')}</ul>` : '<p class="muted">Nothing booked yet.</p>'}
      <div class="actions">
        <a class="btn" href="/portal/appointments/">Make an appointment</a>
        <a class="btn sec" href="/portal/mydmv/signout">Sign out</a>
      </div>
    </div>
    <div class="card card--tight">
      <h3>Saved details</h3>
      <p class="muted small" style="margin:0">Your name, email and phone are filled in for you
      when you book. ${esc(session.phone || '')}</p>
    </div>`,
  });
}
