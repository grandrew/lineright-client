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
 *                  still hears that they have the appointment — and is shown
 *                  the confirmation page: where it was, and the robot's picture
 *                  of it (`shotsDir`), for when that page opens nowhere else.
 *   slot gone      "gone": it comes off the board, and the person keeps their place.
 *                  Not after taking over from a quiet device, which most likely
 *                  booked it before it went quiet: the hand-off runs out its time
 *                  instead, for that device's "I booked it" to arrive.
 *   claimed        another of the person's devices has it; this one stands back —
 *                  unless this computer's robot booked it already, left running
 *                  when the app crashed mid-booking: that booking is the
 *                  appointment, and the app, started again, says so.
 *   too late       the slot is no longer held for them; nothing to open.
 *   anything else  a human check, a timeout, a booking the DMV did not confirm —
 *                  the booking page opens for the person to finish, as a hand-off
 *                  always has, and the bar says why.
 * A booking the DMV did not confirm is never tried again: the appointment may
 * exist, and a second try could make two.
 *
 * With AI booking oversight (overseer.js) — the person bought credits and left
 * it on — the robot runs with a channel open to the app, and when it gets stuck
 * on a page it no longer knows its way round, the AI takes its browser over
 * and finishes before any of the above is decided: what the robot answers then
 * is what the AI made of it (`overseen`), held to the same rules.
 *
 * Closing the app does not stop a booking under way (`finish`): the app waits
 * for the robot, tells the site how it went, then goes. Stopped part way, the
 * robot may have sent the form and booked the slot with nobody left to say so,
 * and the turn would run out as missed while the person has the appointment.
 *
 * None of this happens until the person has said yes ("Let the app book for
 * me", `robotBooking`), on the real DMV or a practice one alike: until then a
 * slot that is theirs opens on the booking page for them to book, which is what
 * they expect when they have not asked for anything else. A yes given before
 * there was one switch — to booking on the real DMV, `realDmvRobots` — counts.
 */
const path = require('node:path');
const { targetAllowed } = require('./robots');

/** Whether the person has let the app's robot book for them. */
function mayBook(store) {
  return Boolean(store.get('robotBooking', store.get('realDmvRobots', false)));
}

/** How long a booking the site has not heard about is reported again. */
const REPORT_FOR_MS = 30 * 60 * 1000;

/** How long closing the app waits for a booking under way: past any robot's own time (budgetMs). */
const FINISH_MS = 5 * 60 * 1000;

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
   * @param {function} [opts.onOutcome] ({kind, ms, job, outcome}) after each booking attempt, for
   *                                    telemetry.js and the trace (traces.js)
   * @param {string} [opts.shotsDir]   where the robot keeps its pictures of confirmation pages; none without
   */
  constructor({ runner, getClient, getStore, getProfile, reader = null, log = () => {}, onState = () => {},
    onOutcome = () => {}, shotsDir = '', overseer = null }) {
    Object.assign(this, { runner, getClient, getStore, getProfile, reader, log, onState, onOutcome, shotsDir, overseer });
    this.current = null;
    // Two hand-offs can arrive in one sync (one person, two lines), and each is
    // booked at once: busy, and the booking on show, last until both are done.
    this.running = new Map();   // job id -> the booking under way
    this.last = null;
    this.tried = new Set();
    this.pending = new Map();   // job id -> a booking the site has not heard about yet
    this.retrying = false;
    this.idle = [];             // waiting in finish() for the bookings under way
  }

  /**
   * Wait for the bookings under way to end — the robot done, and the site told
   * how it went — or for `timeoutMs`. True when none is left. On closing the app.
   */
  finish(timeoutMs = FINISH_MS) {
    if (!this.running.size) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idle.push(() => { clearTimeout(timer); resolve(true); });
    });
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
    // This computer's robot booked it already — before the app crashed, say —
    // and the site never heard: that is the appointment, whichever of the
    // person's devices holds the slot now. book() says so.
    if (this.recorded(h)) return { ok: true, recorded: true };
    if (h.booker && !h.booker.you && !h.booker.silent) return { ok: false, why: 'elsewhere', device: h.booker.name };
    if (!this.runner.available()) return { ok: false, why: 'no-robot' };
    if (!targetAllowed(h.robot.base_url, this.getClient().serverUrl)) return { ok: false, why: 'target' };
    if (!mayBook(store)) return { ok: false, why: 'not-agreed' };
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
    if (envelope.idempotency_key) envelope.idempotency_key = this.keyFor(h);
    return envelope;
  }

  /**
   * The key the robot books this hand-off under. Its replay store is this
   * machine's, and outlives any one site or database; a key is only unique
   * within the site that issued it, so the site's host goes in front.
   */
  keyFor(h) {
    const key = h && h.robot && h.robot.request && h.robot.request.idempotency_key;
    if (!key) return null;
    let host = '';
    try { host = new URL(this.getClient().serverUrl).host; } catch { /* no site: keep the key as it is */ }
    return host ? `${host}/${key}` : key;
  }

  /** Where the picture of this hand-off's confirmation page goes, if pictures are kept. */
  shotFor(h) {
    const key = this.keyFor(h);
    return this.shotsDir && key ? path.join(this.shotsDir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`) : '';
  }

  /** The booking this computer's robot made for this hand-off, if it made one: `{ confirmation, … }`. */
  recorded(h) {
    if (!h || !h.robot || typeof this.runner.recorded !== 'function') return null;
    const record = this.runner.recorded(this.keyFor(h));
    return record && record.confirmation ? record : null;
  }

  /**
   * Book it. Resolves to what happened:
   *   { kind: 'booked', confirmation, url, shot, unreported?, recorded? } | { kind: 'gone', quiet?, device? } |
   *   { kind: 'elsewhere', device } | { kind: 'late', why } |
   *   { kind: 'page', why, unconfirmed? }
   */
  async book(h) {
    const started = Date.now();
    this.tried.add(h.job_id);
    const client = this.getClient();
    const where = h.slot ? `${h.slot.office_name} on ${h.slot.date} at ${h.slot.time}` : h.queue_name;
    this.running.set(h.job_id, { job_id: h.job_id, queue_name: h.queue_name, where });
    this.current = this.running.get(h.job_id);
    if (this.reader) this.reader.setBusy(true);
    this.onState(this.state());
    let outcome;
    try {
      const made = this.recorded(h);
      if (made) {
        // Booked by this computer's robot while the app was not there to say so
        // (it crashed, or was closed, mid-booking). Say it now — no claim, and no
        // second robot: another device may hold the slot by now, and its robot
        // will have found it gone.
        this.log(`${where} was booked by this computer's robot before the app stopped (${made.confirmation})`);
        outcome = { kind: 'booked', confirmation: made.confirmation, recorded: true,
          url: made.confirmation_url || null, shot: made.confirmation_shot || null };
        try {
          await client.booked(h.job_id, made.confirmation, { robot: true });
        } catch (err) {
          outcome.unreported = err.message;
          if (!definitive(err)) {
            this.pending.set(h.job_id, { confirmation: made.confirmation, where, since: Date.now() });
          }
        }
        return outcome;
      }
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
      // AI oversight, when the person has it: a channel to the robot as it books,
      // for its stuck moments (overseer.js).
      const timeoutMs = budgetMs(h.seconds_left);
      const watch = this.overseer && this.overseer.wanted() ? this.overseer.watch(h, { deadline: Date.now() + timeoutMs }) : null;
      const result = await this.runner.run('book', this.request(h), {
        dmvBase: h.robot.base_url, solverUrl: h.robot.captcha_solver_url || '', allowBooking: true,
        timeoutMs, confirmationShot: this.shotFor(h), context: { job: h.job_id }, ...(watch ? { watch } : {}),
      });
      const overseen = result.overseen ? { overseen: true } : {};
      if (result.status === 'confirmed' && result.confirmation) {
        outcome = { kind: 'booked', confirmation: result.confirmation,
          url: result.confirmation_url || null, shot: result.confirmation_shot || null, ...overseen };
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
        outcome = { kind: 'gone', ...overseen };
        try {
          await client.gone(h.job_id, result.message || '');
        } catch (err) {
          this.log(`the site did not take "gone" for job ${h.job_id}: ${err.message}`);
        }
      } else if (result.unconfirmed) {
        outcome = { kind: 'page', unconfirmed: true, ...overseen, why: 'The robot went as far as booking it, but the DMV showed no confirmation. Check your email for one before you book it again.' };
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
      try {
        this.onOutcome({ kind: outcome ? outcome.kind : 'stopped', ms: Date.now() - started, job: h.job_id,
          outcome: outcome || null });
      } catch { /* never the problem */ }
      this.last = outcome ? { job_id: h.job_id, queue_name: h.queue_name, where, ...outcome, at: Date.now() } : this.last;
      this.running.delete(h.job_id);
      this.current = [...this.running.values()].at(-1) || null;
      if (this.reader) this.reader.setBusy(this.running.size > 0);
      this.onState(this.state());
      if (!this.running.size) for (const done of this.idle.splice(0)) done();
    }
  }
}

module.exports = { mayBook, Booker, budgetMs, definitive };
