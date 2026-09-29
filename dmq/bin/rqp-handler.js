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

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// A deterministic stand-in so both sides of the integration can be tested
// without touching dmv.ca.gov. Never reachable unless RQP_MODE says so.
function simulate(env) {
  const mode = env.RQP_SIMULATE_OUTCOME || 'NO_AVAILABILITY';
  const office = (env.DMV_OFFICES || 'Poway').split(',')[0].trim();
  const date = new Date(`${env.DATE_START}T00:00:00`);
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

  if (key) {
    const prior = store.get(key);
    if (prior?.unconfirmed) {
      // An earlier run of this job submitted a booking DMV never confirmed.
      // Running it again is the one thing that can book the person twice.
      process.stdout.write(
        JSON.stringify(
          result(NACK_FATAL, prior.message, {
            unconfirmed: true,
            attempted: prior.attempted ?? null,
            replayed: true,
            latency_ms: Date.now() - started,
          })
        )
      );
      return 0;
    }
    if (prior) {
      process.stdout.write(
        JSON.stringify(
          result(ACK, `Replayed existing booking ${prior.confirmation}.`, {
            confirmation: prior.confirmation,
            replayed: true,
            booked_date: prior.booked_date ?? null,
            latency_ms: Date.now() - started,
          })
        )
      );
      return 0;
    }
  }

  let envelope;
  try {
    const env = { ...process.env, ...requestToEnv(request, process.env) };
    const outcome = process.env.RQP_MODE === 'simulate' ? simulate(env) : await run(env);
    envelope = outcomeToResult(outcome, { latencyMs: Date.now() - started });
  } catch (error) {
    envelope = errorToResult(error instanceof RqpError ? error : error, {
      latencyMs: Date.now() - started,
    });
  }

  // Record what must never be repeated: a real booking, and a submitted one
  // that DMV never confirmed, since that may be a real booking too.
  if (key && envelope.status === ACK && envelope.confirmation) {
    store.put(key, { confirmation: envelope.confirmation, booked_date: envelope.booked_date ?? null });
  } else if (key && envelope.unconfirmed) {
    store.put(key, { unconfirmed: true, message: envelope.message, attempted: envelope.attempted ?? null });
  }

  process.stdout.write(JSON.stringify(envelope));
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
