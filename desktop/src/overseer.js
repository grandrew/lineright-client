'use strict';
/**
 * AI booking oversight: a senior pair of eyes on the booking robot.
 *
 * When a slot is the person's, this app's robot books it (booker.js, the dmq
 * handler) in a browser of its own, out of sight. It follows the booking site's
 * pages as they were when it was written; a site that changed under it — a
 * button renamed, a label reworded, a confirmation laid out anew — stops it,
 * and without oversight the person is handed the page to finish by hand, if
 * they are there to see it in time.
 *
 * With oversight, the app keeps a channel to the robot as it books
 * (dmq/src/control.js). It hears each step the robot takes; and when the robot
 * is stuck it is asked, before the robot gives up, whether it takes over. If
 * the person has it on and has bought credits for it (the site's agent.py says
 * so on every sync), it does: it opens a session on the site, takes the robot's
 * page as it is — mid-booking, the time already held — and a language model,
 * asked through the site and charged to the person's bought credits, works the
 * page from there (agent/loop.js) until the booking is made, or found gone, or
 * shown to need the person. Then it tells the robot what came of it, and the
 * robot ends with that as if it had done it itself — a booking it says it made
 * believed only with its confirmation number on the page.
 *
 * Three moments it is asked in (dmq/src/bot.js):
 *   booking     stuck before the booking went: finish it
 *   gone        nothing at all to choose where the slot should be: look again
 *   confirming  sent, and no confirmation number seen: read the page, press nothing
 * A human check is never one of them: that is the person's.
 *
 * And when it stepped in, it says so to the site (`agentReport`): where the
 * robot was stuck and why, each step it took — the person's details only as
 * their placeholders — and how it ended. That is how the people running the
 * site see a booking site change before the next person's booking fails on it.
 *
 * None of the person's details go to the model: a page is read with them taken
 * out (scrub.js), and the model types a placeholder ("[first_name]") that is
 * filled in here, on this computer.
 */
const { RobotDriver } = require('./agent/drivers');
const { runAgent } = require('./agent/loop');
const { overseeBooking } = require('./agent/prompts');
const { Scrubber } = require('./scrub');

/** The least time worth taking over with. */
const MIN_TAKEOVER_MS = 30000;
/** Kept back from the robot's own time, for it to finish after the AI is done. */
const MARGIN_MS = 15000;
/** How long one command on the robot's page may take. */
const COMMAND_MS = 30000;
/** A booking robot this quiet is said to have stalled (in the report and the trace). */
const STALL_MS = 60000;
/** Steps one takeover may take. */
const MAX_STEPS = 30;

/** What the site is told a session came to, from how the model finished. */
const REPORTED = { booked: 'booked', gone: 'gone', human_check: 'handed', unconfirmed: 'failed', failed: 'failed' };

class Overseer {
  /**
   * @param {object} opts
   * @param {function} opts.getClient   the SyncClient in use now
   * @param {function} opts.getStore    the settings
   * @param {function} opts.getProfile  the profile's values
   * @param {function} opts.getStatus   the site's word on this account (sync's `agent`), or null
   * @param {function} [opts.onState]   (state) the oversight changed: for the window
   * @param {function} [opts.onEvent]   ({kind, …}) for the trace and the log
   */
  constructor({ getClient, getStore, getProfile, getStatus, onState = () => {}, onEvent = () => {}, log = () => {},
    appVersion = '', now = () => Date.now(), setInterval: si = setInterval, clearInterval: ci = clearInterval,
    runAgent: ra = runAgent }) {
    Object.assign(this, { getClient, getStore, getProfile, getStatus, onState, onEvent, log, appVersion, now,
      setInterval: si, clearInterval: ci, runAgent: ra });
    this.active = null;    // the takeover under way
    this.last = null;      // how the last one ended
    this.status = null;    // what the site said last, when a session was refused
  }

  /** Whether the person has it on: Settings → AI booking oversight. On unless they turned it off. */
  on() {
    return this.getStore().get('aiOversight', true) !== false;
  }

  /** The site's word on this account: may it, and on what terms. */
  terms() {
    return this.getStatus() || this.status || null;
  }

  /** Whether a robot run should keep a channel open for oversight at all. */
  wanted() {
    const t = this.terms();
    return this.on() && Boolean(t && t.available);
  }

  state() {
    const t = this.terms();
    return {
      on: this.on(), available: Boolean(t && t.available), why: t ? t.why || '' : 'unknown',
      message: t ? t.message || '' : '', terms: t || null, active: this.active, last: this.last,
    };
  }

  changed() {
    try { this.onState(this.state()); } catch { /* never the problem */ }
  }

  /**
   * Oversight of one booking run: `h` the hand-off being booked, `deadline`
   * (epoch ms) when the runner stops the robot. robots.js attaches it to the
   * robot process once it is started.
   */
  watch(h, { deadline }) {
    return new Watch(this, h, deadline);
  }
}

class Watch {
  constructor(overseer, h, deadline) {
    this.o = overseer;
    this.h = h;
    this.deadline = deadline;
    this.child = null;
    this.steps = [];
    this.pending = new Map();
    this.seq = 0;
    this.took = false;
    this.stalls = 0;
    this.lastStepAt = overseer.now();
    this.timer = null;
  }

  /** The robot is running: listen to it. */
  attach(child) {
    this.child = child;
    child.on('message', (message) => this.heard(message));
    this.timer = this.o.setInterval(() => {
      if (this.o.active && this.o.active.job_id === this.h.job_id) return;
      if (this.o.now() - this.lastStepAt > STALL_MS) {
        this.stalls += 1;
        this.lastStepAt = this.o.now();
        this.o.onEvent({ kind: 'robot.stall', job: this.h.job_id, step: this.steps.length ? this.steps[this.steps.length - 1].tag : '' });
      }
    }, 10000);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  /** The robot has ended: nothing more will come, and nothing can be asked of it. */
  detach() {
    if (this.timer) this.o.clearInterval(this.timer);
    this.timer = null;
    for (const [, waiting] of this.pending) waiting.reject(new Error('the robot has stopped'));
    this.pending.clear();
  }

  send(message) {
    try {
      if (this.child && this.child.connected) this.child.send({ lr: 'app', ...message });
    } catch { /* the robot went: detach() says so */ }
  }

  heard(message) {
    if (!message || message.lr !== 'robot') return;
    if (message.type === 'step') {
      this.lastStepAt = this.o.now();
      this.steps.push({ tag: String(message.tag || ''), detail: String(message.detail || '').slice(0, 300) });
      if (this.steps.length > 40) this.steps.shift();
    } else if (message.type === 'result') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new Error(message.error || 'it did not work'));
    } else if (message.type === 'trouble') {
      this.trouble(message).catch((err) => {
        this.o.log(`oversight failed: ${err.message}`);
        this.send({ type: 'done', outcome: { status: 'failed', why: `the oversight failed: ${err.message}` } });
      });
    }
  }

  /** One command on the robot's page. */
  request(op, args) {
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`the robot's browser did not answer "${op}"`));
      }, COMMAND_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ type: 'cmd', id, op, args });
    });
  }

  /** The robot is stuck: take over, or say no. */
  async trouble(m) {
    const o = this.o;
    const h = this.h;
    const where = h.slot ? `${h.slot.office_name} on ${h.slot.date} at ${h.slot.time}` : h.queue_name;
    const decline = (why) => {
      this.send({ type: 'decline', id: m.id });
      o.log(`the robot is stuck booking ${where} (${m.stage}: ${m.why}); oversight stays out: ${why}`);
      o.onEvent({ kind: 'agent.declined', job: h.job_id, stage: m.stage, why });
    };
    if (!o.on()) return decline('it is switched off');
    const terms = o.terms();
    if (!terms || !terms.available) return decline((terms && terms.message) || 'the site does not offer it to this account');
    if (this.took) return decline('it took over once already in this run');
    const left = this.deadline - o.now() - MARGIN_MS;
    if (left < MIN_TAKEOVER_MS) return decline(`too little time left (${Math.round(left / 1000)} s)`);
    const client = o.getClient();
    const trigger = `${m.step || m.stage}: ${m.why || ''}`.slice(0, 300);
    const scrubber = new Scrubber();
    scrubber.setProfile(o.getProfile());
    const scrub = (text) => scrubber.plain(String(text == null ? '' : text));
    let session;
    try {
      session = await client.agentOpen({ purpose: 'oversee', job_id: h.job_id, stage: m.stage, trigger: scrub(trigger),
        connector: h.connector || '', app_version: o.appVersion });
    } catch (err) {
      if (err.body && err.body.agent) o.status = err.body.agent;
      o.changed();
      return decline(`the site would not open a session: ${err.message}`);
    }
    this.took = true;
    const budget = Math.min(left, this.deadline - o.now() - MARGIN_MS);
    this.send({ type: 'take', id: m.id, readOnly: Boolean(m.readOnly), budgetMs: budget });
    const started = o.now();
    o.active = { job_id: h.job_id, where, stage: m.stage, session: session.session_id, steps: 0, credits: 0,
      doing: m.readOnly ? 'reading the page' : 'taking over', since: started };
    o.log(`the robot is stuck booking ${where} (${trigger}); AI oversight takes over (session ${session.session_id})`);
    o.onEvent({ kind: 'agent.take', job: h.job_id, stage: m.stage, session: session.session_id });
    o.changed();
    const allowed = (h.robot && Array.isArray(h.robot.requires)) ? h.robot.requires : [];
    const seconds = Math.round(budget / 1000);
    const run = await o.runAgent({
      chat: async (body) => {
        const reply = await client.agentChat(session.session_id, body);
        if (o.active) {
          o.active.credits += Number(reply.charged) || 0;
          o.changed();
        }
        return reply;
      },
      driver: new RobotDriver((op, args) => this.request(op, args)),
      task: overseeBooking({ trouble: m, h, steps: this.steps, seconds, maxSteps: MAX_STEPS, allowed }),
      values: o.getProfile(), allowed, readOnly: Boolean(m.readOnly), scrub,
      deadline: started + budget - 5000, maxSteps: Math.min(MAX_STEPS, Number(session.max_calls) || MAX_STEPS),
      log: (line) => o.log(`oversight: ${line}`),
      onStep: (step) => {
        if (!o.active) return;
        o.active.steps += 1;
        o.active.doing = step.tool === 'finish' ? 'finishing' : `${step.tool}${step.args && step.args.ref ? ` [${step.args.ref}]` : ''}`;
        o.changed();
      },
      now: o.now,
    });
    const said = run.outcome;
    let outcome = said
      ? { booked: { status: 'booked', confirmation: said.confirmation, submitted: said.submitted },
        gone: { status: 'gone', why: said.summary },
        unconfirmed: { status: 'unconfirmed', why: said.summary, submitted: true },
        human_check: { status: 'gate', why: said.summary, submitted: said.submitted },
      }[said.outcome] || { status: 'failed', why: said.summary, submitted: said.submitted }
      : { status: 'failed', why: `the AI stopped: ${run.stopped}`, submitted: run.pressedFinal };
    if (outcome.status === 'booked' && !outcome.confirmation) {
      outcome = { status: 'unconfirmed', why: 'the AI said booked with no confirmation number', submitted: true };
    }
    this.send({ type: 'done', outcome });
    const ms = o.now() - started;
    o.log(`oversight of ${where} ended: ${said ? said.outcome : `stopped (${run.stopped})`}`
      + ` after ${run.calls} call${run.calls === 1 ? '' : 's'}, ${run.credits} credit${run.credits === 1 ? '' : 's'}`
      + (said && said.summary ? ` — ${said.summary}` : ''));
    const report = {
      outcome: said ? (REPORTED[said.outcome] || 'failed') : 'stopped',
      stage: m.stage, trigger: scrub(trigger),
      summary: scrub(said ? said.summary : run.stopped),
      trouble: scrub(m.why || ''),
      steps: run.steps, pages: run.pages,
      robot: { stage: m.stage, step: m.step || '', url: pathOf(m.url, scrub),
        last_steps: this.steps.slice(-8).map((s) => s.tag), stalls: this.stalls },
      result: { status: outcome.status, submitted: Boolean(outcome.submitted), confirmation: Boolean(outcome.confirmation),
        calls: run.calls, credits: run.credits, stopped: run.stopped || undefined },
      duration_ms: ms,
    };
    try {
      await client.agentReport(session.session_id, report);
    } catch (err) {
      o.log(`the site did not take the oversight report: ${err.message}`);
    }
    o.onEvent({ kind: 'agent.end', job: h.job_id, stage: m.stage, outcome: report.outcome, status: outcome.status,
      calls: run.calls, credits: run.credits, ms, steps: run.steps.length });
    o.active = null;
    o.last = { job_id: h.job_id, where, stage: m.stage, outcome: report.outcome, status: outcome.status, calls: run.calls,
      credits: run.credits, summary: report.summary, at: o.now() };
    o.changed();
    return outcome;
  }
}

function pathOf(url, scrub) {
  try {
    return scrub(new URL(url).pathname);
  } catch {
    return '';
  }
}

module.exports = { Overseer, Watch, MIN_TAKEOVER_MS, MARGIN_MS, STALL_MS };
