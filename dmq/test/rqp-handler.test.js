/**
 * Exercises the process boundary regbot's connector uses: JSON in on stdin,
 * one RQP/1 envelope out on stdout. Runs in simulate mode, so no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.join(HERE, '..', 'bin', 'rqp-handler.js');

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rqp-')), 'bookings.json');
}

function call(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HANDLER],
      { env: { ...process.env, RQP_MODE: 'simulate', ...env } },
      (error, stdout, stderr) => {
        if (error && !stdout) return reject(new Error(`${error.message}\n${stderr}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`unparseable stdout: ${stdout}\n${stderr}`));
        }
      }
    );
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

const REQUEST = {
  protocol: 'RQP/1',
  kind: 'booking.request',
  job_id: 412,
  idempotency_key: 'rqp1-job-412',
  target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' },
  slot: { preferred_date: '2026-10-08', preferred_time: '10:00', window: ['2026-10-01', '2026-10-31'] },
  applicant: { user_id: 21, nickname: 'demo_runner' },
  personal_data: {
    offices: 'Poway,San Marcos',
    first_name: 'A', last_name: 'B', email: 'a@b.c', phone: '5555550123',
  },
  priority: { bid: 140, currency: 'CHR' },
};

test('handler answers a well-formed request with a result envelope', async () => {
  const env = await call(REQUEST, { RQP_STATE_PATH: tmpState() });
  assert.equal(env.protocol, 'RQP/1');
  assert.equal(env.kind, 'booking.result');
  assert.ok(['confirmed', 'unavailable', 'rejected'].includes(env.status));
});

test('malformed JSON is answered, not crashed on', async () => {
  const env = await call('{not json', { RQP_STATE_PATH: tmpState() });
  assert.equal(env.status, 'rejected');
  assert.match(env.message, /Malformed request JSON/);
});

test('a bad application is refused permanently so the escrow comes straight back', async () => {
  const env = await call(
    { ...REQUEST, target: { ...REQUEST.target, queue: 'drive-test-auto' } },
    { RQP_STATE_PATH: tmpState() }
  );
  assert.equal(env.status, 'rejected');
  assert.match(env.message, /Driver licence or permit number is missing/);
});

test('an unmapped line is refused permanently', async () => {
  const env = await call(
    { ...REQUEST, target: { ...REQUEST.target, queue: 'submarine-licence' } },
    { RQP_STATE_PATH: tmpState() }
  );
  assert.equal(env.status, 'rejected');
  assert.match(env.message, /No DMV service mapped/);
});

test('a redelivered job replays the original confirmation instead of booking twice', async () => {
  // regbot is at-least-once: a worker can die after DMV committed but before the
  // ack lands. The contract says a replay must not produce a second appointment.
  const state = tmpState();
  const env = { RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true', RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' };

  const first = await call(REQUEST, env);
  assert.equal(first.status, 'confirmed');
  assert.ok(first.confirmation);
  assert.ok(!first.replayed);

  const second = await call(REQUEST, env);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.confirmation, first.confirmation, 'must return the original reference');
  assert.equal(second.replayed, true);
});

test('the replay store survives a restart', async () => {
  const state = tmpState();
  const env = { RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true', RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' };
  const first = await call(REQUEST, env);

  // A fresh process reads it back off disk — an in-memory cache would double-book.
  const stored = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(stored[REQUEST.idempotency_key].confirmation, first.confirmation);

  const afterRestart = await call(REQUEST, env);
  assert.equal(afterRestart.confirmation, first.confirmation);
});

test('a different job does not inherit another job’s booking', async () => {
  const state = tmpState();
  const env = { RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true', RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' };
  const a = await call(REQUEST, env);
  const b = await call({ ...REQUEST, job_id: 413, idempotency_key: 'rqp1-job-413' }, env);
  assert.ok(!b.replayed, 'job 413 must run on its own');
  assert.notEqual(b.confirmation, '', 'and get its own confirmation');
  assert.ok(a.confirmation);
});

test('nothing is recorded for a run that did not book', async () => {
  const state = tmpState();
  const env = await call(REQUEST, { RQP_STATE_PATH: state, RQP_SIMULATE_OUTCOME: 'NO_AVAILABILITY' });
  assert.equal(env.status, 'unavailable');
  assert.equal(fs.existsSync(state), false, 'a failed attempt must not block the retry');
});

test('a booking DMV never confirmed is refused, and a redelivery does not run it again', async () => {
  // It may exist. regbot does not retry a rejection, but a worker can die
  // before settling one, and then the job comes back: the store must answer
  // it, because running the bot again is what books a person twice.
  const state = tmpState();
  const env = { RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true', RQP_SIMULATE_OUTCOME: 'BOOKING_UNCONFIRMED' };

  const first = await call(REQUEST, env);
  assert.equal(first.status, 'rejected');
  assert.equal(first.unconfirmed, true);
  assert.equal(first.confirmation, '');
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8'))[REQUEST.idempotency_key].unconfirmed, true);

  // Even a redelivery that would now book cleanly is not run.
  const again = await call(REQUEST, { ...env, RQP_SIMULATE_OUTCOME: 'BOOKED_SUCCESS' });
  assert.equal(again.status, 'rejected');
  assert.equal(again.replayed, true);
  assert.equal(again.confirmation, '');
  assert.equal(again.message, first.message);
});

test('booking stays off unless the operator enables it', async () => {
  const env = await call(REQUEST, {
    RQP_STATE_PATH: tmpState(),
    RQP_SIMULATE_OUTCOME: 'FOUND_AND_STOPPED',
  });
  assert.equal(env.status, 'unavailable');
  assert.equal(env.confirmation, '');
  assert.match(env.message, /booking is disabled/);
});

test('an allocated slot that is no longer listed says so, and is not recorded', async () => {
  // The app that sent the robot takes it off the board on this, rather than
  // handing a slot nobody can book to the next bidder.
  const state = tmpState();
  const env = await call(REQUEST, { RQP_STATE_PATH: state, RQP_ALLOW_BOOKING: 'true', RQP_SIMULATE_OUTCOME: 'SLOT_GONE' });
  assert.equal(env.status, 'unavailable');
  assert.equal(env.slot_gone, true);
  assert.match(env.message, /no longer listed/);
  assert.equal(fs.existsSync(state), false);
});
