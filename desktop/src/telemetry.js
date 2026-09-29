'use strict';
/**
 * What this app knows about how it is doing, kept on this computer.
 *
 * Every conversation with the regbot site (how long it took, whether it
 * worked), every round trip the site timed (pinger.js), every read and every
 * booking the robots did (reader.js, booker.js, robots.js), and once a minute
 * how much memory and CPU the app is using. Counted into one bucket per minute
 * for the last day, with the recent events beside them, and saved to
 * telemetry.json in the app's data folder so a restart does not lose it.
 *
 * The Advanced screen draws it. Nothing leaves this computer unless the person
 * presses Share there, or turns sharing on: then `payload()` is what goes, to
 * the site's POST /api/client/telemetry — numbers, and a fixed list of words,
 * the same schema the site keeps (the server's client_telemetry.py). No profile
 * detail, no office, no date, no line name: the site knows which reads and
 * hand-offs were this app's already, and does not need them again to see how
 * the app is doing.
 *
 * Plain Node, with its clock and its file handed in, so it runs under
 * `node --test`.
 */
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'regbot.app-telemetry/1';
const MINUTE = 60;
const KEEP_MINUTES = 24 * 60;
const KEEP_EVENTS = 300;
const RESERVOIR = 2000;
// How far back a share reaches when there has been none: a day.
const SHARE_REACH_S = 24 * 3600;
const EVENT_KINDS = new Set(['sync_error', 'offline', 'online', 'read', 'robot', 'booking', 'handoff',
  'connection', 'share', 'start', 'stop']);
const WORD = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const RANGES = { '1h': [3600, 60], '6h': [6 * 3600, 300], '24h': [24 * 3600, 900] };

/** What one minute holds. Counts add up; the rest are sums and extremes. */
function blankMinute(t) {
  return {
    t, syncs: 0, sync_errors: 0, sync_ms_sum: 0, sync_ms_max: 0, api_calls: 0, api_errors: 0,
    offline: 0, rtt_ms_sum: 0, rtt_n: 0, reads: 0, reads_done: 0, reads_blocked: 0, reads_failed: 0,
    openings: 0, robot_runs: 0, robot_failures: 0, bookings: 0, bookings_booked: 0, handoffs: 0,
    memory_mb: null, cpu_pct: null, heap_mb: null,
  };
}

function quantile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = ((sorted.length - 1) * pct) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 10) / 10;
}

/**
 * A word, or nothing. Only what already is one — an outcome like `done` or
 * `slot_gone` — is kept; anything else (a message, an address, a name) is
 * dropped rather than tidied into a word, which would only disguise it.
 */
function word(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  return WORD.test(text) ? text : null;
}

class Telemetry {
  /**
   * @param {object} opts
   * @param {string} [opts.file]     where to keep it (telemetry.json); none keeps it in memory
   * @param {function} [opts.now]    epoch milliseconds
   * @param {object} [opts.app]      {version, platform, arch, electron, packaged}
   */
  constructor({ file = null, now = Date.now, app = {}, fs = nodeFs } = {}) {
    Object.assign(this, { file, now, fs });
    this.app = { version: '', platform: process.platform, arch: process.arch, electron: '', packaged: false, ...app };
    this.minutes = [];
    this.events = [];
    this.samples = { sync_ms: [], rtt_ms: [], read_s: [], robot_s: [], book_s: [] };
    this.shares = [];
    // Names this app's uploads: the same period sent again (a reply that never
    // came back) is the same upload, which the site keeps once.
    this.installId = crypto.randomBytes(9).toString('hex');
    this.startedAt = Math.floor(now() / 1000);
    this.failingSince = 0;
    this.dirty = false;
    this.load();
  }

  // -------------------------------------------------------------- keeping it
  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (saved && saved.v === 1) {
        this.minutes = Array.isArray(saved.minutes) ? saved.minutes.slice(-KEEP_MINUTES) : [];
        this.events = Array.isArray(saved.events) ? saved.events.slice(-KEEP_EVENTS) : [];
        for (const key of Object.keys(this.samples)) {
          if (saved.samples && Array.isArray(saved.samples[key])) this.samples[key] = saved.samples[key].slice(-RESERVOIR);
        }
        this.shares = Array.isArray(saved.shares) ? saved.shares.slice(-20) : [];
        if (typeof saved.install === 'string' && /^[0-9a-f]{18}$/.test(saved.install)) this.installId = saved.install;
      }
    } catch { /* nothing saved yet, or unreadable: start afresh */ }
    this.prune();
  }

  save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify({ v: 1, install: this.installId, minutes: this.minutes, events: this.events,
      samples: this.samples, shares: this.shares });
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      this.fs.writeFileSync(tmp, body, { mode: 0o600 });
      this.fs.renameSync(tmp, this.file);
    } catch { /* the numbers must never be the problem */ }
  }

  clear() {
    this.minutes = [];
    this.events = [];
    for (const key of Object.keys(this.samples)) this.samples[key] = [];
    this.shares = [];
    // A cleared history is not tied to the uploads before it.
    this.installId = crypto.randomBytes(9).toString('hex');
    this.dirty = true;
    this.save();
  }

  prune() {
    const oldest = this.nowS() - KEEP_MINUTES * MINUTE;
    while (this.minutes.length && this.minutes[0].t < oldest) this.minutes.shift();
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
  }

  nowS() {
    return Math.floor(this.now() / 1000);
  }

  bucket() {
    const t = Math.floor(this.nowS() / MINUTE) * MINUTE;
    let last = this.minutes[this.minutes.length - 1];
    if (!last || last.t !== t) {
      last = blankMinute(t);
      this.minutes.push(last);
      this.prune();
    }
    this.dirty = true;
    return last;
  }

  sample(key, value) {
    const list = this.samples[key];
    list.push(Math.round(value * 10) / 10);
    if (list.length > RESERVOIR) list.splice(0, list.length - RESERVOIR);
  }

  event(kind, fields = {}) {
    if (!EVENT_KINDS.has(kind)) return;
    const e = { t: this.nowS(), kind };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'number' && Number.isFinite(value)) e[key] = Math.round(value * 10) / 10;
      else if (typeof value === 'string' && word(value)) e[key] = word(value);
    }
    this.events.push(e);
    if (this.events.length > KEEP_EVENTS) this.events.shift();
    this.dirty = true;
  }

  // ------------------------------------------------------- what is recorded
  /** Every call to the site (sync.js). `status` 0 is "could not reach it". */
  request({ path: where = '', ms = 0, status = 0 } = {}) {
    const m = this.bucket();
    const ok = status >= 200 && status < 400;
    m.api_calls += 1;
    if (!ok) m.api_errors += 1;
    if (status === 0) m.offline += 1;
    if (/\/api\/client\/sync$/.test(where)) {
      m.syncs += 1;
      m.sync_ms_sum += ms;
      m.sync_ms_max = Math.max(m.sync_ms_max, ms);
      this.sample('sync_ms', ms);
      // One event where a run of failures starts, and one where it ends, not one a poll.
      if (!ok) {
        m.sync_errors += 1;
        if (!this.failingSince) {
          this.failingSince = this.nowS();
          this.event(status === 0 ? 'offline' : 'sync_error', { code: status });
        }
      } else if (this.failingSince) {
        this.event('online', { ms: (this.nowS() - this.failingSince) * 1000 });
        this.failingSince = 0;
      }
    }
  }

  /** A round trip the site timed on its own clock (pinger.js). */
  rtt(ms) {
    if (!Number.isFinite(ms)) return;
    const m = this.bucket();
    m.rtt_ms_sum += ms;
    m.rtt_n += 1;
    this.sample('rtt_ms', ms);
  }

  /** One read the robots did for the site (reader.js). */
  read({ status = '', ms = 0, offices = 0, found = 0 } = {}) {
    const m = this.bucket();
    m.reads += 1;
    if (status === 'done') m.reads_done += 1;
    else if (status === 'blocked') m.reads_blocked += 1;
    else m.reads_failed += 1;
    m.openings += Number(found) || 0;
    if (ms) this.sample('read_s', ms / 1000);
    this.event('read', { status, ms, offices, found });
  }

  /** One robot run of any kind (robots.js). */
  robot({ kind = '', ms = 0, status = '' } = {}) {
    const m = this.bucket();
    m.robot_runs += 1;
    if (!['confirmed', 'ok', 'found', 'no_availability', 'done'].includes(status)) m.robot_failures += 1;
    if (ms) this.sample('robot_s', ms / 1000);
    this.event('robot', { robot: kind, status, ms });
  }

  /** What became of a booking this app's robot attempted (booker.js). */
  booking({ kind = '', ms = 0 } = {}) {
    const m = this.bucket();
    m.bookings += 1;
    if (kind === 'booked') m.bookings_booked += 1;
    if (ms) this.sample('book_s', ms / 1000);
    this.event('booking', { status: kind, ms });
  }

  handoff() {
    this.bucket().handoffs += 1;
    this.event('handoff', { status: 'arrived' });
  }

  connection(state, ms) {
    this.event('connection', { status: state, rtt_ms: ms });
  }

  /**
   * How much the app is using: Electron's app.getAppMetrics() for every
   * process it runs (the window, the pages, the helpers) and the main
   * process's own heap.
   */
  processes(metrics = [], memory = {}) {
    const m = this.bucket();
    let kb = 0;
    let cpu = 0;
    for (const p of metrics || []) {
      if (p.memory && Number.isFinite(p.memory.workingSetSize)) kb += p.memory.workingSetSize;
      if (p.cpu && Number.isFinite(p.cpu.percentCPUUsage)) cpu += p.cpu.percentCPUUsage;
    }
    m.memory_mb = Math.round(kb / 102.4) / 10;
    m.cpu_pct = Math.round(cpu * 10) / 10;
    if (memory && Number.isFinite(memory.heapUsed)) m.heap_mb = Math.round(memory.heapUsed / 104857.6) / 10;
  }

  // ------------------------------------------------------------ reading it
  within(fromS, toS = this.nowS()) {
    return this.minutes.filter((m) => m.t >= fromS && m.t <= toS);
  }

  summary(fromS = 0, toS = this.nowS()) {
    const rows = this.within(fromS, toS);
    const sum = (key) => rows.reduce((a, m) => a + (Number(m[key]) || 0), 0);
    const mem = rows.map((m) => m.memory_mb).filter((v) => v !== null && v !== undefined);
    const cpu = rows.map((m) => m.cpu_pct).filter((v) => v !== null && v !== undefined);
    const syncs = sum('syncs');
    return {
      syncs, sync_errors: sum('sync_errors'), api_calls: sum('api_calls'), api_errors: sum('api_errors'),
      offline_minutes: rows.filter((m) => m.offline > 0 && m.offline >= m.api_calls).length,
      sync_ms_avg: syncs ? Math.round(sum('sync_ms_sum') / syncs) : null,
      sync_ms_p50: quantile(this.samples.sync_ms, 50), sync_ms_p95: quantile(this.samples.sync_ms, 95),
      pings_timed: sum('rtt_n'), rtt_ms_p50: quantile(this.samples.rtt_ms, 50), rtt_ms_p95: quantile(this.samples.rtt_ms, 95),
      reads: sum('reads'), reads_done: sum('reads_done'), reads_blocked: sum('reads_blocked'), reads_failed: sum('reads_failed'),
      openings_found: sum('openings'), read_s_p50: quantile(this.samples.read_s, 50),
      robot_runs: sum('robot_runs'), robot_failures: sum('robot_failures'), robot_s_p50: quantile(this.samples.robot_s, 50),
      bookings: sum('bookings'), bookings_booked: sum('bookings_booked'), handoffs: sum('handoffs'),
      memory_mb_p50: quantile(mem, 50), memory_mb_max: mem.length ? Math.max(...mem) : null,
      cpu_pct_p50: quantile(cpu, 50), cpu_pct_max: cpu.length ? Math.max(...cpu) : null,
      uptime_minutes: Math.round((this.nowS() - this.startedAt) / 60),
      minutes_kept: rows.length,
    };
  }

  /** Every minute of [from, to) into `step`-second points, for a chart or a share. */
  series(fromS, toS, step) {
    const points = [];
    for (let t = Math.floor(fromS / step) * step; t <= toS; t += step) points.push(t);
    const at = new Map(points.map((t, i) => [t, i]));
    const n = points.length;
    const zero = () => new Array(n).fill(0);
    const gap = () => new Array(n).fill(null);
    const out = {
      syncs: zero(), sync_errors: zero(), sync_ms: gap(), sync_ms_max: gap(), rtt_ms: gap(),
      api_calls: zero(), api_errors: zero(), reads_done: zero(), reads_blocked: zero(), reads_failed: zero(),
      openings: zero(), robot_runs: zero(), bookings: zero(), memory_mb: gap(), cpu_pct: gap(),
    };
    const sums = { sync: new Array(n).fill(0), rtt: new Array(n).fill(0), rttN: new Array(n).fill(0),
      mem: new Array(n).fill(0), memN: new Array(n).fill(0), cpu: new Array(n).fill(0), cpuN: new Array(n).fill(0) };
    for (const m of this.within(points[0] || fromS, toS)) {
      const i = at.get(Math.floor(m.t / step) * step);
      if (i === undefined) continue;
      for (const key of ['syncs', 'sync_errors', 'api_calls', 'api_errors', 'reads_done', 'reads_blocked',
        'reads_failed', 'openings', 'robot_runs', 'bookings']) out[key][i] += m[key] || 0;
      sums.sync[i] += m.sync_ms_sum || 0;
      out.sync_ms_max[i] = Math.max(out.sync_ms_max[i] || 0, m.sync_ms_max || 0) || null;
      sums.rtt[i] += m.rtt_ms_sum || 0;
      sums.rttN[i] += m.rtt_n || 0;
      if (m.memory_mb !== null && m.memory_mb !== undefined) { sums.mem[i] += m.memory_mb; sums.memN[i] += 1; }
      if (m.cpu_pct !== null && m.cpu_pct !== undefined) { sums.cpu[i] += m.cpu_pct; sums.cpuN[i] += 1; }
    }
    for (let i = 0; i < n; i += 1) {
      if (out.syncs[i]) out.sync_ms[i] = Math.round(sums.sync[i] / out.syncs[i]);
      if (sums.rttN[i]) out.rtt_ms[i] = Math.round(sums.rtt[i] / sums.rttN[i]);
      if (sums.memN[i]) out.memory_mb[i] = Math.round((sums.mem[i] / sums.memN[i]) * 10) / 10;
      if (sums.cpuN[i]) out.cpu_pct[i] = Math.round((sums.cpu[i] / sums.cpuN[i]) * 10) / 10;
    }
    return { points, step, series: out };
  }

  /** What the Advanced screen draws. */
  snapshot(range = '1h') {
    const [span, step] = RANGES[range] || RANGES['1h'];
    const to = this.nowS();
    const drawn = this.series(to - span + step, to, step);
    return {
      range, ...drawn, summary: this.summary(to - span, to),
      events: this.events.slice(-60).reverse(), shares: this.shares.slice(-5).reverse(),
      lastShare: this.lastShare(),
    };
  }

  lastShare() {
    const ok = this.shares.filter((s) => s.ok);
    return ok.length ? ok[ok.length - 1] : null;
  }

  /**
   * Exactly what Share sends: since the last share (a day at most), in
   * five-minute points. Numbers, and a fixed list of words.
   */
  payload({ mode = 'public' } = {}) {
    const to = this.nowS();
    const last = this.lastShare();
    const reach = Math.max(to - SHARE_REACH_S, last ? last.to : 0, this.minutes.length ? this.minutes[0].t : to - 60);
    // From the start of a five-minute point, so every point falls inside the period.
    const from = Math.floor(reach / 300) * 300;
    const drawn = this.series(from, to, 300);
    const series = {};
    for (const key of ['syncs', 'sync_errors', 'sync_ms', 'rtt_ms', 'api_errors', 'reads_done', 'reads_blocked',
      'robot_runs', 'memory_mb', 'cpu_pct']) {
      series[key] = drawn.points.map((t, i) => [t, drawn.series[key][i]]).filter(([t]) => t >= from && t <= to);
    }
    const summary = {};
    for (const [key, value] of Object.entries(this.summary(from, to))) {
      if (typeof value === 'number' && Number.isFinite(value)) summary[key] = value;
    }
    return {
      schema: SCHEMA,
      upload_id: `${this.installId}-${from}`,
      app: {
        version: this.app.version, platform: this.app.platform, arch: this.app.arch,
        electron: this.app.electron, packaged: Boolean(this.app.packaged), mode,
      },
      period: { from, to },
      summary,
      series,
      events: this.events.filter((e) => e.t >= from && e.t <= to).slice(-KEEP_EVENTS),
    };
  }

  /** What the site said to a share. */
  noteShare({ ok, message = '', id = null, period = null, auto = false } = {}) {
    this.shares.push({ at: this.nowS(), ok: Boolean(ok), message: String(message).slice(0, 200), id,
      from: period ? period.from : null, to: period ? period.to : null, auto: Boolean(auto) });
    if (this.shares.length > 20) this.shares.shift();
    if (ok) this.event('share', { status: auto ? 'auto' : 'manual' });
    this.dirty = true;
    this.save();
  }
}

module.exports = { Telemetry, SCHEMA, RANGES, quantile, word };
