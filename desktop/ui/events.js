/* What happened, and the last of it that matters, said until it is closed.

   The site keeps the history of a person's bids, turns, bookings and credits
   (its history.py) and words every entry. Each sync carries the significant
   ones of the last fortnight (`doc.events`); the History page asks for the
   whole of it, a page at a time. The app adds a few of its own (`app`): an
   update that this computer cannot install by itself (a Mac, whose app is not
   signed with an Apple Developer ID).

   The bar along the top shows the newest significant one nobody closed, and
   stays — across restarts — until it is closed; then the next one shows, so
   none goes by unseen. Closed keys are kept by the main process. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.eventsBar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /** How far back the bar looks: older events are in History, not on the bar. */
  const BAR_DAYS = 14;
  const MARKS = { ok: '✓', bad: '✗', warn: '!', info: 'i' };
  const ICONS = {
    placed: '＋', changed: '✎', widened: '↔', turn: '☞', missed: '⧗', passed: '↷', booked: '✓',
    withdrawn: '↩', ended: '■', bought: '⧗', earned: '⧗', topup: '⧗', appointment_soon: '◷',
    appointment_passed: '✓', cancelled: '✗', update_manual: '⇩', refunded: '↩',
  };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function when(at) {
    const t = Date.parse(at);
    return Number.isFinite(t) ? t : NaN;
  }

  /** Every event the bar may show, newest first, once each by key. */
  function merged(serverEvents, appEvents) {
    const seen = new Set();
    const out = [];
    for (const e of [...(Array.isArray(serverEvents) ? serverEvents : []), ...(Array.isArray(appEvents) ? appEvents : [])]) {
      if (!e || typeof e.key !== 'string' || !e.key || seen.has(e.key) || !Number.isFinite(when(e.at))) continue;
      seen.add(e.key);
      out.push(e);
    }
    return out.sort((a, b) => when(b.at) - when(a.at));
  }

  /**
   * The event for the bar: the newest significant one of the last BAR_DAYS
   * not closed, and how many more like it wait behind it.
   */
  function pick(serverEvents, appEvents, closed, now = Date.now()) {
    const shut = new Set(Array.isArray(closed) ? closed : []);
    const open = merged(serverEvents, appEvents).filter((e) => e.significant !== false
      && !shut.has(e.key) && now - when(e.at) <= BAR_DAYS * 86400000);
    return { event: open[0] || null, more: Math.max(0, open.length - 1) };
  }

  /** "Mon, Nov 2 at 2:30 PM" from an instant, in this computer's time, in English. */
  function stamp(at) {
    const t = when(at);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }

  /** The button an event offers, besides closing it: [action, label], or null. */
  function action(e) {
    switch (e.action) {
      case 'bid_again': return e.queue_id ? ['bid_again', 'Bid again'] : null;
      case 'board': return e.queue_id ? ['board', 'Open the line'] : null;
      case 'bookings': return ['bookings', 'My Bookings'];
      case 'download': return e.url ? ['download', e.version ? `Download ${e.version}` : 'Download'] : null;
      case 'history': return ['history', 'History'];
      default: return null;
    }
  }

  /** The bar's inside, for one event; `more` events wait behind it. */
  function bar(e, more = 0) {
    const tone = MARKS[e.tone] ? e.tone : 'info';
    const act = action(e);
    const steps = Array.isArray(e.steps) && e.steps.length
      ? `<ol class="ev-steps">${e.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
    return `<span class="mark">${esc(ICONS[e.kind] || MARKS[tone])}</span>
      <span class="text"><b>${esc(e.title)}</b>${e.text ? ` · ${esc(e.text)}` : ''}${steps}
        <span class="ev-when">${esc(stamp(e.at))}${e.queue_name ? ` · ${esc(e.queue_name)}` : ''}${more ? ` · ${more} more not yet seen` : ''}</span></span>
      <span class="actions">
        ${act ? `<button class="pill primary" data-ev="${esc(act[0])}">${esc(act[1])}</button>` : ''}
        ${e.action !== 'history' ? '<button class="pill" data-ev="history">History</button>' : ''}
        <button class="pill" data-ev="close" title="Close: it stays in History" aria-label="Close">×</button>
      </span>`;
  }

  /** The day an event is filed under, in this computer's time: "Sunday, November 1". */
  function day(at) {
    const t = when(at);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  }

  /** The History page's list: one row an event, under its day, newest first. */
  function timeline(events) {
    const list = merged(events, []);
    if (!list.length) return '<div class="empty">Nothing has happened yet. Your bids, turns, bookings and credits will be listed here.</div>';
    let out = '';
    let current = '';
    for (const e of list) {
      const d = day(e.at);
      if (d !== current) {
        if (current) out += '</div>';
        out += `<h3 class="hist-day">${esc(d)}</h3><div class="hist-group">`;
        current = d;
      }
      const tone = MARKS[e.tone] ? e.tone : 'info';
      const act = action(e);
      out += `<div class="hist-row hist-${esc(tone)}" data-key="${esc(e.key)}">
        <span class="hist-icon">${esc(ICONS[e.kind] || MARKS[tone])}</span>
        <span class="hist-time">${esc(new Date(when(e.at)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span>
        <span class="hist-what"><b>${esc(e.title)}</b>${e.text ? `<br><span class="small">${esc(e.text)}</span>` : ''}${e.bid_id ? `<br><span class="tiny muted">Bid #${esc(e.bid_id)}${e.queue_name ? ` · ${esc(e.queue_name)}` : ''}</span>` : ''}</span>
        <span class="hist-act">${act && act[0] !== 'history' ? `<button class="btn btn-sm" data-ev="${esc(act[0])}" data-key="${esc(e.key)}">${esc(act[1])}</button>` : ''}</span>
      </div>`;
    }
    return `${out}</div>`;
  }

  return { BAR_DAYS, merged, pick, bar, timeline, action, stamp, day };
});
