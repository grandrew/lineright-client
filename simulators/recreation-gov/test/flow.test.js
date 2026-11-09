/**
 * The stand-in on its own, over HTTP, no browser: the feed answers in the
 * shape the scout reads, and the booking flow — campsite, order details, cart,
 * payment, confirmation — holds and sells a campsite once, and each hard case
 * happens on demand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStandin, addCampsite, SESSION, DECLINED_CARD } from '../standin.mjs';

const COOKIE = `${SESSION.name}=${SESSION.value}`;

async function standin(t, mode = null) {
  const site = await startStandin();
  t.after(() => site.close());
  addCampsite(site.state, { id: '100', site: '044', open: ['2027-06-30', '2027-07-01'] });
  site.state.mode = mode;
  return site;
}

const post = (site, path, form, cookie = COOKIE) => fetch(`${site.url}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(form).toString(),
});

/** The flow as a person goes through it, to the pay button; the hold id it got. */
async function toPayment(site, { checkin = '06/30/2027', checkout = '07/02/2027' } = {}) {
  const details = await (await post(site, '/camping/reservations/orderdetails', { campsite: '100', checkin, checkout })).text();
  const hold = /name="hold" value="(\d+)"/.exec(details)?.[1];
  if (!hold) return { details };
  await post(site, '/cart', { hold, occupants: '4', vehicles: '1', equipment: 'Tent', ack: '1' });
  await post(site, '/checkout', { hold });
  return { hold, details };
}

test('the feed answers month by month, in the shape the scout reads', async (t) => {
  const site = await standin(t);
  const june = await (await fetch(`${site.url}/api/camps/availability/campground/232447/month?start_date=2027-06-01T00%3A00%3A00.000Z`)).json();
  assert.deepEqual(june.campsites['100'].availabilities, { '2027-06-30T00:00:00Z': 'Available' });
  assert.equal(june.campsites['100'].type_of_use, 'Overnight');
  const july = await (await fetch(`${site.url}/api/camps/availability/campground/232447/month?start_date=2027-07-01T00%3A00%3A00.000Z`)).json();
  assert.deepEqual(Object.keys(july.campsites['100'].availabilities), ['2027-07-01T00:00:00Z']);
  const elsewhere = await (await fetch(`${site.url}/api/camps/availability/campground/232450/month?start_date=2027-06-01T00%3A00%3A00.000Z`)).json();
  assert.deepEqual(elsewhere.campsites, {});
});

test('every page says it is a stand-in', async (t) => {
  const site = await standin(t);
  const html = await (await fetch(`${site.url}/camping/campsites/100`)).text();
  assert.match(html, /This is a stand-in/);
  assert.match(html, /<title>[^<]*\(stand-in\)<\/title>/);
});

test('a campsite is held at the order step and sold once', async (t) => {
  const site = await standin(t);
  const { hold } = await toPayment(site);
  assert.ok(hold);
  assert.equal(site.state.campsites['100'].nights['2027-06-30'], 'Reserved', 'in a cart, it is nobody else\'s');
  const paid = await post(site, '/checkout/pay', { hold, card_number: '4242424242424242', zip: '93701' });
  assert.equal(paid.status, 302);
  assert.match(paid.headers.get('location'), /\/checkout\/confirmation\?reservation=1234567890-1$/);
  assert.equal(site.state.orders.length, 1);
  const again = await toPayment(site);
  assert.match(again.details, /no longer available/);
});

test('signed out, the order step sends the person to sign in', async (t) => {
  const site = await standin(t);
  const res = await post(site, '/camping/reservations/orderdetails', { campsite: '100', checkin: '06/30/2027', checkout: '07/02/2027' }, null);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/log-in');
  const signin = await fetch(`${site.url}/__signin`, { redirect: 'manual' });
  assert.match(signin.headers.get('set-cookie'), new RegExp(`^${COOKIE};`));
});

test('the hard cases, on demand: declined, silent, gone at the cart, a waiting room, rate limited', async (t) => {
  const site = await standin(t);
  const { hold } = await toPayment(site);
  const declined = await (await post(site, '/checkout/pay', { hold, card_number: DECLINED_CARD })).text();
  assert.match(declined, /declined/);
  assert.equal(site.state.orders.length, 0);
  site.state.mode = 'silent';
  const silent = await (await post(site, '/checkout/pay', { hold, card_number: '4242424242424242' })).text();
  assert.doesNotMatch(silent, /Reservation #/);
  assert.equal(site.state.orders.length, 1, 'the order went, with no number shown');
  site.state.mode = 'gone-at-cart';
  addCampsite(site.state, { id: '100', site: '044', open: ['2027-06-30', '2027-07-01'] });
  assert.match((await toPayment(site)).details, /no longer available/);
  site.state.mode = 'waiting-room';
  const queued = await fetch(`${site.url}/camping/campsites/100`, { redirect: 'manual' });
  assert.equal(queued.headers.get('location'), '/waiting-room');
  site.state.mode = 'rate-limited';
  const limited = await fetch(`${site.url}/api/camps/availability/campground/232447/month?start_date=2027-06-01T00%3A00%3A00.000Z`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
