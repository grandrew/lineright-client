/* The bar that says a bid widened by itself (the regbot site's widen.py):
   its time passed with nothing booked, so it now takes later openings. One
   row a widening, newest first, each closed for good once closed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.widenedBar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SHOWN = 3;
  const KEEP_GONE = 40;
  const REACH_WORDS = {
    '1h': '1 hour', '2h': '2 hours', '5h': '5 hours', '1d': '1 day',
    '5d': '5 days', '2w': '2 weeks', '1mo': '1 month', '6mo': '6 months',
  };

  /** The widenings to show: not closed, newest first, at most SHOWN. */
  function visible(doc, gone) {
    const list = doc && Array.isArray(doc.widened) ? doc.widened : [];
    if (doc && doc.handoffs && doc.handoffs.length) return [];
    const closed = new Set(Array.isArray(gone) ? gone : []);
    return list.filter((w) => w && typeof w.key === 'string' && w.key && !closed.has(w.key)).slice(0, SHOWN);
  }

  /** `gone` with this widening closed, the oldest forgotten past KEEP_GONE. */
  function remember(gone, key) {
    const out = (Array.isArray(gone) ? gone : []).filter((k) => k !== key);
    out.push(key);
    return out.slice(-KEEP_GONE);
  }

  function loadGone(raw) {
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string' && k).slice(-KEEP_GONE) : [];
  }

  function words(code) {
    return REACH_WORDS[code] || code || '';
  }

  /** "Tue Nov 3 at 11:30" from the line's 'YYYY-MM-DD HH:MM'. */
  function when(until, formatDate) {
    const [date, time] = String(until || '').split(' ');
    if (!date) return '';
    return `${formatDate ? formatDate(date) : date}${time ? ` at ${time}` : ''}`;
  }

  /** "about 99% chance of an appointment by Tue Nov 3", as the site works it out now. */
  function chance(w, formatDate) {
    const p = Number(w.chance);
    if (w.chance === undefined || w.chance === null || !Number.isFinite(p)) return '';
    const said = p < 0.05 ? 'under 5%' : `about ${Math.round(p * 100)}%`;
    const by = String(w.chance_until || '').split(' ')[0];
    return `${said} chance of an appointment${by ? ` by ${formatDate ? formatDate(by) : by}` : ''}`;
  }

  function sentence(w, formatDate) {
    const line = w.queue_name ? `${w.queue_name}: ` : '';
    const upTo = when(w.until, formatDate);
    const odds = chance(w, formatDate);
    return `${line}its time passed with nothing booked, so it now looks ${words(w.if_passed)} past your time instead of ${words(w.from_if_passed)}${upTo ? `, taking openings up to ${upTo}` : ''}${odds ? ` — ${odds}` : ''}. It keeps widening each day until something is booked.`;
  }

  return { visible, remember, loadGone, sentence, chance, words, SHOWN };
});
