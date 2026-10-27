'use strict';
/**
 * The AI oversight's parts, with a scripted model and a pretend browser: the
 * tools (agent/tools.js) and the person's details kept out of the model's way,
 * the loop (agent/loop.js) and how it stops, and the overseer (overseer.js) —
 * when it takes a stuck robot over, what it tells the robot, and what it
 * reports to the site.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { toolsFor, execute, fillIn, schemas } = require('../src/agent/tools');
const { runAgent, compact } = require('../src/agent/loop');
const { overseeBooking, siteTask, dayWords, timeWords } = require('../src/agent/prompts');
const { Overseer } = require('../src/overseer');

const PROFILE = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '(555) 555-0123',
  dob: '1990-02-03', ssn: '123-45-6789' };

/** A page in a pretend browser: what a look returns, and what each action does to it. */
function fakeDriver(pages, { failClick = null } = {}) {
  const did = [];
  let at = 0;
  return {
    did,
    async look() { return { url: `https://www.dmv.ca.gov${pages[at].path}`, title: pages[at].title, text: pages[at].text, height: 900, viewport: 900 }; },
    async label(ref) { return (pages[at].labels || {})[ref] || null; },
    async click(ref) {
      if (failClick === ref) throw new Error('locator.click: Timeout 8000ms exceeded.\nCall log: …');
      did.push(['click', ref]);
      const to = (pages[at].clicks || {})[ref];
      if (to !== undefined) at = to;
      return {};
    },
    async fill(ref, value) { did.push(['fill', ref, value]); return {}; },
    async choose(ref, option) { did.push(['choose', ref, option]); return {}; },
    async check(ref, on) { did.push(['check', ref, on]); return {}; },
    async press(key) { did.push(['press', key]); return {}; },
    async scroll(down) { did.push(['scroll', down]); return {}; },
    async wait(ms) { did.push(['wait', ms]); return {}; },
    async back() { did.push(['back']); return {}; },
    async open(url) { did.push(['open', url]); return {}; },
    async text() { return pages[at].text; },
  };
}

const call = (name, args = {}, id = `call_${Math.random().toString(36).slice(2, 8)}`) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A model that answers from a script: each item the tool calls of one reply (or a message in words). */
function scripted(steps) {
  const seen = [];
  const chat = async (body) => {
    seen.push(body);
    const next = steps.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'string') return { message: { role: 'assistant', content: next }, charged: 1 };
    return { message: { role: 'assistant', content: null, tool_calls: next || [call('finish', { outcome: 'failed', submitted: false, summary: 'script ran out' })] }, charged: 2 };
  };
  return { chat, seen };
}

const DETAILS = {
  path: '/portal/appointments/details', title: 'Your details',
  text: '# Your details\n[3] textbox "Given name" empty\n[4] textbox "Family name" empty\n[5] button "Review my details"',
  labels: { 5: 'Review my details' }, clicks: { 5: 1 },
};
const REVIEW = {
  path: '/portal/appointments/details', title: 'Check your details',
  text: '# Check your details\nName [first_name] [last_name]\n[9] button "Book this appointment"',
  labels: { 9: 'Book this appointment' }, clicks: { 9: 2 },
};
const CONFIRMED = {
  path: '/portal/appointments/confirmation', title: 'Appointment confirmed',
  text: '# Appointment details\nBooking reference\nTS-1A2B3C4D', labels: {},
};

// ------------------------------------------------------------------ tools
test('the person\'s details go in only as placeholders, and only the allowed ones', () => {
  assert.equal(fillIn('[first_name] [last_name]', PROFILE, ['first_name', 'last_name']), 'Ada Lovelace');
  assert.equal(fillIn('plain words', PROFILE, []), 'plain words');
  assert.throws(() => fillIn('[ssn]', PROFILE, ['first_name']), /\[ssn\] is not a detail you can type here — these are: \[first_name\]/);
  assert.throws(() => fillIn('[middle_name]', PROFILE, ['middle_name']), /not a detail/, 'one the profile does not have');
});

test('read only means only looking', () => {
  const names = (list) => list.map((t) => t.function.name).sort();
  assert.deepEqual(names(toolsFor({ readOnly: true })), ['finish', 'look_at_page', 'read_text', 'scroll', 'wait']);
  assert.ok(!names(toolsFor({})).includes('open_page'), 'no going by address unless the task allows it');
  assert.ok(names(toolsFor({ allowOpen: true })).includes('open_page'));
  assert.deepEqual(schemas({ kind: 'check' }).finish.function.parameters.properties.outcome.enum, ['checked', 'human_check', 'failed']);
});

test('a tool does its thing and shows the page after, with the person taken out', async () => {
  const driver = fakeDriver([DETAILS, REVIEW, CONFIRMED]);
  const scrub = (s) => String(s).replace(/Ada/g, '[first_name]');
  const typed = await execute(call('type_text', { ref: 3, text: '[first_name]' }), { driver, values: PROFILE, allowed: ['first_name'], scrub });
  assert.deepEqual(driver.did[0], ['fill', 3, 'Ada']);
  assert.match(typed.text, /^Typed into \[3\]\.\nThe page now:\nPage: Your details — www\.dmv\.ca\.gov\/portal\/appointments\/details\n# Your details/);
  const pressed = await execute(call('click', { ref: 5 }), { driver, scrub });
  assert.equal(pressed.label, 'Review my details');
  assert.match(pressed.text, /^Pressed \[5\] "Review my details"\.\nThe page now:\nPage: Check your details/);
  const refused = await execute(call('click', { ref: 9 }), { driver, readOnly: true });
  assert.match(refused.text, /not allowed: the booking was sent/);
  assert.equal(driver.did.length, 2, 'nothing pressed read only');
  const ssn = execute(call('type_text', { ref: 3, text: '[ssn]' }), { driver, values: PROFILE, allowed: ['first_name'] });
  await assert.rejects(ssn, /not a detail you can type here/);
  const done = await execute(call('finish', { outcome: 'booked', confirmation: ' TS-1 ', submitted: true, summary: 'ok' }), { driver });
  assert.deepEqual(done.final, { outcome: 'booked', confirmation: 'TS-1', submitted: true, summary: 'ok', findings: undefined });
});

// ------------------------------------------------------------------- the loop
test('the loop: the model works the page to a confirmation', async () => {
  const driver = fakeDriver([DETAILS, REVIEW, CONFIRMED]);
  const { chat, seen } = scripted([
    [call('type_text', { ref: 3, text: '[first_name]' }), call('type_text', { ref: 4, text: '[last_name]' })],
    [call('click', { ref: 5 })],
    [call('click', { ref: 9 })],
    [call('finish', { outcome: 'booked', confirmation: 'TS-1A2B3C4D', submitted: true, summary: 'The labels were renamed.' })],
  ]);
  const steps = [];
  const run = await runAgent({ chat, driver, task: overseeBooking({ trouble: { stage: 'booking', why: 'no First Name box' } }),
    values: PROFILE, allowed: ['first_name', 'last_name'], scrub: (s) => s, onStep: (s) => steps.push(s.tool) });
  assert.equal(run.outcome.outcome, 'booked');
  assert.equal(run.outcome.confirmation, 'TS-1A2B3C4D');
  assert.deepEqual(driver.did, [['fill', 3, 'Ada'], ['fill', 4, 'Lovelace'], ['click', 5], ['click', 9]]);
  assert.deepEqual(steps, ['type_text', 'type_text', 'click', 'click', 'finish']);
  assert.equal(run.calls, 4);
  assert.equal(run.credits, 8);
  assert.deepEqual(run.pages, ['/portal/appointments/details', '/portal/appointments/confirmation']);
  assert.ok(run.pressedFinal, '"Book this appointment" is the press that books');
  assert.equal(run.steps[0].args.text, '[first_name]', 'the log has the placeholder, never the name');
  for (const body of seen) {
    const sent = JSON.stringify(body.messages);
    assert.ok(!sent.includes('Lovelace') && !sent.includes('Ada'), 'the model never sees the person');
    assert.equal(body.tool_choice, 'auto');
  }
  assert.match(seen[0].messages[1].content, /The page now:\nPage: Your details/);
});

test('the loop: a model that talks instead of acting is nudged, then stopped', async () => {
  const driver = fakeDriver([DETAILS]);
  const { chat, seen } = scripted(['I think I should click.', 'Still thinking.', 'Hmm.']);
  const run = await runAgent({ chat, driver, task: { system: 's', user: 'u' } });
  assert.equal(run.outcome, null);
  assert.match(run.stopped, /stopped using its tools/);
  assert.equal(seen.length, 3);
  assert.match(seen[1].messages.at(-1).content, /Use the tools/);
});

test('the loop: out of steps, out of time, out of credits', async () => {
  const looking = () => Array.from({ length: 10 }, () => [call('look_at_page')]);
  let run = await runAgent({ chat: scripted(looking()).chat, driver: fakeDriver([DETAILS]), task: { system: 's', user: 'u' }, maxSteps: 3 });
  assert.match(run.stopped, /out of steps \(3\)/);
  let t = 0;
  run = await runAgent({ chat: scripted(looking()).chat, driver: fakeDriver([DETAILS]), task: { system: 's', user: 'u' },
    deadline: 1000, now: () => (t += 400) });
  assert.match(run.stopped, /out of time/);
  const broke = Object.assign(new Error('AI booking oversight has no bought credits left to spend'), { status: 402 });
  run = await runAgent({ chat: scripted([[call('look_at_page')], broke]).chat, driver: fakeDriver([DETAILS]), task: { system: 's', user: 'u' } });
  assert.match(run.stopped, /^402: AI booking oversight has no bought credits/);
  assert.equal(run.calls, 1);
});

test('the loop: a failing action is told to the model, which carries on', async () => {
  const driver = fakeDriver([DETAILS, REVIEW, CONFIRMED], { failClick: 5 });
  const { chat, seen } = scripted([[call('click', { ref: 5 })],
    [call('finish', { outcome: 'failed', submitted: false, summary: 'could not press' })]]);
  const run = await runAgent({ chat, driver, task: { system: 's', user: 'u' } });
  assert.equal(run.outcome.outcome, 'failed');
  const told = seen[1].messages.at(-1);
  assert.equal(told.role, 'tool');
  assert.match(told.content, /^That did not work: locator\.click: Timeout 8000ms exceeded\.\. Take a new look/);
  assert.ok(!told.content.includes('Call log'), 'one line of it');
});

test('older page readings are left out of what is sent', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'task\nPoway, Tuesday\nThe page now:\nP0' }];
  const meta = [null, { page: true }];
  for (let i = 1; i <= 4; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [call('look_at_page', {}, `c${i}`)] });
    meta.push(null);
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: i === 2 ? 'Pressed [5].\nThe page now:\nPage 2\nlong text 2' : `Page ${i}\nlong text ${i}` });
    meta.push({ page: true });
  }
  const sent = compact(messages, meta);
  assert.equal(sent[1].content, 'task\nPoway, Tuesday\n(the page as it was then is left out)', 'the brief stays whole');
  assert.equal(sent[3].content, 'Page 1\n(the page as it was then is left out)');
  assert.equal(sent[5].content, 'Pressed [5].\n(the page as it was then is left out)');
  assert.equal(sent[7].content, 'Page 3\nlong text 3');
  assert.equal(sent[9].content, 'Page 4\nlong text 4');
  assert.equal(messages[3].content, 'Page 1\nlong text 1', 'the conversation itself is kept whole');
});

test('the briefs', () => {
  assert.equal(dayWords('2026-11-03'), 'Tuesday, November 3, 2026');
  assert.equal(timeWords('14:20'), '2:20 PM');
  const h = { site_name: 'California DMV', queue_name: 'REAL ID', slot: { office_name: 'Poway', date: '2026-11-03', time: '10:20' },
    robot: { guide: '1. Search for the office.' } };
  const brief = overseeBooking({ trouble: { stage: 'booking', step: 'filling in the details', why: 'no First Name box' }, h,
    steps: [{ tag: 'TARGETED', detail: 'Poway' }], allowed: ['first_name'] });
  assert.match(brief.user, /Poway, Tuesday, November 3, 2026 at 10:20 AM/);
  assert.match(brief.user, /1\. Search for the office\./);
  assert.match(brief.user, /Where the robot stopped: filling in the details — no First Name box/);
  assert.match(brief.user, /- TARGETED: Poway/);
  assert.match(brief.user, /Details you can type: \[first_name\]/);
  assert.match(brief.system, /Finish the booking the robot started/);
  assert.match(overseeBooking({ trouble: { stage: 'confirming' }, h }).system, /ALREADY BEEN SENT/);
  assert.match(overseeBooking({ trouble: { stage: 'gone' }, h }).system, /no longer offered/);
  const check = siteTask({ site: { name: 'Clinic', start_url: 'https://clinic.test/', description: 'Pick a doctor.' },
    want: { what: 'a check-up', from: '2026-11-01', to: '2026-11-30' } });
  assert.equal(check.kind, 'check');
  assert.match(check.system, /Do not book/);
  assert.match(check.user, /Between 2026-11-01 and 2026-11-30/);
});

// -------------------------------------------------------------- the overseer
function fakeChild() {
  const child = new EventEmitter();
  child.connected = true;
  child.sent = [];
  child.send = (m) => { child.sent.push(m); child.emit('sent', m); };
  child.robot = (m) => child.emit('message', { lr: 'robot', ...m });
  return child;
}

const nextSent = (child, type) => new Promise((resolve) => {
  const found = child.sent.find((m) => m.type === type && !m.seen);
  if (found) { found.seen = true; resolve(found); return; }
  const on = (m) => { if (m.type === type) { m.seen = true; child.off('sent', on); resolve(m); } };
  child.on('sent', on);
});

function harness({ status = { available: true, step_credits: 1.7, session_credits: 150 }, on = true, open = null } = {}) {
  const store = new Map(on ? [] : [['aiOversight', false]]);
  const calls = { open: [], chat: [], report: [] };
  const client = {
    agentOpen: async (body) => { calls.open.push(body); if (open) throw open; return { session_id: 7, max_calls: 40 }; },
    agentChat: async (id, body) => { calls.chat.push(body); return { message: { role: 'assistant', content: 'x' }, charged: 1 }; },
    agentReport: async (id, body) => { calls.report.push({ id, body }); return { ok: true }; },
  };
  const events = [];
  const states = [];
  let t = 1_000_000;
  const overseer = new Overseer({
    getClient: () => client, getStore: () => ({ get: (k, d) => (store.has(k) ? store.get(k) : d) }),
    getProfile: () => PROFILE, getStatus: () => status, onEvent: (e) => events.push(e), onState: (s) => states.push(s),
    appVersion: '0.4.0', now: () => t, setInterval: () => null, clearInterval: () => {},
  });
  return { overseer, client, calls, events, states, advance: (ms) => { t += ms; }, now: () => t };
}

const HANDOFF = { job_id: 77, queue_name: 'REAL ID', site_name: 'California DMV', connector: 'dmv.ca.gov.qmatic',
  slot: { office_name: 'Poway', date: '2026-11-03', time: '10:20' },
  robot: { requires: ['first_name', 'last_name', 'email', 'phone'], guide: 'the pages' } };

test('the overseer takes a stuck robot over, tells it how it ended, and reports it', async () => {
  const { overseer, calls, events, now } = harness();
  let agentArgs = null;
  overseer.runAgent = async (args) => {
    agentArgs = args;
    return { outcome: { outcome: 'booked', confirmation: 'TS-9', submitted: true, summary: 'Ada: renamed labels; booked.' },
      steps: [{ tool: 'click', args: { ref: 5 }, result: 'Pressed [5]' }], calls: 3, credits: 5, pages: ['/details'], stopped: '' };
  };
  assert.equal(overseer.wanted(), true);
  const watch = overseer.watch(HANDOFF, { deadline: now() + 200000 });
  const child = fakeChild();
  watch.attach(child);
  child.robot({ type: 'step', tag: 'TARGETED', detail: 'Poway' });
  child.robot({ type: 'trouble', id: 't1', stage: 'booking', step: 'filling in the details', why: 'no "First Name" for Ada',
    url: 'https://www.dmv.ca.gov/portal/appointments/details?hold=x' });
  const take = await nextSent(child, 'take');
  assert.equal(take.id, 't1');
  assert.equal(take.readOnly, false);
  assert.equal(take.budgetMs, 185000);
  const done = await nextSent(child, 'done');
  assert.deepEqual(done.outcome, { status: 'booked', confirmation: 'TS-9', submitted: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.open[0].stage, 'booking');
  assert.equal(calls.open[0].job_id, 77);
  assert.doesNotMatch(calls.open[0].trigger, /Ada/, 'the person is taken out of what goes to the site');
  assert.deepEqual(agentArgs.allowed, ['first_name', 'last_name', 'email', 'phone']);
  assert.equal(agentArgs.readOnly, false);
  assert.match(agentArgs.task.user, /Poway/);
  assert.equal(agentArgs.scrub('Ada Lovelace at ada@example.com'), '[first_name] [last_name] at [email]');
  const report = calls.report[0];
  assert.equal(report.id, 7);
  assert.equal(report.body.outcome, 'booked');
  assert.equal(report.body.summary, '[first_name]: renamed labels; booked.');
  assert.deepEqual(report.body.robot.last_steps, ['TARGETED']);
  assert.equal(report.body.robot.url, '/portal/appointments/details');
  assert.deepEqual(report.body.result, { status: 'booked', submitted: true, confirmation: true, calls: 3, credits: 5, stopped: undefined });
  assert.ok(!JSON.stringify(report).includes('Lovelace'));
  assert.deepEqual(events.map((e) => e.kind), ['agent.take', 'agent.end']);
  assert.equal(overseer.state().last.outcome, 'booked');
  assert.equal(overseer.state().active, null);
  // Once a run: a second trouble in the same run is declined.
  child.robot({ type: 'trouble', id: 't2', stage: 'confirming', readOnly: true });
  assert.equal((await nextSent(child, 'decline')).id, 't2');
});

test('the overseer stays out: switched off, not bought, too late, refused', async () => {
  const cases = [
    [{ on: false }, /switched off/],
    [{ status: { available: false, why: 'needs_purchase', message: 'runs on bought credits' } }, /runs on bought credits/],
    [{ open: Object.assign(new Error('Too many AI sessions this hour'), { status: 429, body: {} }) }, /would not open a session: Too many/],
  ];
  for (const [opts, why] of cases) {
    const { overseer, events, now } = harness(opts);
    const watch = overseer.watch(HANDOFF, { deadline: now() + 200000 });
    const child = fakeChild();
    watch.attach(child);
    child.robot({ type: 'trouble', id: 'x', stage: 'booking', why: 'stuck' });
    assert.equal((await nextSent(child, 'decline')).id, 'x');
    assert.match(events.find((e) => e.kind === 'agent.declined').why, why);
  }
  const { overseer, events, now } = harness();
  const watch = overseer.watch(HANDOFF, { deadline: now() + 40000 });
  const child = fakeChild();
  watch.attach(child);
  child.robot({ type: 'trouble', id: 'y', stage: 'booking', why: 'stuck' });
  await nextSent(child, 'decline');
  assert.match(events[0].why, /too little time left \(25 s\)/);
});

test('what the model ends with becomes what the robot is told', async () => {
  const ends = [
    [{ outcome: 'gone', submitted: false, summary: 'no times' }, { status: 'gone', why: 'no times' }, 'gone'],
    [{ outcome: 'human_check', submitted: false, summary: 'captcha' }, { status: 'gate', why: 'captcha', submitted: false }, 'handed'],
    [{ outcome: 'unconfirmed', submitted: true, summary: '?' }, { status: 'unconfirmed', why: '?', submitted: true }, 'failed'],
    [{ outcome: 'booked', confirmation: '', submitted: true, summary: 'x' },
      { status: 'unconfirmed', why: 'the AI said booked with no confirmation number', submitted: true }, 'booked'],
    [null, { status: 'failed', why: 'the AI stopped: out of time', submitted: true }, 'stopped'],
  ];
  for (const [said, told, reported] of ends) {
    const { overseer, calls, now } = harness();
    overseer.runAgent = async () => ({ outcome: said, steps: [], calls: 1, credits: 1, pages: [], stopped: said ? '' : 'out of time',
      pressedFinal: true });
    const watch = overseer.watch(HANDOFF, { deadline: now() + 200000 });
    const child = fakeChild();
    watch.attach(child);
    child.robot({ type: 'trouble', id: 'z', stage: 'booking', why: 'stuck' });
    assert.deepEqual((await nextSent(child, 'done')).outcome, told);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.report[0].body.outcome, reported);
  }
});

test('the robot\'s page, worked over the channel', async () => {
  const { overseer, now } = harness();
  overseer.runAgent = async ({ driver }) => {
    const page = await driver.look(1000);
    await driver.click(4);
    await assert.rejects(driver.fill(9, 'x'), /no such element/);
    return { outcome: { outcome: 'failed', submitted: false, summary: page.title }, steps: [], calls: 1, credits: 1, pages: [] };
  };
  const watch = overseer.watch(HANDOFF, { deadline: now() + 200000 });
  const child = fakeChild();
  watch.attach(child);
  child.on('sent', (m) => {
    if (m.type !== 'cmd') return;
    if (m.op === 'eval') child.robot({ type: 'result', id: m.id, ok: true, value: { title: 'Read', text: '', url: 'https://x/' } });
    else if (m.op === 'click') child.robot({ type: 'result', id: m.id, ok: true, value: { url: 'https://x/' } });
    else child.robot({ type: 'result', id: m.id, ok: false, error: 'no such element' });
  });
  child.robot({ type: 'trouble', id: 'w', stage: 'booking', why: 'stuck' });
  const done = await nextSent(child, 'done');
  assert.equal(done.outcome.why, 'Read');
  const ops = child.sent.filter((m) => m.type === 'cmd').map((m) => [m.op, m.args.selector || m.args.source.slice(0, 17)]);
  assert.deepEqual(ops, [['eval', 'function readPage'], ['click', '[data-lr-ref="4"]'], ['fill', '[data-lr-ref="9"]']]);
  watch.detach();
});
