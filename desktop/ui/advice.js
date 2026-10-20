/* One suggestion on the banner. The server decides it (regbot/advice.py);
   this only says whether it is still the row to show, and how to say it.
   Dismissing one key leaves a later, different suggestion visible. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.adviceBanner = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const KINDS = { radius: true, time: true, offices: true };
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

  /** The suggestion to show, or null when a turn owns the banner or this key was closed. */
  function visible(doc, gone) {
    const advice = doc && doc.advice;
    if (!advice || typeof advice.key !== 'string' || !advice.key) return null;
    if (!KINDS[advice.kind]) return null;
    if (doc.handoffs && doc.handoffs.length) return null;
    if (gone && gone[advice.key]) return null;
    return advice;
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

  return { visible, sentence, actionLabel, miles };
});
