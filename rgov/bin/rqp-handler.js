#!/usr/bin/env node
/**
 * RQP/1 booking process for the Yosemite line.
 *
 * Reads one `booking.request` envelope on stdin, books the stay, writes one
 * `booking.result` envelope on stdout. Spawned exactly as
 * ../../dmq/bin/rqp-handler.js is, and kept to the same rules: one booking per
 * idempotency key, ever, on this computer (the replay store); a second run of a
 * booking still going waits for the first; and an order that was placed but
 * never confirmed is never placed again — here it may also have been charged.
 *
 *   echo '<envelope>' | node bin/rqp-handler.js
 *
 * Exit status is 0 whenever a valid envelope was produced — a failed booking is
 * a result, not a crash. Non-zero means no envelope could be written at all.
 */
import crypto from 'crypto';
import { BookingStore, controlChannel, overseeHere } from '../src/shared.js';
import { baseUrl } from '../src/config.js';
import { findCampground } from '../src/catalog.js';
import {
  ACK,
  NACK_FATAL,
  requestToEnv,
  outcomeToResult,
  errorToResult,
  result,
} from '../src/rqp.js';

// An app closed mid-booking leaves nobody reading stdout; a write then fails
// with EPIPE, which must not end the run between paying and recording it.
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

/**
 * A deterministic stand-in so both sides of the integration can be tested
 * without touching recreation.gov. Never reachable unless RQP_MODE says so.
 */
async function simulate(env, hooks = {}) {
  const mode = env.RQP_SIMULATE_OUTCOME || 'NO_AVAILABILITY';
  const campground = findCampground(env.RGOV_TARGET_CAMPGROUND || String(env.RGOV_CAMPGROUNDS || '').split(',')[0]);
  const where = { campground: campground?.short ?? 'Upper Pines', campsite_id: env.RGOV_TARGET_CAMPSITE || '100',
    site: env.RGOV_TARGET_SITE || '044', arrival: env.RGOV_TARGET_ARRIVAL || env.DATE_START, nights: Number(env.RGOV_NIGHTS || 1) };
  const delay = Number(env.RQP_SIMULATE_DELAY_MS || 0);
  console.log(`simulate: ${mode}`);
  await sleep(delay / 2);
  if (['BOOKED_SUCCESS', 'BOOKING_UNCONFIRMED', 'PAYMENT_DECLINED'].includes(mode)) hooks.onSubmit?.();
  console.log('simulate: the order is placed');
  await sleep(delay / 2);
  console.log('simulate: done');
  await sleep(100);
  if (mode === 'BOOKED_SUCCESS') {
    const reference = `${String(crypto.randomInt(1e9, 1e10))}-1`;
    const url = env.RGOV_BASE_URL ? `${env.RGOV_BASE_URL}/checkout/confirmation?reservation=${reference}` : undefined;
    return { status: 'BOOKED_SUCCESS', ...where, reference, url, results: [] };
  }
  if (mode === 'BOOKING_UNCONFIRMED') {
    return { status: 'BOOKING_UNCONFIRMED', ...where, seen: 'still on /checkout, no reservation number shown', results: [] };
  }
  if (mode === 'PAYMENT_DECLINED') {
    return { status: 'PAYMENT_DECLINED', ...where, cart_url: `${baseUrl(env)}/cart`, held_until: '7:14 AM', results: [] };
  }
  if (mode === 'FOUND_AND_STOPPED') return { status: 'FOUND_AND_STOPPED', best: where, results: [] };
  if (mode === 'SLOT_GONE') return { status: 'NO_AVAILABILITY', slot_gone: true, ...where, results: [] };
  return { status: 'NO_AVAILABILITY', results: [{ campground: where.campground, status: 'NO_AVAILABILITY' }] };
}

async function main() {
  const started = Date.now();
  const raw = await readStdin();

  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(JSON.stringify(result(NACK_FATAL, `Malformed request JSON: ${error.message}`)));
    return 0;
  }

  const store = new BookingStore(process.env.RQP_STATE_PATH || './data/rqp-bookings.json');
  const key = request?.idempotency_key;
  const answer = (envelope) => process.stdout.write(JSON.stringify(envelope));

  if (key) {
    // Another run of this very booking may still be at it (the app closed or
    // crashed mid-booking and started again): wait for it and answer with
    // what it got, rather than race it to a second order.
    const waitUntil = started + Number(process.env.RQP_WAIT_MS || 180000);
    for (;;) {
      const prior = store.get(key);
      if (prior?.unconfirmed) {
        answer(result(NACK_FATAL, prior.message, { unconfirmed: true, attempted: prior.attempted ?? null,
          replayed: true, latency_ms: Date.now() - started }));
        return 0;
      }
      if (prior) {
        answer(result(ACK, `Replayed existing reservation ${prior.confirmation}.`, {
          confirmation: prior.confirmation,
          ...(prior.confirmation_url ? { confirmation_url: prior.confirmation_url } : {}),
          ...(prior.confirmation_shot ? { confirmation_shot: prior.confirmation_shot } : {}),
          replayed: true, booked_date: prior.booked_date ?? null, latency_ms: Date.now() - started,
        }));
        return 0;
      }
      const claim = store.begin(key);
      if (claim.held) break;
      if (!claim.alive) {
        const message = 'An earlier attempt at this booking stopped after it placed the order, so the reservation '
          + 'may have been made and paid for. Check your Recreation.gov reservations before you book it again.';
        store.put(key, { unconfirmed: true, message, attempted: null });
        store.end(key, { anyone: true });
        answer(result(NACK_FATAL, message, { unconfirmed: true, attempted: null, latency_ms: Date.now() - started }));
        return 0;
      }
      if (Date.now() >= waitUntil) {
        answer(result('unavailable', 'Another attempt at this booking is still running, so this one did not start a second.',
          { latency_ms: Date.now() - started }));
        return 0;
      }
      await sleep(1000);
    }
  }

  let envelope;
  try {
    const env = { ...process.env, ...requestToEnv(request, process.env) };
    const hooks = { onSubmit: () => key && store.phase(key, 'submitting') };
    const control = controlChannel();
    if (control) {
      hooks.onStep = (tag, detail) => control.event('step', { tag, detail: String(detail ?? '').slice(0, 500) });
      hooks.onTrouble = (page, trouble) => overseeHere(control, page, trouble, {
        base: baseUrl(env), readOnly: Boolean(trouble.readOnly),
        beforeTake: trouble.readOnly ? null : hooks.onSubmit,
      });
    }
    const outcome = process.env.RQP_MODE === 'simulate'
      ? await simulate(env, hooks)
      : await (await import('../src/checkout.js')).run(env, hooks);
    if (control) control.close();
    envelope = outcomeToResult(outcome, { latencyMs: Date.now() - started });
  } catch (error) {
    envelope = errorToResult(error, { latencyMs: Date.now() - started });
  }

  // Record what must never be repeated: a reservation, and an order placed
  // that never confirmed. Then the mark comes off.
  if (key && envelope.status === ACK && envelope.confirmation) {
    store.put(key, { confirmation: envelope.confirmation, booked_date: envelope.booked_date ?? null,
      ...(envelope.confirmation_url ? { confirmation_url: envelope.confirmation_url } : {}),
      ...(envelope.confirmation_shot ? { confirmation_shot: envelope.confirmation_shot } : {}) });
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
