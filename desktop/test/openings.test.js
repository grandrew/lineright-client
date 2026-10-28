'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OF = require('../ui/openings');

// 2026-10-27 19:25 in Santa Clara (PDT, UTC-7) is 2026-10-28 02:25 UTC.
const NOW = Date.UTC(2026, 9, 28, 2, 25) / 1000;
const TZ = 'America/Los_Angeles';
const H = 3600;

function item(over = {}) {
  return {
    id: 1, office: 'Santa Clara', miles: 2.3, slot: '2026-10-29 15:10', lead_h: 46.1,
    t: NOW - 2 * H, last: NOW - 2 * H + 120, missed: NOW - 2 * H + 300,
    open: false, outcome: 'gone', booked: false, fit: null, before_bid: false, sightings: 2,
    est: 210, lo: 120, hi: 300, ...over,
  };
}

function doc(over = {}) {
  const items = [item({ id: 2, t: NOW - H, outcome: 'open', open: true, est: 3600, lo: 3600, hi: null }), item()];
  return {
    kind: 'client.openings', queue_id: 7, hours: 72, ranges: [24, 72, 168, 720], step: 3 * H,
    since: NOW - 72 * H, now: NOW, timezone: TZ,
    scope: { kind: 'place', text: 'Within 5 mi of 95050', offices: 2, bid_id: null },
    stats: { openings: 9, per_day: 3, median: 240, p25: 90, p75: 600, quick: 0.56, bracketed: 7, open: 1,
      booked: 2, yours: 0, offices: 2, busiest_hour: 8, takes: null },
    trend: { before: 600, lately: 180, way: 'shorter', older: 4, newer: 5 },
    buckets: [{ t: NOW - 6 * H, n: 2, median: 200, p25: 100, p75: 300 }, { t: NOW - 3 * H, n: 1, median: 400, p25: 400, p75: 400 },
      { t: NOW, n: 0, median: null, p25: null, p75: null }],
    by_hour: new Array(24).fill(0),
    points: items.map((i) => [i.id, i.t, i.est, i.lo, i.hi, i.outcome, i.fit, 0, i.slot]),
    items, more: 0,
    offices: [{ name: 'Santa Clara', n: 2, median: 210, miles: 2.3 }],
    quick_seconds: 300, look_seconds: 120,
    ...over,
  };
}

test('what is asked: a bid, a form that has chosen offices, or the whole line', () => {
  assert.deepEqual(OF.body({ bidId: 8, fields: { origin: '95050' }, hours: 24, fitsOnly: true }), { hours: 24, bid_id: 8, fits_only: true });
  assert.deepEqual(OF.body({ fields: { office_mode: 'radius', origin: '95050', radius_miles: '5' } }),
    { hours: 72, fields: { office_mode: 'radius', origin: '95050', radius_miles: '5' } });
  assert.deepEqual(OF.body({ fields: { office_mode: '', origin: ' ' }, fitsOnly: true }), { hours: 72 },
    'nothing chosen yet is the whole line, and only a bid has openings it takes');
  assert.deepEqual(OF.body({ office: 'Santa Clara' }), { hours: 72, office: 'Santa Clara' });
  assert.equal(OF.key(7, { hours: 72, fields: { b: 1, a: 2 } }), OF.key(7, { fields: { a: 2, b: 1 }, hours: 72 }));
  assert.notEqual(OF.key(7, { hours: 72 }), OF.key(8, { hours: 72 }));
});

test('lengths of time, said and short', () => {
  assert.equal(OF.dur(20), 'under a minute');
  assert.equal(OF.dur(240), '4 min');
  assert.equal(OF.dur(2 * H + 600), '2 h 10 min');
  assert.equal(OF.dur(14 * H), '14 h');
  assert.equal(OF.dur(3 * 86400), '3 days');
  assert.equal(OF.short(45), '45s');
  assert.equal(OF.short(240), '4m');
  assert.equal(OF.short(H + 1200), '1h 20m');
  assert.equal(OF.short(2 * 86400), '2d');
});

test('how long one lasted, from what the looks say', () => {
  assert.deepEqual(OF.lasted(item()).text, 'about 4 min');
  assert.match(OF.lasted(item()).detail, /Seen for 2 min, and gone by a look 5 min after it first came/);
  assert.match(OF.lasted(item({ lo: 0, hi: 120, est: 60 })).detail, /^Seen once, and gone by a look 2 min after/);
  assert.equal(OF.lasted(item({ hi: null, lo: 0, est: 30 })).text, 'seen once');
  assert.equal(OF.lasted(item({ hi: null, lo: 600, est: 630 })).text, 'at least 10 min');
  assert.equal(OF.lasted(item({ open: true, est: 1500 })).text, 'open 25 min so far');
});

test('what became of one, and what it was to the bid', () => {
  assert.deepEqual(OF.outcome(item({ outcome: 'yours', booked: true })), { label: 'Yours · booked', tone: 'yours' });
  assert.equal(OF.outcome(item({ outcome: 'yours' })).label, 'Offered to you');
  assert.equal(OF.outcome(item({ outcome: 'booked' })).label, 'Booked via LineRight');
  assert.equal(OF.outcome(item({ outcome: 'offered' })).label, 'Offered to a bidder');
  assert.equal(OF.outcome(item({ outcome: 'open' })).label, 'Open now');
  assert.equal(OF.outcome(item()).label, 'Gone');
  assert.equal(OF.fit(item({ fit: 'takes' })), 'your bid takes it');
  assert.equal(OF.fit(item({ fit: 'takes', before_bid: true })), 'would fit · before you bid');
  assert.equal(OF.fit(item({ fit: 'later' })), 'later than your bid took then');
  assert.equal(OF.fit(item()), '');
});

test('times on the line\'s own clock, whatever this computer\'s is', () => {
  assert.equal(OF.clock(TZ, NOW), '7:25 PM');
  assert.equal(OF.offset(TZ, NOW), -7 * H);
  assert.equal(OF.day(TZ, NOW - H, NOW), 'Today');
  assert.equal(OF.day(TZ, NOW - 24 * H, NOW), 'Yesterday');
  assert.equal(OF.day(TZ, NOW - 72 * H, NOW), 'Sat, Oct 24');
  assert.equal(OF.slot('2026-10-29 15:10'), 'Thu, Oct 29 · 3:10 PM');
  assert.equal(OF.ahead(0.4), 'less than an hour ahead');
  assert.equal(OF.ahead(5.2), '5 h ahead');
  assert.equal(OF.ahead(46), '2 days ahead');
  assert.equal(OF.hourText(8), '8–9 AM');
  assert.equal(OF.hourText(11), '11 AM–12 PM');
  assert.equal(OF.hourText(12), '12–1 PM');
  assert.equal(OF.hourText(23), '11 PM–12 AM');
});

test('the numbers at the top', () => {
  const tiles = OF.tiles(doc());
  const said = Object.fromEntries(tiles.map((t) => [t.label, t]));
  assert.equal(said.openings.value, '9');
  assert.equal(said.openings.sub, 'about 3 a day');
  assert.equal(said['typically gone in'].value, '4m');
  assert.equal(said['typically gone in'].sub, 'half within 2m–10m');
  assert.equal(said['gone within 5 min'].value, '56%');
  assert.equal(said['lately, from 10m'].value, '↓ 3m');
  assert.equal(said['lately, from 10m'].sub, 'going faster');
  assert.equal(said['open now'].value, '1');
  assert.equal(said['most came'].value, '8–9 AM');
  assert.equal(said['your bid would take'], undefined, 'not for a form');
  const bid = OF.tiles(doc({ stats: { ...doc().stats, takes: 4, yours: 1 }, trend: null }));
  assert.equal(bid.find((t) => t.label === 'your bid would take').value, '4 of 9');
  assert.equal(bid.find((t) => t.label === 'your bid would take').sub, '1 went to you');
  assert.equal(bid.some((t) => t.label.startsWith('lately')), false, 'no trend, no tile');
  assert.match(OF.scopeText(doc()), /^At the 2 offices you chose · Within 5 mi of 95050$/);
  assert.equal(OF.scopeText(doc({ scope: { kind: 'bid', offices: 1, text: 'Santa Clara only' } })), "At your bid's office · Santa Clara only");
  assert.equal(OF.scopeText(doc({ scope: { kind: 'line' } })), 'At every office on this line');
});

test('the plot: a dot an opening, the median through each step, and where each dot is', () => {
  const d = doc();
  const drawn = OF.plot(d, { width: 640, focus: 2 });
  assert.equal(drawn.width, 640);
  assert.equal((drawn.svg.match(/<circle /g) || []).length, 2);
  assert.match(drawn.svg, /class="of-dot open focus" cx="[\d.]+" cy="[\d.]+" r="5.5" data-pid="2"/);
  assert.match(drawn.svg, /class="of-median" d="M[\d.]+,[\d.]+L[\d.]+,[\d.]+"/, 'the two steps with a median, joined');
  assert.match(drawn.svg, /<polygon class="of-band"/);
  assert.match(drawn.svg, /<line class="of-span gone"/, 'the gone one spans from its last sighting to the look that missed it');
  assert.doesNotMatch(OF.plot(doc({ points: [[1, NOW - H, 60, 0, 120, 'gone', null, 0, '2026-10-29 15:10']] })).svg, /of-span/,
    'one seen once is only its dot');
  assert.match(drawn.svg, /class="of-rise"/, 'the open one points up: it is still lasting');
  assert.equal(drawn.hits.length, 2);
  for (const h of drawn.hits) {
    assert.ok(h.x >= 44 && h.x <= 640 - 14, `x ${h.x}`);
    assert.ok(h.y >= 12 && h.y <= 178, `y ${h.y}`);
  }
  const older = drawn.hits.find((h) => h.id === 1);
  const newer = drawn.hits.find((h) => h.id === 2);
  assert.ok(older.x < newer.x, 'later to the right');
  assert.ok(newer.y < older.y, 'longer higher up');
  assert.match(drawn.svg, />7 PM<|>Tue 27</, 'ticks on the line\'s clock');
});

test('an empty plot says so, and the legend only names what is there', () => {
  const drawn = OF.plot(doc({ points: [], items: [], buckets: [] }), { width: 500 });
  assert.match(drawn.svg, /No openings came here in the last 3 days/);
  assert.equal(drawn.hits.length, 0);
  const legend = OF.legend(doc());
  assert.match(legend, /Open now/);
  assert.doesNotMatch(legend, /Offered to a bidder/);
  assert.match(OF.legend(doc({ points: [[1, NOW, 60, 0, null, 'gone', 'later', 0, '2026-10-29 15:10']] })), /later than your bid took/);
});

test('the list: by day, newest first, and nothing from the site is taken as markup', () => {
  const html = OF.rows(doc({ items: [item({ id: 3, office: '<img src=x onerror=alert(1)>' }), item({ id: 4, t: NOW - 30 * H })] }), { shown: 40, focus: 4 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.deepEqual([...html.matchAll(/class="of-day">([^<]+)</g)].map((m) => m[1]), ['Today', 'Yesterday']);
  assert.match(html, /class="of-row gone focus" data-pid="4"/);
  assert.match(html, /Thu, Oct 29 · 3:10 PM · 2 days ahead/);
  assert.equal((OF.rows(doc(), { shown: 1 }).match(/class="of-row/g) || []).length, 1);
  assert.match(OF.basis(doc()), /about every 2 min/);
});

test('the tooltip says where, when, how long and what became of it', () => {
  const html = OF.tip(item({ fit: 'takes' }), doc());
  assert.match(html, /Santa Clara · 2.3 mi/);
  assert.match(html, /Thu, Oct 29 · 3:10 PM/);
  assert.match(html, /Came <b>Today 5:25 PM<\/b>/);
  assert.match(html, /Lasted <b>about 4 min<\/b>/);
  assert.match(html, /<div class="of-tip-note">your bid takes it<\/div>/);
});

// ------------------------------------------------ how reading the line goes
const NOW_MS = NOW * 1000;
const iso = (s) => new Date(NOW_MS - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function watch(over = {}) {
  return {
    state: 'ok', label: 'The apps read this line lately', looked_at: iso(600), read_at: iso(600), offices: 187, read_24h: 42,
    soonest: { office: 'Redding', date: '2026-11-03', time: '09:40', seen_at: iso(3 * H) }, issue: null, advice: [],
    at: [
      { office: 'Redding', read_at: iso(3 * H), ok: true, found: 4, date: '2026-11-03', time: '09:40', error: null, miles: 12.5 },
      { office: 'Chico', read_at: iso(600), ok: true, found: 0, date: null, time: null, error: null, miles: null },
      { office: 'Arvin', read_at: iso(900), ok: false, found: 0, date: null, time: null, error: 'could not be read', miles: null },
    ],
    ...over,
  };
}

test('a line\'s reading as a chip: the soonest seen, or the trouble', () => {
  const c = OF.watchChip(watch(), NOW_MS);
  assert.equal(c.tone, 'ok');
  assert.match(c.text, /Soonest seen: Tue, Nov 3 · 9:40 AM at Redding/);
  assert.match(c.title, /Seen 3 h ago\. A time seen a while ago may be gone/);
  assert.equal(OF.watchChip(watch({ state: 'trouble', label: 'x' })).tone, 'bad');
  assert.equal(OF.watchChip(watch({ state: 'blocked', label: 'x' })).tone, 'warn');
  assert.equal(OF.watchChip(watch({ state: 'unwatched', soonest: null })).text, 'Not looked at lately');
  assert.equal(OF.watchChip(watch({ soonest: null })).text, 'Nothing open seen lately');
  assert.equal(OF.watchChip(null), null);
});

test('the soonest seen at each office, the ones that could not be read, and the trouble', () => {
  const html = OF.watchBlock(watch({ unread: 2 }), { shown: 2, nowMs: NOW_MS });
  assert.match(html, /42 of 187 offices read in 24 h · last read 10 min ago/);
  assert.match(html, /Tue, Nov 3 · 9:40 AM/);
  assert.match(html, /12\.5 mi/);
  assert.match(html, /nothing open/);
  assert.doesNotMatch(html, /Arvin/, 'two shown');
  assert.match(html, /Show all 3/);
  assert.match(html, /2 not looked at yet/);
  const trouble = OF.watchBlock(watch({ state: 'trouble', label: 'The apps\' robots cannot read this line right now',
    issue: { kind: 'failed', since: iso(2 * H), reads: 3, apps: 2, check: 'agent' },
    advice: ['Openings here may go unseen until the robots are fixed.'] }), { nowMs: NOW_MS });
  assert.match(trouble, /Since 2 h ago: 3 looks by 2 apps could read nothing\. An AI is checking the booking site now\./);
  assert.match(trouble, /<li>Openings here may go unseen/);
  assert.match(trouble, /could not be read/);
  assert.equal(OF.watchBlock(null), '');
  assert.match(OF.watchBlock(watch({ at: [] })), /No office here has been looked at yet/);
});
