/* Changing a bid: a wider range, a later time, and the amount worth paying.
   The site prices it (regbot/quote.py); this decides what the form offers,
   what it sends, and how the site's numbers are said. A change only widens
   a bid: the choices below never offer less than the bid takes now. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.bidChange = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /** The ranges the form offers, as the join form does, and the wider ones the site allows. */
  const RANGES = [5, 10, 15, 25, 40, 60, 100, 150, 250];
  /** How far to look once the preferred time has passed, narrowest first (allocation.py IF_PASSED). */
  const REACHES = ['1h', '2h', '5h', '1d', '5d', '2w', '1mo', '6mo'];
  const REACH_WORDS = {
    '1h': '1 hour', '2h': '2 hours', '5h': '5 hours', '1d': '1 day',
    '5d': '5 days', '2w': '2 weeks', '1mo': '1 month', '6mo': '6 months',
  };

  function miles(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '';
    const r = Math.round(x * 10) / 10;
    return String(r);
  }

  /**
   * The office choices: the current one first, then only wider ones.
   * A range is offered every step above it. One named office is offered
   * the offices within a range of it, as a range around that office.
   * Each is { value, label, fields }; `fields` is what the site is sent.
   */
  function placeChoices(place) {
    const p = place || {};
    if (p.office_mode === 'radius') {
      const have = Number(p.radius_miles) || 0;
      const from = p.origin_label || p.origin || 'there';
      const out = [{ value: '', label: `Within ${miles(have)} miles of ${from} (as now)`, fields: null }];
      for (const step of RANGES) {
        if (step > have + 1e-6) out.push({ value: String(step), label: `Within ${step} miles of ${from}`, fields: { radius_miles: step } });
      }
      return out;
    }
    if (p.office_mode === 'specific') {
      const office = p.office_name || p.office || 'this office';
      const out = [{ value: '', label: `Only ${office} (as now)`, fields: null }];
      for (const step of RANGES) {
        out.push({ value: String(step), label: `${office}, and any office within ${step} miles of it`, fields: { office_mode: 'radius', origin: office, radius_miles: step } });
      }
      return out;
    }
    return [{ value: '', label: 'Any office (as now)', fields: null }];
  }

  /** The reaches at or past the current one. An old bid with none already takes any time. */
  function reachChoices(code) {
    if (!code) return [];
    const at = REACHES.indexOf(code);
    return REACHES.slice(Math.max(0, at)).map((value) => ({ value, label: `Within ${REACH_WORDS[value]}${value === code ? ' (as now)' : ''}` }));
  }

  /**
   * What to send for the change being drawn up: only what differs from the bid.
   * `draft` is { place, date, time, reach, soonest, amount }; `mine` is the
   * board's `mine`. Returns { fields?, preferred_date?, preferred_time?,
   * if_passed?, soonest?, amount? }.
   */
  function body(draft, mine) {
    const d = draft || {};
    const m = mine || {};
    const out = {};
    const choice = placeChoices(m.place).find((c) => c.value === String(d.place || ''));
    if (choice && choice.fields) out.fields = { ...choice.fields };
    if (d.date && d.date !== m.preferred_date) out.preferred_date = d.date;
    if (d.time && d.time !== m.preferred_time) out.preferred_time = d.time;
    if (d.reach && d.reach !== m.if_passed) out.if_passed = d.reach;
    if (typeof d.soonest === 'boolean' && d.soonest !== Boolean(m.soonest)) out.soonest = d.soonest;
    const amount = Number(d.amount);
    if (Number.isInteger(amount) && amount > 0 && amount !== Number(m.amount)) out.amount = amount;
    return out;
  }

  /** Whether the draft changes anything but the amount (and so needs a fresh quote). */
  function shapeKey(draft) {
    const d = draft || {};
    return [d.place || '', d.date || '', d.time || '', d.reach || '', d.soonest ? 'soonest' : ''].join('|');
  }

  function duration(seconds) {
    if (seconds == null) return null;
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 90) return 'about a minute';
    const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of units) {
      if (s >= size * 1.5 || unit === 'minute') {
        const n = Math.round(s / size);
        return `about ${n} ${unit}${n === 1 ? '' : 's'}`;
      }
    }
    return 'about a minute';
  }

  /** How soon, in a few words, from one option's outlook. */
  function soon(look, days) {
    const o = look || {};
    if (!o.turns) {
      return o.fitting ? `no turn in the next ${days || 28} days` : 'no opening that fits was seen lately';
    }
    const likely = duration(o.likely_s);
    const first = duration(o.first_turn_s);
    if (o.thin) return `first turn in ${first}, maybe (few openings seen)`;
    if (likely && o.likely_s !== o.first_turn_s) return `first turn in ${first}, likely booked in ${likely}`;
    return `likely booked in ${likely || first}`;
  }

  /** What an option buys, in a few words. */
  function title(option) {
    const o = option || {};
    const s = o.standing || {};
    switch (o.label) {
      case 'current': return 'As now';
      case 'out': return 'None of your offices offers this line';
      case 'first': return 'First for your offices';
      case 'less': return s.rivals_ahead === 0 ? 'First, for less' : `${s.rivals_ahead} ahead for your offices, for less`;
      case 'in': return 'Offered openings again';
      default: return s.rivals_ahead === 1 ? '1 ahead for your offices' : `${s.rivals_ahead} ahead for your offices`;
    }
  }

  /** The money side of a change: '+⧗16', '⧗59 back', or ''. */
  function deltaText(delta, coins) {
    const n = Number(delta) || 0;
    if (n > 0) return `+${coins(n)}`;
    if (n < 0) return `${coins(-n)} back`;
    return '';
  }

  /** The Save button's words for the draft as it stands. */
  function saveLabel(draft, mine, coins) {
    const sent = body(draft, mine);
    const keys = Object.keys(sent);
    if (!keys.length) return 'Nothing changed yet';
    const money = 'amount' in sent ? deltaText(sent.amount - Number(mine.amount), coins) : '';
    const shape = keys.some((k) => k !== 'amount');
    if (shape && money) return `Save the change · ${money}`;
    if (shape) return 'Save the change';
    return Number(sent.amount) > Number(mine.amount) ? `Raise to ${coins(sent.amount)} · ${money}` : `Lower to ${coins(sent.amount)} · ${money}`;
  }

  return { RANGES, REACHES, REACH_WORDS, placeChoices, reachChoices, body, shapeKey, duration, soon, title, deltaText, saveLabel, miles };
});
