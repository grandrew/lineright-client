'use strict';
/**
 * Booking the person's own slot, from this computer.
 *
 * When the regbot site says a slot is this person's, it hands their app the
 * booking request it stored for the job — the line, the window, the allocated
 * slot, the office choice, an idempotency key (the hand-off's `robot` block,
 * the server's client_api.handoff_view). The booking handler robot (robots.js)
 * books it here, with the details the form wants taken from the profile kept on
 * this machine: the only place they are used, and they go nowhere but into that
 * form. The first of the person's devices to claim the slot books it; the others
 * stand back — unless it goes quiet (closed, crashed, off the network): then
 * the next one takes it over, and should the quiet one still be booking after
 * all, the two race for one slot the booking site lets only one of them have.
 *
 * What happens then:
 *   confirmed      "I booked it", with the DMV's own confirmation number. Booked
 *                  is booked: if the site will not take the report, the person
 *                  still hears that they have the appointment.
 *   slot gone      "gone": it comes off the board, and the person keeps their place.
 *                  Not after taking over from a quiet device, which most likely
 *                  booked it before it went quiet: the hand-off runs out its time
 *                  instead, for that device's "I booked it" to arrive.
 *   claimed        another of the person's devices has it; this one stands back.
 *   too late       the slot is no longer held for them; nothing to open.
 *   anything else  a human check, a timeout, a booking the DMV did not confirm —
 *                  the booking page opens for the person to finish, as a hand-off
 *                  always has, and the bar says why.
 * A booking the DMV did not confirm is never tried again: the appointment may
 * exist, and a second try could make two.
 *
 * On the real DMV none of this happens until the person has said yes.
 */
const { targetAllowed, isRealDmv } = require('./robots');

/** How long a booking the site has not heard about is reported again. */
const REPORT_FOR_MS = 30 * 60 * 1000;

/** An answer from the site that settles it, yes or no — as against no answer. */
function definitive(err) {
  return err && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** How long the robot may take: the hand-off's time, less a margin for the page. */
function budgetMs(secondsLeft) {
  const left = Number(secondsLeft);
  const seconds = Number.isFinite(left) && left > 0 ? Math.min(left - 45, 240) : 240;
  return Math.max(30, seconds) * 1000;
}

class Booker {
  /**
   * @param {object} opts
   * @param {object} opts.runner       a RobotRunner
   * @param {function} opts.getClient  the SyncClient in use now
   * @param {function} opts.getStore   the settings in use now
   * @param {function} opts.getProfile the profile's values now ({key: value})
   * @param {object} [opts.reader]     told it is busy while a booking runs
   * @param {function} [opts.onOutcome] ({kind, ms}) after each booking attempt, for telemetry.js
   */
  constructor({ runner, getClient, getStore, getProfile, reader = null, log = () => {}, onState = () => {},
    onOutcome = () => {} }) {
    Object.assign(this, { runner, getClient, getStore, getProfile, reader, log, onState, onOutcome });
    this.current = null;
    this.last = null;
    this.tried = new Set();
    this.pending = new Map();   // job id -> a booking the site has not heard about yet
    this.retrying = false;
  }

  state() {
    return { booking: this.current, lastBooking: this.last };
  }

  /** Another account, or another site: its hand-offs are not the ones tried here. */
  forget() {
    this.tried.clear();
    this.pending.clear();
    this.last = null;
  }

  /**
   * Say "I booked it" again for bookings the site did not hear about: it could
   * not be reached when the robot finished. Called on every sync; each one stops
   * at an answer, yes or no, or after half an hour.
   */
  async retryReports() {
    if (this.retrying || !this.pending.size) return;
    this.retrying = true;
    try {
      const client = this.getClient();
      for (const [jobId, report] of [...this.pending]) {
        if (Date.now() - report.since > REPORT_FOR_MS) {
          this.pending.delete(jobId);
          continue;
        }
        try {
          await client.booked(jobId, report.confirmation, { robot: true });
          this.pending.delete(jobId);
          this.log(`the site has now heard that ${report.where} was booked (${report.confirmation})`);
        } catch (err) {
          if (!definitive(err)) continue;
          this.pending.delete(jobId);
          this.log(`the site would not take the booking of ${report.where}: ${err.message}`);
        }
      }
    } finally {
      this.retrying = false;
    }
  }

  /**
   * Whether this app books this hand-off itself. `{ ok }`, or why not: the
   * reason decides what the app does instead (open the page, or leave it to the
   * device that has it).
   */
  wants(h) {
    const store = this.getStore();
    if (!h || h.phase !== 'booking' || !h.slot || !h.robot) return { ok: false, why: 'no-robot' };
    // Offered to several, and somebody else booked it or found it gone already.
    if (h.over) return { ok: false, why: 'over' };
    if (this.tried.has(h.job_id)) return { ok: false, why: 'tried' };
    if (h.booker && !h.booker.you && !h.booker.silent) return { ok: false, why: 'elsewhere', device: h.booker.name };
    if (!this.runner.available()) return { ok: false, why: 'no-robot' };
    if (!targetAllowed(h.robot.base_url, this.getClient().serverUrl)) return { ok: false, why: 'target' };
    if (isRealDmv(h.robot.base_url) && !store.get('realDmvRobots', false)) return { ok: false, why: 'not-agreed' };
    const values = this.getProfile();
    const missing = (h.robot.requires || []).filter((key) => !String(values[key] || '').trim());
    if (missing.length) return { ok: false, why: 'profile', missing };
    return { ok: true };
  }

  /** The stored request, with the details the form wants added from the profile. */
  request(h) {
    const envelope = JSON.parse(JSON.stringify(h.robot.request));
    const personal = envelope.personal_data && typeof envelope.personal_data === 'object'
      ? envelope.personal_data : {};
    const values = this.getProfile();
    for (const key of h.robot.requires || []) personal[key] = String(values[key] || '').trim();
    envelope.personal_data = personal;
    // The robot's replay store is this machine's, and outlives any one site or
    // database; a key is only unique within the site that issued it.
    let host = '';
    try { host = new URL(this.getClient().serverUrl).host; } catch { /* no site: keep the key as it is */ }
    if (host && envelope.idempotency_key) envelope.idempotency_key = `${host}/${envelope.idempotency_key}`;
    return envelope;
  }

  /**
   * Book it. Resolves to what happened:
   *   { kind: 'booked', confirmation, unreported? } | { kind: 'gone', quiet?, device? } |
   *   { kind: 'elsewhere', device } | { kind: 'late', why } |
   *   { kind: 'page', why, unconfirmed? }
   */
  async book(h) {
    const started = Date.now();
    this.tried.add(h.job_id);
    const client = this.getClient();
    const where = h.slot ? `${h.slot.office_name} on ${h.slot.date} at ${h.slot.time}` : h.queue_name;
    this.current = { job_id: h.job_id, queue_name: h.queue_name, where };
    if (this.reader) this.reader.setBusy(true);
    this.onState(this.state());
    let outcome;
    try {
      let claim;
      try {
        claim = await client.claim(h.job_id);
      } catch (err) {
        if (err.status === 409 && err.body && err.body.booker) {
          // Another device got there first. Not tried here: should that one go
          // quiet, this one may yet take it over.
          this.tried.delete(h.job_id);
          outcome = { kind: 'elsewhere', device: String(err.body.booker.name || 'Another device') };
          return outcome;
        }
        if (err.status === 409 || err.status === 404) {
          // Its time ran out, or it went on to the next bidder, before the robot started.
          outcome = { kind: 'late', why: err.message };
          return outcome;
        }
        throw err;
      }
      const tookOver = (claim && claim.took_over_from) || '';
      this.log(`booking ${where} for ${h.queue_name}`
        + (tookOver ? `, taking it over from ${tookOver}, which stopped answering` : ''));
      const result = await this.runner.run('book', this.request(h), {
        dmvBase: h.robot.base_url, solverUrl: h.robot.captcha_solver_url || '', allowBooking: true,
        timeoutMs: budgetMs(h.seconds_left),
      });
      if (result.status === 'confirmed' && result.confirmation) {
        outcome = { kind: 'booked', confirmation: result.confirmation };
        try {
          await client.booked(h.job_id, result.confirmation, { robot: true });
        } catch (err) {
          outcome.unreported = err.message;
          // No answer at all is not "no": say it again until the site hears it.
          if (!definitive(err)) {
            this.pending.set(h.job_id, { confirmation: result.confirmation, where, since: Date.now() });
          }
        }
      } else if (result.slot_gone && tookOver) {
        // The quiet device most likely booked it before it went quiet. "Gone"
        // would put the person back in line holding an appointment; the hand-off
        // runs out its time instead, for that device's "I booked it" to arrive.
        outcome = { kind: 'gone', quiet: true, device: tookOver };
      } else if (result.slot_gone) {
        outcome = { kind: 'gone' };
        try {
          await client.gone(h.job_id, result.message || '');
        } catch (err) {
          this.log(`the site did not take "gone" for job ${h.job_id}: ${err.message}`);
        }
      } else if (result.unconfirmed) {
        outcome = { kind: 'page', unconfirmed: true, why: 'The robot went as far as booking it, but the DMV showed no confirmation. Check your email for one before you book it again.' };
      } else if (result.gate) {
        outcome = { kind: 'page', why: 'The DMV asked for a human check. Finish booking it on the page.' };
      } else {
        outcome = { kind: 'page', why: `The robot could not book it (${result.message || result.status}). Finish booking it on the page.` };
      }
      return outcome;
    } catch (err) {
      outcome = { kind: 'page', why: `The robot could not book it (${err.message}). Finish booking it on the page.` };
      return outcome;
    } finally {
      this.log(`booking ${where}: ${outcome ? outcome.kind : 'stopped'}`);
      try { this.onOutcome({ kind: outcome ? outcome.kind : 'stopped', ms: Date.now() - started }); } catch { /* never the problem */ }
      this.last = outcome ? { job_id: h.job_id, queue_name: h.queue_name, where, ...outcome, at: Date.now() } : this.last;
      this.current = null;
      if (this.reader) this.reader.setBusy(false);
      this.onState(this.state());
    }
  }
}

module.exports = { Booker, budgetMs, definitive };
