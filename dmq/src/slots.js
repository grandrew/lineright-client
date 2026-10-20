/**
 * Slot vocabulary — the pure half of discovery.
 *
 * Kept apart from discover.js so that turning a page of times into offers can
 * be tested, and used, without a browser anywhere in the picture. The scout's
 * simulate mode depends on exactly this: it builds real offers without ever
 * loading Playwright.
 */
import { findOffice } from './catalog.js';

/** '10:30 AM' -> '10:30'; '1:05 PM' -> '13:05'; '14:20' -> '14:20'. Null otherwise. */
export function to24h(label) {
  const text = String(label || '').trim();
  const ampm = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/.exec(text);
  if (ampm) {
    const minutes = Number(ampm[2]);
    let hour = Number(ampm[1]);
    if (hour < 1 || hour > 12 || minutes > 59) return null;
    hour %= 12;
    if (ampm[3].toLowerCase() === 'p') hour += 12;
    return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  // The times API returns 24-hour strings ("08:00", "14:20"). A label that
  // still says that, because the page did not format it, is the same clock time.
  const h24 = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!h24) return null;
  return `${h24[1]}:${h24[2]}`;
}

/** Every distinct clock time on a page of appointment slots, earliest first. */
export function parseTimes(bodyText) {
  let text = String(bodyText || '');
  const ampm = text.match(/\b\d{1,2}:\d{2}\s?[AaPp]\.?[Mm]\.?\b/g) || [];
  const times = [];
  for (const raw of ampm) {
    const t = to24h(raw);
    if (t && !times.includes(t)) times.push(t);
  }
  // Strip the 12-hour hits first so "08:00 AM" is not also counted as "08:00".
  text = text.replace(/\b\d{1,2}:\d{2}\s?[AaPp]\.?[Mm]\.?\b/g, ' ');
  const bare = text.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) || [];
  for (const raw of bare) {
    if (!times.includes(raw)) times.push(raw);
  }
  return times.sort();
}

/** Local calendar date as 'YYYY-MM-DD'. UTC would shift it a day. */
export function dateKey(date) {
  if (typeof date === 'string') return date;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-`
    + String(date.getDate()).padStart(2, '0');
}

/**
 * One offer, in the shape regbot's `offers` table expects.
 *
 * The office is re-resolved through the catalogue so every offer carries the
 * publicId and the coordinates the matcher needs. An offer the matcher cannot
 * place on a map is one nobody bidding by radius could ever win, so an
 * unresolvable office yields null rather than a half-filled offer.
 */
export function toOffer(officeTerm, date, time) {
  const office = findOffice(officeTerm);
  if (!office || !time) return null;
  return {
    office_code: office.code,
    office_name: office.name,
    office_lat: office.lat,
    office_lng: office.lng,
    slot_date: dateKey(date),
    slot_time: time,
  };
}
