'use strict';
/**
 * What this app did, kept on this computer for a few days (Settings → Logs,
 * three by default): enough to tell afterwards exactly what happened on a
 * booking site — which pages, which requests and what came back, what was
 * clicked and filled in, what the robots did and what they saw.
 *
 *   app-<day>.log         the app's own log, as log() says it
 *   site-<day>.jsonl      each request to the LineRight Regbot site, with what
 *                         was sent and what came back
 *   pages-<day>.jsonl     the pages in the app's tabs (pagelog.js): navigations,
 *                         requests and their answers, console messages, clicks
 *                         and fields changed, autofill, confirmations found
 *   pages/<day>/          those pages' documents as they arrived, and each page
 *                         as it stood after a step
 *   robot-<day>.log       the robots' own run log (dmq)
 *   robots/<time>-<what>/ one robot run: what it was asked and what it answered
 *                         (run.json), its network and console (events.jsonl),
 *                         and Playwright's trace of it (trace.zip; dmq's
 *                         instrument.js)
 *
 * Anything older than `keepDays` goes, at start and every hour; and should the
 * folder pass `maxBytes` all the same, the oldest goes first.
 *
 * Secrets never go in (redact): tokens, cookies, passwords and captcha answers,
 * and the numbers a form holds that matter if this folder is ever copied — a
 * Social Security or licence number, a date of birth. Names, emails and phone
 * numbers, the person's own, are kept: they are what a booking is made of.
 *
 * Writing never throws: a log that cannot be written is not a reason for the
 * app to stop.
 */
const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

/** Keys whose values never go into a log. Kept in step with dmq's instrument.js. */
const SECRET = /pass(?:word|wd|code|phrase)?\b|passport|pwd|secret|token|auth|cookie|session|csrf|xsrf|captcha|api.?key|ssn|social.?sec|dl.?(?:num|no)|licen[cs]e.?(?:num|no)|permit.?(?:num|no)|birth|\bdob\b|card.?(?:num|no)|cvv|cvc|security.?code|account.?num|routing/i;

const masked = (value) => `‹redacted, ${String(value === null || value === undefined ? '' : value).length} chars›`;

/** `value` with every secret-looking key's value struck out, all the way down. */
function redact(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!SECRET.test(key) || v === null || v === '' || v === undefined) out[key] = redact(v, depth + 1);
    else out[key] = typeof v === 'object' ? '‹redacted›' : masked(v);
  }
  return out;
}

/** A URL with its secret-looking query values struck out. */
function redactUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET.test(key)) { u.searchParams.set(key, masked(u.searchParams.get(key))); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** A body as sent or received, its secrets struck out, cut to MAX_BODY. */
function redactBody(text, mime = '') {
  if (text === null || text === undefined) return text;
  let body = String(text);
  const trimmed = body.trim();
  if (/json/i.test(mime) || /^[[{]/.test(trimmed)) {
    try { body = JSON.stringify(redact(JSON.parse(trimmed))); } catch { /* not JSON after all */ }
  } else if (/x-www-form-urlencoded/i.test(mime) || /^[\w.%[\]-]+=[^\s]*(&[\w.%[\]-]+=[^\s]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    for (const key of [...params.keys()]) if (SECRET.test(key)) params.set(key, masked(params.get(key)));
    body = params.toString();
  }
  return clip(body);
}

/** Headers, the secret ones saying only that they were there. */
function redactHeaders(all = {}) {
  const out = {};
  for (const [key, value] of Object.entries(all || {})) out[key] = SECRET.test(key) ? masked(value) : value;
  return out;
}

function clip(text, max = MAX_BODY) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}… ‹${s.length - max} more chars›` : s;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

class Logbook {
  /**
   * @param {object} opts
   * @param {string} opts.dir       the folder, absolute: <user data>/logs
   * @param {number} [opts.keepDays] how long anything is kept
   * @param {number} [opts.maxBytes] past this, the oldest goes even if it is not old yet
   */
  constructor({ dir, keepDays = 3, maxBytes = 2 * 1024 ** 3, now = () => Date.now(), disk = fs, tap = null }) {
    if (!dir || !path.isAbsolute(dir)) throw new Error('A logbook needs an absolute folder.');
    Object.assign(this, { dir, maxBytes, now, disk });
    // Told of every line and record as it is written, its secrets already struck
    // out: the app's trace (tracetaps.js) is made from them. {event(name, record), line(name, text)}
    this.tap = tap;
    this.keepDays = Logbook.days(keepDays);
    this.made = new Set();
    this.lastPrune = null;
  }

  /** A number of days to keep, as the setting allows: 1 to 30, 3 when unsure. */
  static days(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(30, n) : 3;
  }

  setKeepDays(days) {
    this.keepDays = Logbook.days(days);
    return this.keepDays;
  }

  /** Today, here: the day a file is named after. */
  day(at = this.now()) {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** A moment as a name that sorts: 20261014-175512-123. */
  stamp(at = this.now()) {
    const d = new Date(at);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
  }

  /** Today's file of one kind: app-2026-10-14.log. */
  file(name, ext = 'log') {
    return path.join(this.dir, `${name}-${this.day()}.${ext}`);
  }

  /** A folder under the logs, made if it is not there yet; null if it cannot be. */
  folder(...parts) {
    const dir = path.join(this.dir, ...parts);
    if (this.made.has(dir) && this.disk.existsSync(dir)) return dir;
    try {
      this.disk.mkdirSync(dir, { recursive: true });
      this.made.add(dir);
      return dir;
    } catch {
      return null;
    }
  }

  append(file, text) {
    if (!this.folder()) return;
    try {
      this.disk.appendFileSync(file, text);
    } catch {
      // The folder went from under it (a reset deletes it): made again, once.
      this.made.clear();
      if (!this.folder()) return;
      try { this.disk.appendFileSync(file, text); } catch { /* never the problem */ }
    }
  }

  /** One line of text, timestamped, in today's `<name>-<day>.log`. */
  line(name, text) {
    this.append(this.file(name, 'log'), `${new Date(this.now()).toISOString()} ${text}\n`);
    if (this.tap) {
      try { this.tap.line(name, text); } catch { /* never the problem */ }
    }
  }

  /** One record, its secrets struck out, in today's `<name>-<day>.jsonl`. */
  event(name, record) {
    let clean;
    let text;
    try {
      clean = redact(record);
      text = JSON.stringify({ t: new Date(this.now()).toISOString(), ...clean });
    } catch { return; }
    this.append(this.file(name, 'jsonl'), `${text}\n`);
    if (this.tap) {
      try { this.tap.event(name, clean); } catch { /* never the problem */ }
    }
  }

  /** A file of its own under `parts`, named for now and `label`; the path relative to the logs, or null. */
  keep(parts, label, content) {
    const dir = this.folder(...parts);
    if (!dir) return null;
    const name = `${this.stamp()}-${String(label).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}`;
    try {
      this.disk.writeFileSync(path.join(dir, name), content);
      return path.relative(this.dir, path.join(dir, name));
    } catch {
      return null;
    }
  }

  /** A folder for one run of something, under `group`: robots/20261014-175512-123-book-job77. */
  runDir(group, label) {
    const safe = String(label || 'run').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
    return this.folder(group, `${this.stamp()}-${safe}`);
  }

  /**
   * Delete what is older than `keepDays`, then, if the folder is still past
   * `maxBytes`, the oldest files until it is not. Returns what is left.
   */
  prune() {
    const cutoff = this.now() - this.keepDays * DAY_MS;
    const disk = this.disk;
    const entries = (dir) => { try { return disk.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    const remove = (target, dir) => {
      try { disk.rmSync(target, { recursive: dir, force: true }); } catch { /* next time */ }
    };
    // The newest moment anything under `target` was written.
    const newest = (target) => {
      let st;
      try { st = disk.statSync(target); } catch { return 0; }
      if (!st.isDirectory()) return st.mtimeMs;
      let latest = st.mtimeMs;
      for (const e of entries(target)) latest = Math.max(latest, newest(path.join(target, e.name)));
      return latest;
    };
    // Age: today's files and each day's or run's folder, as a whole.
    for (const e of entries(this.dir)) {
      const top = path.join(this.dir, e.name);
      if (!e.isDirectory()) {
        if (newest(top) < cutoff) remove(top, false);
        continue;
      }
      for (const inner of entries(top)) {
        const target = path.join(top, inner.name);
        if (newest(target) < cutoff) remove(target, inner.isDirectory());
      }
    }
    // Size: the oldest files first, then whatever folders that left empty.
    const files = [];
    const walk = (dir) => {
      for (const e of entries(dir)) {
        const target = path.join(dir, e.name);
        if (e.isDirectory()) walk(target);
        else {
          try { const st = disk.statSync(target); files.push({ target, at: st.mtimeMs, bytes: st.size }); } catch { /* gone */ }
        }
      }
    };
    walk(this.dir);
    let bytes = files.reduce((n, f) => n + f.bytes, 0);
    if (bytes > this.maxBytes) {
      files.sort((a, b) => a.at - b.at);
      for (const f of files) {
        if (bytes <= this.maxBytes) break;
        remove(f.target, false);
        bytes -= f.bytes;
      }
    }
    const sweep = (dir) => {
      for (const e of entries(dir)) {
        if (!e.isDirectory()) continue;
        const target = path.join(dir, e.name);
        sweep(target);
        if (!entries(target).length) remove(target, true);
      }
    };
    sweep(this.dir);
    // Folders it removed are made again when next written to.
    this.made.clear();
    this.lastPrune = { at: this.now(), bytes, files: files.length };
    return this.lastPrune;
  }
}

module.exports = { Logbook, redact, redactUrl, redactBody, redactHeaders, clip, SECRET };
