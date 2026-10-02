#!/usr/bin/env node
/**
 * RQP/1 connector process.
 *
 * Reads one `booking.request` envelope on stdin, runs the bot, writes one
 * `booking.result` envelope on stdout. This is the process regbot's
 * connectors/ca_dmv.py spawns; JSON over a pipe keeps the Python worker and
 * this Node bot decoupled.
 *
 *   echo '<envelope>' | node bin/rqp-handler.js
 *
 * Exit status is 0 whenever a valid envelope was produced — a failed booking is
 * a result, not a crash. Non-zero means no envelope could be written at all.
 */
import crypto from 'crypto';
import { run } from '../src/bot.js';
import { BookingStore } from '../src/idempotency.js';
import {
  ACK,
  NACK_FATAL,
  requestToEnv,
  outcomeToResult,
  errorToResult,
  result,
  RqpError,
  toDateOnly,
} from '../src/rqp.js';

// The app reads the answer on stdout, and the bot logs there as it goes
// (runlog.js). An app closed or crashed mid-booking leaves nobody reading, and
// a write then fails with EPIPE, which would end this run part way: after it
// may have booked, before it has recorded so. A write nobody reads is let go,
// and the run finishes and records what it made, for the app started again.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A deterministic stand-in so both sides of the integration can be tested
// without touching dmv.ca.gov. Never reachable unless RQP_MODE says so.
// RQP_SIMULATE_DELAY_MS makes it take that long, sending the form half way.
async function simulate(env, hooks = {}) {
  const mode = env.RQP_SIMULATE_OUTCOME || 'NO_AVAILABILITY';
  const office = (env.DMV_OFFICES || 'Poway').split(',')[0].trim();
  const date = new Date(`${env.DATE_START}T00:00:00`);
  const delay = Number(env.RQP_SIMULATE_DELAY_MS || 0);
  // Logging as it goes, as the bot does: the answer is the last line.
  console.log(`simulate: ${mode}`);
  await sleep(delay / 2);
  if (mode === 'BOOKED_SUCCESS' || mode === 'BOOKING_UNCONFIRMED') hooks.onSubmit?.();
  console.log('simulate: the form is sent');
  await sleep(delay / 2);
  console.log('simulate: done');
  // Closing the browser, as the bot does before it answers.
  await sleep(100);
  if (mode === 'BOOKED_SUCCESS') {
    const reference = `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return { status: 'BOOKED_SUCCESS', date, time: '10:30 AM', office, reference, results: [] };
  }
  if (mode === 'BOOKING_UNCONFIRMED') {
    return { status: 'BOOKING_UNCONFIRMED', date, time: '10:30 AM', office,
             seen: 'still on /portal/appointments/details, no confirmation shown', results: [] };
  }
  if (mode === 'FOUND_AND_STOPPED') {
    return { status: 'FOUND_AND_STOPPED', best: { office, date }, results: [] };
  }
  if (mode === 'SLOT_GONE') {
    return { status: 'NO_AVAILABILITY', slot_gone: true, office, date, results: [] };
  }
  return { status: 'NO_AVAILABILITY', results: [{ office, status: 'NO_AVAILABILITY', date: null }] };
}

async function main() {
  const started = Date.now();
  const raw = await readStdin();

  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(JSON.stringify(result('rejected', `Malformed request JSON: ${error.message}`)));
    return 0;
  }

  const store = new BookingStore(process.env.RQP_STATE_PATH || './data/rqp-bookings.json');
  const key = request?.idempotency_key;
  const answer = (envelope) => process.stdout.write(JSON.stringify(envelope));

  if (key) {
    // Another run of this very booking may still be at it: an app closed, or
    // crashed, in the middle of booking leaves its robot to finish, and the app
    // started again sends this one for the same slot. Racing it would lose the
    // slot to it and report the slot gone while the person holds the
    // appointment, so this one waits for it and answers with what it got.
    const waitUntil = started + Number(process.env.RQP_WAIT_MS || 180000);
    for (;;) {
      const prior = store.get(key);
      if (prior?.unconfirmed) {
        // An earlier run of this job submitted a booking DMV never confirmed.
        // Running it again is the one thing that can book the person twice.
        answer(result(NACK_FATAL, prior.message, {
          unconfirmed: true,
          attempted: prior.attempted ?? null,
          replayed: true,
          latency_ms: Date.now() - started,
        }));
        return 0;
      }
      if (prior) {
        answer(result(ACK, `Replayed existing booking ${prior.confirmation}.`, {
          confirmation: prior.confirmation,
          replayed: true,
          booked_date: prior.booked_date ?? null,
          latency_ms: Date.now() - started,
        }));
        return 0;
      }
      const claim = store.begin(key);
      if (claim.held) break;
      if (!claim.alive) {
        // It stopped after sending the form and never said what came of it: the
        // appointment may exist, and booking again could make a second one.
        const message = 'An earlier attempt at this booking stopped after it sent the form, so the '
          + 'appointment may have been made. Check your email for a confirmation before you book it again.';
        store.put(key, { unconfirmed: true, message, attempted: null });
        store.end(key, { anyone: true });
        answer(result(NACK_FATAL, message, { unconfirmed: true, attempted: null, latency_ms: Date.now() - started }));
        return 0;
      }
      if (Date.now() >= waitUntil) {
        answer(result('unavailable', 'Another attempt at this booking is still running, so this one did not start a second.', {
          latency_ms: Date.now() - started,
        }));
        return 0;
      }
      await sleep(1000);
    }
  }

  let envelope;
  try {
    const env = { ...process.env, ...requestToEnv(request, process.env) };
    // The moment the form goes: from here an appointment may exist, which is
    // what a later run must know should this one not live to say.
    const hooks = { onSubmit: () => key && store.phase(key, 'submitting') };
    const outcome = process.env.RQP_MODE === 'simulate' ? await simulate(env, hooks) : await run(env, hooks);
    envelope = outcomeToResult(outcome, { latencyMs: Date.now() - started });
  } catch (error) {
    envelope = errorToResult(error instanceof RqpError ? error : error, {
      latencyMs: Date.now() - started,
    });
  }

  // Record what must never be repeated: a real booking, and a submitted one
  // that DMV never confirmed, since that may be a real booking too. Then the
  // mark comes off, so a run waiting on this one finds what it came to.
  if (key && envelope.status === ACK && envelope.confirmation) {
    store.put(key, { confirmation: envelope.confirmation, booked_date: envelope.booked_date ?? null });
  } else if (key && envelope.unconfirmed) {
    store.put(key, { unconfirmed: true, message: envelope.message, attempted: envelope.attempted ?? null });
  }
  if (key) store.end(key);

  answer(envelope);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    try {
      process.stdout.write(JSON.stringify(result('unavailable', `Handler crashed: ${error.message}`)));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
