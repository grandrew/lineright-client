'use strict';
/**
 * How far a bid will look once the moment it asked for has passed.
 *
 * The choice is a limit, measured from that moment: 5 hours ends five hours
 * later, and a slot on a later day is outside it. The same rule is in
 * lineright-server's allocation. This copy is what the app uses when the
 * server it is talking to does not know the choice yet, so a far opening is
 * passed instead of put in front of the person.
 */

const CODES = ['1h', '2h', '5h', '1d', '5d', '2w', '1mo', '6mo'];

function wall(date, time) {
  const [year, month, day] = String(date || '').split('-').map(Number);
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  if (![year, month, day, hour, minute].every((n) => Number.isInteger(n))) return null;
  return Date.UTC(year, month - 1, day, hour, minute);
}

function addMonths(ms, months) {
  const when = new Date(ms);
  const day = when.getUTCDate();
  const index = when.getUTCMonth() + months;
  const year = when.getUTCFullYear() + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, last), when.getUTCHours(), when.getUTCMinutes());
}

function reachEnd(prefMs, code) {
  const hour = 3600000;
  const day = 24 * hour;
  if (code === '1h') return prefMs + hour;
  if (code === '2h') return prefMs + 2 * hour;
  if (code === '5h') return prefMs + 5 * hour;
  if (code === '1d') return prefMs + day;
  if (code === '5d') return prefMs + 5 * day;
  if (code === '2w') return prefMs + 14 * day;
  if (code === '1mo') return addMonths(prefMs, 1);
  if (code === '6mo') return addMonths(prefMs, 6);
  return null;
}

/** The computer's clock as a wall time, so it can be compared with a slot. */
function localWall(nowMs = Date.now()) {
  const n = new Date(nowMs);
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes());
}

/**
 * True when this slot is farther than the bid will accept.
 *
 * Before the preferred moment, any later slot is too far. After it, any slot
 * past the chosen reach is too far, and so is one whose clock time has
 * already gone by. A bid that books the soonest in its reach (`soonest`, the
 * site's allocation.takes_until) takes its whole reach from the start.
 */
function outsideReach({ preferredDate, preferredTime, code, slotDate, slotTime, nowMs, soonest = false }) {
  if (!CODES.includes(code)) return false;
  const pref = wall(preferredDate, preferredTime);
  const slot = wall(slotDate, slotTime);
  const end = pref === null ? null : reachEnd(pref, code);
  if (pref === null || slot === null || end === null) return false;
  const now = localWall(nowMs);
  if (now <= pref && !soonest) return slot > pref;
  return slot > end || slot < now;
}

/**
 * The reach a turn is held to: the bid's own as the server sends it, which
 * may have widened by itself since it was chosen here (the regbot site's
 * widen.py), and the one remembered on this computer only when the server
 * sends none (a server from before the choice existed).
 */
function reachFor(position, remembered) {
  const sent = position && CODES.includes(position.if_passed) ? position.if_passed : '';
  return sent || (CODES.includes(remembered) ? remembered : '') || '';
}

module.exports = { CODES, wall, reachEnd, outsideReach, reachFor };
