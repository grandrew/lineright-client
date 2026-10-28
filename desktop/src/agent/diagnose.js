'use strict';
/**
 * Finding out why the robots cannot read a line, on the site's money.
 *
 * The site has every app look at its lines now and then (the server's
 * linewatch.py). When a look reads none of its offices, the site asks another
 * app to look again; when that app's scout fails too, the site's answer
 * carries a grant: an AI session it opened itself and pays for, bound to this
 * app and that trouble, a few calls, lapsing a minute after the last one. This
 * runs it: a bare browser on the booking site (dmq's rqp-browser.js), and the
 * AI going through the pages as a person would — the site's guide to them, what
 * the scout said, the scout's last log lines — up to the list of times, never
 * further. It reports what it found and the fix it suggests for the robot.
 *
 * Nothing of the person's is involved: a scout carries no applicant, and no
 * detail may be typed. Their credits are not touched.
 */
const { runAgent } = require('./loop');
const { diagnoseTask } = require('./prompts');
const { RobotDriver } = require('./drivers');
const { DIAGNOSE_ENDS } = require('./tools');
const { TaskWatch } = require('./sitetask');

/** The longest a check runs, whatever the grant allows. */
const MAX_MS = 6 * 60000;

/**
 * Run one check. Resolves to `{ diagnosis, steps, calls, pages, stopped, session }`;
 * rejects only when it could not start (no robots, a start page that is not the read's site).
 *
 * @param {object} opts
 * @param {object} opts.grant     the site's grant (reads answer's `grant`)
 * @param {object} [opts.result]  what this app's scout answered just now
 * @param {string[]} [opts.robotLog] the scout's last log lines
 */
async function runDiagnosis({ runner, client, grant = {}, result = {}, robotLog = [], scrub = (s) => s,
  log = () => {}, onStep = () => {}, now = () => Date.now() }) {
  let start;
  let base;
  try {
    start = new URL(String(grant.start_url || ''));
    base = new URL(String(grant.base_url || grant.start_url || ''));
    if (!/^https?:$/.test(start.protocol)) throw new Error('not a web address');
  } catch {
    throw new Error('The check names no page to start at.');
  }
  if (start.origin !== base.origin) throw new Error(`The check's page is not on ${base.origin}.`);
  if (!runner.available()) throw new Error('This build carries no robots, so it has no browser for the AI.');
  const budget = Math.max(30000, Math.min(MAX_MS, (Number(grant.seconds) || 300) * 1000 - 15000));
  const maxSteps = Math.max(1, Math.min(30, Number(grant.max_calls) || 20));
  const started = now();
  const quiet = { log, onEvent: () => {}, now, setInterval: () => null, clearInterval: () => {} };
  const lines = robotLog.map((l) => scrub(String(l)).slice(0, 300));
  const watch = new TaskWatch(quiet, async (self) => {
    const run = await runAgent({
      chat: (body) => client.agentChat(grant.session_id, body),
      driver: new RobotDriver((op, args) => self.request(op, args)),
      task: diagnoseTask({ grant, result, robotLog: lines, seconds: Math.round(budget / 1000), maxSteps }),
      scrub, allowOpen: true, deadline: started + budget - 5000, maxSteps, log, onStep, now,
    });
    self.send({ type: 'done', outcome: run.outcome ? { status: run.outcome.outcome, ...run.outcome } : { status: 'failed', why: run.stopped } });
    return run;
  });
  const answer = await runner.run('browse', { protocol: 'RQP/1', kind: 'browse.request', start_url: start.toString(),
    budget_ms: budget }, { timeoutMs: budget + 60000, context: { check: grant.issue_id }, watch });
  const run = (await watch.result) || { outcome: null, steps: [], calls: 0, credits: 0, pages: [],
    stopped: (answer && answer.message) || 'the browser did not start' };
  const said = run.outcome;
  const diagnosis = said ? {
    outcome: DIAGNOSE_ENDS.includes(said.outcome) ? said.outcome : 'failed',
    summary: scrub(said.summary || ''), cause: scrub(said.cause || ''), fix: scrub(said.fix || ''),
    times_seen: Number(said.times_seen) || (Array.isArray(said.findings) ? said.findings.length : 0),
  } : { outcome: 'failed', summary: scrub(run.stopped || ''), cause: `The AI did not finish: ${scrub(run.stopped || '')}`, fix: '', times_seen: 0 };
  try {
    await client.agentReport(grant.session_id, {
      outcome: said ? 'checked' : 'stopped', stage: 'watch.check',
      summary: diagnosis.summary, trouble: scrub(String(result.message || '')), steps: run.steps, pages: run.pages,
      site: { name: grant.site_name || '', host: start.host, line: grant.queue_name || '' },
      robot: { message: scrub(String(result.message || '')), log: lines.slice(-25) },
      result: { calls: run.calls, offices: (grant.offices || []).length }, duration_ms: now() - started, diagnosis,
    });
  } catch (err) {
    log(`the site did not take the check's report: ${err.message}`);
  }
  return { diagnosis, steps: run.steps, calls: run.calls, pages: run.pages, stopped: run.stopped, session: grant.session_id };
}

module.exports = { runDiagnosis, MAX_MS };
