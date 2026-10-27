/**
 * The robot's browser, for whoever oversees the robot.
 *
 * The desktop app runs a robot as a process of its own (desktop/src/robots.js)
 * and, when the person's account has AI booking oversight, keeps a channel to
 * it open as it goes (Node's IPC: process.send / 'message'). Over it the robot
 * says each step it takes; and when it is stuck — a page that no longer looks
 * as it expects, a slot it cannot find, a booking it cannot see confirmed — it
 * asks whether its overseer wants to take over before it gives up. If so, it
 * hands over the page it is on as it is, mid-booking, and does what it is told
 * there until the overseer says it is done and what came of it:
 *
 *   robot → app   { lr: 'robot', type: 'hello', pid }
 *                 { lr: 'robot', type: 'step', tag, detail }
 *                 { lr: 'robot', type: 'trouble', id, stage, error, url, … }
 *                 { lr: 'robot', type: 'result', id, ok, value | error }
 *   app → robot   { lr: 'app', type: 'take', id, readOnly } | { lr: 'app', type: 'decline', id }
 *                 { lr: 'app', type: 'cmd', id, op, args }
 *                 { lr: 'app', type: 'done', outcome }
 *
 * What the overseer can do with the page is what a person could, and no more:
 * look at it (run the app's own reading script in it), press, type, choose,
 * scroll, wait, go back, go to another page of the same site. Never another
 * site: a `goto` elsewhere is refused here, whatever asked for it.
 *
 * Without the channel (RQP_CONTROL unset, or no IPC — the robot run by hand,
 * or by the server's worker) nothing here does anything, and the robot fails
 * as it always did.
 */

/** How long an action on the page may take before it is said to have failed. */
const ACTION_MS = 8000;
/** How long the robot waits for its overseer to say whether it takes over: it opens a session on the site first. */
const ASK_MS = 30000;
/** The longest one `wait` may be. */
const MAX_WAIT_MS = 15000;

/** The commands that only look. A read-only takeover (after the form went) gets these alone. */
export const LOOKING = new Set(['eval', 'info', 'wait', 'scroll', 'screenshot', 'text']);

/** Whether `url` is on the same site as `base` — the only place `goto` goes. */
export function sameSite(url, base) {
  try {
    const to = new URL(url, base);
    const home = new URL(base);
    return (to.protocol === 'https:' || to.protocol === 'http:') && to.origin === home.origin;
  } catch {
    return false;
  }
}

/**
 * The channel to this robot's overseer, or null when there is none.
 * `proc` is the process (tests give their own), `env` its environment.
 */
export function controlChannel({ proc = process, env = process.env } = {}) {
  if (env.RQP_CONTROL !== '1' || typeof proc.send !== 'function') return null;
  const waiting = new Map();      // id -> resolve, for answers to the robot's asks
  const queue = [];               // commands waiting to be served
  let wake = null;
  let finished = null;            // the overseer's 'done'
  let seq = 0;
  const send = (message) => {
    try { proc.send({ lr: 'robot', ...message }); } catch { /* the app went away: nobody to tell */ }
  };
  const onMessage = (message) => {
    if (!message || message.lr !== 'app') return;
    if (message.type === 'take' || message.type === 'decline') {
      const resolve = waiting.get(message.id);
      if (!resolve) return;
      waiting.delete(message.id);
      // A takeover starts clean: its commands may follow its 'take' at once.
      if (message.type === 'take') { queue.length = 0; finished = null; }
      resolve(message);
    } else if (message.type === 'cmd') {
      queue.push(message);
      if (wake) wake();
    } else if (message.type === 'done') {
      finished = message.outcome || { status: 'failed', why: 'no outcome' };
      if (wake) wake();
    }
  };
  proc.on('message', onMessage);
  // The channel must not keep a finished robot alive.
  if (proc.channel && typeof proc.channel.unref === 'function') proc.channel.unref();
  send({ type: 'hello', pid: proc.pid });

  return {
    /** Say something as it happens: a step, mostly. */
    event(type, fields = {}) {
      send({ type, ...fields });
    },

    /**
     * The robot is stuck: does its overseer take over? Resolves to
     * `{ take: true, readOnly }` or `{ take: false }`; no answer in time is no.
     */
    async ask(trouble, { timeoutMs = ASK_MS } = {}) {
      const id = `t${++seq}`;
      let timer = null;
      const answer = await new Promise((resolve) => {
        waiting.set(id, resolve);
        send({ type: 'trouble', id, ...trouble });
        timer = setTimeout(() => { if (waiting.delete(id)) resolve({ type: 'decline', id, why: 'no answer' }); }, timeoutMs);
      });
      clearTimeout(timer);
      return answer.type === 'take'
        ? { take: true, readOnly: Boolean(answer.readOnly), budgetMs: Number(answer.budgetMs) || 0 }
        : { take: false };
    },

    /**
     * Do what the overseer says on `page`, until it says it is done or
     * `deadline` (epoch ms) passes. Resolves to its outcome — `{ status, … }` —
     * or `{ status: 'timeout' }`.
     */
    async serve(page, { deadline, readOnly = false, base = '' }) {
      for (;;) {
        if (finished) return finished;
        if (Date.now() >= deadline) return { status: 'timeout', why: 'the overseer ran out of time' };
        const message = queue.shift();
        if (!message) {
          let timer = null;
          await new Promise((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          });
          clearTimeout(timer);
          wake = null;
          continue;
        }
        const reply = { type: 'result', id: message.id };
        try {
          if (readOnly && !LOOKING.has(message.op)) throw new Error(`"${message.op}" is not allowed now: the booking has been sent, so this page is only looked at`);
          reply.value = await run(page, message.op, message.args || {}, { base });
          reply.ok = true;
        } catch (err) {
          reply.ok = false;
          reply.error = String((err && err.message) || err).split('\n')[0].slice(0, 400);
        }
        send(reply);
      }
    },

    close() {
      proc.off('message', onMessage);
    },
  };
}

/** One command on the page. */
export async function run(page, op, args, { base = '' } = {}) {
  const at = (selector) => {
    if (typeof selector !== 'string' || !selector) throw new Error('which element?');
    return page.locator(selector).first();
  };
  switch (op) {
    case 'eval': {
      // A string, so it runs as DevTools runs it: a page's own rules on scripts
      // do not stop the app reading the page.
      if (typeof args.source !== 'string') throw new Error('nothing to run');
      return page.evaluate(`(${args.source})(${JSON.stringify(args.arg ?? null)})`);
    }
    case 'info':
      return { url: page.url(), title: await page.title().catch(() => '') };
    case 'text':
      return (await page.locator('body').innerText({ timeout: ACTION_MS }).catch(() => '')).slice(0, 200000);
    case 'click':
      await at(args.selector).click({ timeout: ACTION_MS });
      await settle(page);
      return { url: page.url() };
    case 'fill':
      await at(args.selector).fill(String(args.value ?? ''), { timeout: ACTION_MS });
      return { ok: true };
    case 'type':
      await at(args.selector).pressSequentially(String(args.value ?? ''), { delay: 30, timeout: ACTION_MS });
      return { ok: true };
    case 'select': {
      const box = at(args.selector);
      const value = String(args.value ?? '');
      try {
        await box.selectOption({ label: value }, { timeout: ACTION_MS });
      } catch {
        await box.selectOption(value, { timeout: ACTION_MS });
      }
      return { ok: true };
    }
    case 'check':
      await at(args.selector).setChecked(args.on !== false, { timeout: ACTION_MS });
      return { ok: true };
    case 'press':
      if (typeof args.key !== 'string' || !/^[A-Za-z0-9+]{1,30}$/.test(args.key)) throw new Error('which key?');
      await page.keyboard.press(args.key);
      await settle(page);
      return { url: page.url() };
    case 'scroll':
      await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, Number(args.dy) || 600)));
      return { ok: true };
    case 'wait':
      await page.waitForTimeout(Math.max(0, Math.min(MAX_WAIT_MS, Number(args.ms) || 1000)));
      await page.waitForLoadState('domcontentloaded', { timeout: ACTION_MS }).catch(() => {});
      return { url: page.url() };
    case 'goto': {
      const url = String(args.url || '');
      if (!sameSite(url, base || page.url())) throw new Error('only pages of the same site');
      await page.goto(new URL(url, base || page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page);
      return { url: page.url() };
    }
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      await settle(page);
      return { url: page.url() };
    case 'screenshot': {
      const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: ACTION_MS });
      return { jpeg: shot.toString('base64') };
    }
    default:
      throw new Error(`unknown command "${op}"`);
  }
}

/** Give a page a moment after an action that may load another. */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600).catch(() => {});
}

/**
 * The robot is stuck on `page`: offer it to the overseer, and if it takes it,
 * let it work there until it says what came of it. Returns that outcome, or
 * null when nobody took over. `trouble` says where the robot was and why it stopped.
 */
export async function overseeHere(control, page, trouble, { budgetMs = 180000, base = '', readOnly = false,
  beforeTake = null } = {}) {
  if (!control || !page || page.isClosed()) return null;
  let answer;
  try {
    answer = await control.ask({ ...trouble, url: page.url(), readOnly, budgetMs });
  } catch {
    return null;
  }
  if (!answer.take) return null;
  if (beforeTake) await beforeTake();
  const outcome = await control.serve(page, { deadline: Date.now() + (answer.budgetMs || budgetMs),
    readOnly: readOnly || answer.readOnly, base });
  control.event('handback', { status: outcome && outcome.status });
  return outcome;
}
