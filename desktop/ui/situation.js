/* The nearest opening, on its own bar. The server describes it
   (regbot/situation.py). Nothing here changes a bid. The bar comes back
   5 minutes after the situation is first seen, then 30 minutes after it
   is closed, then every 5 hours. A different opening starts that over,
   except while the bar is up: then the new one takes its place at once.
   The nearest opening often changes back and forth as real openings come
   and go, so the wait of each one seen lately is remembered, and one that
   comes back carries on where it was. Each is announced once. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.situationBar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // First appearance, then the wait after each close. The last wait repeats.
  const GAPS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 5 * 60 * 60 * 1000];
  // Openings remembered, with their waits and their announcements.
  const MEMORY = 24;

  function miles(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '';
    const rounded = Math.round(x * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  function fresh(key, now) {
    return { key, closed: 0, nextAt: now + GAPS_MS[0], open: false };
  }

  function gapAfter(closed) {
    return GAPS_MS[Math.min(Math.max(closed, 0), GAPS_MS.length - 1)];
  }

  function seenOf(pace) {
    return pace && pace.seen && typeof pace.seen === 'object' && !Array.isArray(pace.seen) ? pace.seen : {};
  }

  function waitOf(entry) {
    return { closed: Number(entry.closed) || 0, nextAt: Number(entry.nextAt) || 0, open: !!entry.open };
  }

  /** The wait for `key`: this one's own, one remembered from when it was the
   *  nearest before, or a new one. A new one shows at once when the bar is up
   *  for the one it replaces, and waits 5 minutes otherwise. */
  function paceFor(pace, key, now) {
    if (pace && pace.key === key) return { key, ...waitOf(pace), seen: seenOf(pace) };
    const seen = Object.assign({}, seenOf(pace));
    const leaving = pace && typeof pace.key === 'string' && pace.key ? waitOf(pace) : null;
    if (leaving) {
      delete seen[pace.key];
      seen[pace.key] = leaving;
    }
    const back = seen[key];
    delete seen[key];
    const keys = Object.keys(seen);
    for (let i = 0; i < keys.length - MEMORY; i += 1) delete seen[keys[i]];
    if (back) return { key, ...waitOf(back), seen };
    const up = leaving && leaving.open;
    return { ...fresh(key, now), ...(up ? { open: true } : {}), seen };
  }

  /** Advance the wait. A turn or a suggestion hides the bar without closing it. */
  function visible(doc, pace, now) {
    const situation = doc && doc.situation;
    const blocked = doc && ((doc.handoffs && doc.handoffs.length) || (doc.advice && doc.advice.key));
    if (!situation || typeof situation.key !== 'string' || !situation.key) {
      return { pace: pace || null, show: null, armIn: null };
    }
    let next = paceFor(pace, situation.key, now);
    if (!next.open && now >= next.nextAt) next = { ...next, open: true };
    if (blocked || !next.open) {
      const armIn = next.open || blocked ? null : Math.max(0, next.nextAt - now);
      return { pace: next, show: null, armIn };
    }
    return { pace: next, show: situation, armIn: null };
  }

  /** Whether this showing is a new notice: `noted` is the showings announced
   *  lately, `mark` this one. Hiding the bar, or another opening in between,
   *  does not make the same showing new again. */
  function announced(prev, show, pace) {
    const marks = Array.isArray(prev) ? prev : (prev ? [String(prev)] : []);
    if (!show || !show.key) return { noted: marks, mark: '', log: false };
    const mark = `${show.key}:${(pace && pace.closed) || 0}`;
    if (marks.includes(mark)) return { noted: marks, mark, log: false };
    return { noted: [...marks, mark].slice(-MEMORY), mark, log: true };
  }

  function dismiss(pace, now) {
    if (!pace || !pace.key) return pace || null;
    const closed = (Number(pace.closed) || 0) + 1;
    return { key: pace.key, closed, nextAt: now + gapAfter(closed), open: false, seen: seenOf(pace) };
  }

  function when(date, time, formatDate) {
    const day = formatDate ? formatDate(date) : (date || '');
    return `${day} at ${time || ''}`.replace(/\s+/g, ' ').trim();
  }

  function untilText(situation, formatDate) {
    const raw = situation.accept_until;
    if (!raw) return '';
    const [date, time] = String(raw).split(' ');
    return when(date, time, formatDate);
  }

  function because(situation, formatDate) {
    const until = untilText(situation, formatDate);
    const range = situation.radius_miles == null || situation.radius_miles === ''
      ? '' : `your ${miles(situation.radius_miles)}-mile range`;
    if (situation.other_office) {
      const who = situation.from_office || 'one office';
      const later = situation.outside_reach && until
        ? ` It is also later than your reach, which runs to ${until}.` : '';
      return `Your bid is for ${who} only.${later}`;
    }
    if (situation.outside_miles && situation.outside_reach) {
      return `It is outside ${range || 'your range'}, and later than your reach${until ? `, which runs to ${until}` : ''}.`;
    }
    if (situation.outside_miles) {
      const reach = until ? ` Your reach runs to ${until}, which still includes it.` : '';
      return `It is outside ${range || 'your range'}.${reach}`;
    }
    if (situation.outside_reach) {
      const inside = range ? `It is inside ${range}. ` : '';
      return `${inside}Your reach runs to ${until || 'the time you asked for'}, and this is later.`;
    }
    if (situation.passed) return '';
    if (range && until) return `It is inside ${range}, and your reach runs to ${until}.`;
    if (range) return `It is inside ${range}.`;
    if (until) return `Your reach runs to ${until}, and this is inside it.`;
    return 'It is inside what you asked for.';
  }

  function sentence(situation, formatDate) {
    if (!situation) return '';
    const queue = situation.queue_name || 'this line';
    if (situation.empty) return `Nothing is open on ${queue} right now.`;
    const away = situation.miles == null || situation.miles === '' ? '' : ` (${miles(situation.miles)} mi)`;
    const head = `The nearest opening is ${situation.office_name || 'an office'} on ${when(situation.slot_date, situation.slot_time, formatDate)}${away}.`;
    const parts = [head];
    const reason = because(situation, formatDate);
    if (reason) parts.push(reason);
    if (situation.passed) parts.push('You already passed this one.');
    const fits = !situation.outside_miles && !situation.outside_reach && !situation.other_office && !situation.passed;
    if (!fits) {
      const take = situation.can_take;
      if (take && take.office_name) {
        const far = take.miles == null || take.miles === '' ? '' : ` (${miles(take.miles)} mi)`;
        parts.push(`The nearest you can take is ${take.office_name} on ${when(take.slot_date, take.slot_time, formatDate)}${far}.`);
      } else {
        parts.push('Nothing you can take is open.');
      }
    }
    return parts.join(' ');
  }

  return { GAPS_MS, visible, announced, dismiss, sentence, miles, fresh };
});
