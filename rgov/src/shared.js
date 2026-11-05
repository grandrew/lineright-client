/**
 * What these robots share with the DMV ones beside them (../../dmq).
 *
 * The replay store, the overseer's channel, the trace and the run log are not
 * about the DMV at all: they are how any robot of this app books once, hands a
 * stuck page over, and writes down what it did with the person taken out. So
 * they are used from there rather than copied, and a fix to one is a fix to
 * both. The same goes for Playwright and the Chromium it drives: the installer
 * stages them once, under dmq (desktop/scripts/bundle.js), and these robots run
 * beside it, in a checkout and in an installed app alike.
 */
import { createRequire } from 'module';

export { BookingStore, processAlive } from '../../dmq/src/idempotency.js';
export { controlChannel, overseeHere, sameSite } from '../../dmq/src/control.js';
export { instrument, redact, redactUrl } from '../../dmq/src/instrument.js';
export { makeRunLogger } from '../../dmq/src/runlog.js';
export { milesBetween, isCoordinate, roundMiles } from '../../dmq/src/geo.js';

/** Playwright, as dmq has it. Loaded only when a browser is wanted: a scout never needs one. */
export function playwright() {
  return createRequire(new URL('../../dmq/package.json', import.meta.url))('playwright');
}
