#!/usr/bin/env node
/**
 * RQP/1 discovery process for the Yosemite line.
 *
 * Reads one `discovery.request` envelope on stdin, reads the availability feed
 * for the campgrounds it names, writes one `discovery.result` envelope on
 * stdout. Spawned exactly as ../../dmq/bin/rqp-scout.js is.
 *
 *   echo '<envelope>' | node bin/rqp-scout.js
 *
 * This process cannot book anything: it is handed no applicant, no card and no
 * sign-in, and it never opens a browser.
 *
 * Exit status is 0 whenever a valid envelope was produced.
 */
import { findCampground } from '../src/catalog.js';
import { campsitesFrom } from '../src/availability.js';
import { offersFor } from '../src/discover.js';
import {
  discoveryRequestToEnv,
  offersToResult,
  discoveryErrorToResult,
  discoveryResult,
  NACK_FATAL,
} from '../src/rqp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop when the app that started this sweep is gone: nobody else would read the answer. */
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
 * without touching recreation.gov. Never reachable unless RQP_MODE says so.
 *
 * Each campground offers two campsites: one open for the whole window, one
 * open only for its first night, which is enough for the matcher to have to
 * choose by length of stay as well as by campground.
 */
async function simulate(env) {
  await sleep(Number(env.RQP_SIMULATE_DELAY_MS || 0));
  const window = [env.DATE_START, env.DATE_END];
  const nights = Number(env.RGOV_NIGHTS || 1);
  const offers = [];
  const checked = [];
  for (const term of String(env.RGOV_CAMPGROUNDS || '').split(',')) {
    const campground = findCampground(term);
    if (!campground) continue;
    const all = {};
    const one = {};
    for (let d = new Date(`${window[0]}T00:00:00Z`), i = 0; i < 40; i += 1, d.setUTCDate(d.getUTCDate() + 1)) {
      const key = `${d.toISOString().slice(0, 10)}T00:00:00Z`;
      all[key] = 'Available';
      one[key] = i === 0 ? 'Available' : 'Reserved';
    }
    const month = { campsites: {
      [`${campground.id}01`]: { campsite_id: `${campground.id}01`, site: '001', loop: 'A', campsite_type: 'STANDARD NONELECTRIC', type_of_use: 'Overnight', max_num_people: 6, availabilities: all },
      [`${campground.id}02`]: { campsite_id: `${campground.id}02`, site: '002', loop: 'A', campsite_type: 'STANDARD NONELECTRIC', type_of_use: 'Overnight', max_num_people: 6, availabilities: one },
    } };
    const sites = campsitesFrom([month]);
    const made = offersFor(campground, sites, window, nights);
    offers.push(...made);
    checked.push({ office: campground.short, campground_id: campground.id, campsites: sites.length, found: made.length, error: null });
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
    process.stdout.write(JSON.stringify(discoveryResult(NACK_FATAL, `Malformed discovery request JSON: ${error.message}`)));
    return 0;
  }

  let envelope;
  try {
    const env = { ...process.env, ...discoveryRequestToEnv(request, process.env) };
    const sweep = process.env.RQP_MODE === 'simulate'
      ? await simulate(env)
      : await (await import('../src/discover.js')).discover(env, {
        log: (status, detail) => console.error(`${status} | ${detail}`),
      });
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
      process.stdout.write(JSON.stringify(discoveryErrorToResult({ message: `Scout crashed: ${error.message}` })));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
