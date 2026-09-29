/**
 * Slot vocabulary — the pure half of discovery.
 *
 * Kept apart from discover.js so that turning a page of times into offers can
 * be tested, and used, without a browser anywhere in the picture. The scout's
 * simulate mode depends on exactly this: it builds real offers without ever
 * loading Playwright.
 */
import { findOffice } from './catalog.js';

/** '10:30 AM' -> '10:30'; '1:05 PM' -> '13:05'. Null for anything else. */
export function to24h(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$/.exec(String(label || ''));
  if (!m) return null;
  const minutes = Number(m[2]);
  let hour = Number(m[1]);
  if (hour < 1 || hour > 12 || minutes > 59) return null;
  hour %= 12;
  if (m[3].toLowerCase() === 'p') hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Every distinct clock time on a page of appointment slots, earliest first. */
export function parseTimes(bodyText) {
  const found = String(bodyText || '').match(/\b\d{1,2}:\d{2}\s?[AaPp]\.?[Mm]\.?\b/g) || [];
  const times = [];
  for (const raw of found) {
    const t = to24h(raw);
    if (t && !times.includes(t)) times.push(t);
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
