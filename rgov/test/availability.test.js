import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nightOf, addDays, nightsBetween, monthsCovering, monthUrl, campsitesFrom, openRuns, stayFits,
  nightsNeeded, fetchMonth, FeedGate, USER_AGENT,
} from '../src/availability.js';

const month = (sites) => ({ campsites: Object.fromEntries(sites.map((s) => [s.campsite_id, s])) });
const site = (id, nights, extra = {}) => ({
  campsite_id: id, site: id, loop: 'A', campsite_type: 'STANDARD NONELECTRIC', type_of_use: 'Overnight', max_num_people: 6,
  availabilities: Object.fromEntries(Object.entries(nights).map(([n, s]) => [`${n}T00:00:00Z`, s])), ...extra,
});

test('nights are calendar days, whatever the clock says', () => {
  assert.equal(nightOf('2027-03-01T00:00:00Z'), '2027-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(nightsBetween('2027-03-30', '2027-04-02'), 3);
});

test('a stay that crosses a month needs both months', () => {
  assert.deepEqual(monthsCovering('2027-06-28', '2027-07-03'), ['2027-06-01', '2027-07-01']);
  assert.deepEqual(monthsCovering('2027-12-30', '2028-01-02'), ['2027-12-01', '2028-01-01']);
  assert.deepEqual(monthsCovering('2027-06-01', '2027-06-01'), ['2027-06-01']);
  assert.deepEqual(nightsNeeded(['2027-07-01', '2027-07-03'], 2), { first: '2027-07-01', last: '2027-07-04' });
});

test('the feed is asked for the first of the month, as the site asks', () => {
  assert.equal(monthUrl('https://www.recreation.gov/', '232447', '2027-06-01'),
    'https://www.recreation.gov/api/camps/availability/campground/232447/month?start_date=2027-06-01T00%3A00%3A00.000Z');
});

test('months join into one record a campsite, and hidden or day-use sites drop out', () => {
  const sites = campsitesFrom([
    month([site('1', { '2027-06-30': 'Available' }), site('2', { '2027-06-30': 'Available' }, { hide_external: true }),
      site('3', { '2027-06-30': 'Available' }, { type_of_use: 'Day' })]),
    month([site('1', { '2027-07-01': 'Reserved' })]),
  ]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].nights.get('2027-06-30'), 'Available');
  assert.equal(sites[0].nights.get('2027-07-01'), 'Reserved');
});

test('open runs are the stretches of Available nights, and only Available counts', () => {
  const [s] = campsitesFrom([month([site('1', {
    '2027-06-01': 'Available', '2027-06-02': 'Available', '2027-06-03': 'Reserved',
    '2027-06-04': 'NYR', '2027-06-05': 'Open', '2027-06-06': 'Available',
  })])]);
  assert.deepEqual(openRuns(s, '2027-06-01', '2027-06-06'), [
    { first_night: '2027-06-01', last_night: '2027-06-02', nights: 2 },
    { first_night: '2027-06-06', last_night: '2027-06-06', nights: 1 },
  ]);
  assert.equal(stayFits(s, '2027-06-01', 2), true);
  assert.equal(stayFits(s, '2027-06-02', 2), false);
});

test('a campsite booked by the place is open only while places are left', () => {
  const [s] = campsitesFrom([month([site('1', { '2027-06-01': 'Available', '2027-06-02': 'Available' },
    { quantities: { '2027-06-01T00:00:00Z': 3, '2027-06-02T00:00:00Z': 0 } })])]);
  assert.equal(stayFits(s, '2027-06-01', 1), true);
  assert.equal(stayFits(s, '2027-06-02', 1), false);
});

const fakeFetch = (status, body, type = 'application/json') => async (url, init) => {
  fakeFetch.last = { url, init };
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type, 'retry-after': '30' } });
};

test('the feed is asked honestly: an Accept header and a user agent that says who is asking', async () => {
  await fetchMonth('http://feed', '232447', '2027-06-01', { fetchImpl: fakeFetch(200, { campsites: {} }) });
  assert.equal(fakeFetch.last.init.headers['user-agent'], USER_AGENT);
  assert.match(USER_AGENT, /lineright\.org/);
});

test('slow down, or turned away, is a gate and not an error to retry', async () => {
  await assert.rejects(fetchMonth('http://feed', '232447', '2027-06-01', { fetchImpl: fakeFetch(429, '{}') }),
    (e) => e instanceof FeedGate && e.gate.kind === 'rate_limited' && e.gate.extra.retry_after === '30');
  await assert.rejects(fetchMonth('http://feed', '232447', '2027-06-01', { fetchImpl: fakeFetch(200, '<html>', 'text/html') }),
    (e) => e instanceof FeedGate && e.gate.kind === 'blocked');
  await assert.rejects(fetchMonth('http://feed', '232447', '2027-06-01', { fetchImpl: fakeFetch(503, '{}') }),
    (e) => !(e instanceof FeedGate) && /HTTP 503/.test(e.message));
});
