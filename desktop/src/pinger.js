'use strict';
/**
 * Pinging the regbot site: how the site times this app, and how the app hears
 * within a second that a slot is its person's.
 *
 * A found slot is offered to the top few in line a few seconds apart, and the
 * first to book it has it (the server's offering.py). Two things decide how this
 * app fares in that: how quickly it hears, and how slow its connection is.
 *
 * Hearing. Every `next_ms` — the site says how often: every second or so when
 * the person is near the front of a line, rarely otherwise — the app pings.
 * `wake` in the reply means a slot was released to this person since the app
 * last synced, and the app syncs at once rather than waiting its turn.
 *
 * Timing. When the site asks (`measure`), the app sends the echo it was given
 * straight back in a second ping, and the site times the round trip on its own
 * clock (the server's presence.py). The site then says, on every sync, how this
 * connection stands among the apps online — and drops one too slow to wait for.
 *
 * Everything here is plain Node and takes its clock and its client from
 * outside, so it runs under `node --test`.
 */

const IDLE_MS = 15000;

class Pinger {
  /**
   * @param {object} opts
   * @param {function} opts.getClient   the SyncClient in use now
   * @param {function} [opts.onWake]    a slot was released to this person: sync now
   * @param {function} [opts.onMeasured] ({rtt_ms, at}) after the site timed a round trip
   * @param {number} [opts.delayMs]     held before answering an echo: tests only, a slow line
   */
  constructor({ getClient, onWake = () => {}, onMeasured = () => {}, log = () => {}, delayMs = 0,
    setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }) {
    Object.assign(this, { getClient, onWake, onMeasured, log, delayMs });
    this.setTimeout = st;
    this.clearTimeout = ct;
    this.running = false;
    this.timer = null;
    this.last = null;         // { rtt_ms, at } — the last round trip the site timed
    this.everyMs = IDLE_MS;
  }

  start() {
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(ms) {
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    this.timer = this.setTimeout(() => { this.timer = null; this.tick(); }, Math.max(0, ms));
  }

  /** One ping, and the echo straight back when the site asks to time it. */
  async tick() {
    let next = this.everyMs;
    try {
      const client = this.getClient();
      if (client && client.paired) {
        const first = await client.ping({});
        next = Number(first.next_ms) || next;
        this.everyMs = next;
        if (first.wake) this.onWake();
        if (first.measure && first.echo) {
          if (this.delayMs) await new Promise((resolve) => this.setTimeout(resolve, this.delayMs));
          const second = await client.ping({ echo: first.echo });
          if (second.rtt_ms !== null && second.rtt_ms !== undefined) {
            this.last = { rtt_ms: Number(second.rtt_ms), at: Date.now() };
            this.onMeasured(this.last);
          }
          if (second.wake) this.onWake();
        }
      }
    } catch (err) {
      // Offline, or signed out: the sync loop says so. Try again at an easy pace.
      next = Math.max(next, 5000);
    } finally {
      this.schedule(next);
    }
  }
}

module.exports = { Pinger, IDLE_MS };
