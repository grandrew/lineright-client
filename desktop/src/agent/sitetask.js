'use strict';
/**
 * A site described in plain words, and the AI alone on it.
 *
 * For the California DMV this app carries a robot that knows its pages, and
 * the AI is only its overseer (overseer.js). For a site nobody has written a
 * robot for, the beginning of another way: describe the site in plain words —
 * where booking starts, what its pages ask, what it says when it is done — and
 * the AI works a browser of its own on it (dmq's rqp-browser.js), to check what
 * is available or to book. Developer mode only, for now: it is how a new site
 * is tried before anything is built for it.
 *
 *   site   { name, start_url, description }
 *   kind   'check' (report what is available; nothing is held or booked) or 'book'
 *   want   what is wanted, in words, or { what, where, from, to, time }
 *
 * The same rules hold as for oversight: the model is asked through the regbot
 * site and charged to the person's bought credits; the person's details only
 * as placeholders, and only those the task allows; the browser never leaves
 * the site it was opened on. The session's report goes to the site too.
 */
const { runAgent } = require('./loop');
const { siteTask } = require('./prompts');
const { RobotDriver } = require('./drivers');
const { Watch } = require('../overseer');

/** What a task may take at most, start to end. */
const MAX_BUDGET_MS = 10 * 60000;

/** The browser robot's channel, for a task: when its page is ready, the AI works it. */
class TaskWatch extends Watch {
  constructor(overseerLike, work) {
    super(overseerLike, { job_id: null, queue_name: 'task' }, Date.now() + MAX_BUDGET_MS);
    this.work = work;
    this.result = null;
  }

  heard(message) {
    if (message && message.lr === 'robot' && message.type === 'ready') {
      this.result = this.work(this, message).catch((err) => {
        this.send({ type: 'done', outcome: { status: 'failed', why: err.message } });
        return { stopped: err.message, steps: [], calls: 0, credits: 0, pages: [], outcome: null };
      });
      return;
    }
    super.heard(message);
  }
}

/**
 * Run one task. Resolves to `{ outcome, steps, calls, credits, pages, stopped, session }`;
 * rejects only when it could not start (the site would not open a session, no address).
 */
async function runSiteTask({ runner, client, site = {}, kind = 'check', want = '', values = {}, allowed = [],
  budgetMs = 300000, scrub = (s) => s, log = () => {}, onStep = () => {}, appVersion = '' }) {
  let start;
  try {
    start = new URL(String(site.start_url || ''));
    if (!/^https?:$/.test(start.protocol)) throw new Error('not a web address');
  } catch {
    throw new Error('Give the address the booking starts at (https://…).');
  }
  if (!runner.available()) throw new Error('This build carries no robots, so it has no browser for the AI.');
  const budget = Math.max(30000, Math.min(MAX_BUDGET_MS, Number(budgetMs) || 300000));
  const session = await client.agentOpen({ purpose: 'task', stage: kind === 'book' ? 'task.book' : 'task.check',
    trigger: `${site.name || start.host}: ${typeof want === 'string' ? want : JSON.stringify(want)}`.slice(0, 300),
    connector: start.host, app_version: appVersion });
  const started = Date.now();
  const quiet = { log, onEvent: () => {}, now: () => Date.now(), setInterval: () => null, clearInterval: () => {} };
  const watch = new TaskWatch(quiet, async (self) => {
    const run = await runAgent({
      chat: (body) => client.agentChat(session.session_id, body),
      driver: new RobotDriver((op, args) => self.request(op, args)),
      task: siteTask({ site, kind, want, allowed, seconds: Math.round(budget / 1000), maxSteps: 40 }),
      values, allowed, scrub, allowOpen: true, deadline: started + budget - 5000,
      maxSteps: Math.min(40, Number(session.max_calls) || 40), log, onStep,
    });
    self.send({ type: 'done', outcome: run.outcome ? { status: run.outcome.outcome, ...run.outcome } : { status: 'failed', why: run.stopped } });
    return run;
  });
  const answer = await runner.run('browse', { protocol: 'RQP/1', kind: 'browse.request', start_url: start.toString(),
    budget_ms: budget }, { timeoutMs: budget + 60000, context: { task: session.session_id }, watch });
  const run = (await watch.result) || { outcome: null, steps: [], calls: 0, credits: 0, pages: [],
    stopped: answer.message || 'the browser did not start' };
  const said = run.outcome;
  try {
    await client.agentReport(session.session_id, {
      outcome: said ? ({ checked: 'checked', booked: 'booked', gone: 'gone', human_check: 'handed' }[said.outcome] || 'failed') : 'stopped',
      stage: kind === 'book' ? 'task.book' : 'task.check',
      summary: scrub(said ? said.summary : run.stopped), steps: run.steps, pages: run.pages,
      site: { name: site.name || '', host: start.host },
      result: { findings: said && said.findings ? said.findings.length : 0, calls: run.calls, credits: run.credits },
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    log(`the site did not take the task's report: ${err.message}`);
  }
  return { ...run, session: session.session_id };
}

module.exports = { runSiteTask, TaskWatch, MAX_BUDGET_MS };
