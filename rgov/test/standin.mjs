/**
 * A stand-in of Recreation.gov, on loopback, for the booking robot's flow to
 * be driven end to end — feed, campsite page, order details, cart, payment,
 * confirmation — without touching recreation.gov, holding anybody's campsite
 * or charging anybody's card.
 *
 * It is not a copy of the site. It draws the pages the robot's selectors
 * (src/selectors.js) expect, which are what the site shows a person; when the
 * live site turns out to differ, both change together. What it does model is
 * what the robot has to get right: a campsite that goes between the feed and
 * the cart, a person who is not signed in, a waiting room, a card that is
 * declined, an order that never confirms, and an order placed twice.
 *
 *   const site = await startStandin();   // { url, state, close() }
 *   site.state.mode = 'decline' | 'silent' | 'waiting-room' | 'gone-at-cart' | null
 *
 * A signed-in person carries the cookie `rgov_session=ok`.
 */
import http from 'node:http';

export const SESSION = { name: 'rgov_session', value: 'ok' };
export const DECLINED_CARD = '4000000000000002';

function page(title, body, { signedIn = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<header><a href="/">Recreation.gov</a> ${signedIn ? '<a href="/account">My Account</a>' : '<a href="/log-in">Log In</a>'}</header>
<main>${body}</main></body></html>`;
}

const options = (values, selected) => values.map((v) => `<option${String(v) === String(selected) ? ' selected' : ''}>${v}</option>`).join('');

function readForm(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(buf))));
  });
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const fromUs = (us) => { const [m, d, y] = String(us).split('/'); return `${y}-${m}-${d}`; };

/**
 * campsites: { [campsite_id]: { facility, site, loop, max, nights: { 'YYYY-MM-DD': status } } }
 */
export function freshState() {
  return {
    mode: null,
    campsites: {},
    holds: [],      // what went in a cart
    orders: [],     // what was paid for: { reservation, campsite_id, arrival, nights, occupants, equipment }
    requests: [],   // every path asked for, for tests to count
    seq: 0,
  };
}

export async function startStandin({ state = freshState() } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://standin');
    state.requests.push(`${req.method} ${url.pathname}`);
    const signedIn = String(req.headers.cookie || '').includes(`${SESSION.name}=${SESSION.value}`);
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };

    if (state.mode === 'waiting-room' && !url.pathname.startsWith('/api/') && url.pathname !== '/waiting-room') {
      return send(302, '', { location: '/waiting-room' });
    }
    if (url.pathname === '/waiting-room') {
      return send(200, page('Waiting room', '<h1>You are now in line</h1><p>Please wait for your turn.</p>', { signedIn }));
    }

    // The availability feed.
    const feed = /^\/api\/camps\/availability\/campground\/(\d+)\/month$/.exec(url.pathname);
    if (feed) {
      if (state.mode === 'rate-limited') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        return res.end('{"error":"too many requests"}');
      }
      const month = String(url.searchParams.get('start_date') || '').slice(0, 7);
      const campsites = {};
      for (const [id, c] of Object.entries(state.campsites)) {
        if (c.facility !== feed[1]) continue;
        const availabilities = {};
        for (const [night, status] of Object.entries(c.nights)) {
          if (night.startsWith(month)) availabilities[`${night}T00:00:00Z`] = status;
        }
        campsites[id] = { campsite_id: id, site: c.site, loop: c.loop, campsite_type: 'STANDARD NONELECTRIC',
          type_of_use: 'Overnight', max_num_people: c.max, min_num_people: 1, availabilities };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ campsites, count: Object.keys(campsites).length }));
    }

    if (url.pathname === '/log-in') {
      return send(200, page('Log In', '<h1>Log In</h1><label>Email <input name="email"></label>', { signedIn }));
    }

    // A campsite page: choose the nights, book.
    const campsite = /^\/camping\/campsites\/(\d+)$/.exec(url.pathname);
    if (campsite && req.method === 'GET') {
      const c = state.campsites[campsite[1]];
      if (!c) return send(404, page('Not found', '<h1>No such campsite</h1>', { signedIn }));
      return send(200, page(`Site ${c.site}`, `<h1>Site ${c.site}, Loop ${c.loop}</h1>
<form method="post" action="/camping/reservations/orderdetails">
  <input type="hidden" name="campsite" value="${campsite[1]}">
  <label>Check In <input name="checkin" placeholder="MM/DD/YYYY"></label>
  <label>Check Out <input name="checkout" placeholder="MM/DD/YYYY"></label>
  <button type="submit">Book Now</button>
</form>`, { signedIn }));
    }

    if (url.pathname === '/camping/reservations/orderdetails' && req.method === 'POST') {
      if (!signedIn) return send(302, '', { location: '/log-in' });
      const form = await readForm(req);
      const c = state.campsites[form.campsite];
      const arrival = fromUs(form.checkin);
      const departure = fromUs(form.checkout);
      const nights = [];
      for (let n = arrival; n < departure; n = addDays(n, 1)) nights.push(n);
      const open = c && nights.length && nights.every((n) => c.nights[n] === 'Available');
      if (!open || state.mode === 'gone-at-cart') {
        return send(200, page('Unavailable', '<p role="alert">This site is no longer available for your selected dates.</p>', { signedIn }));
      }
      for (const n of nights) c.nights[n] = 'Reserved'; // in a cart: nobody else can have it now
      const hold = { id: ++state.seq, campsite_id: form.campsite, arrival, nights: nights.length };
      state.holds.push(hold);
      return send(200, page('Order Details', `<h1>Order Details</h1>
<form method="post" action="/cart">
  <input type="hidden" name="hold" value="${hold.id}">
  <label>Number of Occupants <select name="occupants">${options([1, 2, 3, 4, 5, 6], 1)}</select></label>
  <label>Number of Vehicles <select name="vehicles">${options([0, 1, 2], 1)}</select></label>
  <label>Equipment <select name="equipment">${options(['Tent', 'RV/Motorhome', 'Trailer'], 'Tent')}</select></label>
  <label><input type="checkbox" name="ack" value="1"> I acknowledge the campground rules</label>
  <button type="submit">Proceed to Cart</button>
</form>`, { signedIn }));
    }

    if (url.pathname === '/cart' && req.method === 'POST') {
      const form = await readForm(req);
      const hold = state.holds.find((h) => String(h.id) === form.hold);
      if (!hold || form.ack !== '1') {
        return send(200, page('Order Details', '<p role="alert">Please acknowledge the campground rules.</p>', { signedIn }));
      }
      Object.assign(hold, { occupants: Number(form.occupants), vehicles: Number(form.vehicles), equipment: form.equipment });
      return send(200, page('Cart', `<h1>Cart</h1><p>Site held for you until 7:14 AM.</p>
<form method="post" action="/checkout"><input type="hidden" name="hold" value="${hold.id}">
<button type="submit">Proceed to Payment</button></form>`, { signedIn }));
    }

    if (url.pathname === '/cart' && req.method === 'GET') {
      return send(200, page('Cart', '<h1>Cart</h1>', { signedIn }));
    }

    if (url.pathname === '/checkout' && req.method === 'POST') {
      const form = await readForm(req);
      return send(200, page('Payment', `<h1>Payment</h1>
<form method="post" action="/checkout/pay"><input type="hidden" name="hold" value="${form.hold}">
  <label>Name on Card <input name="card_name"></label>
  <label>Card Number <input name="card_number"></label>
  <label>Expiration Month <select name="exp_month">${options(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])}</select></label>
  <label>Expiration Year <select name="exp_year">${options([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035])}</select></label>
  <label>Security Code <input name="cvc"></label>
  <label>Street Address <input name="street"></label>
  <label>City <input name="city"></label>
  <label>State <input name="state"></label>
  <label>ZIP Code <input name="zip"></label>
  <button type="submit">Confirm and Pay</button>
</form>`, { signedIn }));
    }

    if (url.pathname === '/checkout/pay' && req.method === 'POST') {
      const form = await readForm(req);
      const hold = state.holds.find((h) => String(h.id) === form.hold);
      if (form.card_number === DECLINED_CARD || state.mode === 'decline') {
        return send(200, page('Payment', '<p role="alert">Your card was declined. Please try another card.</p>', { signedIn }));
      }
      const order = { reservation: `${String(1234567890 + state.orders.length)}-1`, campsite_id: hold?.campsite_id,
        arrival: hold?.arrival, nights: hold?.nights, occupants: hold?.occupants, equipment: hold?.equipment,
        billing_zip: form.zip };
      state.orders.push(order);
      if (state.mode === 'silent') return send(200, page('Processing', '<p>We are processing your order.</p>', { signedIn }));
      return send(302, '', { location: `/checkout/confirmation?reservation=${order.reservation}` });
    }

    if (url.pathname === '/checkout/confirmation') {
      const reservation = url.searchParams.get('reservation');
      return send(200, page('Confirmed', `<h1>Thank you!</h1><p>Reservation # ${reservation}</p>`, { signedIn }));
    }

    return send(404, page('Not found', '<h1>Not found</h1>', { signedIn }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Put a campsite in the stand-in: open (`Available`) on the nights given, reserved on the rest of its month. */
export function addCampsite(state, { id, facility = '232447', site = '044', loop = 'Upper Pines', max = 6, open = [] }) {
  const nights = {};
  for (const night of open) nights[night] = 'Available';
  state.campsites[id] = { facility, site, loop, max, nights };
  return state.campsites[id];
}
