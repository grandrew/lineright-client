/* My Bookings: the person's appointments as the page shows them — which are
   still to come, how long until each, when its next reminder is, and the
   counter on the bar. The appointments and their reminders are the main
   process's (src/bookings.js); this only words them. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.bookingsPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  /** An appointment that began less than this long ago is still on. */
  const STILL_ON = 2 * HOUR;

  const REMINDER_WORDS = { day: 'a day before', six: 'six hours before', hour: 'an hour before' };
  const VIA_WORDS = { robot: "booked by this app's robot", page: 'booked by you on the booking page',
    server: 'booked by LineRight Regbot' };

  function startsAt(b) {
    const ms = b && b.starts_at ? Date.parse(b.starts_at) : NaN;
    return Number.isFinite(ms) ? ms : NaN;
  }

  /** Still to come (or just begun), and not cancelled. */
  function isComing(b, now) {
    const at = startsAt(b);
    return Boolean(b) && b.status === 'booked' && Number.isFinite(at) && at > now - STILL_ON;
  }

  /** The ones still to come, soonest first; the rest — over or cancelled — latest first. */
  function split(list, now) {
    const all = Array.isArray(list) ? list.filter(Boolean) : [];
    const coming = all.filter((b) => isComing(b, now)).sort((a, b) => startsAt(a) - startsAt(b));
    const rest = all.filter((b) => !isComing(b, now)).sort((a, b) => (startsAt(b) || 0) - (startsAt(a) || 0));
    return { coming, rest };
  }

  /** "10:00 AM" from "10:00". */
  function timeLabel(time) {
    const [h, m] = String(time || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return String(time || '');
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** "in 1 day 11 hours", "in 3 hours 20 minutes", "in 12 minutes", "started 20 minutes ago". */
  function untilWords(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) {
      const ago = Math.round(-ms / MINUTE);
      return ago < 1 ? 'now' : `started ${plural(ago, 'minute')} ago`;
    }
    if (ms < HOUR) return `in ${plural(Math.max(1, Math.round(ms / MINUTE)), 'minute')}`;
    if (ms < DAY) {
      const h = Math.floor(ms / HOUR);
      const m = Math.round((ms - h * HOUR) / MINUTE);
      return `in ${plural(h, 'hour')}${m ? ` ${plural(m, 'minute')}` : ''}`;
    }
    const d = Math.floor(ms / DAY);
    const h = Math.round((ms - d * DAY) / HOUR);
    return `in ${plural(d, 'day')}${h ? ` ${plural(h, 'hour')}` : ''}`;
  }

  /** "Mon, Oct 26 at 10:00 AM", on this computer's clock. */
  function atWords(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${day} at ${time}`;
  }

  /** The next reminder for the card: "Mon, Oct 26 at 10:00 AM (a day before)". */
  function nextWords(b) {
    const next = b && b.next;
    if (!next || !Number.isFinite(next.at)) return '';
    return `${atWords(next.at)} (${REMINDER_WORDS[next.kind] || next.kind})`;
  }

  /** How it was booked: "booked by this app's robot on desk". */
  function viaWords(b) {
    const said = VIA_WORDS[b && b.booked_via] || '';
    return said && b.booked_via === 'robot' && b.device ? `${said} on ${b.device}` : said;
  }

  /** The bar's counter: how many are to come, and whether one is within a day. */
  function counter(list, now) {
    const coming = split(list, now).coming;
    return { count: coming.length, soon: coming.some((b) => startsAt(b) - now < DAY) };
  }

  return { REMINDER_WORDS, startsAt, isComing, split, timeLabel, untilWords, atWords, nextWords,
    viaWords, counter };
});
