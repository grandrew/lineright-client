'use strict';
/**
 * The person's appointments, kept in view until they have been, and a
 * reminder before each: a desktop notification and a sound.
 *
 *   a day before        the same time the day before
 *   six hours before    kept between 8 am and 7 pm: one that would come
 *                       earlier than 8 am comes at 8 am instead, or — when
 *                       8 am is less than two hours before the appointment —
 *                       at 7 pm the evening before
 *   an hour before
 *
 * The regbot site says what the appointments are (sync's `bookings`, its
 * bookings.py). They are kept here as well (the store's `bookings`), so the
 * reminders still come when the site cannot be reached. A reminder whose time
 * went by while the app was closed comes when it opens, if the appointment is
 * still to come: the latest one due, once, and the earlier ones are let go.
 * Appointment times, and the working hours, are the line's own wall clock
 * (`timezone`).
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** The six-hour reminder comes between these hours of the day. */
const WORK_FROM = 8;
const WORK_TO = 19;
/** Moved later to 8 am, it must still leave this long before the appointment. */
const LEAD_AT_LEAST = 2 * HOUR;
/** How long an appointment that has begun stays among the coming ones. */
const STILL_ON = 2 * HOUR;
/** Fired reminders are remembered this long after their appointment. */
const REMEMBER = 3 * DAY;

const KINDS = {
  day: 'a day before',
  six: 'six hours before',
  hour: 'an hour before',
};

/** The wall clock in `tz` at instant `ms`: {year, month, day, hour, minute}. */
function wallIn(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms));
  } catch {
    return wallIn(ms, undefined);
  }
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24,
    minute: get('minute') };
}

/** The instant a wall time in `tz` names: "2026-10-27", "10:00", "America/Los_Angeles". */
function zonedMs(date, time, tz) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return NaN;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive;
  // The zone's offset at the guess, twice: once is wrong across a DST change.
  for (let i = 0; i < 2; i += 1) {
    const w = wallIn(guess, tz);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += naive - seen;
  }
  return guess;
}

/** When the appointment is, as an instant. */
function startsAt(b) {
  const sent = b && b.starts_at ? Date.parse(b.starts_at) : NaN;
  return Number.isFinite(sent) ? sent : zonedMs(b && b.date, b && b.time, b && b.timezone);
}

/** `hour`:00 on the wall-clock day of instant `ms` in `tz`, `days` later. */
function atHourOf(ms, tz, hour, days = 0) {
  const w = wallIn(ms, tz);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  const iso = day.toISOString().slice(0, 10);
  return zonedMs(iso, `${String(hour).padStart(2, '0')}:00`, tz);
}

/** The three reminders for one appointment: [{kind, at}], in order. */
function schedule(b) {
  const start = startsAt(b);
  if (!Number.isFinite(start)) return [];
  const tz = b.timezone;
  let six = start - 6 * HOUR;
  const w = wallIn(six, tz);
  if (w.hour < WORK_FROM) {
    const eight = atHourOf(six, tz, WORK_FROM);
    six = start - eight >= LEAD_AT_LEAST ? eight : atHourOf(six, tz, WORK_TO, -1);
  } else if (w.hour > WORK_TO || (w.hour === WORK_TO && w.minute > 0)) {
    six = atHourOf(six, tz, WORK_TO);
  }
  return [
    { kind: 'day', at: start - DAY },
    { kind: 'six', at: six },
    { kind: 'hour', at: start - HOUR },
  ].sort((a, b2) => a.at - b2.at);
}

/** Whether this one is still to come (or only just begun), and not cancelled. */
function upcoming(b, now = Date.now()) {
  if (!b || b.status !== 'booked') return false;
  const start = startsAt(b);
  return Number.isFinite(start) && start > now - STILL_ON;
}

/** The coming ones, soonest first. */
function coming(list, now = Date.now()) {
  return (list || []).filter((b) => upcoming(b, now)).sort((a, b) => startsAt(a) - startsAt(b));
}

const key = (b, kind) => `${b.id}:${kind}`;

/**
 * The reminder to give now, if any: the latest one whose time has come and
 * that has not been given, while the appointment is still ahead. `skip` are
 * the earlier ones it stands in for.
 */
function due(b, fired, now = Date.now()) {
  if (!b || b.status !== 'booked') return null;
  const start = startsAt(b);
  if (!Number.isFinite(start) || now >= start) return null;
  const ready = schedule(b).filter((r) => r.at <= now);
  if (!ready.length) return null;
  const last = ready[ready.length - 1];
  if (fired[key(b, last.kind)]) return null;
  return { ...last, skip: ready.slice(0, -1).map((r) => r.kind) };
}

/** The next reminder still to come for one appointment, or null. */
function nextReminder(b, fired = {}, now = Date.now()) {
  if (!upcoming(b, now)) return null;
  return schedule(b).find((r) => r.at > now && !fired[key(b, r.kind)]) || null;
}

/** "10:00 AM" from "10:00". */
function clockLabel(time) {
  const [h, m] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(time || '');
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "today at 10:00 AM", "tomorrow at 10:00 AM", or "on Tue, Oct 27 at 10:00 AM", seen from `now`. */
function whenWords(b, now = Date.now()) {
  const today = wallIn(now, b.timezone);
  const todayIso = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1)).toISOString().slice(0, 10);
  const at = clockLabel(b.time);
  if (b.date === todayIso) return `today at ${at}`;
  if (b.date === tomorrow) return `tomorrow at ${at}`;
  const d = new Date(`${b.date}T12:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? b.date
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `on ${day} at ${at}`;
}

/** What one reminder says: {title, body}. */
function words(b, kind, now = Date.now()) {
  const where = [b.office_name, b.address].filter(Boolean).join(', ');
  const left = startsAt(b) - now;
  const soon = kind === 'hour' || left < 90 * 60000;
  const title = soon
    ? `Your appointment is in ${Math.max(1, Math.round(left / 60000))} minutes`
    : `Your appointment is ${whenWords(b, now)}`;
  const body = `${b.queue_name || 'Appointment'}${where ? ` — ${where}` : ''}`
    + `${soon ? `, ${clockLabel(b.time)}` : ''}.`
    + `${b.confirmation ? ` Confirmation ${b.confirmation}.` : ''}`;
  return { title, body };
}

class Reminders {
  /**
   * @param {object} opts
   * @param {object} opts.store     the app's settings: `bookings` and `bookingReminders` are kept there
   * @param {function} opts.notify  ({title, body, booking, kind}) a desktop notification
   * @param {function} opts.chime   (kind) the sound
   * @param {function} [opts.onChange] (list) the coming ones changed
   */
  constructor({ store, notify = () => {}, chime = () => {}, onChange = () => {}, log = () => {},
    now = () => Date.now() }) {
    Object.assign(this, { store, notify, chime, onChange, log, now });
    const kept = store.get('bookings');
    this.list = Array.isArray(kept && kept.list) ? kept.list : [];
    this.fired = { ...(store.get('bookingReminders') || {}) };
    this.timer = null;
  }

  /** What the site says now. The list is kept, and the reminders checked at once. */
  update(list) {
    if (!Array.isArray(list)) return;
    const before = JSON.stringify(this.list);
    this.list = list;
    if (JSON.stringify(list) !== before) {
      this.store.set('bookings', { at: new Date(this.now()).toISOString(), list });
      this.onChange(this.coming());
    }
    this.tick();
  }

  /** Cancelled here before the site's next word on it. */
  cancelled(id) {
    let changed = false;
    this.list = this.list.map((b) => {
      if (b.id !== id || b.status === 'cancelled') return b;
      changed = true;
      return { ...b, status: 'cancelled', cancelled_at: new Date(this.now()).toISOString() };
    });
    if (changed) {
      this.store.set('bookings', { at: new Date(this.now()).toISOString(), list: this.list });
      this.onChange(this.coming());
    }
  }

  find(id) {
    return this.list.find((b) => b.id === Number(id)) || null;
  }

  coming() {
    return coming(this.list, this.now());
  }

  /** The coming ones, each with its next reminder, for the app's page. */
  view() {
    const now = this.now();
    return {
      list: this.list.map((b) => ({ ...b, next: nextReminder(b, this.fired, now) })),
      coming: this.coming().length,
    };
  }

  /** Give whatever reminder is due. Returns what was given. */
  tick() {
    const now = this.now();
    const given = [];
    for (const b of this.list) {
      const r = due(b, this.fired, now);
      if (!r) continue;
      for (const kind of r.skip) this.fired[key(b, kind)] = this.fired[key(b, kind)] || -now;
      this.fired[key(b, r.kind)] = now;
      const said = words(b, r.kind, now);
      this.log(`reminder ${r.kind} for booking ${b.id} (${b.office_name} ${b.date} ${b.time}): ${said.title}`);
      try { this.notify({ ...said, booking: b, kind: r.kind }); } catch (err) { this.log(`reminder notification failed: ${err.message}`); }
      try { this.chime(r.kind); } catch (err) { this.log(`reminder sound failed: ${err.message}`); }
      given.push({ id: b.id, kind: r.kind });
    }
    // Forget what was given for appointments long over.
    const live = new Map(this.list.map((b) => [String(b.id), startsAt(b)]));
    for (const k of Object.keys(this.fired)) {
      const start = live.get(k.split(':')[0]);
      if (start === undefined || !Number.isFinite(start) || now - start > REMEMBER) delete this.fired[k];
    }
    if (given.length || Object.keys(this.fired).length !== Object.keys(this.store.get('bookingReminders') || {}).length) {
      this.store.set('bookingReminders', this.fired);
    }
    return given;
  }

  start(everyMs = 30000) {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  KINDS, wallIn, zonedMs, startsAt, schedule, upcoming, coming, due, nextReminder, whenWords,
  clockLabel, words, Reminders,
};
