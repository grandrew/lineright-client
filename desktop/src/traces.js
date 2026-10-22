'use strict';
/**
 * A trace of what this app did, kept on this computer until the LineRight
 * Regbot site asks for it — the person taken out of it first (scrub.js).
 *
 * The app already writes down everything it does, for its person, in its logs
 * folder (logbook.js): every page in its tabs and every request they made,
 * what its robots did on a booking site, every exchange with the site. That
 * stays here, names and all. The trace is the part of it the people running
 * LineRight Regbot need to see how the apps are doing: whether a turn reached
 * the app, whether it was booked and how, where it went wrong — which page,
 * which request, how long each took, what the robots saw, what the app said to
 * its person. One event at a time, each numbered (`s`), timed by this
 * computer's clock (`t`, epoch milliseconds), named by its kind (`k`), and
 * scrubbed: no profile detail, no confirmation number, no field anybody typed,
 * no query value that could be one (scrub.js).
 *
 * Nothing is sent of the app's own accord. The site says on every sync whether
 * it wants a trace and how much of it — `{level, acked, ask}` — and the app
 * answers an ask with the events after the one the site already has, in one
 * gzipped upload of the size the site set (main.js, client.uploadTraces). That
 * is how the site keeps the uploads from all its apps to what it can take: it
 * asks one app at a time, as often as it likes. What the site has acknowledged
 * is deleted here; what it never asks for is gone after a week, or once there is
 * more of it than `maxBytes`, the oldest first.
 *
 * The person can turn it off (Advanced): then nothing is written, and what was
 * kept is deleted.
 *
 *   <user data>/traces/state.json           the numbering, what the site has, the switch
 *   <user data>/traces/000000000001.jsonl   the events, one a line, a megabyte a file
 *
 * Plain Node, its clock and its files handed in, so it runs under `node --test`.
 */
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SCHEMA = 'regbot.app-trace/1';
const LEVELS = ['off', 'outline', 'full'];
/** What only a full trace has: every request, console lines, counts of a page's resources. */
const DETAIL = new Set(['net', 'page.console', 'page.res', 'robot.console', 'robot.nav']);
/** What the site would want soon: a turn and how it went, a human check, something broken. */
const URGENT = /^(?:handoff\.|book\.|human\.|app\.error|app\.crash|page\.crash)/;
const KIND = /^[a-z][a-z0-9_.-]{0,39}$/;
const SEGMENT = /^(\d{12})\.jsonl$/;
const SEGMENT_BYTES = 1024 * 1024;
const MAX_EVENT = 8 * 1024;
const DAY_MS = 24 * 3600 * 1000;

const segmentName = (first) => `${String(first).padStart(12, '0')}.jsonl`;
const newStream = () => crypto.randomBytes(8).toString('hex');

class TraceStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir          <user data>/traces, absolute; none keeps nothing on disk
   * @param {object} opts.scrubber     a Scrubber (scrub.js): every event goes through it, twice
   * @param {number} [opts.maxBytes]   past this, the oldest events go, sent or not
   * @param {number} [opts.keepDays]   events never asked for go after this long
   * @param {number} [opts.perMinute]  at most this many events a minute; past it they are counted, not kept
   */
  constructor({ dir = null, scrubber, now = Date.now, fs = nodeFs, maxBytes = 64 * 1024 * 1024, keepDays = 7,
    perMinute = 3000, flushMs = 2000, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    if (dir && !path.isAbsolute(dir)) throw new Error('A trace needs an absolute folder.');
    if (!scrubber) throw new Error('A trace is never kept unscrubbed: hand it a Scrubber.');
    Object.assign(this, { dir, scrubber, now, fs, maxBytes, keepDays, perMinute, flushMs, setTimeout: st, clearTimeout: ct });
    this.state = { v: 1, stream: newStream(), next: 1, acked: 0, session: 0, level: 'full', on: true, lost: 0,
      uploads: [] };
    this.buffer = [];          // lines not yet on disk: [{s, line}]
    this.segments = [];        // [{file, first, last, bytes, at}]
    this.timer = null;
    this.dirty = false;
    this.urgent = false;
    this.minute = { at: 0, n: 0, dropped: {} };
    this.load();
  }

  // ---------------------------------------------------------------- keeping it
  load() {
    if (!this.dir) return;
    try {
      const saved = JSON.parse(this.fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'));
      if (saved && saved.v === 1 && typeof saved.stream === 'string' && /^[0-9a-f]{16}$/.test(saved.stream)) {
        this.state.stream = saved.stream;
        for (const key of ['next', 'acked', 'session', 'lost']) {
          if (Number.isInteger(saved[key]) && saved[key] >= 0) this.state[key] = saved[key];
        }
        if (LEVELS.includes(saved.level)) this.state.level = saved.level;
        if (typeof saved.on === 'boolean') this.state.on = saved.on;
        if (Array.isArray(saved.uploads)) this.state.uploads = saved.uploads.slice(-10);
      }
    } catch { /* nothing kept yet, or unreadable: start afresh */ }
    let names = [];
    try { names = this.fs.readdirSync(this.dir).filter((n) => SEGMENT.test(n)).sort(); } catch { /* no folder yet */ }
    for (const name of names) {
      const file = path.join(this.dir, name);
      let st;
      try { st = this.fs.statSync(file); } catch { continue; }
      this.segments.push({ file, first: Number(name.match(SEGMENT)[1]), last: 0, bytes: st.size, at: st.mtimeMs });
    }
    // Each file ends where the next begins; the last one says itself.
    for (let i = 0; i < this.segments.length - 1; i += 1) this.segments[i].last = this.segments[i + 1].first - 1;
    const tail = this.segments[this.segments.length - 1];
    if (tail) {
      tail.last = tail.first - 1;
      for (const e of this.read(tail)) tail.last = Math.max(tail.last, e.s);
      // Written after the state was last saved (a crash): numbering carries on after it.
      this.state.next = Math.max(this.state.next, tail.last + 1);
    }
    if (this.state.acked > this.state.next - 1) this.state.acked = this.state.next - 1;
  }

  saveState() {
    if (!this.dir || !this.dirty) return;
    this.dirty = false;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'state.json');
      this.fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
      this.fs.renameSync(`${file}.tmp`, file);
    } catch { /* a trace is never the problem */ }
  }

  /** The events of one file, in order; a line a crash cut short is skipped. */
  read(segment) {
    let text = '';
    try { text = this.fs.readFileSync(segment.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && Number.isInteger(e.s)) out.push(e);
      } catch { /* cut short */ }
    }
    return out;
  }

  /** What is in the buffer, onto the disk: now and then, and before anything is read back. */
  flush() {
    if (this.timer) { this.clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length && this.dir) {
      const lines = this.buffer;
      this.buffer = [];
      try {
        this.fs.mkdirSync(this.dir, { recursive: true });
        let seg = this.segments[this.segments.length - 1];
        let chunk = [];
        let chunkBytes = 0;
        const write = () => {
          if (!chunk.length) return;
          const text = `${chunk.join('\n')}\n`;
          this.fs.appendFileSync(seg.file, text, { mode: 0o600 });
          seg.bytes += Buffer.byteLength(text);
          seg.at = this.now();
          chunk = [];
          chunkBytes = 0;
        };
        for (const { s, line } of lines) {
          if (!seg || seg.bytes + chunkBytes >= SEGMENT_BYTES) {
            if (seg) write();
            seg = { file: path.join(this.dir, segmentName(s)), first: s, last: s - 1, bytes: 0, at: this.now() };
            this.segments.push(seg);
          }
          chunk.push(line);
          chunkBytes += Buffer.byteLength(line) + 1;
          seg.last = s;
        }
        write();
      } catch { /* a trace is never the problem */ }
      this.dirty = true;
      if (this.bytes() > this.maxBytes) this.prune();
    } else if (!this.dir) {
      this.buffer.splice(0, Math.max(0, this.buffer.length - 5000));
    }
    this.saveState();
  }

  schedule() {
    if (this.timer || !this.dir) return;
    this.timer = this.setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  bytes() {
    return this.segments.reduce((n, s) => n + s.bytes, 0) + this.buffer.reduce((n, b) => n + b.line.length + 1, 0);
  }

  /** The first event still kept here; `next` when there is none. */
  oldest() {
    if (this.segments.length) return this.segments[0].first;
    if (this.buffer.length) return this.buffer[0].s;
    return this.state.next;
  }

  /**
   * The old go: whatever the site never asked for in `keepDays`, then the
   * oldest until what is left is under `maxBytes`. What went unsent is counted,
   * and the site sees the gap (status().oldest).
   */
  prune() {
    const cutoff = this.now() - this.keepDays * DAY_MS;
    const tail = this.segments[this.segments.length - 1];
    while (this.segments.length) {
      const seg = this.segments[0];
      const old = seg.at < cutoff;
      const big = this.bytes() > this.maxBytes;
      if (!old && !big) break;
      if (seg === tail && !old) {
        // The one being written: started afresh rather than kept growing.
        this.drop(seg);
        break;
      }
      this.drop(seg);
    }
  }

  drop(seg) {
    const unsent = Math.max(0, seg.last - Math.max(seg.first - 1, this.state.acked));
    try { this.fs.rmSync(seg.file, { force: true }); } catch { /* next time */ }
    this.segments.splice(this.segments.indexOf(seg), 1);
    if (unsent) this.state.lost += unsent;
    this.dirty = true;
  }

  // ----------------------------------------------------------- writing it down
  /** Whether events are being written: the person has it on, and the site wants them. */
  collecting() {
    return this.state.on && this.state.level !== 'off';
  }

  level() {
    return this.state.level;
  }

  /**
   * One event: `kind` and its fields, scrubbed, numbered and timed. Returns
   * what was kept, or null when nothing was (off, outline only, too many this
   * minute, not a kind).
   */
  add(kind, fields = {}, { at = null } = {}) {
    if (!this.collecting() || !KIND.test(kind)) return null;
    if (this.state.level === 'outline' && DETAIL.has(kind)) return null;
    const t = Math.round(at || this.now());
    if (!this.allow(kind, t)) return null;
    let clean;
    try { clean = this.scrubber.value(fields || {}); } catch { return null; }
    const event = { s: this.state.next, t, k: kind };
    for (const [key, value] of Object.entries(clean || {})) {
      if (value !== undefined && value !== null && !(key in event)) event[key] = value;
    }
    let line = JSON.stringify(event);
    if (line.length > MAX_EVENT) {
      // Too big to be one event: the biggest fields go until it is not.
      const keys = Object.keys(event).filter((k) => !['s', 't', 'k'].includes(k))
        .sort((a, b) => JSON.stringify(event[b]).length - JSON.stringify(event[a]).length);
      for (const key of keys) {
        event[key] = '[cut]';
        line = JSON.stringify(event);
        if (line.length <= MAX_EVENT) break;
      }
    }
    this.state.next += 1;
    this.dirty = true;
    this.buffer.push({ s: event.s, line });
    if (URGENT.test(kind)) this.urgent = true;
    this.schedule();
    return event;
  }

  /** At most `perMinute` events a minute; what is past it is counted, and said once the minute is over. */
  allow(kind, t) {
    const minute = Math.floor(t / 60000);
    if (minute !== this.minute.at) {
      const dropped = this.minute.dropped;
      const n = Object.values(dropped).reduce((a, b) => a + b, 0);
      this.minute = { at: minute, n: 0, dropped: {} };
      if (n) this.add('trace.dropped', { n, kinds: dropped });
    }
    if (this.minute.n >= this.perMinute) {
      this.minute.dropped[kind] = (this.minute.dropped[kind] || 0) + 1;
      return false;
    }
    this.minute.n += 1;
    return true;
  }

  // ------------------------------------------------------------- the site's side
  /** What every sync says about the trace: how far it goes, what is kept, whether the person allows it. */
  status() {
    return { schema: SCHEMA, stream: this.state.stream, next: this.state.next, oldest: this.oldest(),
      acked: this.state.acked, bytes: this.bytes(), urgent: this.urgent, on: this.state.on,
      level: this.state.level, lost: this.state.lost };
  }

  /** The site's `{level}`: how much to write down from now on. Anything else is ignored. */
  setLevel(level) {
    if (!LEVELS.includes(level) || level === this.state.level) return false;
    this.state.level = level;
    this.dirty = true;
    this.saveState();
    return true;
  }

  /**
   * The events after `after`, as many as fit `maxEvents` and `maxBytes`, each
   * scrubbed again with what the scrubber knows now (a confirmation number
   * learnt after an event was written). `gap` is a run the site asked for that
   * is not kept here any more.
   */
  batch({ after = 0, maxEvents = 2000, maxBytes = 1024 * 1024 } = {}) {
    this.flush();
    const from = Math.max(0, Number(after) || 0);
    const events = [];
    let bytes = 0;
    let full = false;
    const oldest = this.oldest();
    const gap = from + 1 < oldest && oldest > 1 ? { from: from + 1, to: oldest - 1 } : null;
    const take = (e) => {
      if (e.s <= from) return true;
      const again = this.rescrub(e);
      const size = JSON.stringify(again).length + 1;
      if (events.length >= maxEvents || (events.length && bytes + size > maxBytes)) return false;
      events.push(again);
      bytes += size;
      return true;
    };
    for (const seg of this.segments) {
      if (full) break;
      if (seg.last <= from) continue;
      for (const e of this.read(seg)) if (!take(e)) { full = true; break; }
    }
    // Without a folder, everything is still in the buffer.
    if (!full) for (const b of this.buffer) if (!take(JSON.parse(b.line))) break;
    const last = events.length ? events[events.length - 1].s : from;
    return { events, first: events.length ? events[0].s : null, last, gap, bytes,
      more: last < this.state.next - 1 };
  }

  rescrub(e) {
    const { s, t, k, ...rest } = e;
    let clean = rest;
    try { clean = this.scrubber.value(rest); } catch { /* as it was written */ }
    return { s, t, k, ...clean };
  }

  /**
   * The upload that answers `ask` ({id, after, max_events, max_kb}): the
   * events, and what the site needs to place them — which history they belong
   * to, how far it goes now, what is missing — gzipped.
   */
  upload(ask, app = {}) {
    const maxEvents = Math.max(1, Math.min(Number(ask.max_events) || 2000, 50000));
    const maxBytes = Math.max(16 * 1024, Math.min((Number(ask.max_kb) || 1024) * 1024, 8 * 1024 * 1024));
    const got = this.batch({ after: ask.after, maxEvents, maxBytes });
    const body = {
      schema: SCHEMA, ask: ask.id, stream: this.state.stream, after: Number(ask.after) || 0,
      first: got.first, last: got.last, more: got.more, next: this.state.next, oldest: this.oldest(),
      gap: got.gap, lost: this.state.lost, sent_at: this.now(), app, events: got.events,
    };
    const json = Buffer.from(JSON.stringify(body));
    return { body, json, gzip: zlib.gzipSync(json), events: got.events.length, last: got.last };
  }

  /**
   * The site has everything up to `seq`: it is deleted here, a whole file at a
   * time. A number past what was ever written is taken as what was written.
   */
  ack(seq) {
    const n = Math.min(Math.floor(Number(seq) || 0), this.state.next - 1);
    if (n <= this.state.acked) return false;
    this.state.acked = n;
    this.dirty = true;
    this.flush();
    while (this.segments.length && this.segments[0].last <= n) this.drop(this.segments[0]);
    if (!this.dir) this.buffer = this.buffer.filter((b) => b.s > n);
    this.saveState();
    return true;
  }

  /** What became of an upload, for the Advanced screen; a good one clears `urgent`. */
  noteUpload({ ok, events = 0, bytes = 0, message = '' } = {}) {
    this.state.uploads.push({ at: this.now(), ok: Boolean(ok), events, bytes, message: String(message).slice(0, 200) });
    this.state.uploads = this.state.uploads.slice(-10);
    if (ok) this.urgent = false;
    this.dirty = true;
    this.saveState();
  }

  // --------------------------------------------------------------- the person
  /** The person's switch. Off writes nothing more and deletes what was kept. */
  setOn(on) {
    const want = Boolean(on);
    if (want === this.state.on) return false;
    this.clear();
    this.state.on = want;
    this.dirty = true;
    this.saveState();
    return true;
  }

  /** Everything kept, gone; a new history, which the site starts afresh. */
  clear() {
    if (this.timer) { this.clearTimeout(this.timer); this.timer = null; }
    for (const seg of this.segments) {
      try { this.fs.rmSync(seg.file, { force: true }); } catch { /* gone already */ }
    }
    this.segments = [];
    this.buffer = [];
    this.urgent = false;
    Object.assign(this.state, { stream: newStream(), next: 1, acked: 0, lost: 0, uploads: [] });
    this.dirty = true;
    this.saveState();
  }

  /** A full reset (main.js): as on a first start — nothing kept, on, everything written down. */
  reset() {
    this.clear();
    Object.assign(this.state, { on: true, level: 'full', session: 0 });
    this.dirty = true;
    this.saveState();
  }

  /** A new run of the app: its number, for app.start. */
  newSession() {
    this.state.session += 1;
    this.dirty = true;
    return this.state.session;
  }

  /** The last `n` events, newest last: what the Advanced screen shows of what would go. */
  recent(n = 100) {
    const out = this.buffer.slice(-n).map((b) => JSON.parse(b.line));
    for (let i = this.segments.length - 1; i >= 0 && out.length < n; i -= 1) {
      const events = this.read(this.segments[i]);
      out.unshift(...events.slice(-(n - out.length)));
    }
    return out.slice(-n).map((e) => this.rescrub(e));
  }

  /** For the Advanced screen: how much is kept, and how the uploads went. */
  view() {
    const kept = Math.max(0, this.state.next - Math.max(this.oldest(), this.state.acked + 1));
    return { on: this.state.on, level: this.state.level, kept, bytes: this.bytes(), sent: this.state.acked,
      lost: this.state.lost, uploads: this.state.uploads.slice().reverse(), stream: this.state.stream };
  }
}

module.exports = { TraceStore, SCHEMA, LEVELS, DETAIL, URGENT, SEGMENT_BYTES };
