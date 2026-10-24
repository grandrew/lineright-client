/* One suggestion on the banner. The server decides it (regbot/advice.py);
   this only says whether it is still the row to show, and how to say it.
   Dismissing one key leaves a later, different suggestion visible. A key
   names the change, not the opening, so a closed one comes back when the
   opening it points to is at least a day sooner than when it was closed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.adviceBanner = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const KINDS = { radius: true, time: true, offices: true };
  // A sync that drops the suggestion for a moment does not take the bar down.
  // Two minutes is long enough for the board to flicker and short enough that
  // a suggestion which has really gone gets out of the way.
  const HOLD_MS = 2 * 60 * 1000;
  // How much sooner an opening has to be to bring a closed suggestion back.
  const SOONER_MS = 24 * 60 * 60 * 1000;
  // Closed suggestions kept, the latest last.
  const KEEP_GONE = 40;
  const REACH_SHORT = {
    '1h': '1 hour', '2h': '2 hours', '5h': '5 hours', '1d': '1 day',
    '5d': '5 days', '2w': '2 weeks', '1mo': '1 month', '6mo': '6 months',
  };

  function miles(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '';
    const rounded = Math.round(x * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  /** When the suggested opening is, to compare two of them; NaN when it does not say. */
  function moment(advice) {
    const date = String((advice && advice.slot_date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    const raw = String(advice.slot_time || '');
    const time = /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : '00:00';
    return Date.parse(`${date}T${time}:00Z`);
  }

  /** Whether this suggestion was closed, and nothing about it is clearly sooner since.
   *  `gone` maps a key to the moment of the opening it pointed to when closed
   *  (moment()), or to anything else when that is not known. */
  function closed(advice, gone) {
    if (!gone || !Object.prototype.hasOwnProperty.call(gone, advice.key)) return false;
    const was = gone[advice.key];
    const at = moment(advice);
    const sooner = typeof was === 'number' && Number.isFinite(was) && Number.isFinite(at) && at <= was - SOONER_MS;
    return !sooner;
  }

  /** The suggestion to show, or null when a turn owns the banner or it was closed. */
  function visible(doc, gone) {
    const advice = doc && doc.advice;
    if (!advice || typeof advice.key !== 'string' || !advice.key) return null;
    if (!KINDS[advice.kind]) return null;
    if (doc.handoffs && doc.handoffs.length) return null;
    if (closed(advice, gone)) return null;
    return advice;
  }

  /** `gone` with this suggestion closed at the opening it points to now. */
  function remember(gone, advice) {
    const out = Object.assign({}, gone);
    delete out[advice.key];
    const at = moment(advice);
    out[advice.key] = Number.isFinite(at) ? at : null;
    const keys = Object.keys(out);
    for (let i = 0; i < keys.length - KEEP_GONE; i += 1) delete out[keys[i]];
    return out;
  }

  /** The closed suggestions as saved: [key, moment] pairs. */
  function saveGone(gone) {
    return Object.entries(gone || {}).slice(-KEEP_GONE)
      .map(([key, at]) => [key, typeof at === 'number' && Number.isFinite(at) ? at : null]);
  }

  /** The closed suggestions from what was saved. A bare key, saved before a
   *  close kept its opening, is forgotten: that suggestion shows once more. */
  function loadGone(raw) {
    const gone = {};
    if (!Array.isArray(raw)) return gone;
    for (const item of raw) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[0]) continue;
      gone[item[0]] = typeof item[1] === 'number' && Number.isFinite(item[1]) ? item[1] : null;
    }
    return gone;
  }

  /** The suggestion to paint, keeping the last one across a short gap in sync.
   *  `doc` is the sync as painted: with no suggestion when none is shown, so a
   *  closed one does not hold back the nearest-opening bar (situation.js). */
  function hold(doc, kept, now, gone) {
    const raw = visible(doc, gone);
    if (raw) return { advice: raw, at: now, doc: doc };
    const still = kept && kept.advice && (now - kept.at) < HOLD_MS
      ? visible({ advice: kept.advice, handoffs: doc && doc.handoffs }, gone)
      : null;
    if (still) return { advice: still, at: kept.at, doc: Object.assign({}, doc, { advice: still }) };
    return { advice: null, at: 0, doc: doc && doc.advice ? Object.assign({}, doc, { advice: null }) : doc };
  }

  function sentence(advice, formatDate) {
    const date = formatDate ? formatDate(advice.slot_date) : (advice.slot_date || '');
    const when = `${date} at ${advice.slot_time || ''}`.replace(/\s+/g, ' ').trim();
    const away = advice.miles == null || advice.miles === '' ? '' : ` (${miles(advice.miles)} mi)`;
    const where = `${advice.office_name || 'An office'}${away}`;
    if (advice.kind === 'radius') {
      return `Widen the range from ${miles(advice.from_radius)} to ${miles(advice.radius_miles)} miles. ${where} has ${when}, and nothing in the current range is that soon.`;
    }
    if (advice.kind === 'time') {
      const next = REACH_SHORT[advice.if_passed] || advice.if_passed || '';
      const prev = REACH_SHORT[advice.from_if_passed] || advice.from_if_passed || '';
      return `Look ${next} past the time you asked for, instead of ${prev}. ${where} has ${when}, inside that reach.`;
    }
    return `Also look at offices within ${miles(advice.radius_miles)} miles of ${advice.from_office || 'that office'}. ${where} has ${when}.`;
  }

  function actionLabel(advice) {
    if (!advice) return '';
    if (advice.kind === 'radius') return `Widen to ${miles(advice.radius_miles)} miles`;
    if (advice.kind === 'time') return `Look ${REACH_SHORT[advice.if_passed] || advice.if_passed || ''} out`;
    if (advice.kind === 'offices') return `Add offices within ${miles(advice.radius_miles)} miles`;
    return '';
  }

  return { visible, hold, remember, saveGone, loadGone, moment, HOLD_MS, SOONER_MS, sentence, actionLabel, miles };
});
