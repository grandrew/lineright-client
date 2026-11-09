/**
 * Everything the booking robot knows about Recreation.gov's pages, in one
 * place.
 *
 * NOT YET VERIFIED AGAINST THE LIVE SITE. The availability feed is (see
 * test/live.test.js); these pages are not, because checking them means signing
 * in and putting a real campsite in a real cart, which holds it from everybody
 * else for the hold's fifteen minutes. They are written to the flow the site
 * shows a person — campsite page, order details, cart, payment, confirmation —
 * and found the way a person finds them, by role and label rather than by
 * class names, so that a re-styling does not break them. The simulator in
 * ../simulators/recreation-gov/ draws pages these selectors work on; when the
 * live site disagrees, change it here, change the simulator to match, and say
 * in the comment when it was seen.
 *
 * Every lookup searches every frame of the page, since a payment form is often
 * a frame of the payment processor's.
 */

export const campsiteUrl = (base, campsiteId) => `${base}/camping/campsites/${encodeURIComponent(campsiteId)}`;
export const cartUrl = (base) => `${base}/cart`;

/** The first visible element `make(frame)` finds in any frame of `page`, or null. */
export async function inAnyFrame(page, make, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const frame of page.frames()) {
      const found = make(frame).first();
      if (await found.isVisible().catch(() => false)) return found;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
}

async function must(page, make, what, opts) {
  const found = await inAnyFrame(page, make, opts);
  if (!found) throw new Error(`Could not find ${what} on ${new URL(page.url()).pathname}`);
  return found;
}

export const field = (page, label, what = String(label)) => must(page, (f) => f.getByLabel(label), what);
export const button = (page, name, what = String(name)) => must(page, (f) => f.getByRole('button', { name }), what);

/** 'YYYY-MM-DD' as the date inputs take it: MM/DD/YYYY. */
export function usDate(day) {
  const [y, m, d] = String(day).split('-');
  return `${m}/${d}/${y}`;
}

// ------------------------------------------------------------- the steps

export const CHECK_IN = /check.?in|arrival/i;
export const CHECK_OUT = /check.?out|departure/i;
export const BOOK = /^(book now|add to cart)$/i;
export const OCCUPANTS = /number of (occupants|people)|occupants|party size/i;
export const VEHICLES = /number of vehicles|vehicles/i;
export const EQUIPMENT = /equipment/i;
export const EQUIPMENT_LENGTH = /length/i;
export const ACKNOWLEDGE = /acknowledge|i have read|agree/i;
export const TO_CART = /proceed to cart|continue to cart|add to cart/i;
export const TO_PAYMENT = /proceed to payment|checkout|continue to payment/i;
export const PAY = /^(confirm|pay|confirm and pay|place order|complete (order|purchase))/i;

export const CARD = {
  name: /name on card|cardholder/i,
  number: /card number/i,
  expMonth: /exp(iration|iry)? ?month|^month$/i,
  expYear: /exp(iration|iry)? ?year|^year$/i,
  cvc: /security code|cvv|cvc/i,
};
// Anchored, so that "State" is not also "United States" and "Address" not
// "Email Address" — with room for the space a label leaves around its words.
export const BILLING = {
  street: /^\s*(billing )?(street )?address( line 1)?\s*$/i,
  city: /^\s*(billing )?city\s*$/i,
  state: /^\s*(billing )?state\s*$/i,
  zip: /^\s*(billing )?(zip|postal)( code)?\s*$/i,
};

/** Equipment as the order form names it, for what a bid says: 'tent', 'rv', 'trailer', 'van'. */
export const EQUIPMENT_NAMES = {
  tent: /^tent$/i,
  rv: /rv|motorhome/i,
  trailer: /trailer/i,
  van: /van|pickup camper/i,
};

// ------------------------------------------------------------- reading pages

/**
 * Whether the person is signed in. The site's header says "Log In" (or "Sign
 * Up") to somebody who is not, and their name or "My Account" to somebody who
 * is. Unsure counts as not: booking needs an account, and going on without
 * one only reaches the sign-in page with a site in nobody's cart.
 */
export async function signedIn(page) {
  const text = await page.locator('header, nav, [role="banner"]').first().innerText({ timeout: 5000 }).catch(() => '');
  if (/\blog ?in\b|\bsign ?(up|in)\b/i.test(text)) return false;
  return /my account|sign ?out|log ?out|my reservations|\bhi,/i.test(text);
}

/**
 * The reservation number the confirmation page shows. Recreation.gov's are
 * ten digits and a dash and a part number, `0123456789-1`; an order number may
 * also be shown on its own. Either is what the person can find it by.
 */
export function parseConfirmation({ url = '', text = '' } = {}) {
  const said = /reservation\s*(?:#|number|no\.?)?\s*:?\s*(\d{6,12}-\d{1,3})\b/i.exec(text)
    || /\border\s*(?:#|number|no\.?)\s*:?\s*(\d{6,14})\b/i.exec(text)
    || /\b(\d{10}-\d{1,3})\b/.exec(text);
  if (said) return said[1];
  const fromUrl = /[?&](?:reservation|order)(?:_?id|Number)?=(\d{6,14}(?:-\d{1,3})?)/i.exec(url);
  return fromUrl ? fromUrl[1] : null;
}

/** Whether the payment page says the card was refused. */
export function saysDeclined(text = '') {
  return /\b(declined|card (was|has been) (refused|rejected)|payment (failed|could not be processed)|insufficient funds)\b/i.test(text);
}

/** Whether the page says the campsite went to somebody else. */
export function saysGone(text = '') {
  return /\b(no longer available|not available for (the|your) selected dates|someone else|already (been )?reserved|sold out)\b/i.test(text);
}

/** When the cart's hold runs out, as the page says it, if it says. */
export function heldUntil(text = '') {
  // "7:14 AM" or "7:14 a.m.", without the full stop that ends the sentence.
  const clock = /\b(?:held|reserved) (?:for you )?until\s+(\d{1,2}:\d{2}\s*(?:[ap]m\b|[ap]\.m\.))/i.exec(text);
  if (clock) return clock[1];
  const left = /\b(\d{1,2}):(\d{2})\s+(?:remaining|left)\b/i.exec(text);
  if (!left) return null;
  const at = new Date(Date.now() + (Number(left[1]) * 60 + Number(left[2])) * 1000);
  return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

/**
 * A human check or a turn-away standing in the way, or null. These robots
 * stop at one and hand the page to the person; they never try to get past one
 * themselves — not with a solving service, not with a disguised browser.
 */
export async function readGate(page, step = '') {
  const url = page.url();
  const frames = page.frames().map((f) => f.url());
  const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  let kind = null;
  if (frames.some((u) => /hcaptcha\.com/i.test(u))) kind = 'hcaptcha';
  else if (frames.some((u) => /recaptcha\/(api2|enterprise)\/anchor/i.test(u))) kind = 'recaptcha';
  else if (frames.some((u) => /challenges\.cloudflare\.com/i.test(u))) kind = 'turnstile';
  else if (/queue-it\.net|\/waiting-?room/i.test(url) || /you are (now )?in (the )?(line|queue)|waiting room/i.test(text)) kind = 'waiting_room';
  else if (/access denied|request (was )?blocked|unusual (activity|traffic)/i.test(text)) kind = 'blocked';
  if (!kind) return null;
  return { kind, page_url: url, step };
}

/** Whether the page asks the person to sign in, in a dialog or as the page itself. */
export async function asksToSignIn(page) {
  if (/\/(log-?in|sign-?in)\b/i.test(page.url())) return true;
  const dialog = page.getByRole('dialog').filter({ hasText: /log ?in|sign ?in/i });
  return dialog.first().isVisible().catch(() => false);
}
