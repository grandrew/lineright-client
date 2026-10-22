'use strict';
/**
 * What becomes of a turn's tab once the turn is over.
 *
 * Every turn opens its booking page in a tab (main.js `turnTab`), and a slot
 * is offered to several people a few seconds apart, so an app in a busy line
 * is handed turn after turn that somebody else books. Each tab is a renderer
 * of its own, a hundred megabytes or so; kept, they would pile up for as long
 * as the app runs.
 *
 * So a turn's tab the person had no use for is spare once the turn is over:
 * the next turn on the same line opens its page in it instead of in a new
 * tab, and one still spare CLOSE_AFTER_MS after its turn ended closes — the
 * quarter of an hour the bar keeps saying how the turn ended — unless it is
 * the page on screen.
 *
 * Never spare:
 * - a turn still going (in the last sync and not over);
 * - a tab the person used: clicked, typed or scrolled in, or steered from the
 *   strip (shell.js `touched`);
 * - one a robot is booking under, this computer's or another device's;
 * - one showing a booking confirmation: booked by hand there (main.js
 *   `bookedInTab`), or with a confirmation number on its page, looked for
 *   once the turn is over and again after every load — until it has been
 *   looked at, it is kept;
 * - a turn this computer's robot booked, while the DMV's own confirmation is
 *   not open in a tab of its own (closed, or never shown): its "✓ Booked"
 *   card is then the one place the number is.
 *
 * Tabs that are not a turn's — a booking site the person opened, the DMV's
 * confirmation — are never closed here.
 */

const CLOSE_AFTER_MS = 15 * 60000;

/** Which line a hand-off is on: the next turn there may have the last one's tab. */
function lineOf(h) {
  if (!h) return '';
  if (h.queue_id !== undefined && h.queue_id !== null) return `queue:${h.queue_id}`;
  return `${h.site_slug || ''}:${h.queue_slug || h.queue_name || ''}`;
}

/**
 * Why a turn's tab stays, or null when it is spare. `facts` is what main.js
 * knows of it: live, touched, booking, bookedByHand, booked (the robot's card
 * says so), confirmationOpen (the DMV's confirmation for it is in a tab),
 * looked (its page was read once the turn was over) and shows (that read
 * found a confirmation number).
 */
function keptBecause(facts) {
  const f = facts || {};
  if (f.live) return 'live';
  if (f.touched) return 'used';
  if (f.booking) return 'booking';
  if (f.bookedByHand || f.shows) return 'confirmation';
  if (f.booked && !f.confirmationOpen) return 'confirmation';
  if (!f.looked) return 'unread';
  return null;
}

function spare(facts) {
  return keptBecause(facts) === null;
}

/**
 * The tab, of `tabs` ({id, line, endedAt, facts}), the next turn on `line`
 * opens in: a spare one of that line's, the one whose turn ended last.
 */
function spareFor(tabs, line) {
  if (!line) return null;
  let best = null;
  for (const t of tabs) {
    if (t.line !== line || !t.endedAt || !spare(t.facts)) continue;
    if (!best || t.endedAt > best.endedAt) best = t;
  }
  return best;
}

/**
 * Whether a tab closes now: spare, its turn over for `closeAfterMs`, and not
 * the page in front of the person.
 */
function closeNow({ facts, endedAt, onScreen = false }, now = Date.now(), closeAfterMs = CLOSE_AFTER_MS) {
  if (!endedAt || onScreen || !spare(facts)) return false;
  return now - endedAt >= closeAfterMs;
}

module.exports = { CLOSE_AFTER_MS, lineOf, keptBecause, spare, spareFor, closeNow };
