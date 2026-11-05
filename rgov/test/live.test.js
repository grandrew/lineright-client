/**
 * Read-only checks against recreation.gov's public availability feed: that it
 * still answers this robot's honest user agent, and still has the shape the
 * scout reads. A handful of requests, no sign-in, no cart, nothing held. Run
 * it sparingly (`npm run test:live`): it is a public service, and every
 * campsite on it is somebody's holiday.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMonth, campsitesFrom, AVAILABLE } from '../src/availability.js';
import { DEFAULT_BASE_URL } from '../src/config.js';

const skip = process.env.LIVE === '1' ? false : 'set LIVE=1 to read recreation.gov';
const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

test('Upper Pines: the feed answers, with campsites and a status for every night', { skip }, async () => {
  const month = await fetchMonth(DEFAULT_BASE_URL, '232447', nextMonth());
  const sites = campsitesFrom([month]);
  assert.ok(sites.length > 100, `only ${sites.length} campsites`);
  const statuses = new Set(sites.flatMap((s) => [...s.nights.values()]));
  assert.ok(statuses.size > 0);
  for (const s of statuses) assert.match(s, /^[A-Z][A-Za-z ]+$|^NYR$/, `unexpected status ${s}`);
  assert.ok([...statuses].every((s) => typeof s === 'string'));
  assert.equal(AVAILABLE, 'Available');
});

test('Camp 4: one walk-in campsite, booked by the place', { skip }, async () => {
  const sites = campsitesFrom([await fetchMonth(DEFAULT_BASE_URL, '10004152', nextMonth())]);
  assert.ok(sites.length >= 1);
  assert.match(sites[0].campsite_type, /TENT|WALK/i);
});
