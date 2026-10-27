'use strict';
/**
 * The AI at work on one page: ask the model what to do, do it, tell it what
 * happened, until it says it is finished — or the time, the steps or the
 * credits run out.
 *
 * The model is asked through the regbot site (its agent.py), never straight:
 * `chat(body)` is one call there, charged to the person's bought credits. So
 * each step costs, and the conversation is kept short: the page readings from
 * before the last two are left out of what is sent again (each action brings
 * the page back as it is then, so the model always has the page in front of it).
 *
 * What comes back is the outcome the model finished with, and a log of every
 * step — the tool, what it was given (the person's details only ever as
 * their placeholders) and the first line of what came of it — which is what
 * the app reports to the site as the intervention's telemetry.
 */
const { toolsFor, execute, argsOf, pageText, FINAL } = require('./tools');

/** How many of the latest page readings stay whole in what is sent. */
const KEEP_PAGES = 2;
/** Nudges for a model that answers in words instead of using a tool. */
const NUDGES = 2;

class AgentStopped extends Error {}

/**
 * What is sent: the conversation with the older page readings shortened, and
 * any reasoning the model wrote kept only where the site may want it back.
 */
function compact(messages, meta) {
  const pageAt = meta.map((m, i) => (m && m.page ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(pageAt.slice(-KEEP_PAGES));
  return messages.map((m, i) => {
    if (!meta[i] || !meta[i].page || keep.has(i)) return m;
    // What was said before the page stays — the task's brief, "Pressed [5]" —
    // and only the page itself goes; a reading that is nothing but the page
    // keeps its first line, where the page is.
    const content = String(m.content || '');
    const at = content.indexOf('\nThe page now:\n');
    const head = at >= 0 ? content.slice(0, at) : content.split('\n')[0];
    return { ...m, content: `${head}\n(the page as it was then is left out)` };
  });
}

/**
 * Run the AI on one task. Resolves, never rejects, to
 * `{ outcome, steps, calls, credits, pages, stopped }`:
 *   outcome  what the model finished with ({ outcome, confirmation, submitted, summary, findings }),
 *            or null when it did not finish
 *   stopped  why it stopped without finishing: out of time, steps, credits, an error
 *
 * @param {object} opts
 * @param {function} opts.chat     (body) -> the site's reply ({ message, charged, session, … })
 * @param {object} opts.driver     a RobotDriver or a TabDriver (drivers.js)
 * @param {object} opts.task       { system, user, kind: 'book' | 'check' } (prompts.js)
 * @param {object} [opts.values]   the profile's values, for the placeholders
 * @param {string[]} [opts.allowed] which placeholders may be typed
 * @param {boolean} [opts.readOnly] only look (the booking was sent)
 * @param {function} [opts.scrub]  text -> text with the person taken out
 * @param {number} [opts.deadline] epoch ms
 * @param {number} [opts.maxSteps]
 */
async function runAgent({ chat, driver, task, values = {}, allowed = [], readOnly = false, scrub = (s) => s,
  deadline = Date.now() + 180000, maxSteps = 40, allowOpen = false, log = () => {}, onStep = () => {},
  now = () => Date.now() }) {
  const tools = toolsFor({ kind: task.kind || 'book', readOnly, allowOpen });
  const run = { outcome: null, steps: [], calls: 0, credits: 0, pages: [], stopped: '', pressedFinal: false };
  const noteUrl = (url) => {
    try {
      const path = scrub(new URL(url).pathname);
      if (path && run.pages[run.pages.length - 1] !== path) run.pages.push(path);
    } catch { /* not an address */ }
  };
  let first;
  try {
    const page = await driver.look(14000);
    noteUrl(page && page.url);
    first = pageText(page, scrub);
  } catch (err) {
    run.stopped = `the page could not be read: ${err.message}`;
    return run;
  }
  const messages = [
    { role: 'system', content: task.system },
    { role: 'user', content: `${task.user}\n\nThe page now:\n${first}` },
  ];
  const meta = [null, { page: true }];
  let nudges = 0;
  try {
    for (let step = 0; ; step += 1) {
      if (now() >= deadline) throw new AgentStopped('out of time');
      if (step >= maxSteps) throw new AgentStopped(`out of steps (${maxSteps})`);
      let reply;
      try {
        reply = await chat({ messages: compact(messages, meta), tools, tool_choice: 'auto', temperature: 0.1 });
      } catch (err) {
        // The site said no more (credits, calls, time) or could not reach the model.
        throw new AgentStopped(`${err.status ? `${err.status}: ` : ''}${err.message}`);
      }
      run.calls += 1;
      run.credits += Number(reply.charged) || 0;
      const message = reply.message || { role: 'assistant', content: '' };
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({ role: 'assistant', content: message.content ?? null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) });
      meta.push(null);
      if (!calls.length) {
        if (nudges >= NUDGES) throw new AgentStopped('the model stopped using its tools');
        nudges += 1;
        messages.push({ role: 'user', content: 'Use the tools to act on the page, and call finish when the outcome is clear.' });
        meta.push(null);
        continue;
      }
      for (const call of calls) {
        const name = call.function && call.function.name;
        const started = now();
        let done;
        try {
          done = await execute(call, { driver, values, allowed, readOnly, scrub, allowOpen });
        } catch (err) {
          done = { text: `That did not work: ${scrub(String(err.message || err).split('\n')[0])}. Take a new look at the page if the numbers may have changed.` };
        }
        const args = argsOf(call);
        if (name === 'click' && done.label && FINAL.test(done.label)) run.pressedFinal = true;
        const entry = { tool: name, args: scrubArgs(args, scrub), result: String(done.text || '').split('\n')[0].slice(0, 300),
          ms: now() - started };
        run.steps.push(entry);
        try { onStep(entry); } catch { /* never the problem */ }
        log(`${name} ${JSON.stringify(entry.args)} → ${entry.result}`);
        const urlLine = /\nPage: .* — (\S+)/.exec(done.text || '');
        if (urlLine) noteUrl(`https://${urlLine[1]}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(done.text || '') });
        meta.push(done.page ? { page: true } : null);
        if (done.final) {
          run.outcome = done.final;
          // A press of what looked like the booking button counts as sending it,
          // whatever the model remembers.
          if (run.pressedFinal) run.outcome.submitted = true;
          return run;
        }
      }
    }
  } catch (err) {
    run.stopped = err instanceof AgentStopped ? err.message : `stopped: ${err.message}`;
    return run;
  }
}

/** A call's arguments for the log: short, and the person taken out. */
function scrubArgs(args, scrub) {
  const out = {};
  for (const [k, v] of Object.entries(args || {}).slice(0, 8)) {
    out[k] = typeof v === 'string' ? scrub(v).slice(0, 160) : typeof v === 'number' || typeof v === 'boolean' ? v : '…';
  }
  return out;
}

module.exports = { runAgent, compact, scrubArgs, KEEP_PAGES };
