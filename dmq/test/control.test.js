/**
 * The robot's browser, handed to its overseer (control.js): the channel, the
 * ask and its answer, and what an overseer may and may not do on the page.
 * The process is a stand-in that records what the robot sends and lets the
 * test answer as the app would; the page is a real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { controlChannel, overseeHere, run, sameSite, LOOKING } from '../src/control.js';

const PAGE = `<!doctype html><meta charset="utf-8"><title>Your details</title>
<h1>Your details</h1>
<label for="fn">Given name</label><input id="fn">
<select id="when"><option value="am">Morning</option><option value="pm">Afternoon</option></select>
<button id="go" onclick="document.getElementById('out').textContent='Booked: '+document.getElementById('fn').value">Book this appointment</button>
<p id="out"></p>
<a href="/other">Another page</a>`;

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.sent = [];
  proc.send = (message) => { proc.sent.push(message); proc.emit('sent', message); };
  proc.channel = { unref() {} };
  proc.say = (message) => proc.emit('message', { lr: 'app', ...message });
  return proc;
}

const next = (proc, type) => new Promise((resolve) => {
  const found = proc.sent.find((m) => m.type === type && !m.seen);
  if (found) { found.seen = true; resolve(found); return; }
  const on = (m) => { if (m.type === type) { m.seen = true; proc.off('sent', on); resolve(m); } };
  proc.on('sent', on);
});

async function site(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/other' ? '<title>Other</title><p>Another page of the site</p>' : PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/details`);
  t.after(async () => { await browser.close(); server.close(); });
  return { page, base };
}

test('no channel without the app asking for one, or without IPC', () => {
  assert.equal(controlChannel({ proc: fakeProcess(), env: {} }), null);
  const proc = fakeProcess();
  delete proc.send;
  assert.equal(controlChannel({ proc, env: { RQP_CONTROL: '1' } }), null);
});

test('steps go to the app, and a stuck robot asks: declined, or no answer, is no', async () => {
  const proc = fakeProcess();
  const control = controlChannel({ proc, env: { RQP_CONTROL: '1' } });
  assert.equal(proc.sent[0].type, 'hello');
  control.event('step', { tag: 'TARGETED', detail: 'Poway 2026-11-02' });
  assert.deepEqual(proc.sent[1], { lr: 'robot', type: 'step', tag: 'TARGETED', detail: 'Poway 2026-11-02' });
  const asked = control.ask({ stage: 'booking', why: 'no Continue button' });
  const trouble = await next(proc, 'trouble');
  assert.equal(trouble.stage, 'booking');
  proc.say({ type: 'decline', id: trouble.id });
  assert.deepEqual(await asked, { take: false });
  const unanswered = control.ask({ stage: 'gone' }, { timeoutMs: 30 });
  await next(proc, 'trouble');
  assert.deepEqual(await unanswered, { take: false });
  const taken = control.ask({ stage: 'booking' });
  const again = await next(proc, 'trouble');
  proc.say({ type: 'take', id: again.id, budgetMs: 5000 });
  assert.deepEqual(await taken, { take: true, readOnly: false, budgetMs: 5000 });
  control.close();
});

test('taken over, the robot does what it is told on its page until it is told it is done', async (t) => {
  const { page, base } = await site(t);
  const proc = fakeProcess();
  const control = controlChannel({ proc, env: { RQP_CONTROL: '1' } });
  let before = 0;
  const ended = overseeHere(control, page, { stage: 'booking', why: 'no "First Name"' },
    { base, beforeTake: () => { before += 1; } });
  const trouble = await next(proc, 'trouble');
  assert.equal(trouble.url, `${base}/details`);
  proc.say({ type: 'take', id: trouble.id });
  const ask = async (op, args) => {
    const id = `c${Math.random()}`;
    proc.say({ type: 'cmd', id, op, args });
    for (;;) {
      const r = await next(proc, 'result');
      if (r.id === id) return r;
    }
  };
  const read = await ask('eval', { source: '(arg) => document.title + arg', arg: '!' });
  assert.deepEqual(read, { lr: 'robot', type: 'result', id: read.id, ok: true, value: 'Your details!', seen: true });
  assert.equal(before, 1, 'taking over before the form went counts as the form going');
  assert.equal((await ask('fill', { selector: '#fn', value: 'Ada' })).ok, true);
  assert.equal((await ask('select', { selector: '#when', value: 'Afternoon' })).ok, true);
  assert.equal(await page.inputValue('#when'), 'pm');
  assert.equal((await ask('click', { selector: '#go' })).ok, true);
  assert.equal(await page.textContent('#out'), 'Booked: Ada');
  const refused = await ask('goto', { url: 'https://example.com/' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /same site/);
  assert.equal((await ask('goto', { url: '/other' })).value.url, `${base}/other`);
  assert.equal((await ask('back', {})).value.url, `${base}/details`);
  assert.match((await ask('frobnicate', {})).error, /unknown command/);
  assert.match((await ask('click', { selector: '#nothing-here' })).error, /Timeout|waiting/i);
  proc.say({ type: 'done', outcome: { status: 'booked', confirmation: 'TS-1' } });
  assert.deepEqual(await ended, { status: 'booked', confirmation: 'TS-1' });
  assert.equal((await next(proc, 'handback')).status, 'booked');
  control.close();
});

test('read only, after the booking went: it may look and nothing else', async (t) => {
  const { page, base } = await site(t);
  const proc = fakeProcess();
  const control = controlChannel({ proc, env: { RQP_CONTROL: '1' } });
  const ended = overseeHere(control, page, { stage: 'confirming', readOnly: true }, { base, readOnly: true });
  const trouble = await next(proc, 'trouble');
  assert.equal(trouble.readOnly, true);
  proc.say({ type: 'take', id: trouble.id });
  proc.say({ type: 'cmd', id: 'a', op: 'click', args: { selector: '#go' } });
  const r = await next(proc, 'result');
  assert.equal(r.ok, false);
  assert.match(r.error, /only looked at/);
  proc.say({ type: 'cmd', id: 'b', op: 'text', args: {} });
  assert.match((await next(proc, 'result')).value, /Your details/);
  proc.say({ type: 'done', outcome: { status: 'failed' } });
  assert.equal((await ended).status, 'failed');
  assert.equal(await page.textContent('#out'), '', 'nothing was pressed');
  control.close();
});

test('an overseer that runs out of time hands back with a timeout', async (t) => {
  const { page, base } = await site(t);
  const proc = fakeProcess();
  const control = controlChannel({ proc, env: { RQP_CONTROL: '1' } });
  const ended = overseeHere(control, page, { stage: 'gone' }, { base, budgetMs: 150 });
  const trouble = await next(proc, 'trouble');
  proc.say({ type: 'take', id: trouble.id });
  assert.equal((await ended).status, 'timeout');
  control.close();
});

test('the same site only', () => {
  assert.equal(sameSite('/portal/x', 'https://www.dmv.ca.gov'), true);
  assert.equal(sameSite('https://www.dmv.ca.gov/portal', 'https://www.dmv.ca.gov/portal/appointments'), true);
  assert.equal(sameSite('https://evil.example/', 'https://www.dmv.ca.gov'), false);
  assert.equal(sameSite('javascript:alert(1)', 'https://www.dmv.ca.gov'), false);
  assert.equal(sameSite('http://www.dmv.ca.gov/', 'https://www.dmv.ca.gov'), false);
  assert.ok(LOOKING.has('eval') && !LOOKING.has('click') && !LOOKING.has('goto'));
  assert.equal(typeof run, 'function');
});
