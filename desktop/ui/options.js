/* Three ways to ask, beside the join form, each with its chance (the regbot
   site's outlook.py works them out from the openings seen on the line).
   This only says them and turns one back into the form's fields. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.bidOptions = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const REACH_WORDS = {
    '1h': '1 hour', '2h': '2 hours', '5h': '5 hours', '1d': '1 day',
    '5d': '5 days', '2w': '2 weeks', '1mo': '1 month', '6mo': '6 months',
  };
  const HOUR = 3600000;

  /** What the site is asked about: the place fields, the date, time, reach and amount. */
  function body(form, placeKeys) {
    const fields = {};
    for (const key of placeKeys || []) {
      if (form[key] !== undefined && form[key] !== null) fields[key] = String(form[key]);
    }
    return {
      fields,
      preferred_date: form.preferred_date || '',
      preferred_time: form.preferred_time || '',
      if_passed: form.if_passed || '',
      amount: Number(form.amount) || 0,
    };
  }

  /** The same draft asked about twice is asked once. */
  function key(draft) {
    return JSON.stringify(draft || {});
  }

  function chance(p) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0.05) return 'under 5%';
    return `about ${Math.round(n * 100)}%`;
  }

  /** How sure it is, for the colour of the number. */
  function tone(p) {
    const n = Number(p) || 0;
    if (n >= 0.85) return 'ok';
    if (n >= 0.5) return 'warn';
    return 'bad';
  }

  function day(date, formatDate) {
    return formatDate ? formatDate(date) : date;
  }

  /** "Tue Oct 27, 17:00" from 'YYYY-MM-DD' and 'HH:MM', or from 'YYYY-MM-DD HH:MM'. */
  function moment(date, time, formatDate) {
    if (time === undefined) [date, time] = String(date || '').split(' ');
    if (!date) return '';
    return `${day(date, formatDate)}${time ? `, ${time}` : ''}`;
  }

  /** "usually booked within a day", from when the site thinks it most likely books. */
  function likely(likelyBy, nowMs) {
    if (!likelyBy) return '';
    const [date, time] = String(likelyBy).split(' ');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = String(time || '00:00').split(':').map(Number);
    const at = new Date(y, m - 1, d, hh, mm).getTime();
    const hours = Math.max(0, (at - (nowMs || Date.now())) / HOUR);
    if (!Number.isFinite(hours)) return '';
    if (hours <= 12) return 'likely booked within hours';
    if (hours <= 30) return 'likely booked within a day';
    return `likely booked within ${Math.ceil(hours / 24)} days`;
  }

  function reach(code) {
    return REACH_WORDS[code] || code || '';
  }

  /** The words for one option: what it asks for, and what it is likely to get. */
  function describe(option, formatDate, nowMs) {
    return {
      label: option.label || '',
      place: option.place_text || '',
      asks: `anything up to ${moment(option.preferred_date, option.preferred_time, formatDate)}, then ${reach(option.if_passed)} more`,
      chance: chance(option.chance),
      tone: tone(option.chance),
      by: option.until ? `of an appointment by ${moment(option.until, undefined, formatDate)}` : '',
      likely: likely(option.likely_by, nowMs),
    };
  }

  /** The form's fields once this option is used: its date, time, reach, and its place if it has one. */
  function apply(option) {
    const out = {
      preferred_date: option.preferred_date,
      preferred_time: option.preferred_time,
      if_passed: option.if_passed,
    };
    if (option.place && typeof option.place === 'object') Object.assign(out, option.place);
    return out;
  }

  /** The line under the options: what they are worked out from. */
  function basis(doc) {
    const b = (doc && doc.basis) || {};
    const days = Number(b.days) || 0;
    const seen = `${Number(b.openings) || 0} opening${Number(b.openings) === 1 ? '' : 's'} seen on this line in the last ${days === Math.round(days) ? days : days.toFixed(1)} days`;
    const rough = b.rough ? ' Some of these offices have hardly been looked at yet, so this is rough.' : '';
    return `Worked out from the ${seen}, against the bids ahead. An estimate, not a promise.${rough}`;
  }

  return { body, key, chance, tone, moment, likely, reach, describe, apply, basis };
});
