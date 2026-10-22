'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RobotRunner, robotEnv, targetAllowed, isRealDmv, lastJson, REAL_DMV } = require('../src/robots');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-robots-'));
const DMQ = path.join(__dirname, '..', '..', 'dmq');
const HAVE_DMQ = fs.existsSync(path.join(DMQ, 'bin', 'rqp-scout.js'));

/** A dmq directory whose "scout" is this script: it reads the envelope and says what it saw. */
function fakeDmq(body) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'rqp-scout.js'), body);
  fs.writeFileSync(path.join(dir, 'bin', 'rqp-handler.js'), body);
  return dir;
}

const ECHO = `let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
  console.log('LOG a line that is not the answer');
  console.log('{ not json either');
  const e = JSON.parse(s);
  console.log(JSON.stringify({ kind: 'discovery.result', status: 'confirmed', offers: [],
    saw: e.offices, env: { dmv: process.env.DMV_BASE_URL, allow: process.env.RQP_ALLOW_BOOKING || '',
      mode: process.env.RQP_MODE || '', headless: process.env.HEADLESS, state: process.env.RQP_STATE_PATH } }));
});`;

// This app's own host/: on Windows every robot is started with its preload
// (robotPlatformEnv), so the folder handed to the runner must have it.
const HOST = path.join(__dirname, '..', 'host');

function runner(dmq, extra = {}) {
  return new RobotRunner({ paths: { dmq, browsers: null, host: HOST, packaged: false }, node: process.execPath,
    stateDir: path.join(tmpdir(), 'robots'), env: { PATH: process.env.PATH }, ...extra });
}

test('a robot runs on nothing the machine set that would steer it', () => {
  const env = robotEnv({
    env: { PATH: '/bin', HOME: '/h', DMV_BASE_URL: 'https://evil', RQP_ALLOW_BOOKING: 'true', RQP_MODE: 'simulate',
      CAPTCHA_SOLVER_URL: 'http://x', HEADLESS: 'false', NODE_OPTIONS: '--inspect', REGBOT_DB: '/x.db' },
    paths: { browsers: '/b', host: '/h', packaged: true }, platform: 'linux', stateDir: '/s',
    dmvBase: 'https://www.dmv.ca.gov/',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.DMV_BASE_URL, 'https://www.dmv.ca.gov');
  assert.equal(env.RQP_ALLOW_BOOKING, undefined, 'submitting is asked for, never inherited');
  assert.equal(env.RQP_MODE, undefined);
  assert.equal(env.CAPTCHA_SOLVER_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.REGBOT_DB, undefined);
  assert.equal(env.HEADLESS, 'true');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/b');
  assert.equal(env.RQP_STATE_PATH, path.join('/s', 'rqp-bookings.json'));
  assert.equal(env.RUN_LOG_PATH, path.join('/s', 'dmv-robot.log'));
});

test('booking is allowed only when asked, a solving farm only for a practice DMV, simulate only unpackaged', () => {
  const paths = { browsers: null, host: '/h', packaged: false };
  assert.equal(robotEnv({ env: {}, paths, stateDir: '/s', allowBooking: true }).RQP_ALLOW_BOOKING, 'true');
  const practice = robotEnv({ env: {}, paths, stateDir: '/s', dmvBase: 'http://127.0.0.1:8787',
    solverUrl: 'http://127.0.0.1:8787/__captcha/solve' });
  assert.equal(practice.CAPTCHA_SOLVER_URL, 'http://127.0.0.1:8787/__captcha/solve');
  assert.equal(robotEnv({ env: {}, paths, stateDir: '/s', dmvBase: REAL_DMV,
    solverUrl: 'http://127.0.0.1:8787/__captcha/solve' }).CAPTCHA_SOLVER_URL, undefined);
  const sim = { REGBOT_ROBOT_SIMULATE: '1', REGBOT_ROBOT_OUTCOME: 'BOOKED_SUCCESS', REGBOT_ROBOT_DELAY_MS: '6000' };
  assert.equal(robotEnv({ env: sim, paths, stateDir: '/s' }).RQP_MODE, 'simulate');
  assert.equal(robotEnv({ env: sim, paths, stateDir: '/s' }).RQP_SIMULATE_OUTCOME, 'BOOKED_SUCCESS');
  assert.equal(robotEnv({ env: sim, paths, stateDir: '/s' }).RQP_SIMULATE_DELAY_MS, '6000');
  assert.equal(robotEnv({ env: { REGBOT_ROBOT_DELAY_MS: '6000' }, paths, stateDir: '/s' }).RQP_SIMULATE_DELAY_MS, undefined,
    'only a simulating robot is slowed');
  assert.equal(robotEnv({ env: sim, paths: { ...paths, packaged: true }, stateDir: '/s' }).RQP_MODE, undefined,
    'an installed app never simulates');
  const win = robotEnv({ env: {}, paths: { host: 'C:\\app\\host' }, platform: 'win32', stateDir: 'C:\\s' });
  assert.equal(win.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, '1');
  assert.match(win.NODE_OPTIONS, /robot-preload\.cjs/);
});

test('a robot goes to the real DMV, or to a practice one only when the site is on this machine too', () => {
  assert.equal(targetAllowed('https://www.dmv.ca.gov', 'https://regbot.example'), true);
  assert.equal(targetAllowed('https://www.dmv.ca.gov/', 'http://127.0.0.1:5000'), true);
  assert.equal(targetAllowed('http://127.0.0.1:8787', 'http://127.0.0.1:5000'), true);
  assert.equal(targetAllowed('http://127.0.0.1:8787', 'https://regbot.example'), false,
    'a remote site cannot send the robot at this machine');
  assert.equal(targetAllowed('https://dmv.example', 'https://regbot.example'), false);
  assert.equal(targetAllowed('not a url', 'http://127.0.0.1:5000'), false);
  assert.equal(isRealDmv('https://www.dmv.ca.gov/'), true);
  assert.equal(isRealDmv('http://127.0.0.1:8787'), false);
});

test('the answer is the last JSON line, whatever was logged before it', () => {
  assert.deepEqual(lastJson('a\n{"x":1}\nlog\n{"y":2}\n'), { y: 2 });
  assert.deepEqual(lastJson('{"y":2}\n{ oops\n'), { y: 2 });
  assert.equal(lastJson('nothing here'), null);
  assert.equal(lastJson('[1,2]'), null);
});

test('a run hands the envelope in and takes the answer out, in the environment it was given', async () => {
  const run = runner(fakeDmq(ECHO));
  const answer = await run.run('scout', { offices: ['Poway'] }, { dmvBase: 'http://127.0.0.1:8787' });
  assert.deepEqual(answer.saw, ['Poway']);
  assert.equal(answer.env.dmv, 'http://127.0.0.1:8787');
  assert.equal(answer.env.allow, '', 'a scout never submits');
  assert.equal(answer.env.headless, 'true');
  assert.ok(fs.existsSync(path.dirname(answer.env.state)), 'its state folder made');
  const booking = await run.run('book', { offices: [] }, { allowBooking: true });
  assert.equal(booking.env.allow, 'true');
  assert.equal(run.running.size, 0);
});

test('a robot that says nothing, or runs too long, is an answer too', async () => {
  const silent = runner(fakeDmq('process.stderr.write("boom\\n"); process.exit(3);'));
  const quiet = await silent.run('scout', {});
  assert.equal(quiet.status, 'unavailable');
  assert.match(quiet.message, /boom/);

  const stuck = runner(fakeDmq('setInterval(() => {}, 1000);'));
  const started = Date.now();
  const late = await stuck.run('scout', {}, { timeoutMs: 400 });
  assert.equal(late.status, 'unavailable');
  assert.match(late.message, /did not finish/);
  assert.ok(Date.now() - started < 5000);
  assert.equal(stuck.running.size, 0);

  const missing = await runner(tmpdir()).run('scout', {});
  assert.equal(missing.status, 'unavailable');
});

test('the runner reads what its booking robot recorded on this computer', () => {
  const dir = tmpdir();
  const run = runner(DMQ, { stateDir: dir });
  assert.equal(run.recorded('127.0.0.1:5000/rqp1-job-1'), null, 'nothing recorded yet');
  fs.writeFileSync(path.join(dir, 'rqp-bookings.json'), JSON.stringify({
    '127.0.0.1:5000/rqp1-job-1': { confirmation: 'TS-AAA3150A', booked_date: '2026-10-19' } }));
  assert.deepEqual(run.recorded('127.0.0.1:5000/rqp1-job-1'), { confirmation: 'TS-AAA3150A', booked_date: '2026-10-19' });
  assert.equal(run.recorded('127.0.0.1:5000/rqp1-job-2'), null);
  assert.equal(run.recorded(null), null);
  fs.writeFileSync(path.join(dir, 'rqp-bookings.json'), '{ half written');
  assert.equal(run.recorded('127.0.0.1:5000/rqp1-job-1'), null, 'a store it cannot read is no answer');
});

test('stopping stops every robot still running', async () => {
  const stuck = runner(fakeDmq('setInterval(() => {}, 1000);'));
  const pending = stuck.run('scout', {}, { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stuck.running.size, 1);
  stuck.stopAll();
  const answer = await pending;
  assert.equal(answer.status, 'unavailable');
});

test('with a logbook, each run is written down in a folder of its own, secrets struck out', async () => {
  const { Logbook } = require('../src/logbook');
  const logs = path.join(tmpdir(), 'logs');
  const logbook = new Logbook({ dir: logs });
  const traced = runner(fakeDmq(`let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
    console.log('[t] TARGETED | Poway');
    console.error('a warning');
    console.log(JSON.stringify({ kind: 'booking.result', status: 'confirmed', confirmation: 'TS-1',
      trace: process.env.RQP_TRACE_DIR, shots: process.env.RQP_TRACE_SCREENSHOTS, runlog: process.env.RUN_LOG_PATH }));
  });`), { logbook });
  const answer = await traced.run('book', { job_id: 77, idempotency_key: 'k',
    personal_data: { first_name: 'Ada', dl_number: 'D1234567', dob: '12/10/1990' } }, { allowBooking: true, dmvBase: 'http://127.0.0.1:8787' });
  assert.match(path.basename(answer.trace), /^\d{8}-\d{6}-\d{3}-book-job77$/);
  assert.equal(path.dirname(answer.trace), path.join(logs, 'robots'));
  assert.equal(answer.shots, '1', 'a booking keeps pictures');
  assert.equal(answer.runlog, logbook.file('robot', 'log'));
  const run = JSON.parse(fs.readFileSync(path.join(answer.trace, 'run.json'), 'utf8'));
  assert.equal(run.kind, 'book');
  assert.equal(run.envelope.personal_data.first_name, 'Ada');
  assert.match(run.envelope.personal_data.dl_number, /^‹redacted/);
  assert.match(run.envelope.personal_data.dob, /^‹redacted/);
  assert.equal(run.options.dmvBase, 'http://127.0.0.1:8787');
  assert.equal(run.code, 0);
  assert.equal(run.answer.confirmation, 'TS-1');
  assert.match(run.stdout, /TARGETED \| Poway/);
  assert.match(run.stderr, /a warning/);
  assert.ok(run.startedAt && run.endedAt && Number.isFinite(run.ms));

  const look = await traced.run('scout', { target: { queue: 'real-id' } });
  assert.match(path.basename(look.trace), /-scout-real-id$/);
  assert.equal(look.shots, '0', 'a look does not');
  // Without a logbook, nothing is kept and the robot is told nothing of it.
  const plain = await runner(fakeDmq(`process.stdin.on('data', () => {}); process.stdin.on('end', () =>
    console.log(JSON.stringify({ status: 'confirmed', trace: process.env.RQP_TRACE_DIR || null })));`)).run('book', {});
  assert.equal(plain.trace, null);
});

test('closing stops the robots that look, and leaves one booking to finish', async () => {
  const stuck = runner(fakeDmq('setInterval(() => {}, 1000);'));
  const scout = stuck.run('scout', {}, { timeoutMs: 60000 });
  const booking = stuck.run('book', {}, { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stuck.running.size, 2);
  stuck.stop('scout');
  assert.equal((await scout).status, 'unavailable');
  assert.deepEqual([...stuck.running.values()], ['book'], 'the booking robot still runs');
  stuck.stopAll();
  assert.equal((await booking).status, 'unavailable');
  assert.equal(stuck.running.size, 0);
});

test('the real scout, in its own simulate mode, finds what the site asked about',
  { skip: !HAVE_DMQ && 'no ../dmq checkout' }, async () => {
  const run = runner(DMQ, { env: { PATH: process.env.PATH, REGBOT_ROBOT_SIMULATE: '1' } });
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const answer = await run.run('scout', {
    protocol: 'RQP/1', kind: 'discovery.request',
    target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'real-id', queue_name: 'REAL ID' },
    offices: ['Poway'], window: [day, day], hours: ['08:00', '17:00'], timezone: 'America/Los_Angeles',
  }, { dmvBase: 'http://127.0.0.1:9', timeoutMs: 60000 });
  assert.equal(answer.kind, 'discovery.result', JSON.stringify(answer));
  assert.equal(answer.offers.length, 2);
  for (const offer of answer.offers) {
    assert.equal(offer.office_name, 'Poway');
    assert.equal(offer.slot_date, day);
  }
});

test('a run that has ended is told, with its folder, its answer and which read or turn it was', async () => {
  const finished = [];
  const run = runner(fakeDmq(ECHO), { onFinish: (r) => finished.push(r) });
  await run.run('scout', { offices: ['Poway'] }, { dmvBase: 'http://127.0.0.1:8787', context: { read: 812 } });
  const silent = runner(fakeDmq('process.exit(3);'), { onFinish: (r) => finished.push(r) });
  await silent.run('book', {}, { context: { job: 77 } });
  assert.deepEqual(finished.map((r) => [r.kind, r.context, r.code, typeof r.ms, r.dir]), [
    ['scout', { read: 812 }, 0, 'number', ''], ['book', { job: 77 }, 3, 'number', '']]);
  assert.deepEqual(finished[0].answer.saw, ['Poway']);
  assert.equal(finished[1].answer.status, 'unavailable');
  const broken = runner(fakeDmq(ECHO), { onFinish: () => { throw new Error('a broken listener'); } });
  assert.deepEqual((await broken.run('scout', { offices: ['Poway'] })).saw, ['Poway'], 'never the run\'s problem');
});
