/* Recent openings: where and when each came up on a line, how long it lasted
   before it was gone, and what became of it (the regbot site's
   openings_feed.py works them out). This says them: the numbers at the top,
   the plot of how long they last, and the list. Everything is drawn as text
   and SVG markup from the site's JSON; app.js puts it on the page and wires it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.openingsFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const RANGE_WORDS = { 24: '24 hours', 72: '3 days', 168: '7 days', 720: '30 days' };
  const MIN = 60;
  const HOUR = 3600;
  const DAY = 86400;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  // ------------------------------------------------------------ what is asked
  /** What the site is asked: one bid's offices, a form's office choice, or the whole line. */
  function body({ bidId = null, fields = null, hours = 72, office = '', fitsOnly = false } = {}) {
    const out = { hours: Number(hours) || 72 };
    if (bidId) out.bid_id = Number(bidId);
    else if (fields && Object.values(fields).some((v) => String(v == null ? '' : v).trim())) out.fields = { ...fields };
    if (office) out.office = String(office);
    if (bidId && fitsOnly) out.fits_only = true;
    return out;
  }

  function key(queueId, ask) {
    const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, k) => { o[k] = sorted(v[k]); return o; }, {}) : v);
    return `${Number(queueId)}|${JSON.stringify(sorted(ask || {}))}`;
  }

  // ------------------------------------------------------------- durations
  /** A length of time, said: "under a minute", "4 min", "2 h 10 min", "3 days". */
  function dur(seconds) {
    const s = Math.max(0, num(seconds));
    if (s < MIN) return 'under a minute';
    if (s < HOUR) return `${Math.round(s / MIN)} min`;
    if (s < 10 * HOUR) {
      const h = Math.floor(s / HOUR);
      const m = Math.round((s - h * HOUR) / MIN);
      return m && m < 60 ? `${h} h ${m} min` : `${Math.round(s / HOUR)} h`;
    }
    if (s < 2 * DAY) return `${Math.round(s / HOUR)} h`;
    const d = Math.round(s / DAY);
    return `${d} days`;
  }

  /** The same, short, for an axis or a tile: "45s", "4m", "2h 10m", "3d". */
  function short(seconds) {
    const s = Math.max(0, num(seconds));
    if (s < MIN) return `${Math.round(s)}s`;
    if (s < HOUR) return `${Math.round(s / MIN)}m`;
    if (s < DAY) {
      const h = Math.floor(s / HOUR);
      const m = Math.round((s - h * HOUR) / MIN);
      return m && h < 10 && m < 60 ? `${h}h ${m}m` : `${Math.round(s / HOUR)}h`;
    }
    return `${Math.round(s / DAY)}d`;
  }

  /** How long one lasted: the words in its row, and the detail behind them. */
  function lasted(item) {
    if (item.open) return { text: `open ${dur(item.est)} so far`, detail: 'Still there at the last look.' };
    if (item.hi !== null && item.hi !== undefined) {
      const detail = item.lo > 0
        ? `Seen for ${dur(item.lo)}, and gone by a look ${dur(item.hi)} after it first came.`
        : `Seen once, and gone by a look ${dur(item.hi)} after it came.`;
      return { text: `about ${dur(item.est)}`, detail };
    }
    if (!(item.lo > 0)) return { text: 'seen once', detail: 'Seen by one look; no later look says when it went.' };
    return { text: `at least ${dur(item.lo)}`, detail: `Seen for ${dur(item.lo)}; no later look says when it went.` };
  }

  /** What became of one: its tag's words and tone. */
  function outcome(item) {
    switch (item.outcome) {
      case 'yours': return item.booked ? { label: 'Yours · booked', tone: 'yours' } : { label: 'Offered to you', tone: 'yours' };
      case 'booked': return { label: 'Booked via LineRight', tone: 'booked' };
      case 'offered': return { label: 'Offered to a bidder', tone: 'offered' };
      case 'open': return { label: 'Open now', tone: 'open' };
      default: return { label: 'Gone', tone: 'gone' };
    }
  }

  /** For a bid: whether it would have taken this one when it came. */
  function fit(item) {
    if (item.fit === 'takes') return item.before_bid ? 'would fit · before you bid' : 'your bid takes it';
    if (item.fit === 'later') return 'later than your bid took then';
    return '';
  }

  // -------------------------------------------------------- the line's clock
  const formats = new Map();
  function formatter(tz, opts) {
    const k = `${tz}|${JSON.stringify(opts)}`;
    if (!formats.has(k)) {
      try { formats.set(k, new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', ...opts })); }
      catch { formats.set(k, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts })); }
    }
    return formats.get(k);
  }

  /** The wall clock on the line at `epoch` seconds: {y, mo, d, h, mi, wd}. */
  function wall(tz, epoch) {
    const parts = {};
    for (const p of formatter(tz, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(new Date(num(epoch) * 1000))) parts[p.type] = p.value;
    return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), wd: parts.weekday };
  }

  /** Seconds the line's clock is ahead of UTC at `epoch`. */
  function offset(tz, epoch) {
    const w = wall(tz, epoch);
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) / 1000;
    return Math.round((asUtc - Math.floor(num(epoch) / 60) * 60) / 60) * 60;
  }

  function clock(tz, epoch) {
    return formatter(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(num(epoch) * 1000));
  }

  /** "Today", "Yesterday", or "Mon, Oct 26", on the line's clock. */
  function day(tz, epoch, now) {
    const a = wall(tz, epoch);
    const b = wall(tz, now);
    const days = Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / (DAY * 1000));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return formatter(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(num(epoch) * 1000));
  }

  /** "Thu, Oct 29 · 3:10 PM" from the site's "2026-10-29 15:10", which is already the line's clock. */
  function slot(text) {
    const [d, t] = String(text || '').split(' ');
    const [y, mo, dd] = String(d || '').split('-').map(Number);
    const [hh, mm] = String(t || '').split(':').map(Number);
    if (![y, mo, dd, hh, mm].every(Number.isInteger)) return String(text || '');
    const at = new Date(Date.UTC(y, mo - 1, dd, hh, mm));
    const dayPart = at.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
    const timePart = at.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
    return `${dayPart} · ${timePart}`;
  }

  /** How far ahead of its slot an opening came: "5 h ahead", "2 days ahead". */
  function ahead(hours) {
    const h = num(hours);
    if (h < 1) return 'less than an hour ahead';
    if (h < 36) return `${Math.round(h)} h ahead`;
    return `${Math.round(h / 24)} days ahead`;
  }

  /** An hour of the day as a span: "8–9 AM", "11 AM–12 PM". */
  function hourText(h) {
    const at = (x) => ({ n: x % 12 === 0 ? 12 : x % 12, half: x % 24 < 12 ? 'AM' : 'PM' });
    const a = at(h);
    const b = at(h + 1);
    return a.half === b.half ? `${a.n}–${b.n} ${b.half}` : `${a.n} ${a.half}–${b.n} ${b.half}`;
  }

  // ------------------------------------------------------------- the numbers
  function scopeText(doc) {
    const s = (doc && doc.scope) || {};
    const n = Number(s.offices);
    if (s.kind === 'bid') return `At your bid's ${n === 1 ? 'office' : `${n || ''} offices`.trim()} · ${s.text || ''}`;
    if (s.kind === 'place') return `At the ${n === 1 ? 'office' : `${n || ''} offices`.trim()} you chose · ${s.text || ''}`;
    return 'At every office on this line';
  }

  /** The tiles at the top: [{value, label, sub, tone}]. */
  function tiles(doc) {
    const s = (doc && doc.stats) || {};
    const hours = Number(doc && doc.hours) || 72;
    const out = [];
    out.push({ value: String(num(s.openings)), label: num(s.openings) === 1 ? 'opening' : 'openings',
      sub: hours <= 24 ? `in the last ${RANGE_WORDS[hours] || '24 hours'}` : `about ${num(s.per_day) < 10 ? num(s.per_day).toFixed(1).replace(/\.0$/, '') : Math.round(num(s.per_day))} a day` });
    if (s.median !== null && s.median !== undefined) {
      out.push({ value: short(s.median), label: 'typically gone in',
        sub: s.p25 !== null && s.p75 !== null && s.p25 !== undefined ? `half within ${short(s.p25)}–${short(s.p75)}` : '' });
    }
    if (s.quick !== null && s.quick !== undefined) {
      out.push({ value: `${Math.round(num(s.quick) * 100)}%`, label: `gone within ${Math.round(num(doc.quick_seconds || 300) / 60)} min`,
        sub: num(s.quick) >= 0.5 ? 'be quick' : '', tone: num(s.quick) >= 0.5 ? 'warn' : '' });
    }
    const t = doc && doc.trend;
    if (t) {
      const arrow = t.way === 'shorter' ? '↓' : t.way === 'longer' ? '↑' : '→';
      out.push({ value: `${arrow} ${short(t.lately)}`, label: `lately, from ${short(t.before)}`,
        sub: t.way === 'shorter' ? 'going faster' : t.way === 'longer' ? 'lasting longer' : 'steady',
        tone: t.way === 'shorter' ? 'warn' : t.way === 'longer' ? 'ok' : '' });
    }
    if (num(s.open) > 0) out.push({ value: String(num(s.open)), label: 'open now', sub: 'still there at the last look', tone: 'ok' });
    if (s.takes !== null && s.takes !== undefined) {
      out.push({ value: `${num(s.takes)} of ${num(s.openings)}`, label: 'your bid would take',
        sub: num(s.yours) ? `${num(s.yours)} went to you` : 'as it stands now' });
    } else if (num(s.yours)) {
      out.push({ value: String(num(s.yours)), label: 'went to you', sub: '' });
    }
    if (s.busiest_hour !== null && s.busiest_hour !== undefined) {
      out.push({ value: hourText(Number(s.busiest_hour)), label: 'most came', sub: 'on the line\'s clock' });
    }
    return out;
  }

  // ----------------------------------------------------------------- the plot
  const H = 236;
  const PAD = { l: 44, r: 14, t: 12 };
  const PLOT_BOTTOM = 178;
  const STRIP_TOP = 186;
  const STRIP_BOTTOM = 208;
  const Y_TICKS = [[60, '1m'], [300, '5m'], [900, '15m'], [HOUR, '1h'], [3 * HOUR, '3h'], [12 * HOUR, '12h'],
    [DAY, '1d'], [3 * DAY, '3d'], [7 * DAY, '7d'], [30 * DAY, '30d']];
  const Y_MIN = 20;
  const ORDER = { gone: 0, offered: 1, booked: 2, yours: 3, open: 4 };

  function yTop(points) {
    const most = points.reduce((m, p) => Math.max(m, num(p[2]), num(p[4])), 0);
    const want = Math.max(most * 1.15, 900);
    const tick = Y_TICKS.find(([v]) => v >= want);
    return tick ? tick[0] : Y_TICKS[Y_TICKS.length - 1][0];
  }

  function xTicks(doc, tz) {
    const hours = Number(doc.hours) || 72;
    const step = hours <= 24 ? 3 * HOUR : hours <= 72 ? 12 * HOUR : hours <= 168 ? DAY : 5 * DAY;
    const off = offset(tz, doc.now);
    const out = [];
    let t = Math.ceil((doc.since + off) / step) * step - off;
    for (; t <= doc.now; t += step) {
      const w = wall(tz, t);
      let label;
      if (step < DAY && w.h !== 0) label = clock(tz, t).replace(':00', '');
      else if (hours <= 168) label = `${w.wd} ${w.d}`;
      else label = formatter(tz, { month: 'short', day: 'numeric' }).format(new Date(t * 1000));
      out.push({ t, label });
    }
    return out;
  }

  /**
   * The plot: each opening as a dot, when it came (across) against how long it
   * lasted (up, on a log scale), with the line through each step's median and
   * a band over its middle half; below, how many came in each step. Returns
   * the SVG markup and where each dot is, for hovering: {svg, hits}.
   */
  function plot(doc, { width = 720, focus = null } = {}) {
    const W = Math.max(320, Math.round(num(width)));
    const tz = doc.timezone || 'UTC';
    const points = Array.isArray(doc.points) ? doc.points : [];
    const left = PAD.l;
    const right = W - PAD.r;
    const since = num(doc.since);
    const now = num(doc.now) || since + 1;
    const x = (t) => left + ((num(t) - since) / Math.max(1, now - since)) * (right - left);
    const top = yTop(points);
    const lnMin = Math.log(Y_MIN);
    const lnMax = Math.log(top);
    const y = (v) => {
      const c = Math.min(top, Math.max(Y_MIN, num(v) || Y_MIN));
      return PAD.t + (1 - (Math.log(c) - lnMin) / (lnMax - lnMin)) * (PLOT_BOTTOM - PAD.t);
    };
    const parts = [];
    const r1 = (v) => Math.round(v * 10) / 10;
    // the grid and the axes
    for (const [v, label] of Y_TICKS.filter(([v]) => v <= top)) {
      parts.push(`<line class="rc-grid" x1="${left}" x2="${right}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`);
      parts.push(`<text class="rc-tick" x="${left - 6}" y="${r1(y(v) + 3.5)}" text-anchor="end">${label}</text>`);
    }
    for (const tick of xTicks(doc, tz)) {
      const tx = r1(x(tick.t));
      parts.push(`<line class="rc-grid" x1="${tx}" x2="${tx}" y1="${PAD.t}" y2="${STRIP_BOTTOM}"/>`);
      parts.push(`<text class="rc-tick" x="${tx}" y="${STRIP_BOTTOM + 15}" text-anchor="middle">${esc(tick.label)}</text>`);
    }
    parts.push(`<line class="rc-axis" x1="${left}" x2="${right}" y1="${PLOT_BOTTOM}" y2="${PLOT_BOTTOM}"/>`);
    parts.push(`<text class="rc-tick of-axis-k" x="${left - 6}" y="${STRIP_TOP + 14}" text-anchor="end">came</text>`);
    // how many came in each step
    const buckets = Array.isArray(doc.buckets) ? doc.buckets : [];
    const step = num(doc.step) || HOUR;
    const most = buckets.reduce((m, b) => Math.max(m, num(b.n)), 0);
    for (const b of buckets) {
      if (!num(b.n)) continue;
      const x0 = x(Math.max(since, b.t));
      const x1 = x(Math.min(now, b.t + step));
      const h = Math.max(2, (num(b.n) / Math.max(1, most)) * (STRIP_BOTTOM - STRIP_TOP));
      parts.push(`<rect class="of-count" x="${r1(x0 + 0.5)}" y="${r1(STRIP_BOTTOM - h)}" width="${r1(Math.max(1, x1 - x0 - 1))}" height="${r1(h)}"><title>${num(b.n)} came</title></rect>`);
    }
    // the middle half of each step, and its median
    let band = [];
    let line = '';
    let run = false;
    const flush = () => {
      if (band.length > 1) {
        const upper = band.map(([cx, , hi]) => `${r1(cx)},${r1(y(hi))}`);
        const lower = band.slice().reverse().map(([cx, lo]) => `${r1(cx)},${r1(y(lo))}`);
        parts.push(`<polygon class="of-band" points="${upper.concat(lower).join(' ')}"/>`);
      }
      band = [];
    };
    for (const b of buckets) {
      if (b.median === null || b.median === undefined) { flush(); run = false; continue; }
      const cx = Math.min(right, Math.max(left, x(b.t + step / 2)));
      band.push([cx, num(b.p25), num(b.p75)]);
      line += `${run ? 'L' : 'M'}${r1(cx)},${r1(y(b.median))}`;
      run = true;
    }
    flush();
    // each opening, gone ones underneath
    const hits = [];
    const drawn = points.slice().sort((a, b) => (ORDER[a[5]] || 0) - (ORDER[b[5]] || 0) || a[1] - b[1]);
    const dots = [];
    for (const p of drawn) {
      const [id, t, est, lo, hi, kind, fitKind] = p;
      const cx = r1(x(t));
      const cy = r1(y(est));
      const later = fitKind === 'later' ? ' later' : '';
      // Seen more than once: from its last sighting up to the look that found it gone.
      if (hi !== null && hi !== undefined && hi > lo && lo > 0) {
        dots.push(`<line class="of-span ${esc(kind)}${later}" x1="${cx}" x2="${cx}" y1="${r1(y(Math.max(lo, Y_MIN)))}" y2="${r1(y(hi))}"/>`);
      }
      if (kind === 'open') dots.push(`<path class="of-rise" d="M${cx},${r1(cy - 8)} l-3,4 h6 z"/>`);
      dots.push(`<circle class="of-dot ${esc(kind)}${later}${focus === id ? ' focus' : ''}" cx="${cx}" cy="${cy}" r="${focus === id ? 5.5 : 3.6}" data-pid="${Number(id)}"/>`);
      hits.push({ id, x: cx, y: cy });
    }
    parts.push(dots.join(''));
    if (line) parts.push(`<path class="of-median" d="${line}"/>`);
    if (!points.length) {
      parts.push(`<text class="rc-empty" x="${r1((left + right) / 2)}" y="${r1((PAD.t + PLOT_BOTTOM) / 2)}" text-anchor="middle">No openings came here in the last ${esc(RANGE_WORDS[doc.hours] || `${doc.hours} hours`)}</text>`);
    }
    const label = `How long each opening lasted, over the last ${RANGE_WORDS[doc.hours] || ''}`;
    const svg = `<svg class="rc-svg of-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg>`;
    return { svg, hits, width: W, height: H };
  }

  /** The legend under the plot, for what this feed holds. */
  function legend(doc) {
    const kinds = new Set((doc.points || []).map((p) => p[5]));
    const keys = [['gone', 'Gone'], ['open', 'Open now'], ['booked', 'Booked via LineRight'], ['offered', 'Offered to a bidder'], ['yours', 'Yours']]
      .filter(([k]) => kinds.has(k) || k === 'gone');
    const out = keys.map(([k, words]) => `<span class="of-key"><i class="of-swatch ${k}"></i>${esc(words)}</span>`);
    out.push('<span class="of-key"><i class="of-swatch median"></i>Median, with its middle half</span>');
    if ((doc.points || []).some((p) => p[6] === 'later')) out.push('<span class="of-key"><i class="of-swatch gone later"></i>Faded: later than your bid took</span>');
    return out.join('');
  }

  /** The tooltip for one opening. */
  function tip(item, doc) {
    const tz = doc.timezone || 'UTC';
    const l = lasted(item);
    const o = outcome(item);
    const f = fit(item);
    return `<div class="rc-tip-t">${esc(item.office)}${item.miles !== null && item.miles !== undefined ? ` · ${esc(item.miles)} mi` : ''}</div>
      <div>Slot <b>${esc(slot(item.slot))}</b></div>
      <div>Came <b>${esc(day(tz, item.t, doc.now))} ${esc(clock(tz, item.t))}</b></div>
      <div>Lasted <b>${esc(l.text)}</b></div>
      <div>Then <b>${esc(o.label)}</b></div>
      ${f ? `<div class="of-tip-note">${esc(f)}</div>` : ''}`;
  }

  // ----------------------------------------------------------------- the list
  /** The bar beside a row: how long it lasted, on the plot's own scale. */
  function barShare(est, top) {
    const v = Math.min(top, Math.max(Y_MIN, num(est)));
    return Math.max(3, Math.round(((Math.log(v) - Math.log(Y_MIN)) / (Math.log(top) - Math.log(Y_MIN))) * 100));
  }

  function rows(doc, { shown = 40, focus = null } = {}) {
    const tz = doc.timezone || 'UTC';
    const items = Array.isArray(doc.items) ? doc.items : [];
    const top = yTop(doc.points || []);
    let lastDay = '';
    const out = [];
    for (const item of items.slice(0, shown)) {
      const d = day(tz, item.t, doc.now);
      if (d !== lastDay) { out.push(`<div class="of-day">${esc(d)}</div>`); lastDay = d; }
      const l = lasted(item);
      const o = outcome(item);
      const f = fit(item);
      out.push(`<div class="of-row ${esc(o.tone)}${item.fit === 'later' ? ' later' : ''}${focus === item.id ? ' focus' : ''}" data-pid="${Number(item.id)}">
        <div class="of-when num">${esc(clock(tz, item.t))}</div>
        <div class="of-what"><div><b>${esc(item.office)}</b>${item.miles !== null && item.miles !== undefined ? ` <span class="muted tiny">${esc(item.miles)} mi</span>` : ''}</div>
          <div class="tiny muted">${esc(slot(item.slot))} · ${esc(ahead(item.lead_h))}</div></div>
        <div class="of-life" title="${esc(l.detail)}"><div class="of-bar"><i class="${esc(o.tone)}" style="width:${barShare(item.est, top)}%"></i></div><span class="small">${esc(l.text)}</span></div>
        <div class="of-out"><span class="of-tag ${esc(o.tone)}">${esc(o.label)}</span>${f ? `<span class="tiny muted">${esc(f)}</span>` : ''}</div>
      </div>`);
    }
    return out.join('');
  }

  /** What a short lasting means here, under the list. */
  function basis(doc) {
    const look = num(doc && doc.look_seconds);
    const every = look ? ` The offices are looked at about every ${dur(look).replace('under a minute', 'minute')}, so one that went quickly may have lasted anywhere under that.` : '';
    return `How long: from the look that first saw it to the first look that found it gone, taken as the middle of the last look that saw it and the first that did not.${every} Times are the line's own clock (${(doc && doc.timezone) || 'UTC'}).`;
  }

  // ------------------------------------------------- how reading the line goes
  // The site watches every line slowly (its linewatch.py): what the last look at
  // each office saw, and any trouble the robots have reading the line.
  const WATCH_TONE = { ok: 'ok', trouble: 'bad', blocked: 'warn', unwatched: 'muted' };
  const CHECKS = { due: 'Another app will look again soon.', waiting: 'Another app found the same; an AI check waits its turn.',
    issued: 'Another app is looking again now.', agent: 'An AI is checking the booking site now.', skipped: '', passed: '', done: '' };

  /** "3 h ago" from a stamp, against `nowMs`. */
  function ago(stamp, nowMs = Date.now()) {
    const t = Date.parse(stamp || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (nowMs - t) / 1000);
    return s < 90 ? 'just now' : `${dur(s)} ago`;
  }

  /** A line's reading in a few words, for a chip: { text, tone, title }, or null. */
  function watchChip(w, nowMs = Date.now()) {
    if (!w) return null;
    if (w.state === 'trouble') return { text: '⚠ The robots cannot read this line', tone: 'bad', title: `${w.label}.` };
    if (w.state === 'blocked') return { text: '⚠ A human check stops the robots', tone: 'warn', title: `${w.label}.` };
    if (w.soonest) {
      return { text: `Soonest seen: ${slot(`${w.soonest.date} ${w.soonest.time || '00:00'}`)} at ${w.soonest.office}`, tone: 'ok',
        title: `Seen ${ago(w.soonest.seen_at, nowMs)}. A time seen a while ago may be gone by now.` };
    }
    if (w.state === 'unwatched') return { text: 'Not looked at lately', tone: 'muted', title: `${w.label}.` };
    return { text: 'Nothing open seen lately', tone: 'muted', title: w.read_at ? `Last read ${ago(w.read_at, nowMs)}.` : '' };
  }

  /** One office as the last look saw it. */
  function watchRow(o, nowMs) {
    const what = o.date ? `<b>${esc(slot(`${o.date} ${o.time || '00:00'}`))}</b>`
      : o.ok ? '<span class="muted">nothing open</span>' : `<span class="warn">${esc(o.error || 'could not be read')}</span>`;
    return `<div class="ow-row">
        <div class="ow-office"><b>${esc(o.office)}</b>${o.miles !== null && o.miles !== undefined ? ` <span class="tiny muted">${esc(o.miles)} mi</span>` : ''}</div>
        <div class="ow-soonest small">${what}${o.ok && o.found > 1 ? ` <span class="tiny muted">${esc(o.found)} times seen</span>` : ''}</div>
        <div class="ow-when tiny muted">${esc(ago(o.read_at, nowMs))}</div>
      </div>`;
  }

  /** The feed card's part on how reading these offices goes, and what each showed: HTML. */
  function watchBlock(w, { shown = 8, nowMs = Date.now() } = {}) {
    if (!w) return '';
    const at = w.at || [];
    const tone = WATCH_TONE[w.state] || 'muted';
    const meta = [w.offices ? `${w.read_24h} of ${w.offices} offices read in 24 h` : '',
      w.read_at ? `last read ${ago(w.read_at, nowMs)}` : ''].filter(Boolean).join(' · ');
    const issue = w.issue;
    const trouble = issue ? `<p class="small ${tone}" style="margin:6px 0 0">Since ${esc(ago(issue.since, nowMs))}: ${esc(issue.reads)} look${issue.reads === 1 ? '' : 's'} by ${esc(issue.apps)} app${issue.apps === 1 ? '' : 's'} could read nothing. ${esc(CHECKS[issue.check] || '')}</p>` : '';
    const advice = (w.advice || []).length ? `<ul class="ow-advice">${w.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
    const list = at.length ? `<div class="ow-list">${at.slice(0, shown).map((o) => watchRow(o, nowMs)).join('')}</div>
        ${at.length > shown ? `<button type="button" class="btn btn-sm btn-block" data-ow-more style="margin-top:6px">Show all ${esc(at.length)}</button>` : ''}`
      : '<p class="small muted" style="margin:6px 0 0">No office here has been looked at yet.</p>';
    const unread = Number(w.unread) ? ` ${esc(w.unread)} not looked at yet.` : '';
    return `<div class="ow" id="ofWatch">
        <div class="ow-head"><span class="ow-dot ${esc(tone)}"></span><b class="small">${esc(w.label)}</b><span class="tiny muted">${esc(meta)}</span></div>
        ${trouble}${advice}
        <div class="panel-title" style="margin:12px 0 4px">Soonest seen at each office</div>
        ${list}
        <p class="tiny muted" style="margin:6px 0 0">As the last look at each office saw it: a time seen hours ago may be gone. Every office is looked at now and then, and those somebody bids on more often.${unread}</p>
      </div>`;
  }

  return { RANGE_WORDS, body, key, dur, short, lasted, outcome, fit, wall, offset, clock, day, slot, ahead,
    hourText, scopeText, tiles, plot, legend, tip, rows, basis, yTop, ago, watchChip, watchBlock };
});
