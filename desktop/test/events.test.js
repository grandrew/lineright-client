'use strict';
/**
 * What happened, and the last of it that matters on the bar until closed
 * (ui/events.js), and this app's own entries: a Mac update it cannot install
 * by itself (src/appevents.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../ui/events');
const { AppEvents, needsManualUpdate, manualUpdate, KEEP_CLOSED } = require('../src/appevents');

const NOW = Date.parse('2026-11-03T18:00:00Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString();

const missed = { key: 'bid-event:41', at: at(40), kind: 'missed', tone: 'bad', significant: true,
  title: 'Your turn ran out', text: 'Santa Clara, Mon, Nov 2 at 2:30 PM. ⧗33 of ⧗46 came back.', action: 'bid_again',
  bid_id: 10, queue_id: 3, queue_name: 'Driver licence or ID card' };
const raised = { key: 'bid-event:30', at: at(60), kind: 'raised', tone: 'info', significant: false, title: 'Raised your bid to ⧗46' };
const booked = { key: 'bid-event:50', at: at(2), kind: 'fulfilled', tone: 'ok', significant: true, title: 'Booked — the appointment is yours', action: 'bookings' };

test('the bar shows the newest significant event nobody closed, then the one before it', () => {
  let pick = ev.pick([missed, raised, booked], [], [], NOW);
  assert.equal(pick.event.key, booked.key);
  assert.equal(pick.more, 1, 'the missed turn waits behind it');
  pick = ev.pick([missed, raised, booked], [], [booked.key], NOW);
  assert.equal(pick.event.key, missed.key, 'closing one shows the next: none goes by unseen');
  pick = ev.pick([missed, raised, booked], [], [booked.key, missed.key], NOW);
  assert.equal(pick.event, null, 'what is not significant is in History only');
});

test('a fortnight back at most, and once each by key, the app\'s own among the site\'s', () => {
  const old = { ...missed, key: 'bid-event:1', at: at(24 * 15) };
  assert.equal(ev.pick([old], [], [], NOW).event, null);
  const update = { ...manualUpdate({ version: '0.4.6', site: 'https://lineright.org', arch: 'arm64' }), at: at(1) };
  const pick = ev.pick([missed, missed], [update], [], NOW);
  assert.equal(pick.event.key, 'update-manual:0.4.6');
  assert.equal(pick.more, 1);
});

test('the bar says what happened, when, what to do, and closes', () => {
  const html = ev.bar(missed, 2);
  assert.match(html, /Your turn ran out/);
  assert.match(html, /⧗33 of ⧗46 came back/);
  assert.match(html, /data-ev="bid_again">Bid again</);
  assert.match(html, /data-ev="history">History</);
  assert.match(html, /data-ev="close"/);
  assert.match(html, /2 more not yet seen/);
  assert.match(html, /\w{3}, \w{3} \d{1,2} at \d{1,2}:\d{2} (AM|PM)/);
  assert.doesNotMatch(ev.bar({ ...missed, queue_id: null }, 0), /Bid again/, 'no line to go back to, no button');
  assert.doesNotMatch(ev.bar({ ...missed, title: '<img src=x>' }, 0), /<img/);
});

test('the history lists everything under its day, the newest first', () => {
  const html = ev.timeline([raised, missed, booked]);
  const order = ['Booked — the appointment is yours', 'Your turn ran out', 'Raised your bid to ⧗46'].map((t) => html.indexOf(t));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((html.match(/class="hist-day"/g) || []).length, new Set([booked, missed, raised].map((e) => ev.day(e.at))).size);
  assert.match(html, /Bid #10 · Driver licence or ID card/);
  assert.match(ev.timeline([]), /Nothing has happened yet/);
});

test('a Mac refusing an update is told how to replace the app by hand', () => {
  const said = "Code signature at URL file:///Users/x/Library/Caches/dev.regbot.desktop.ShipIt/update.i1skF2P/LineRight%20Regbot.app/ did not pass validation: code failed to satisfy specified code requirement(s)";
  assert.equal(needsManualUpdate('darwin', said), true);
  assert.equal(needsManualUpdate('win32', said), false);
  assert.equal(needsManualUpdate('darwin', 'net::ERR_INTERNET_DISCONNECTED'), false);
  const arm = manualUpdate({ version: '0.4.6', site: 'https://lineright.org', arch: 'arm64' });
  assert.equal(arm.url, 'https://lineright.org/download/mac');
  assert.equal(manualUpdate({ version: '0.4.6', site: 'https://lineright.org', arch: 'x64' }).url, 'https://lineright.org/download/mac-intel');
  assert.match(manualUpdate({ version: '0.4.6' }).url, /github\.com\/grandrew\/lineright-client\/releases/);
  assert.equal(arm.key, 'update-manual:0.4.6', 'a new version is a new note');
  assert.match(arm.text, /0\.4\.6 is out/);
  assert.equal(arm.steps.length, 4);
  assert.match(arm.steps.join(' '), /Quit .*Replace.*Open Anyway/);
  assert.match(ev.bar({ ...arm, at: at(0) }), /data-ev="download">Download 0\.4\.6</);
});

test('this app\'s entries and the closed keys are kept, each once', () => {
  const values = {};
  const store = { get: (k, d) => (k in values ? values[k] : d), set: (k, v) => { values[k] = v; } };
  let now = NOW;
  const events = new AppEvents({ store, now: () => now });
  assert.equal(events.add(manualUpdate({ version: '0.4.6' })), true);
  now += 6 * 3600000;
  assert.equal(events.add(manualUpdate({ version: '0.4.6' })), false, 'the first sight is when it happened');
  assert.equal(events.list().length, 1);
  assert.equal(events.list()[0].at, new Date(NOW).toISOString());
  events.close('update-manual:0.4.6');
  events.close('update-manual:0.4.6');
  assert.deepEqual(events.view().closed, ['update-manual:0.4.6']);
  for (let i = 0; i < KEEP_CLOSED + 5; i += 1) events.close(`k${i}`);
  assert.equal(events.closed().length, KEEP_CLOSED);
});
