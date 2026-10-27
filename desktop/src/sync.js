'use strict';
/**
 * The app's side of regbot's client API, and the loop that drives it.
 *
 * Everything here is plain Node: no Electron, so it runs under `node --test`
 * against a fake fetch. The app hands in the real fetch and, for pairing, a
 * fetch bound to the home tab's cookie jar — that is how a sign-in on the
 * site becomes a device token without a password ever passing through here.
 *
 * The server decides everything. This module carries positions and hand-offs
 * to the screen and answers back; it never decides whose turn it is. See
 * regbot/client_api.py for the other half and the reasons.
 */

/** How long an answer to a read may take. A sync stays on the client's own
 *  deadline: judging a filtered scout is the slow call, and only that one. */
const ANSWER_TIMEOUT_MS = 20000;
/** One call to the model, through the site: it waits for the model, which takes its time. */
const AGENT_TIMEOUT_MS = 90000;
/** How long an upload of the trace may take: a megabyte, gzipped, over a slow line. */
const UPLOAD_TIMEOUT_MS = 60000;

class SyncError extends Error {
  constructor(message, status = 0, body = null, retryAfter = 0) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.body = body;
    // Seconds the site asked to be left alone for (a 429's Retry-After).
    this.retryAfter = retryAfter;
  }
}

class NotPaired extends SyncError {
  constructor(message = 'This app is not paired with an account yet.') {
    super(message, 401);
    this.name = 'NotPaired';
  }
}

class SyncClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl        where regbot is
   * @param {string|null} [opts.token]     bearer token from pairing
   * @param {Function} [opts.fetch]        fetch to use (Node's by default)
   * @param {object} [opts.app]            {name, version, platform} sent on pair/sync
   * @param {number} [opts.timeoutMs]      per-request deadline
   * @param {Function} [opts.onRequest]    ({method, path, status, ms}) after every request,
   *                                       for this app's own telemetry (telemetry.js)
   * @param {Function} [opts.onExchange]   the same with what was sent and what came back
   *                                       ({…, body, reply, error}), for the app's logs (logbook.js)
   */
  constructor({ serverUrl, token = null, fetch = globalThis.fetch, app = {}, timeoutMs = 10000, onRequest = null,
    onExchange = null }) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.token = token || null;
    this.fetch = fetch;
    this.app = { name: '', version: '', platform: '', ...app };
    this.timeoutMs = timeoutMs;
    this.onRequest = onRequest;
    this.onExchange = onExchange;
  }

  get paired() {
    return Boolean(this.token);
  }

  url(path) {
    return `${this.serverUrl}${path}`;
  }

  async request(path, options = {}) {
    const started = Date.now();
    let status = 0;
    let reply;
    let error = null;
    try {
      reply = await this.send(path, options);
      status = 200;
      return reply;
    } catch (err) {
      status = err.status || 0;
      error = { message: err.message, body: err.body };
      throw err;
    } finally {
      const done = { method: options.method || 'POST', path, status, ms: Date.now() - started };
      if (this.onRequest) {
        try { this.onRequest(done); } catch { /* never the problem */ }
      }
      if (this.onExchange) {
        // An upload says what it was, not all of itself (logBody).
        const body = options.logBody !== undefined ? options.logBody : options.body;
        try { this.onExchange({ ...done, body, reply, error }); } catch { /* never the problem */ }
      }
    }
  }

  async send(path, { method = 'POST', body, raw = null, encoding = '', fetch = this.fetch, auth = true, timeoutMs = null } = {}) {
    const headers = { accept: 'application/json' };
    // `raw`: bytes already made (a gzipped upload), sent as they are with their encoding.
    if (body !== undefined || raw) headers['content-type'] = 'application/json';
    if (raw && encoding) headers['content-encoding'] = encoding;
    if (auth) {
      if (!this.token) throw new NotPaired();
      headers.authorization = `Bearer ${this.token}`;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const deadline = timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const timer = controller ? setTimeout(() => controller.abort(), deadline) : null;
    let res;
    try {
      res = await fetch(this.url(path), {
        method, headers,
        body: raw || (body === undefined ? undefined : JSON.stringify(body)),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw new SyncError(`Could not reach ${this.serverUrl}: ${err.message}`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (res.status === 401 && auth) {
      // The token was revoked, or never valid. Forget it: the next home-tab
      // sign-in pairs again.
      this.token = null;
      throw new NotPaired((parsed && parsed.error) || 'This device is not paired.');
    }
    if (!res.ok) {
      const wait = Number((res.headers && res.headers.get && res.headers.get('retry-after')) || 0);
      throw new SyncError((parsed && parsed.error) || `${method} ${path} failed (${res.status})`,
        res.status, parsed, Number.isFinite(wait) ? wait : 0);
    }
    return parsed;
  }

  /**
   * Turn a signed-in site session into a device token.
   * @param {Function} cookieFetch a fetch that sends the home tab's cookies
   */
  async pair(cookieFetch) {
    const body = { name: this.app.name, platform: this.app.platform, app_version: this.app.version };
    let reply;
    try {
      reply = await this.request('/api/client/pair', { body, fetch: cookieFetch, auth: false });
    } catch (err) {
      // A 401 here is not a failure, it is "nobody is signed in on the home
      // tab yet". The app asks at start and after every home-tab navigation,
      // and most of those asks land before the person has signed in.
      if (err instanceof SyncError && err.status === 401) throw new NotPaired(err.message);
      throw err;
    }
    this.token = reply.token;
    return reply;
  }

  /** `extra` rides along in the body — the reader's capabilities (reader.js). */
  async sync(extra = {}) {
    return this.request('/api/client/sync', { body: { app_version: this.app.version, ...extra } });
  }

  /** What this device's robot saw for a read the site handed it.
   *  Longer than a sync: the site filters the openings, then says where each
   *  kept one goes, and a scout's worth of that used to outlast the sync deadline. */
  async answerRead(readId, result) {
    return this.request(`/api/client/reads/${Number(readId)}`, { body: result, timeoutMs: ANSWER_TIMEOUT_MS });
  }

  /** Presence and a round trip the site times itself (pinger.js). */
  async ping(body = {}) {
    return this.request('/api/client/ping', { body });
  }

  /** This device is closing mid-read and gives the read back, so no line waits on it. */
  async releaseRead(readId) {
    return this.request(`/api/client/reads/${Number(readId)}/release`, { body: {} });
  }

  /** This device is about to book a hand-off with its robot; the first device to say so has it. */
  async claim(jobId) {
    return this.request(`/api/client/handoffs/${Number(jobId)}/claim`, { body: {} });
  }

  /** The slot was not there when this device went to book it. */
  async gone(jobId, reason = '') {
    return this.request(`/api/client/handoffs/${Number(jobId)}/gone`, { body: { reason } });
  }

  async found(report) {
    return this.request('/api/client/found', { body: report });
  }

  async booked(jobId, confirmation = '', { robot = false } = {}) {
    const body = robot ? { confirmation, robot: true } : { confirmation };
    return this.request(`/api/client/handoffs/${Number(jobId)}/booked`, { body });
  }

  async pass(jobId, reason = '') {
    return this.request(`/api/client/handoffs/${Number(jobId)}/pass`, { body: { reason } });
  }

  async places(siteSlug) {
    const reply = await this.request(`/api/client/places/${encodeURIComponent(siteSlug)}`, { method: 'GET' });
    return reply.places || [];
  }

  /** Change the name other bidders see. The site answers with the account's user block. */
  async setNickname(nickname) {
    return this.request('/api/client/account/nickname', { body: { nickname } });
  }

  /** Unpair another device of this account. */
  async revokeDevice(clientId) {
    return this.request(`/api/client/devices/${Number(clientId)}/revoke`, { body: {} });
  }

  async unpair() {
    try {
      await this.request('/api/client/unpair', { body: {} });
    } finally {
      this.token = null;
    }
  }

  // -- signing in by code ------------------------------------------------
  // The app never loads the site and never sees a password. It asks for a
  // code, the person approves that code on the site in their own browser,
  // and the app collects a token when it next asks.
  async pairStart() {
    const body = { name: this.app.name, platform: this.app.platform, app_version: this.app.version };
    return this.request('/api/client/pair/start', { body, auth: false });
  }

  /** One poll: {status:'pending'} | {status:'approved', token, user} | throws SyncError 410 when over. */
  async pairPoll(secret) {
    const reply = await this.request('/api/client/pair/poll', { body: { secret }, auth: false });
    if (reply && reply.status === 'approved' && reply.token) this.token = reply.token;
    return reply;
  }

  // -- what the screens show -----------------------------------------------
  // Readable before pairing (the directory is public); the token, when there
  // is one, lets the server say which position is yours.
  async sites(q = '') {
    const query = q ? `?q=${encodeURIComponent(q)}` : '';
    return this.request(`/api/client/sites${query}`, { method: 'GET', auth: this.paired });
  }

  async site(slug) {
    return this.request(`/api/client/sites/${encodeURIComponent(slug)}`, { method: 'GET', auth: this.paired });
  }

  async board(queueId) {
    return this.request(`/api/client/queues/${Number(queueId)}`, { method: 'GET', auth: this.paired });
  }

  async placeBid(queueId, bid) {
    return this.request(`/api/client/queues/${Number(queueId)}/bids`, { body: bid });
  }

  async raiseBid(bidId, delta) {
    return this.request(`/api/client/bids/${Number(bidId)}/raise`, { body: { delta: Number(delta) } });
  }

  async setIfPassed(bidId, code) {
    return this.request(`/api/client/bids/${Number(bidId)}/if-passed`, { body: { if_passed: code } });
  }

  /** Apply the one suggestion sync is showing. The server checks the key
   *  against a fresh look and refuses anything else. */
  async applyAdvice(bidId, key) {
    return this.request(`/api/client/bids/${Number(bidId)}/advice`, { body: { key } });
  }

  /** What a bid would get at each amount worth paying, as it is or with `change`
   *  (a wider range, a later time, a longer reach: see ui/bidchange.js). Writes nothing. */
  async quoteBid(bidId, change = {}) {
    return this.request(`/api/client/bids/${Number(bidId)}/quote`, { body: change || {} });
  }

  /** Change a live bid in one write: `amount` is the new total; `fields`,
   *  `preferred_date`, `preferred_time` and `if_passed` may only widen it. */
  async changeBid(bidId, change) {
    return this.request(`/api/client/bids/${Number(bidId)}/change`, { body: change || {} });
  }

  /** Three ways to ask for a new bid on this line, each with its chance. Writes nothing. */
  async bidOptions(queueId, draft) {
    return this.request(`/api/client/queues/${Number(queueId)}/options`, { body: draft || {} });
  }

  /** Three ways to widen a bid already in line, each with its chance. Writes nothing. */
  async widenOptions(bidId) {
    return this.request(`/api/client/bids/${Number(bidId)}/options`, { body: {} });
  }

  /** The person's own choices the site acts on: `auto_widen` for every bid of theirs. */
  async setPreferences(prefs) {
    return this.request('/api/client/preferences', { body: prefs || {} });
  }

  async withdrawBid(bidId) {
    return this.request(`/api/client/bids/${Number(bidId)}/withdraw`, { body: {} });
  }

  async account() {
    return this.request('/api/client/account', { method: 'GET' });
  }

  /** Every appointment this person's bids ended in, the latest first (the site's bookings.py). */
  async bookings() {
    return this.request('/api/client/bookings', { method: 'GET' });
  }

  /** The booking site says this appointment is cancelled: `how` is app, page or elsewhere. */
  async bookingCancelled(bookingId, how = 'app') {
    return this.request(`/api/client/bookings/${Number(bookingId)}/cancelled`, { body: { how } });
  }

  /** Whether this account may have the AI oversee its bookings, and on what terms (the site's agent.py). */
  async agentStatus() {
    return this.request('/api/client/agent', { method: 'GET' });
  }

  /** The robot is stuck (or there is a task): one AI session, refused unless the account can pay for it. */
  async agentOpen(body) {
    return this.request('/api/client/agent/sessions', { body: body || {} });
  }

  /** One call to the model, through the site and charged there. Logged by its size: it carries pages. */
  async agentChat(sessionId, body) {
    const messages = Array.isArray(body && body.messages) ? body.messages : [];
    return this.request(`/api/client/agent/sessions/${Number(sessionId)}/chat`, {
      body, timeoutMs: AGENT_TIMEOUT_MS,
      logBody: { messages: messages.length, tools: Array.isArray(body && body.tools) ? body.tools.length : 0,
        chars: JSON.stringify(messages).length },
    });
  }

  /** What the AI did and what came of it: the intervention's telemetry. */
  async agentReport(sessionId, report) {
    return this.request(`/api/client/agent/sessions/${Number(sessionId)}/report`, { body: report || {} });
  }

  /** Buy a pack of credits: a payment page to open, or (practice) credited now. The
   *  older route, which every regbot site has; /credits/checkout is its new name. */
  async topup(pack) {
    return this.request('/api/client/topup', { body: { pack } });
  }

  /** The balance kept on the site, what is on sale, the purchases and every movement. */
  async credits() {
    return this.request('/api/client/credits', { method: 'GET' });
  }

  /** How one purchase stands — the site asks the payment provider while it is open. */
  async payment(paymentId) {
    return this.request(`/api/client/payments/${Number(paymentId)}`, { method: 'GET' });
  }

  async cancelPayment(paymentId) {
    return this.request(`/api/client/payments/${Number(paymentId)}/cancel`, { body: {} });
  }

  /** The lines this person asked for, and what others have asked for. */
  async siteRequests() {
    return this.request('/api/client/site-requests', { method: 'GET' });
  }

  /** Ask for a line on a booking site the site does not cover yet. */
  async requestSite(body) {
    return this.request('/api/client/site-requests', { body });
  }

  /** "Me too" on a line somebody else asked for. */
  async supportSiteRequest(requestId) {
    return this.request(`/api/client/site-requests/${Number(requestId)}/support`, { body: {} });
  }

  /** What this app's person chose to share of its telemetry (telemetry.js). */
  async shareTelemetry(payload) {
    return this.request('/api/client/telemetry', { body: payload });
  }

  /**
   * The trace the site asked for, on a sync (traces.js upload()): gzipped JSON,
   * answering its ask. The site says back how far it now has it (`acked`).
   */
  async uploadTraces({ gzip, json, body = {}, events = 0 }) {
    return this.request('/api/client/traces', {
      raw: gzip, encoding: 'gzip', timeoutMs: UPLOAD_TIMEOUT_MS,
      logBody: { ask: body.ask, after: body.after, first: body.first, last: body.last, events,
        bytes: json ? json.length : undefined, gzipped: gzip ? gzip.length : undefined },
    });
  }
}

/** Which hand-offs are new since the last sync, which are gone, by job id. */
function diffHandoffs(before = [], after = []) {
  const was = new Map((before || []).map((h) => [h.job_id, h]));
  const now = new Map((after || []).map((h) => [h.job_id, h]));
  return {
    arrived: [...now.values()].filter((h) => !was.has(h.job_id)),
    gone: [...was.values()].filter((h) => !now.has(h.job_id)),
    kept: [...now.values()].filter((h) => was.has(h.job_id)),
  };
}

function describeHandoff(h) {
  const where = h.slot
    ? `${h.slot.office_name}, ${h.slot.date} at ${h.slot.time}`
    : `you reached the front of ${h.queue_name}`;
  return `${h.queue_name} — ${where}`;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Back-off for a server that is not answering: 2s, 4s, 8s … capped at a minute. */
function backoffMs(failures) {
  return Math.min(60000, 2000 * 2 ** Math.max(0, Math.min(failures - 1, 6)));
}

/**
 * Polls at the cadence the server asks for, backs off when it does not
 * answer, and reports every document and every error to whoever is listening.
 * Timers are injectable so the loop can be tested without waiting.
 */
class SyncLoop {
  constructor(client, { onDoc, onError, onStatus, body, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, defaultMs = 4000 } = {}) {
    this.client = client;
    // What else each sync says, asked afresh every time: the reader's state
    // changes between one sync and the next.
    this.body = body || (() => ({}));
    this.onDoc = onDoc || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.setTimeout = st;
    this.clearTimeout = ct;
    this.defaultMs = defaultMs;
    this.timer = null;
    this.running = false;
    this.failures = 0;
    this.inFlight = null;
    this.last = null;
  }

  start() {
    this.running = true;
    this.poke();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sync now rather than at the next tick. */
  poke() {
    if (!this.running) return;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    this.tick();
  }

  schedule(ms) {
    if (!this.running) return;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = this.setTimeout(() => { this.timer = null; this.tick(); }, ms);
  }

  async tick() {
    if (this.inFlight) return this.inFlight;
    // No address yet: the server this app runs itself has not said where it
    // is. That is a wait, not a failure — no back-off, and whoever starts it
    // pokes the loop the moment it is up.
    if (!this.client.serverUrl) {
      this.onStatus({ state: 'starting' });
      this.schedule(this.defaultMs);
      return null;
    }
    if (!this.client.paired) {
      this.onStatus({ state: 'unpaired' });
      this.schedule(this.defaultMs);
      return null;
    }
    this.onStatus({ state: 'syncing' });
    this.inFlight = (async () => {
      try {
        const doc = await this.client.sync(this.body());
        this.failures = 0;
        this.last = doc;
        this.onStatus({ state: 'synced', at: Date.now() });
        this.onDoc(doc);
        this.schedule(Number(doc.poll_after_ms) > 0 ? Number(doc.poll_after_ms) : this.defaultMs);
        return doc;
      } catch (err) {
        if (err instanceof NotPaired) {
          this.failures = 0;
          this.onStatus({ state: 'unpaired', message: err.message });
          this.onError(err);
          this.schedule(this.defaultMs);
          return null;
        }
        this.failures += 1;
        const wait = backoffMs(this.failures);
        this.onStatus({ state: 'offline', message: err.message, retryMs: wait, failures: this.failures });
        this.onError(err);
        this.schedule(wait);
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}

module.exports = { SyncClient, SyncLoop, SyncError, NotPaired, diffHandoffs, describeHandoff, clock, backoffMs,
  ANSWER_TIMEOUT_MS, UPLOAD_TIMEOUT_MS };
