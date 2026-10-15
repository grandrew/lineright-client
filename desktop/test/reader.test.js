'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reader } = require('../src/reader');

const SITE = 'http://127.0.0.1:5000';
const PRACTICE = 'http://127.0.0.1:8787';

function world({ settings = {}, available = true, answer = null, reply = null, serverUrl = SITE,
  giveBack = async () => ({ ok: true, released: true }) } = {}) {
  const calls = { runs: [], answers: [], stops: [], released: [] };
  let release;
  const runner = {
    available: () => available,
    run: async (kind, envelope, opts) => {
      calls.runs.push({ kind, envelope, opts });
      if (answer === 'hold') await new Promise((r) => { release = r; });
      return answer && answer !== 'hold' ? answer : { kind: 'discovery.result', status: 'confirmed', offers: [{ office_code: 'P' }] };
    },
    stop: (kind) => { calls.stops.push(kind); },
  };
  const client = {
    serverUrl,
    answerRead: async (id, result) => {
      calls.answers.push({ id, result });
      if (reply instanceof Error) throw reply;
      return reply || { status: 'done', recorded: 1, offers: [{ where: 'Poway on d at 09:00', verdict: 'passed', to: { rank: 1, you: false } }] };
    },
    releaseRead: async (id) => { calls.released.push(id); return giveBack(id); },
  };
  const store = { get: (key, fallback) => (key in settings ? settings[key] : fallback) };
  const states = [];
  const reader = new Reader({ runner, getClient: () => client, getStore: () => store, onState: (s) => states.push(s) });
  return { reader, calls, states, release: () => release && release() };
}

const read = (id = 7, extra = {}) => ({
  read_id: id, queue_name: 'REAL ID', site_name: 'California DMV', base_url: PRACTICE,
  captcha_solver_url: `${PRACTICE}/__captcha/solve`, timeout_s: 120,
  request: { kind: 'discovery.request', offices: ['Poway', 'El Cajon'] }, ...extra,
});
const settle = () => new Promise((r) => setImmediate(r));

test('each sync says what the reader can do', () => {
  assert.deepEqual(world().reader.capabilities(), { enabled: true, robots: ['dmq-rqp/1'], reading: null, busy: false, agreed: true });
  assert.equal(world({ settings: { readerEnabled: false } }).reader.capabilities().enabled, false);
  assert.equal(world({ available: false }).reader.capabilities().enabled, false, 'no robots on board');
  const { reader } = world();
  reader.setBusy(true);
  assert.equal(reader.capabilities().busy, true);
});

test('a read is run by the scout and answered, and says so while it runs', async () => {
  const w = world({ answer: 'hold' });
  w.reader.offer([read()]);
  await settle();
  assert.equal(w.reader.capabilities().reading, 7, 'the lease is renewed by saying so');
  assert.equal(w.reader.state().reading.offices, 2);
  const [run] = w.calls.runs;
  assert.equal(run.kind, 'scout');
  assert.deepEqual(run.envelope.offices, ['Poway', 'El Cajon']);
  assert.equal(run.opts.dmvBase, PRACTICE);
  assert.equal(run.opts.solverUrl, `${PRACTICE}/__captcha/solve`);
  assert.equal(run.opts.timeoutMs, 120000);
  w.release();
  await settle(); await settle();
  assert.equal(w.calls.answers.length, 1);
  assert.equal(w.calls.answers[0].id, 7);
  assert.equal(w.reader.capabilities().reading, null);
  assert.equal(w.reader.state().last.offers[0].verdict, 'passed');
  // The same read in a sync that was already on its way is not run twice.
  w.reader.offer([read()]);
  await settle();
  assert.equal(w.calls.runs.length, 1);
});

test('an app told to stop looking starts nothing new, whatever the site sends, and gives it back', async () => {
  const w = world({ settings: { readerEnabled: false } });
  w.reader.offer([read(9)]);
  await settle(); await settle();
  assert.equal(w.calls.runs.length, 0);
  assert.deepEqual(w.calls.released, [9], 'not left to lapse, which the site would hold against it');
  w.reader.offer([read(9)]);
  await settle();
  assert.deepEqual(w.calls.released, [9], 'once');
});

test('one read at a time', async () => {
  const w = world({ answer: 'hold' });
  w.reader.offer([read(1)]);
  w.reader.offer([read(2)]);
  await settle();
  assert.equal(w.calls.runs.length, 1);
  w.release();
});

test('a site that names somewhere else gets a refusal, and no more offers to read', async () => {
  const w = world();
  w.reader.offer([read(3, { base_url: 'https://dmv.example' })]);
  await settle(); await settle();
  assert.equal(w.calls.runs.length, 0, 'no robot sent');
  assert.equal(w.calls.answers[0].result.status, 'rejected');
  assert.equal(w.reader.capabilities().enabled, false);
  w.reader.reconsider();
  assert.equal(w.reader.capabilities().enabled, true);
});

test('the real DMV only once the person has said yes', async () => {
  const real = (id) => read(id, { base_url: 'https://www.dmv.ca.gov', captcha_solver_url: null });
  // A site elsewhere has its lines on the real DMV: without the yes the app
  // does not offer to check at all, and one handed to it anyway goes back.
  const no = world({ serverUrl: 'https://regbot.example' });
  assert.deepEqual([no.reader.capabilities().enabled, no.reader.capabilities().agreed], [false, false]);
  no.reader.offer([real(4)]);
  await settle(); await settle();
  assert.equal(no.calls.runs.length, 0);
  assert.equal(no.calls.answers.length, 0);
  assert.deepEqual(no.calls.released, [4], 'given back, not left to lapse');
  assert.equal(no.reader.state().answered, false, 'still to be asked');

  // Checking lines is its own yes; booking's, from before there were two, covers it too.
  for (const settings of [{ realDmvChecks: true }, { realDmvRobots: true }]) {
    const yes = world({ serverUrl: 'https://regbot.example', settings });
    assert.deepEqual([yes.reader.capabilities().enabled, yes.reader.capabilities().agreed], [true, true]);
    assert.equal(yes.reader.state().answered, true);
    yes.reader.offer([real(5)]);
    await settle(); await settle();
    assert.equal(yes.calls.runs.length, 1, JSON.stringify(settings));
  }

  // "Not now" is an answer: the app stops asking, and does not check.
  const later = world({ serverUrl: 'https://regbot.example', settings: { realDmvChecks: false } });
  assert.equal(later.reader.state().answered, true);
  assert.equal(later.reader.capabilities().enabled, false);

  // A practice site on this machine needs no yes for its own DMV — but a read
  // it hands out for the real one is still refused without it.
  const practice = world();
  practice.reader.offer([real(6)]);
  await settle(); await settle();
  assert.equal(practice.calls.runs.length, 0);
  assert.match(practice.calls.answers[0].result.message, /not let this app/);
  assert.equal(practice.reader.capabilities().enabled, false);
});

test('an answer the site will not take is let go', async () => {
  const w = world({ reply: Object.assign(new Error('That read ran out of time'), { status: 410 }) });
  w.reader.offer([read(6)]);
  await settle(); await settle();
  assert.equal(w.reader.capabilities().reading, null);
  assert.equal(w.reader.state().last, null);
});

test('closing mid-read gives the read back, and is quick about it whatever the site does', async () => {
  const idle = world();
  assert.equal(await idle.reader.release(), false, 'nothing in hand, nothing to give back');
  assert.deepEqual(idle.calls.released, []);

  const w = world({ answer: 'hold' });
  w.reader.offer([read(11)]);
  await settle();
  assert.equal(await w.reader.release(), true);
  assert.deepEqual(w.calls.released, [11]);
  w.reader.stop();
  w.release();
  await settle(); await settle();
  assert.equal(w.calls.answers.length, 0, 'and it is not answered after');

  const hung = world({ answer: 'hold', giveBack: () => new Promise(() => {}) });
  hung.reader.offer([read(12)]);
  await settle();
  const started = Date.now();
  assert.equal(await hung.reader.release(200), false);
  assert.ok(Date.now() - started < 1000, 'bounded');
  hung.reader.stop();
  hung.release();
});

test('stopping stops the robots that look, and nothing is answered after', async () => {
  const w = world({ answer: 'hold' });
  w.reader.offer([read(8)]);
  await settle();
  w.reader.stop();
  assert.deepEqual(w.calls.stops, ['scout'], 'a robot booking the person\'s slot is the booker\'s to finish');
  assert.equal(w.reader.capabilities().enabled, false);
  w.release();
  await settle(); await settle();
  assert.equal(w.calls.answers.length, 0);
  w.reader.restart();
  assert.equal(w.reader.capabilities().enabled, true);
});
