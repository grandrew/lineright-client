'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  zonedMs, wallIn, schedule, due, nextReminder, coming, words, whenWords, Reminders,
} = require('../src/bookings');
const page = require('../ui/bookings');

const LA = 'America/Los_Angeles';
const at = (date, time) => zonedMs(date, time, LA);
const hhmm = (ms) => { const w = wallIn(ms, LA); return `${w.month}/${w.day} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`; };

const booking = (over = {}) => ({
  id: 7, bid_id: 2, job_id: 126, queue_name: 'Driver licence or ID card', site_name: 'California DMV',
  office_name: 'San Jose', address: '111 W Alma Avenue, San Jose 95110',
  date: '2026-10-27', time: '10:00', timezone: LA, starts_at: '2026-10-27T17:00:00Z',
  confirmation: '269303047', booked_via: 'robot', device: 'desk', status: 'booked',
  manage_url: 'https://www.dmv.ca.gov/portal/appointments/appt-edit',
  cancel_needs: ['first_name', 'last_name', 'phone'], ...over,
});

class MemoryStore {
  constructor(v = {}) { this.v = { ...v }; }
  get(k, d) { return k in this.v ? this.v[k] : d; }
  set(k, v) { this.v[k] = v; }
}

test('a wall time in the line\'s zone is the right instant, across a clock change', () => {
  assert.equal(new Date(at('2026-10-27', '10:00')).toISOString(), '2026-10-27T17:00:00.000Z');
  // Daylight saving ends on Nov 1 2026 in California: 10:00 is then UTC-8.
  assert.equal(new Date(at('2026-11-02', '10:00')).toISOString(), '2026-11-02T18:00:00.000Z');
  assert.equal(hhmm(at('2026-11-02', '10:00')), '11/2 10:00');
});

test('a day before, six hours before in working hours, and an hour before', () => {
  // 3 pm: six hours before is 9 am, inside 8 am–7 pm.
  assert.deepEqual(schedule(booking({ time: '15:00', starts_at: null })).map((r) => [r.kind, hhmm(r.at)]),
    [['day', '10/26 15:00'], ['six', '10/27 09:00'], ['hour', '10/27 14:00']]);
  // 10 am: six hours before is 4 am; 8 am is still two hours ahead, so 8 am.
  assert.deepEqual(schedule(booking()).map((r) => [r.kind, hhmm(r.at)]),
    [['day', '10/26 10:00'], ['six', '10/27 08:00'], ['hour', '10/27 09:00']]);
  // 9 am: 8 am would be an hour before, beside the last reminder: 7 pm the evening before.
  assert.deepEqual(schedule(booking({ time: '09:00', starts_at: null })).map((r) => [r.kind, hhmm(r.at)]),
    [['day', '10/26 09:00'], ['six', '10/26 19:00'], ['hour', '10/27 08:00']]);
  // 8 am: likewise.
  assert.equal(hhmm(schedule(booking({ time: '08:00', starts_at: null }))[1].at), '10/26 19:00');
  // Six hours before 2 pm is 8 am exactly: kept.
  assert.equal(hhmm(schedule(booking({ time: '14:00', starts_at: null }))[1].at), '10/27 08:00');
  assert.deepEqual(schedule(booking({ date: 'soon', time: '??', starts_at: null })), []);
});

test('the due reminder is the latest whose time came, once; the earlier ones are let go', () => {
  const b = booking();
  const fired = {};
  assert.equal(due(b, fired, at('2026-10-26', '09:59')), null, 'nothing yet');
  const day = due(b, fired, at('2026-10-26', '10:00'));
  assert.deepEqual([day.kind, day.skip], ['day', []]);
  fired['7:day'] = 1;
  assert.equal(due(b, fired, at('2026-10-26', '18:00')), null, 'given already');
  // The app was closed from the day before until 8:30 on the day: one reminder, the six-hour one.
  const late = due(b, {}, at('2026-10-27', '08:30'));
  assert.deepEqual([late.kind, late.skip], ['six', ['day']]);
  assert.equal(due(b, {}, at('2026-10-27', '10:00')), null, 'not once it has begun');
  assert.equal(due({ ...b, status: 'cancelled' }, {}, at('2026-10-27', '09:30')), null, 'not a cancelled one');
  assert.equal(nextReminder(b, { '7:day': 1 }, at('2026-10-26', '12:00')).kind, 'six');
  assert.equal(nextReminder(b, {}, at('2026-10-27', '09:30')), null);
});

test('what a reminder says', () => {
  const b = booking();
  const day = words(b, 'day', at('2026-10-26', '10:00'));
  assert.equal(day.title, 'Your appointment is tomorrow at 10:00 AM');
  assert.equal(day.body, 'Driver licence or ID card — San Jose, 111 W Alma Avenue, San Jose 95110. Confirmation 269303047.');
  assert.equal(words(b, 'six', at('2026-10-27', '08:00')).title, 'Your appointment is today at 10:00 AM');
  const hour = words(b, 'hour', at('2026-10-27', '09:00'));
  assert.equal(hour.title, 'Your appointment is in 60 minutes');
  assert.match(hour.body, /, 10:00 AM\. Confirmation 269303047\.$/);
  assert.equal(whenWords(b, at('2026-10-24', '12:00')), 'on Tue, Oct 27 at 10:00 AM');
});

test('reminders: kept, given when due with a notification and a sound, and not again', () => {
  let now = at('2026-10-26', '09:00');
  const store = new MemoryStore();
  const notes = [];
  const sounds = [];
  const changes = [];
  const r = new Reminders({ store, now: () => now, notify: (n) => notes.push(n), chime: (k) => sounds.push(k),
    onChange: (list) => changes.push(list.length) });
  r.update([booking(), booking({ id: 8, status: 'cancelled' })]);
  assert.deepEqual(changes, [1]);
  assert.equal(store.get('bookings').list.length, 2, 'kept for when the site cannot be reached');
  assert.deepEqual(r.tick(), []);
  now = at('2026-10-26', '10:00');
  assert.deepEqual(r.tick(), [{ id: 7, kind: 'day' }]);
  assert.equal(notes[0].title, 'Your appointment is tomorrow at 10:00 AM');
  assert.deepEqual(sounds, ['day']);
  assert.deepEqual(r.tick(), [], 'once');
  assert.ok(store.get('bookingReminders')['7:day']);
  // A new run of the app keeps what was given and the list.
  const again = new Reminders({ store, now: () => now, notify: (n) => notes.push(n), chime: () => {} });
  assert.equal(again.coming().length, 1);
  assert.deepEqual(again.tick(), []);
  // Cancelled here: no more.
  r.cancelled(7);
  now = at('2026-10-27', '09:00');
  assert.deepEqual(r.tick(), []);
  assert.equal(r.coming().length, 0);
  assert.equal(r.view().coming, 0);
  // Long after the appointment, what was given for it is forgotten.
  now = at('2026-11-02', '12:00');
  r.update([]);
  assert.deepEqual(store.get('bookingReminders'), {});
});

test('the coming ones are soonest first; one just begun still counts', () => {
  const a = booking({ id: 1, date: '2026-10-29', starts_at: '2026-10-29T17:00:00Z' });
  const b = booking({ id: 2 });
  const c = booking({ id: 3, date: '2026-10-20', starts_at: '2026-10-20T17:00:00Z' });
  assert.deepEqual(coming([a, b, c], Date.parse('2026-10-26T00:00:00Z')).map((x) => x.id), [2, 1]);
  assert.deepEqual(coming([b], Date.parse('2026-10-27T18:30:00Z')).map((x) => x.id), [2]);
  assert.deepEqual(coming([b], Date.parse('2026-10-27T19:30:00Z')), []);
});

test('the page: the counter, how long until, and what is over', () => {
  const now = Date.parse('2026-10-25T22:00:00Z');
  const list = [booking(), booking({ id: 8, status: 'cancelled' }),
    booking({ id: 9, date: '2026-10-20', starts_at: '2026-10-20T17:00:00Z' })];
  assert.deepEqual(page.counter(list, now), { count: 1, soon: false });
  assert.deepEqual(page.counter(list, Date.parse('2026-10-27T01:00:00Z')), { count: 1, soon: true });
  const { coming: c, rest } = page.split(list, now);
  assert.deepEqual(c.map((b) => b.id), [7]);
  assert.deepEqual(rest.map((b) => b.id).sort(), [8, 9]);
  assert.equal(page.untilWords(39 * 3600000), 'in 1 day 15 hours');
  assert.equal(page.untilWords(3 * 3600000 + 20 * 60000), 'in 3 hours 20 minutes');
  assert.equal(page.untilWords(12 * 60000), 'in 12 minutes');
  assert.equal(page.untilWords(-20 * 60000), 'started 20 minutes ago');
  assert.equal(page.timeLabel('14:05'), '2:05 PM');
  assert.equal(page.viaWords(booking()), "booked by this app's robot on desk");
  assert.equal(page.viaWords(booking({ booked_via: 'page' })), 'booked by you on the booking page');
  assert.match(page.nextWords({ next: { kind: 'day', at: now } }), /\(a day before\)$/);
  assert.equal(page.nextWords({}), '');
});
