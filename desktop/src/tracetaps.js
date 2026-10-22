'use strict';
/**
 * Where a trace's events (traces.js) come from, besides what main.js says
 * itself: the app's logs as they are written, and each robot run as it ends.
 *
 * The logs (logbook.js) already hold everything — every page in a tab and
 * every request it made, every exchange with the site, the app's own account
 * of what it did. The logbook hands each record here as it writes it, and this
 * turns it into the trace's shorter, scrubbable form:
 *
 *   tab.open / tab.close           a tab, and how long it was open
 *   page.go / page.at / page.load  where a tab went, the status that came back,
 *   page.fail                      how long the page took, or how it failed
 *   net                            one request: method, address, type, status,
 *                                  time to the answer's headers and to its end,
 *                                  size — the documents and data a page asked
 *                                  for, and anything that failed
 *   page.res                       the rest of a page's requests, counted
 *   page.act                       a click, a change, a submit: the element, and
 *                                  for a field only how long and what shape
 *                                  its value was, never the value
 *   page.console                   what a page said that was a warning or an error
 *   human.check                    a page met a captcha: which, and how far it went
 *   page.note                      what the app did on a page: autofill (which
 *                                  fields), a confirmation found, a card shown
 *   site.call                      every exchange with the site but the routine
 *                                  syncs and pings (app.stats counts those)
 *   app.log                        the app's own log, line by line
 *
 * Only a booking page is followed this closely: a tab of a hand-off, or one on
 * a booking site's address. Anywhere else a tab goes — the person's own
 * browsing — the trace says only which site, never which page or what was done.
 *
 * A robot run (robots.js) is read back from its own record of itself
 * (events.jsonl: dmq's instrument.js) when it ends: robot.end says how it went
 * — how long, what it answered, how many requests and of what, the slowest,
 * any captcha. A booking run, or a look that did not go as it should, has its
 * steps, pages, requests and console errors besides; a look that went fine,
 * which is what an app does all day, is the one event.
 */
const nodeFs = require('node:fs');
const path = require('node:path');
const { shape } = require('./scrub');

const DATA = new Set(['document', 'xhr', 'fetch']);
const ROBOT_EVENTS = 400;
/** The captchas a booking site may put in front of a person or a robot, and how far one went. */
const HUMAN = [
  { name: 'recaptcha', host: /(^|\.)(google\.com|gstatic\.com|recaptcha\.net)$/, path: /\/recaptcha\// },
  { name: 'hcaptcha', host: /(^|\.)hcaptcha\.com$/, path: null },
  { name: 'turnstile', host: /^challenges\.cloudflare\.com$/, path: null },
  { name: 'arkose', host: /(^|\.)(arkoselabs\.com|funcaptcha\.com)$/, path: null },
  { name: 'datadome', host: /(^|\.)captcha-delivery\.com$/, path: null },
];

/** Which captcha `url` belongs to, and the stage it says: script, anchor, challenge, verify. */
function humanCheck(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const found = HUMAN.find((h) => h.host.test(u.hostname) && (!h.path || h.path.test(u.pathname)));
  if (!found) return null;
  const p = u.pathname.toLowerCase();
  const stage = /bframe|getcaptcha|challenge/.test(p) ? 'challenge'
    : /userverify|checkcaptcha|verify/.test(p) ? 'verify'
      : /anchor|checksiteconfig/.test(p) ? 'anchor'
        : /\.js$|api\.js|enterprise/.test(p) ? 'script' : null;
  return stage ? { provider: found.name, stage } : null;
}

/** A console level as Electron gives it, old (0-3) or new ('warning'), as a number. */
function level(value) {
  if (typeof value === 'number') return value;
  return { verbose: 0, debug: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3 }[String(value).toLowerCase()] ?? 1;
}

const host = (url) => { try { return new URL(url).host; } catch { return ''; } };
const origin = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : `${u.protocol}`; } catch { return undefined; } };
const kb = (bytes) => (Number.isFinite(bytes) ? Math.round(bytes / 102.4) / 10 : undefined);
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : undefined);

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
}

/** The most-used keys of a count, at most `n`. */
function top(counts, n = 8) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n));
}

class TraceTaps {
  /**
   * @param {object} opts
   * @param {function} opts.add         traces.add(kind, fields, {at})
   * @param {function} [opts.learn]     scrubber.learn(label, value): a value to take out from now on
   * @param {function} [opts.isBooking] whether an address is a booking site's
   */
  constructor({ add, learn = () => {}, isBooking = () => false, now = Date.now, fs = nodeFs }) {
    Object.assign(this, { addEvent: add, learn, isBooking, now, fs });
    this.tabs = new Map();
  }

  add(kind, fields, opts) {
    try { return this.addEvent(kind, fields, opts); } catch { return null; }
  }

  // ------------------------------------------------------------- the logbook
  /** logbook.event(name, record), as it is written. */
  logbookEvent(name, record) {
    try {
      if (name === 'pages') this.page(record || {});
      else if (name === 'site') this.site(record || {});
    } catch { /* a trace is never the problem */ }
  }

  /** logbook.line(name, text), as it is written. */
  logbookLine(name, text) {
    if (name === 'app') this.add('app.log', { text });
  }

  tab(r) {
    let t = this.tabs.get(r.tab);
    if (!t) {
      t = { id: r.tab, kind: r.kind, job: r.job || null, opened: this.now(), booking: Boolean(r.job), pages: 0,
        nav: null, pending: new Map(), human: new Set() };
      this.tabs.set(r.tab, t);
    }
    if (r.job && !t.job) { t.job = r.job; t.booking = true; }
    // A turn's tab handed on to the next turn on its line (main.js turnTab).
    if (r.type === 'reused' && r.job) { t.job = r.job; t.booking = true; }
    return t;
  }

  /** An address as a tab's trace shows it: whole (scrubbed) on a booking page, the site alone elsewhere. */
  where(t, url) {
    return t.booking ? url : origin(url);
  }

  page(r) {
    const t = this.tab(r);
    const b = { tab: t.id, job: t.job || undefined };
    switch (r.type) {
      case 'opened':
        t.booking = Boolean(t.job) || this.isBooking(r.url);
        return this.add('tab.open', { ...b, kind: t.kind, url: this.where(t, r.url), network: r.network });
      case 'closed':
        this.tabs.delete(t.id);
        return this.add('tab.close', { ...b, open_ms: this.now() - t.opened, pages: t.pages });
      case 'navigating':
        t.booking = Boolean(t.job) || this.isBooking(r.url);
        t.nav = { at: this.now() };
        t.pages += 1;
        t.human = new Set();
        t.pending.clear();
        return this.add('page.go', { ...b, url: this.where(t, r.url) });
      case 'navigated':
        if (r.inPage && !t.booking) return null;
        return this.add('page.at', { ...b, url: this.where(t, r.url), st: r.status, in_page: r.inPage || undefined });
      case 'loaded':
        return this.add('page.load', { ...b, url: this.where(t, r.url), title: t.booking ? r.title : undefined,
          ms: t.nav ? this.now() - t.nav.at : undefined });
      case 'load-failed':
        return this.add('page.fail', { ...b, url: this.where(t, r.url), code: r.code, err: r.error });
      case 'crashed':
        return this.add('page.crash', { ...b, why: r.reason, code: r.code });
      case 'unresponsive':
        return this.add('page.hang', b);
      case 'responsive':
        return this.add('page.ok', b);
      case 'network-off':
      case 'recorder':
        return this.add('page.warn', { ...b, what: r.type, why: r.why || r.error });
      default:
        break;
    }
    // The person's own browsing: which site, and nothing of what was on it or done there.
    if (!t.booking) return null;
    switch (r.type) {
      case 'request': {
        const human = humanCheck(r.url);
        if (human && !t.human.has(`${human.provider}:${human.stage}`)) {
          t.human.add(`${human.provider}:${human.stage}`);
          this.add('human.check', { ...b, ...human, url: r.url });
        }
        const rt = lower(r.rtype);
        if (DATA.has(rt)) {
          t.pending.set(r.id, { m: r.method, url: r.url, rt, from: r.redirectedFrom ? r.redirectedFrom.status : undefined });
          if (t.pending.size > 500) t.pending.delete(t.pending.keys().next().value);
        }
        return null;
      }
      case 'response': {
        const p = t.pending.get(r.id);
        if (p) Object.assign(p, { st: r.status, mime: r.mime, cache: r.cached || undefined, head_ms: r.ms });
        else if (r.status >= 400) {
          return this.add('net', { ...b, url: r.url, rt: lower(r.rtype), st: r.status, head_ms: r.ms, mime: r.mime });
        }
        return null;
      }
      case 'done': {
        const p = t.pending.get(r.id);
        if (!p) return null;
        t.pending.delete(r.id);
        return this.add('net', { ...b, m: p.m, url: p.url, rt: p.rt, st: p.st, ms: r.ms, head_ms: p.head_ms,
          kb: kb(r.bytes), mime: p.mime, cache: p.cache, redirected: p.from });
      }
      case 'failed': {
        const p = t.pending.get(r.id) || {};
        t.pending.delete(r.id);
        const rt = lower(r.rtype) || p.rt;
        // A picture or a script let go because the page moved on is not a failure.
        if (r.canceled && !DATA.has(rt)) return null;
        return this.add('net', { ...b, m: p.m, url: r.url || p.url, rt, st: p.st, ms: r.ms, err: r.error,
          blocked: r.blocked, canceled: r.canceled });
      }
      case 'resources':
        return this.add('page.res', { ...b, n: r.n, kb: kb(r.bytes), failed: r.failed || undefined,
          slow_ms: r.slowest_ms, slow_url: r.slowest_url, types: r.types, hosts: r.hosts });
      case 'action':
        return this.add('page.act', { ...b, ...this.action(r) });
      case 'console': {
        const lvl = level(r.level);
        if (lvl < 2) return null;
        return this.add('page.console', { ...b, lvl: lvl >= 3 ? 'error' : 'warn', text: r.text, src: r.source, line: r.line });
      }
      case 'snapshot':
      case 'body':
        return null;
      default:
        return this.note(t, b, r);
    }
  }

  /** A click or a change: the element, and of a field's value only its length and shape. */
  action(r) {
    const out = { act: r.action, el: pick(r.target, ['tag', 'id', 'name', 'type', 'role', 'label', 'text', 'href', 'path']) };
    if (r.chosen !== undefined) out.chosen = r.chosen;
    if (r.checked !== undefined) out.checked = r.checked;
    if (r.value !== undefined) out.v = shape(r.value);
    if (r.length !== undefined) out.v = { len: r.length, personal: true };
    return out;
  }

  /** What main.js put on the page (pageNote): autofill, a confirmation, a card, a report to the site. */
  note(t, b, r) {
    const { tab, kind, job, type, t: _t, ref, ...rest } = r;
    if (ref) this.learn('confirmation', ref);
    const fields = { ...b, type };
    if (type === 'autofill') {
      Object.assign(fields, pick(rest, ['asked', 'filled', 'skipped', 'error']));
      if (Array.isArray(rest.fields)) fields.fields = rest.fields.map((f) => pick(f, ['key', 'how'])).filter(Boolean);
    } else {
      Object.assign(fields, rest);
      if (ref) fields.ref = true;
    }
    return this.add('page.note', fields);
  }

  /** An exchange with the site. The routine ones — syncs and pings that worked — are counted elsewhere. */
  site(r) {
    const where = String(r.path || '').split('?')[0];
    const ok = r.status >= 200 && r.status < 400;
    if (ok && /^\/api\/client\/(?:sync|ping)$/.test(where)) return null;
    if (/^\/api\/client\/traces$/.test(where)) return null;
    const reply = r.reply && typeof r.reply === 'object' && !Array.isArray(r.reply) ? r.reply : null;
    return this.add('site.call', { m: r.method, path: where, st: r.status, ms: r.ms,
      err: r.error ? r.error.message : undefined,
      res: reply ? pick(reply, ['status', 'ok', 'recorded', 'duplicate', 'phase', 'verdict']) : undefined });
  }

  // -------------------------------------------------------------- the robots
  /**
   * One robot run, ended (robots.js onFinish): {kind, dir, answer, ms, code,
   * signal, timedOut, context: {job, read}}. Reads the run's own record back
   * from `dir`; resolves once its events are in the trace.
   */
  async robotRun(run = {}) {
    try {
      await this.robot(run);
    } catch { /* a trace is never the problem */ }
  }

  async robot({ kind = '', dir = '', answer = {}, ms, code, signal, timedOut, context = {} }) {
    const reply = answer || {};
    if (reply.confirmation) this.learn('confirmation', reply.confirmation);
    let lines = [];
    if (dir) {
      try { lines = (await this.fs.promises.readFile(path.join(dir, 'events.jsonl'), 'utf8')).split('\n'); } catch { /* no record */ }
    }
    const checked = Array.isArray(reply.checked) ? reply.checked : [];
    const fine = reply.status === 'confirmed' && !reply.gate && !checked.some((c) => c && c.error);
    const detail = kind === 'book' || !fine;
    const base = { run: dir ? path.basename(dir).slice(0, 19) : undefined, robot: kind, job: context.job, read: context.read };
    const sum = { req: 0, failed: 0, st: {}, hosts: {}, steps: {}, pages: 0, console_errors: 0 };
    const slow = [];
    const asked = new Map();
    const humans = new Set();
    let emitted = 0;
    const emit = (k, fields, at) => {
      if (!detail || emitted >= ROBOT_EVENTS) return;
      emitted += 1;
      this.add(k, { ...base, ...fields }, { at });
    };
    for (const line of lines) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const at = Date.parse(e.t) || undefined;
      switch (e.type) {
        case 'request': {
          sum.req += 1;
          const h = host(e.url);
          if (h) sum.hosts[h] = (sum.hosts[h] || 0) + 1;
          asked.set(e.id, { at, m: e.method, url: e.url, rt: lower(e.rtype) });
          const human = humanCheck(e.url);
          if (human && !humans.has(`${human.provider}:${human.stage}`)) {
            humans.add(`${human.provider}:${human.stage}`);
            this.add('human.check', { ...base, ...human, url: e.url }, { at });
          }
          break;
        }
        case 'response': {
          const q = asked.get(e.id);
          asked.delete(e.id);
          const cls = `${String(e.status).charAt(0)}xx`;
          sum.st[cls] = (sum.st[cls] || 0) + 1;
          const taken = q && q.at && at ? at - q.at : undefined;
          const rt = lower(e.rtype) || (q && q.rt);
          if (DATA.has(rt) && Number.isFinite(taken)) {
            slow.push({ url: e.url, ms: taken });
            slow.sort((a, b) => b.ms - a.ms);
            slow.splice(3);
          }
          if (DATA.has(rt) || e.status >= 400) emit('net', { m: q && q.m, url: e.url, rt, st: e.status, ms: taken, mime: e.mime }, at);
          break;
        }
        case 'failed':
          sum.failed += 1;
          emit('net', { url: e.url, rt: lower(e.rtype), err: e.error }, at);
          break;
        case 'navigated':
          sum.pages += 1;
          emit('robot.nav', { url: e.url }, at);
          break;
        case 'step':
          sum.steps[e.tag] = (sum.steps[e.tag] || 0) + 1;
          emit('robot.step', { tag: e.tag, detail: e.detail }, at);
          break;
        case 'console':
          if (level(e.level) >= 2) {
            sum.console_errors += 1;
            emit('robot.console', { lvl: level(e.level) >= 3 ? 'error' : 'warn', text: e.text }, at);
          }
          break;
        case 'pageerror':
          emit('robot.error', { msg: e.message }, at);
          break;
        case 'dialog':
          emit('robot.dialog', { kind: e.kind, msg: e.message }, at);
          break;
        default:
          break;
      }
    }
    const offers = Array.isArray(reply.offers) ? reply.offers : [];
    return this.add('robot.end', {
      ...base, ms, status: reply.status, msg: reply.message, gate: reply.gate ? (reply.gate.kind || 'gate') : undefined,
      code: code === 0 ? undefined : code, signal, timed_out: timedOut || undefined,
      offices: checked.length || undefined, blocked: checked.filter((c) => c && c.error).length || undefined,
      found: offers.length || undefined, booked: reply.confirmation ? true : undefined,
      slot_gone: reply.slot_gone || undefined, detail: detail || undefined,
      req: sum.req, failed: sum.failed || undefined, st: sum.st, pages: sum.pages || undefined,
      steps: top(sum.steps, 20), hosts: top(sum.hosts), slow: slow.length ? slow : undefined,
      console_errors: sum.console_errors || undefined, cut: emitted >= ROBOT_EVENTS || undefined,
    });
  }
}

module.exports = { TraceTaps, humanCheck, level };
