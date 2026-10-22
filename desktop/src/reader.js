'use strict';
/**
 * Looking for openings for the regbot site, from this computer.
 *
 * The site decides which line to look at and when, and hands it to one app as a
 * read (the server's reads.py). This is the app's half. What it can do goes out on
 * every sync; a read comes back in the sync document; the scout robot runs it
 * (robots.js) — one read at a time — and its answer goes straight back to the
 * site. While a read runs, every sync says so, which keeps its lease. What the
 * scout finds is not this person's for the finding: the site decides who is
 * first, and tells their app.
 *
 * It looks only where it may. A practice DMV on this machine, when the site is
 * on this machine too; the real DMV only once the person has said yes, since it
 * is automated traffic from their own address. Asked to look anywhere else it
 * answers that it could not, stops offering to read for the rest of the run,
 * and the site hands the line to somebody else.
 *
 * The yes is its own: checking lines (`realDmvChecks`) is looking, and earns
 * the person credits on the site for every hour of it (the server's
 * allowance.py); booking for them (`robotBooking`, booker.js) is a separate
 * yes. Somebody who said yes to booking on the real DMV (`realDmvRobots`)
 * before there were two said yes to looking with it. A site elsewhere than this machine has its lines on the real
 * DMV, so without the yes this app does not offer to read for it at all — and
 * every sync says whether it has one (`agreed`), which is what the site pays for.
 */
const { ROBOTS, targetAllowed, isRealDmv, isLoopback } = require('./robots');

function refusal(message) {
  return { protocol: 'RQP/1', kind: 'discovery.result', status: 'rejected', message, offers: [], checked: [] };
}

class Reader {
  /**
   * @param {object} opts
   * @param {object} opts.runner          a RobotRunner
   * @param {function} opts.getClient     the SyncClient in use now (it changes on a reset)
   * @param {function} opts.getStore      the settings in use now
   * @param {function} [opts.onRead]      ({status, ms, offices, found, read}) after each read, for
   *                                      telemetry.js and the trace (traces.js)
   */
  constructor({ runner, getClient, getStore, log = () => {}, onState = () => {}, onRead = () => {} }) {
    Object.assign(this, { runner, getClient, getStore, log, onState, onRead });
    this.current = null;
    this.last = null;
    this.busy = false;
    this.stopped = false;
    this.declined = false;
    this.answered = new Set();
    // Until when this app will not start another look. A pace is "wait, then
    // look"; a drop is "this device is paused". Neither slows the sync that
    // carries a booking — only offer() looks at them.
    this.readyAt = 0;
    this.droppedUntil = 0;
  }

  /** Whether the person has said this app may look at the real DMV. */
  mayLookAtRealDmv() {
    const store = this.getStore();
    return Boolean(store.get('realDmvChecks', store.get('realDmvRobots', false)));
  }

  /** Whether the person has answered that, either way — so the app stops asking. */
  decided() {
    const store = this.getStore();
    const chosen = (key) => (typeof store.chosen === 'function' ? store.chosen(key) : store.get(key) !== undefined);
    return chosen('realDmvChecks') || Boolean(store.get('realDmvRobots', false));
  }

  /** Whether this app has its person's yes to look where the site's lines are. */
  agreed() {
    return isLoopback(this.getClient().serverUrl) || this.mayLookAtRealDmv();
  }

  /** Whether this app offers to read: robots on board, the person has not said no. */
  enabled() {
    return !this.stopped && !this.declined && this.runner.available()
      && this.getStore().get('readerEnabled', true) !== false && this.agreed();
  }

  /**
   * What a sync said about how hard the site is working (traffic.py). A pace
   * starts a wait only when one is not already running, so a sync every few
   * seconds cannot push the wait out forever. A drop is the site's word: when
   * it stops sending one, this app stops honouring it.
   */
  notePace(readerDoc) {
    if (!readerDoc || typeof readerDoc !== 'object') return;
    const pace = Number(readerDoc.pace_ms) || 0;
    if (pace > 0 && Date.now() >= this.readyAt) this.readyAt = Date.now() + pace;
    if ('dropped_until' in readerDoc) {
      const until = Date.parse(readerDoc.dropped_until || '');
      this.droppedUntil = Number.isFinite(until) ? until : 0;
    }
  }

  /** What each sync says about this app's reader (reads.parse_caps on the site). */
  capabilities() {
    return { enabled: this.enabled(), robots: ROBOTS,
      reading: this.current ? this.current.read_id : null, busy: this.busy, agreed: this.agreed() };
  }

  state() {
    return {
      enabled: this.enabled(), busy: this.busy, last: this.last,
      // For the screens: whether checking lines waits on the person's yes, and
      // whether they have answered.
      wanted: this.getStore().get('readerEnabled', true) !== false,
      available: this.runner.available(), agreed: this.agreed(), answered: this.decided(),
      reading: this.current ? { read_id: this.current.read_id, queue_name: this.current.queue_name,
        site_name: this.current.site_name, offices: (this.current.request.offices || []).length } : null,
    };
  }

  emit() {
    this.onState(this.state());
  }

  /** Booking a slot for the person: take no new read until that is done. */
  setBusy(busy) {
    this.busy = Boolean(busy);
    this.emit();
  }

  /** A change of the person's mind in Settings: ask again. */
  reconsider() {
    this.declined = false;
    this.emit();
  }

  /**
   * The reads a sync handed this device. One runs at a time. One this app will
   * not do — checking turned off since it was handed out, or no yes for where
   * it goes — is given back at once, so the site does not hold it against the
   * app as one left unanswered.
   */
  offer(reads) {
    if (!Array.isArray(reads) || !reads.length || this.current) return;
    const read = reads.find((r) => r && !this.answered.has(r.read_id));
    if (!read) return;
    if (Date.now() < this.droppedUntil) {
      // Paused. Give it back so the site does not hold the lease for an app
      // that will not start it. A look already running is this.current and
      // was returned above; it finishes, and the answer is the site's to refuse.
      this.answered.add(read.read_id);
      Promise.resolve().then(() => this.getClient().releaseRead(read.read_id))
        .catch((err) => this.log(`giving back read ${read.read_id}: ${err.message}`));
      return;
    }
    // Told to slow down. Leave the read issued: the next sync offers it again
    // once the wait is over, and the lease is long enough to cover the wait.
    if (Date.now() < this.readyAt) return;
    if (this.enabled()) {
      this.run(read);
      return;
    }
    if (this.stopped) return;
    this.answered.add(read.read_id);
    Promise.resolve().then(() => this.getClient().releaseRead(read.read_id))
      .catch((err) => this.log(`giving back read ${read.read_id}: ${err.message}`));
  }

  async run(read) {
    this.current = read;
    this.emit();
    const client = this.getClient();
    const started = Date.now();
    const offices = (read.request && read.request.offices || []).length;
    let told = null;
    try {
      let result;
      if (!targetAllowed(read.base_url, client.serverUrl)) {
        this.declined = true;
        result = refusal(`This app does not send its robots to ${read.base_url}.`);
      } else if (isRealDmv(read.base_url) && !this.mayLookAtRealDmv()) {
        // Asked once; after this the app stops offering until the person says yes.
        this.declined = true;
        result = refusal('The person has not let this app look at the real DMV from their computer.');
      } else {
        this.log(`looking for openings on ${read.queue_name} — ${(read.request.offices || []).length} office(s)`);
        const seconds = Math.max(30, Math.min(Number(read.timeout_s) || 600, 600));
        result = await this.runner.run('scout', read.request, {
          dmvBase: read.base_url, solverUrl: read.captcha_solver_url || '', timeoutMs: seconds * 1000,
          context: { read: read.read_id } });
      }
      if (this.stopped) return;
      const reply = await client.answerRead(read.read_id, result);
      const pace = Number(reply && reply.pace_ms) || 0;
      if (pace > 0) this.readyAt = Math.max(this.readyAt, Date.now() + pace);
      const verdicts = {};
      for (const o of reply.offers || []) if (o && o.verdict) verdicts[o.verdict] = (verdicts[o.verdict] || 0) + 1;
      told = { status: reply.status || result.status, found: Number(reply.recorded) || 0, robot: result.status,
        verdicts };
      this.last = {
        read_id: read.read_id, queue_name: read.queue_name, at: Date.now(), status: reply.status,
        recorded: reply.recorded,
        offers: (reply.offers || []).map((o) => ({ where: o.where, verdict: o.verdict, to: o.to })),
      };
      this.log(`read ${read.read_id} on ${read.queue_name}: ${reply.status}, ${reply.recorded} opening(s)`
        + (reply.offers && reply.offers.length ? ` — ${reply.offers.map((o) => `${o.where}: ${o.verdict}`
          + (o.to && !o.to.you ? ` to #${o.to.rank}` : '')).join('; ')}` : ''));
    } catch (err) {
      // Too late, or answered already: the site has moved on, and so does this.
      // A 429 is different. The site did not take the answer, so the read is
      // still issued; give it back, and wait out Retry-After before the next
      // look, or the same read is pinned until its lease runs out.
      this.log(`read ${read.read_id}: ${err.message}`);
      told = { status: 'unanswered', found: 0, http: err.status || 0, error: err.message };
      if (err && err.status === 429) {
        const wait = Number(err.retryAfter);
        const ms = (Number.isFinite(wait) && wait > 0 ? wait : 30) * 1000;
        this.readyAt = Math.max(this.readyAt, Date.now() + ms);
        try {
          await client.releaseRead(read.read_id);
        } catch (give) {
          this.log(`giving back read ${read.read_id}: ${give.message}`);
        }
      }
    } finally {
      if (told) {
        try {
          this.onRead({ ...told, ms: Date.now() - started, offices, read: read.read_id, queue: read.queue_id });
        } catch { /* telemetry is never the problem */ }
      }
      this.answered.add(read.read_id);
      if (this.current === read) this.current = null;
      this.emit();
    }
  }

  /**
   * The app is closing: give the read in hand back to the site, so nothing is
   * taken for looked at by an app that is gone. Brief and best effort — it
   * resolves by `timeoutMs` whatever the site does. Stop the robots after.
   */
  release(timeoutMs = 1500) {
    const read = this.current;
    if (!read) return Promise.resolve(false);
    this.answered.add(read.read_id);
    const given = Promise.resolve()
      .then(() => this.getClient().releaseRead(read.read_id))
      .then((reply) => Boolean(reply && reply.released), () => false);
    return Promise.race([given, new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
  }

  /**
   * On quit, and on a full reset: stop looking, now. Only the robots that look
   * stop here; one booking the person's slot is the booker's to finish (on a
   * reset, main.js stops that one too).
   */
  stop() {
    this.stopped = true;
    this.runner.stop('scout');
    this.current = null;
  }

  /** After a reset: a new account, the same robots. */
  restart() {
    this.stopped = false;
    this.declined = false;
    this.answered.clear();
    this.readyAt = 0;
    this.droppedUntil = 0;
    this.last = null;
    this.emit();
  }
}

module.exports = { Reader };
