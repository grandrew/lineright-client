#!/usr/bin/env node
/**
 * RQP/1 discovery process — phase 0.
 *
 * Reads one `discovery.request` envelope on stdin, sweeps the offices it names,
 * writes one `discovery.result` envelope on stdout. regbot's
 * connectors/ca_dmv.py spawns this exactly as it spawns bin/rqp-handler.js, and
 * records the offers that come back.
 *
 *   echo '<envelope>' | node bin/rqp-scout.js
 *
 * This process cannot book anything. It is handed no applicant and no contact
 * details, so there is nothing for a form to be filled in with — which is why
 * discovery needs none of the double opt-in that booking does.
 *
 * Exit status is 0 whenever a valid envelope was produced.
 */
import { toOffer } from '../src/slots.js';
import {
  discoveryRequestToEnv,
  offersToResult,
  discoveryErrorToResult,
  discoveryResult,
  NACK_FATAL,
} from '../src/rqp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop when the app that started this sweep is gone. It would read the answer
 * and nobody else will: an app that crashed, or was killed, leaves its robots
 * running on their own, and a scout carrying on would go on reading the DMV
 * from this person's computer for nobody. (A booking robot is the opposite: it
 * finishes, so the app started again can learn what it booked.)
 */
function stopWithParent(everyMs = 2000) {
  const parent = process.ppid;
  const timer = setInterval(() => {
    let gone = process.ppid !== parent;
    if (!gone) {
      try { process.kill(parent, 0); } catch (error) { gone = error.code === 'ESRCH'; }
    }
    if (gone) process.exit(0);
  }, everyMs);
  timer.unref();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/**
 * A deterministic stand-in so both sides of the integration can be tested
 * without touching dmv.ca.gov. Never reachable unless RQP_MODE says so.
 * RQP_SIMULATE_DELAY_MS makes it take that long.
 *
 * It offers two slots at each office on the first day of the window, which is
 * enough for the matcher to have to choose between offices and between people.
 */
async function simulate(env) {
  await sleep(Number(env.RQP_SIMULATE_DELAY_MS || 0));
  const names = String(env.DMV_OFFICES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const times = (env.RQP_SIMULATE_TIMES || '09:00,13:30').split(',').map((s) => s.trim());
  const offers = [];
  const checked = [];
  for (const name of names) {
    const made = [];
    for (const time of times) {
      const offer = toOffer(name, env.DATE_START, time);
      if (offer) made.push(offer);
    }
    offers.push(...made);
    checked.push({ office: name, found: made.length, error: null });
  }
  return { offers, checked };
}

async function main() {
  const started = Date.now();
  stopWithParent();
  const raw = await readStdin();

  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(JSON.stringify(
      discoveryResult(NACK_FATAL, `Malformed discovery request JSON: ${error.message}`)));
    return 0;
  }

  let envelope;
  try {
    const env = { ...process.env, ...discoveryRequestToEnv(request, process.env) };
    // Imported only when a real sweep is wanted: simulate mode has no use for
    // a browser, and loading Playwright to not use it makes the tests crawl.
    const sweep = process.env.RQP_MODE === 'simulate'
      ? await simulate(env)
      : await (await import('../src/discover.js')).discover(env);
    envelope = offersToResult(sweep, { latencyMs: Date.now() - started });
  } catch (error) {
    envelope = discoveryErrorToResult(error, { latencyMs: Date.now() - started });
  }

  process.stdout.write(JSON.stringify(envelope));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    try {
      process.stdout.write(JSON.stringify(
        discoveryErrorToResult({ message: `Scout crashed: ${error.message}` })));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
