/**
 * The world behind the DMV stand-in: offices, their hours, and what they can
 * offer on a given day.
 *
 * Split out of server.js because it is the part with opinions. The HTTP layer
 * is mechanical; this is where "a busy DMV" is defined, and every knob here
 * changes what a bot is up against:
 *
 *   * Offices keep the hours the catalogue says they keep. Alturas opens on
 *     Tuesday and Thursday only, most offices open at 8 except Wednesdays at 9,
 *     and nothing at all happens on a state holiday. A calendar that ignores
 *     that looks plausible until you notice it is offering 8:00 AM on a
 *     Wednesday at an office that opens at nine.
 *   * Demand differs by service. A REAL ID appointment is the scarce one and a
 *     registration renewal is not, which is why people write bots for the first
 *     and not the second.
 *   * Demand differs by office, deterministically per office, so a board of
 *     bidders spread over a county does not see one uniform world.
 *   * Slots have capacity. "2 customers" is a different question from "1", and
 *     the real API takes numberOfCustomers for exactly that reason.
 *
 * Everything is a pure function of (seed, office, service, date), so the world
 * is reproducible across restarts and a test can ask what November looks like
 * without waiting for November. Cancellations are the exception: they are
 * events, and they are stored.
 */
import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The robots' own office catalogue (dmq/catalog), so the two never disagree on an office.
const CATALOG = process.env.TESTSITE_CATALOG || path.join(HERE, '..', '..', 'dmq', 'catalog', 'ca-dmv-offices.json');

// `vehicle` is the heading of the service's card on the drive-test "Choose a
// vehicle" page. The robot clicks the card whose text starts with its own
// `vehicleType` (src/services.js), so the two must agree. The real page has
// four Select buttons (test/live.test.js counts them), one per drive-test
// service, KTR's included: ?option= preselects nothing, so the card is the
// only way in.
export const SERVICES = {
  VR: { label: 'Vehicle or boat registration', family: 'OFFICE_VISIT',
        blurb: 'Renew, transfer a title, replace a sticker or plate.', demand: 1 },
  CID: { label: "Driver's license or ID card", family: 'OFFICE_VISIT',
         blurb: 'Apply, renew, or replace a card that is not a REAL ID.', demand: 0.8 },
  RID: { label: 'REAL ID', family: 'OFFICE_VISIT',
         blurb: 'The federally accepted card. Bring your documents.', demand: 0.5 },
  IBC: { label: 'Industry Business Center', family: 'OFFICE_VISIT',
         blurb: 'Dealers, dismantlers, and registration services.', demand: 1.2 },
  DT: { label: 'Drive test (automobile)', family: 'DRIVE_TEST', vehicle: 'Automobile',
        blurb: 'Behind-the-wheel test in a car.', demand: 0.45 },
  CDL: { label: 'Drive test (commercial)', family: 'DRIVE_TEST', vehicle: 'Commercial',
         blurb: 'Behind-the-wheel test in a commercial vehicle.', demand: 0.35 },
  MC: { label: 'Drive test (motorcycle)', family: 'DRIVE_TEST', vehicle: 'Motorcycle',
        blurb: 'Riding test on your own motorcycle.', demand: 0.55 },
  KTR: { label: 'Knowledge test re-evaluation', family: 'DRIVE_TEST',
         vehicle: 'Knowledge Test Re-Evaluation',
         blurb: 'Retake a knowledge test by appointment.', demand: 0.7 },
};

/**
 * The one account MyDMV starts with, printed on the sign-in page.
 *
 * A stand-in nobody can sign in to is a stand-in whose account pages are never
 * looked at. It is obviously fake, it lives in memory, and it is forgotten when
 * the process stops.
 */
export const DEMO_ACCOUNT = {
  email: 'applicant@example.invalid', password: 'dmv-stand-in',
  first: 'Jordan', last: 'Ruiz', phone: '(916) 555-0142',
};

export const TIMES = ['8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '1:00 PM', '2:00 PM', '3:00 PM'];

// A drive test needs a route, an examiner and daylight, so the last one of the
// day is earlier than the last counter appointment.
const DRIVE_TEST_LAST = '2:00 PM';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ------------------------------------------------------------------ helpers
export const key = (b, s, d, t) => `${b}|${s}|${d}|${t}`;

export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * What time the world thinks it is: the machine's clock, moved by
 * `clockOffsetMs`. Everything here reads the time through this, the calendar
 * page included (it opens on the month of the `today` the server hands it), so
 * a test can run the whole site on a day of its choosing — the middle of a
 * month, say, where a calendar that opens on the current month has room in it.
 */
export const worldNow = (state) => Date.now() + (Number(state?.clockOffsetMs) || 0);

export const dayOffset = (now, days) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
};

/** Deterministic pseudo-random in [0,1) from a string. Same seed, same world. */
export function hashUnit(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** '1:00 PM' -> 780. The catalogue keeps hours as '13:00'; this compares them. */
export function minutesOf(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(label).trim());
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3] && /pm/i.test(m[3])) hour += 12;
  if (!m[3]) hour = Number(m[1]);            // '13:00' from the catalogue
  return hour * 60 + Number(m[2]);
}

// ---------------------------------------------------------------- holidays
const nth = (year, month, weekday, n) => {
  const d = new Date(year, month, 1);
  d.setDate(1 + ((weekday - d.getDay() + 7) % 7) + (n - 1) * 7);
  return d;
};
const last = (year, month, weekday) => {
  const d = new Date(year, month + 1, 0);
  d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
  return d;
};

/**
 * State holidays, the days every field office is shut.
 *
 * Worth having because a calendar that offers Thanksgiving is the kind of
 * detail that tells you a fixture was never looked at, and because "the next
 * opening is in three weeks" is partly a story about the days in between that
 * were never going to be available.
 */
export function holidays(year) {
  const observed = (d) => {
    const shifted = new Date(d);
    if (shifted.getDay() === 0) shifted.setDate(shifted.getDate() + 1);   // Sun -> Mon
    if (shifted.getDay() === 6) shifted.setDate(shifted.getDate() - 1);   // Sat -> Fri
    return shifted;
  };
  const thanksgiving = nth(year, 10, 4, 4);
  const dayAfter = new Date(thanksgiving);
  dayAfter.setDate(dayAfter.getDate() + 1);
  return new Map([
    [iso(observed(new Date(year, 0, 1))), "New Year's Day"],
    [iso(nth(year, 0, 1, 3)), 'Martin Luther King Jr. Day'],
    [iso(nth(year, 1, 1, 3)), "Presidents' Day"],
    [iso(observed(new Date(year, 2, 31))), 'César Chávez Day'],
    [iso(last(year, 4, 1)), 'Memorial Day'],
    [iso(observed(new Date(year, 5, 19))), 'Juneteenth'],
    [iso(observed(new Date(year, 6, 4))), 'Independence Day'],
    [iso(nth(year, 8, 1, 1)), 'Labor Day'],
    [iso(observed(new Date(year, 10, 11))), 'Veterans Day'],
    [iso(thanksgiving), 'Thanksgiving Day'],
    [iso(dayAfter), 'Day after Thanksgiving'],
    [iso(observed(new Date(year, 11, 25))), 'Christmas Day'],
  ]);
}

const holidayCache = new Map();
export function holidayName(date) {
  const year = Number(date.slice(0, 4));
  if (!holidayCache.has(year)) holidayCache.set(year, holidays(year));
  return holidayCache.get(year).get(date) || null;
}

// ------------------------------------------------------------------ offices
/** The office's hours for a given weekday, or null when it is shut that day. */
export function hoursOn(office, date) {
  const d = date instanceof Date ? date : new Date(`${date}T00:00:00`);
  if (holidayName(iso(d))) return null;
  const spans = office.hours || {};
  const span = spans[WEEKDAYS[d.getDay()]];
  if (!Array.isArray(span) || span.length !== 2) return null;
  return { from: minutesOf(span[0]), to: minutesOf(span[1]), raw: span };
}

/** How the office's week reads on a card: "Mon–Tue, Thu–Fri 8 a.m.–5 p.m." */
export function hoursSummary(office) {
  const spans = office.hours || {};
  const parts = [];
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
    const span = spans[day];
    if (!span) continue;
    const label = `${clock(span[0])}–${clock(span[1])}`;
    const prev = parts[parts.length - 1];
    if (prev && prev.label === label) prev.days.push(day);
    else parts.push({ label, days: [day] });
  }
  if (!parts.length) return 'Closed';
  const name = (d) => d[0].toUpperCase() + d.slice(1);
  return parts.map((p) => {
    const days = p.days.length > 2
      ? `${name(p.days[0])}–${name(p.days[p.days.length - 1])}`
      : p.days.map(name).join(', ');
    return `${days} ${p.label}`;
  }).join(' · ');
}

function clock(hhmm) {
  const mins = minutesOf(hhmm);
  const hour = Math.floor(mins / 60);
  const suffix = hour >= 12 ? 'p.m.' : 'a.m.';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = mins % 60;
  return minute ? `${h12}:${String(minute).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

/**
 * Not every office runs drive tests — some are counter-only, and the real site
 * simply does not list them for a drive-test appointment. Deterministic per
 * office so the map of which is which does not move between runs.
 */
export function doesDriveTests(state, office) {
  return hashUnit(state.seed, 'dt', office.code) > 0.2;
}

/** How hard this office is to get into, 0 (quiet) to 1 (impossible). */
export function officeLoad(state, code) {
  return 0.25 + hashUnit(state.seed, 'load', code) * 0.55;
}

/** How many people one slot can still take: 1, 2 or 3. */
export function capacityOf(state, code, service, date, time) {
  return 1 + Math.floor(hashUnit(state.seed, 'cap', code, service, date, time) * 3);
}

function timesForService(service) {
  const spec = SERVICES[service];
  if (!spec || spec.family !== 'DRIVE_TEST') return TIMES;
  const cutoff = minutesOf(DRIVE_TEST_LAST);
  return TIMES.filter((t) => minutesOf(t) <= cutoff);
}

// ------------------------------------------------------------------- state
export function createState(options = {}) {
  // Twelve is enough for a test and wrong for a run: the catalogue is
  // alphabetical, so the first twelve are Alturas to Blythe and a board full of
  // San Diego bidders matches none of them. The bot then fails at office
  // selection, never reaches a calendar, and buys no tokens — which looks
  // exactly like "the gate held" and is not. 0 means the whole catalogue.
  const want = Number(options.officeCount ?? process.env.TESTSITE_OFFICES ?? 12);
  const offices = loadOffices(want > 0 ? want : Infinity);
  return {
    gate: options.gate ?? process.env.TESTSITE_GATE ?? 'strict',
    tokenTtlMs: Number(options.tokenTtlMs ?? process.env.TESTSITE_TOKEN_TTL_MS ?? 120000),
    // What a solve costs in wall-clock time, and how often it simply fails.
    // Both default to zero so tests are fast and deterministic; the admin panel
    // turns them up to make the latency argument visible rather than asserted.
    // A human farm solving a v2 Invisible challenge is seconds to tens of
    // seconds, and a meaningful slice of attempts come back unusable.
    solveDelayMs: Number(options.solveDelayMs ?? process.env.TESTSITE_SOLVE_DELAY_MS ?? 0),
    solveFailureRate: Number(options.solveFailureRate ?? process.env.TESTSITE_SOLVE_FAILURE ?? 0),
    solveFailures: 0,
    // What the site itself takes to answer. A government portal is not a
    // local fixture: /dates is a database query behind a WordPress REST route
    // and it shows. Zero by default so tests stay fast; the runner turns it up.
    apiDelayMs: Number(options.apiDelayMs ?? process.env.TESTSITE_API_DELAY_MS ?? 0),
    seed: String(options.seed ?? process.env.TESTSITE_SEED ?? 'regbot'),
    // How booked the office is. Nothing at all inside `busyDays`; the generated
    // backlog runs from there to `horizonDays`. Two months is what California
    // actually looks like for a REAL ID appointment in a populated county.
    busyDays: Number(options.busyDays ?? process.env.TESTSITE_BUSY_DAYS ?? 60),
    horizonDays: Number(options.horizonDays ?? process.env.TESTSITE_HORIZON_DAYS ?? 150),
    // Cancellations: how often somebody gives up their appointment, how many at
    // a time, and how long one sits unclaimed before somebody else takes it.
    cancelIntervalMs: Number(options.cancelIntervalMs ?? process.env.TESTSITE_CANCEL_MS ?? 20000),
    cancelBatch: Number(options.cancelBatch ?? process.env.TESTSITE_CANCEL_BATCH ?? 3),
    cancelTtlMs: Number(options.cancelTtlMs ?? process.env.TESTSITE_CANCEL_TTL_MS ?? 120000),
    // How long the site keeps a slot off the market for somebody who is partway
    // through the form. Walk away and it goes back on sale, which is why an
    // abandoned flow does not quietly destroy inventory.
    holdTtlMs: Number(options.holdTtlMs ?? process.env.TESTSITE_HOLD_TTL_MS ?? 600000),
    // Make the final "Schedule appointment" go wrong, to see what a bot does
    // when no confirmation comes back. 'taken': a rival gets the slot at the
    // last moment and nothing is booked. 'no-reply': the booking is made but
    // the answer is lost, so the page never confirms it. Off by default.
    commitFault: String(options.commitFault ?? ''),
    // The site "changed" under the robots: renamed buttons and labels, a
    // confirmation laid out anew (pages.js DRIFTED). '' is the site as it was.
    drift: String(options.drift ?? process.env.TESTSITE_DRIFT ?? ''),
    // Where this world's clock stands against the machine's (see worldNow()).
    clockOffsetMs: Number(options.clockOffsetMs ?? process.env.TESTSITE_CLOCK_OFFSET_MS ?? 0),
    offices,
    tokens: new Map(),      // token -> {branch, expires, used}
    bookings: [],           // {ref, branch, service, date, time, applicant}
    taken: new Set(),       // "branch|service|date|time" already booked or held
    holds: new Map(),       // hold id -> slot held but not yet confirmed
    released: new Map(),    // slot key -> a cancellation, until it lapses
    sessions: new Map(),    // sid -> MyDMV session
    accounts: new Map([[DEMO_ACCOUNT.email, { ...DEMO_ACCOUNT }]]),
    log: [],                // {at, kind, detail} — what the harness did
    solves: 0,              // how many tokens were minted: the "cash burned"
    cancelSeq: 0,           // makes the cancellation stream reproducible
    reclaimed: 0,           // cancellations nobody here managed to take
    expiredHolds: 0,        // slots handed back by people who wandered off
  };
}

export function loadOffices(count) {
  const raw = JSON.parse(readFileSync(CATALOG, 'utf8'));
  return raw.offices
    .filter((o) => o.open)
    .slice(0, Number.isFinite(count) ? count : undefined)
    .map((o) => ({
      code: o.code, slug: o.slug, name: o.name, branch: o.branch, street: o.street,
      city: o.city, zip: o.zip, lat: o.lat, lng: o.lng, hours: o.hours || {},
    }));
}

export function note(state, kind, detail) {
  state.log.push({ at: new Date(worldNow(state)).toISOString(), kind, detail });
  if (state.log.length > 500) state.log.shift();
}

// ---------------------------------------------------------------- calendar
/**
 * What this office can offer for this service, as the calendar would show it.
 *
 * Two regions, because a real DMV has two. Everything inside `busyDays` is
 * booked solid — that is what "the earliest we have is in November" means at
 * the counter — and past it the generated backlog thins into ordinary
 * availability. The only way to get a near date is for somebody to cancel,
 * which is exactly why cancellations are the thing worth racing for.
 *
 * Inside that shape the office's own hours decide what is even possible: a day
 * it does not open has nothing, a holiday has nothing, and a Wednesday that
 * opens at nine has no eight o'clock. The backlog is generated rather than
 * stored, so the world is reproducible from the seed and a restart does not
 * silently change what tests race for. Cancellations are stored, because they
 * are events and not a function of the date.
 */
export function slotsFor(state, branchCode, service, now = worldNow(state), customers = 1) {
  const office = state.offices.find((o) => o.code === branchCode);
  const byDate = new Map();
  const add = (date, time) => {
    if (state.taken.has(key(branchCode, service, date, time))) return;
    if (capacityOf(state, branchCode, service, date, time) < customers) return;
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(time);
  };

  const offered = timesForService(service);
  // An office this site does not have has no backlog to generate. It can still
  // show a slot somebody explicitly freed, because that is how a test stages
  // one — but nothing is invented for a branch id that does not exist.
  const runsIt = Boolean(office)
    && (SERVICES[service]?.family !== 'DRIVE_TEST' || doesDriveTests(state, office));
  const load = officeLoad(state, branchCode);
  const demand = SERVICES[service]?.demand ?? 1;

  if (runsIt) {
    for (let i = state.busyDays; i <= state.horizonDays; i++) {
      const d = dayOffset(now, i);
      const day = iso(d);
      const open = hoursOn(office, d);
      if (!open) continue;                                    // shut, or a holiday
      // How often this office has anything at all on a given day, and how many
      // slots when it does. Scarce services stay scarce everywhere.
      if (hashUnit(state.seed, branchCode, service, day) > (1 - load) * demand) continue;
      const n = 1 + Math.floor(hashUnit(state.seed, 'n', branchCode, service, day) * 3);
      offered
        .filter((t) => minutesOf(t) >= open.from && minutesOf(t) + 30 <= open.to)
        .filter((t) => hashUnit(state.seed, 't', branchCode, service, day, t) < (n / offered.length) * 2)
        .slice(0, n)
        .forEach((time) => add(day, time));
    }
  }

  // Cancellations sit wherever they were dropped, tomorrow included.
  for (const rec of state.released.values()) {
    if (rec.branch !== branchCode || rec.service !== service) continue;
    if (rec.until <= now) continue;                 // lapsed, about to be reclaimed
    add(rec.date, rec.time);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, times]) => ({ date, times: TIMES.filter((t) => times.has(t)) }));
}

// ---------------------------------------------------------- cancellations
const SERVICE_CODES = Object.keys(SERVICES);

/**
 * Somebody gives up their appointment. Returns what opened up.
 *
 * Unconditional on purpose: a named slot is freed whatever the calendar would
 * otherwise say, because this is also how the admin endpoint and the tests
 * stage a race. `releaseCancellations` below is the one that picks realistic
 * slots to free.
 */
export function releaseSlot(state, { branch, service, date, time }, now = worldNow(state)) {
  const k = key(branch, service, date, time);
  const prior = state.released.get(k);
  // One that lapsed unclaimed is gone, whether or not reclaimStale has swept it
  // up yet: the same time given up again later is a new cancellation.
  if (state.taken.has(k) || (prior && prior.until > now)) return null;
  if (prior) {
    state.reclaimed++;
    note(state, 'SLOT_RECLAIMED', `${branch} ${service} ${date} ${time}`);
  }
  const rec = { branch, service, date, time, at: now, until: now + state.cancelTtlMs };
  state.released.set(k, rec);
  note(state, 'SLOT_RELEASED', `${branch} ${service} ${date} ${time}`);
  return rec;
}

/**
 * The cancellation stream: people give up appointments all day long.
 *
 * Random office, random service, random weekday anywhere in the window —
 * tomorrow included, which is the whole point. A cancellation is the only
 * source of a near date, so it is the only thing worth spending a solve on.
 * What it will not do is free a slot that could never have existed: an office
 * that is shut on Mondays has no Monday appointments for anybody to cancel.
 *
 * Driven by a counter rather than Math.random so one seed still reproduces one
 * run, and callable directly so a test need not wait for a timer.
 */
export function releaseCancellations(state, count = state.cancelBatch, now = worldNow(state)) {
  const opened = [];
  for (let i = 0; i < count; i++) {
    const n = ++state.cancelSeq;
    const pick = (what, list) =>
      list[Math.min(list.length - 1, Math.floor(hashUnit(state.seed, 'c', n, what) * list.length))];
    const office = pick('o', state.offices);
    let service = pick('s', SERVICE_CODES);
    if (SERVICES[service].family === 'DRIVE_TEST' && !doesDriveTests(state, office)) service = 'VR';
    const span = Math.max(1, state.horizonDays - 1);
    const d = dayOffset(now, 1 + Math.floor(hashUnit(state.seed, 'c', n, 'd') * span));
    // Walk to the next day this office is actually open — weekends, holidays
    // and its own closed weekdays are days nobody had an appointment to give up.
    let open = hoursOn(office, d);
    for (let guard = 0; !open && guard < 14; guard++) {
      d.setDate(d.getDate() + 1);
      open = hoursOn(office, d);
    }
    if (!open) continue;
    const workable = timesForService(service)
      .filter((t) => minutesOf(t) >= open.from && minutesOf(t) + 30 <= open.to);
    if (!workable.length) continue;
    const time = pick('t', workable);
    const rec = releaseSlot(state, { branch: office.code, service, date: iso(d), time }, now);
    if (rec) opened.push(rec);
  }
  return opened;
}

/**
 * A cancellation nobody claimed in time is gone — taken by one of the many
 * people refreshing the page by hand. Without this the calendar would slowly
 * fill up with free near dates and stop being a race, which is the one thing it
 * has to be.
 */
export function reclaimStale(state, now = worldNow(state)) {
  let gone = 0;
  for (const [k, rec] of [...state.released]) {
    if (rec.until > now) continue;
    state.released.delete(k);
    if (state.taken.has(k)) continue;               // somebody here got it
    state.reclaimed++;
    note(state, 'SLOT_RECLAIMED', `${rec.branch} ${rec.service} ${rec.date} ${rec.time}`);
    gone++;
  }
  return gone;
}

/**
 * Somebody got as far as the form and wandered off. The real site puts the slot
 * back rather than losing it, and so does this one — otherwise every abandoned
 * run would permanently destroy inventory and the calendar would drain.
 */
export function expireHolds(state, now = worldNow(state)) {
  let gone = 0;
  for (const [id, hold] of [...state.holds]) {
    if (hold.expires > now) continue;
    state.holds.delete(id);
    state.taken.delete(key(hold.branch, hold.service, hold.date, hold.time));
    state.expiredHolds++;
    note(state, 'HOLD_EXPIRED', `${hold.branch} ${hold.date} ${hold.time}`);
    gone++;
  }
  return gone;
}

/**
 * Run the world: cancellations appear and lapse, abandoned holds go back on
 * sale.
 *
 * Deliberately not started by createServer. A test that wants a particular
 * calendar calls releaseCancellations itself, and a test that wants a still one
 * should not have to race a background timer to get it.
 */
export function startWorld(state) {
  let timer = null;
  const tick = () => {
    releaseCancellations(state);
    reclaimStale(state);
    expireHolds(state);
    timer = setTimeout(tick, Math.max(250, state.cancelIntervalMs));
    if (timer.unref) timer.unref();
  };
  tick();
  return () => clearTimeout(timer);
}
