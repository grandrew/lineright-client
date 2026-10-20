import { appointmentUrl, baseUrl } from './services.js';

export const APPOINTMENT_TYPE_URL = `${baseUrl()}/portal/appointments/select-appointment-type/`;

export { appointmentUrl, baseUrl };

// Real "Select" buttons on the appointment-type page. Scoping to .btn excludes
// the <title>, the screen-reader status div, the "...select one below:"
// paragraph and the "Select Language" <option>, all of which getByText('Select')
// matches. The original relied on those extras padding the match list so that
// .nth(3) landed on Automobile: true today, but any copy edit to the page
// shifts the index and silently books a different vehicle class.
export function selectButtons(page) {
  return page.locator('a.btn, button.btn, span.btn').filter({ hasText: /^select$/i });
}

async function cardTextFor(handle) {
  return handle
    .evaluate((el) => {
      const card = el.closest('.appointment-reason, article, section, li, div');
      return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
    })
    .catch(() => '');
}

/**
 * The "Select" button belonging to the card for a given vehicle type.
 * Resolves by the card's own text rather than by position.
 */
export async function vehicleSelectButton(page, vehicleType) {
  const buttons = selectButtons(page);
  const count = await buttons.count();

  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const cardText = await cardTextFor(button);
    if (new RegExp(`^${vehicleType}\\b`, 'i').test(cardText)) return button;
  }

  throw new Error(
    `Could not find a "Select" button for "${vehicleType}". ` +
      `Found ${count} Select button(s) on ${page.url()}.`
  );
}

export function locationSearchBox(page) {
  return page.locator('#inputKeyWord').first();
}

/**
 * Office result cards.
 *
 * Scoping to the results list matters: once the map has drawn, each office
 * also gets a marker popup (div.dmv-marker-popup: name, address and an
 * a.dmv-marker-popup__link "Select Location", seen 2026-10-13), so an unscoped
 * search returns two hits per office, and the map's is a link with no href in
 * a popup hidden until its pin is clicked.
 */
export function officeCards(page) {
  return page.locator('li.location-results__list-item, li.search-card');
}

export function selectLocationButtons(page) {
  return officeCards(page).getByRole('button', { name: /select location/i });
}

export async function searchOffices(page, term) {
  const box = locationSearchBox(page);
  await box.waitFor({ state: 'visible', timeout: 20000 });
  await box.fill('');
  await box.fill(term);
  await box.press('Enter');
  await page.waitForTimeout(2500);
  await officeCards(page).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
}

export async function officeCardText(card) {
  return (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

/**
 * Whether a result card is the office that was asked for.
 *
 * The catalogue name has to appear, as a phrase or as the same words in any
 * order: the branch line is sometimes the name turned around ("IBC Mountain
 * View" for "Mountain View IBC"). The first card is not good enough. A search
 * can return a nearby office that does offer the service while the one asked
 * for does not, and that card is then the only one on the page. Taking it
 * would store its calendar under the other office's name.
 */
export function officeNameMatches(term, cardText) {
  const text = String(cardText ?? '').replace(/\s+/g, ' ').trim();
  const name = String(term ?? '').replace(/\s+/g, ' ').trim();
  if (!name || !text) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return true;
  const tokens = name.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (tokens.length < 2) return false;
  return tokens.every((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

/**
 * The "Select Location" button for a given office.
 *
 * A name is matched against the card's own text. A ZIP can only be matched
 * positionally, since the ZIP searched for need not appear on the card, and
 * DMV orders results by distance so the first is the nearest.
 */
export async function officeSelectButton(page, { term, isZip }) {
  const cards = officeCards(page);
  const count = await cards.count();
  if (count === 0) throw new Error(`No offices returned for "${term}"`);

  if (isZip) {
    return cards.first().getByRole('button', { name: /select location/i }).first();
  }

  const seen = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const text = await officeCardText(card);
    seen.push(text.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (officeNameMatches(term, text)) {
      const button = card.getByRole('button', { name: /select location/i }).first();
      if (await button.count().catch(() => 0)) return button;
      throw new Error(`"${term}" is listed, but its button is not Select Location`);
    }
  }
  const sample = seen.slice(0, 3).filter(Boolean).join(' | ');
  throw new Error(
    `No office matching "${term}" in ${count} result(s)${sample ? `: ${sample}` : ''}`
  );
}

// Read the month the calendar is actually showing, so day numbers can be
// resolved against it instead of against DATE_START's month.
export async function readDisplayedMonth(page) {
  const candidates = [
    '[class*="calendar"] [class*="month"]',
    '[class*="datepicker"] [class*="month"]',
    '[aria-live] >> text=/\\b[A-Z][a-z]+ \\d{4}\\b/',
    'h2, h3, h4',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      const text = await locator.nth(i).innerText().catch(() => '');
      const match = text.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
      );
      if (match) return match[0];
    }
  }
  return null;
}

export function openTimeButtons(page) {
  return page.getByRole('button', { name: /open times/i });
}

// A confirmation number has a digit in it. The guard is what stops "Bring the
// confirmation number with you" being read as confirmation number "with".
const REFERENCE = /^[A-Z0-9][A-Z0-9-]{3,39}$/i;
const looksLikeReference = (s) => REFERENCE.test(s) && /\d/.test(s);

/**
 * The confirmation number a finished booking shows, or null.
 *
 * Nobody has seen the real DMV's confirmation page from here: every live check
 * stops before a hold (REPORT.md), and the calendar is gated anyway. So this
 * reads the two places the stand-in puts it — a `ref` on a confirmation page's
 * URL (`/portal/appointments/confirmation?ref=TS-…`), or the number printed
 * after a "Confirmation number" label — and nothing looser. A page with neither
 * is not a confirmation, and the caller treats it as unknown rather than
 * guessing. The first real booking is what will say whether DMV matches.
 */
export function parseConfirmation({ url = '', text = '' } = {}) {
  try {
    const u = new URL(url);
    const ref = (u.searchParams.get('ref') || '').trim();
    if (/confirm/i.test(u.pathname) && looksLikeReference(ref)) return ref;
  } catch {
    // no URL, or not a parseable one: fall through to the page text
  }
  const label = /\bconfirmation\s*(?:(?:number|no|code)\b\.?|#)\s*(?:is\b\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]*)/gi;
  for (const [, candidate] of String(text).matchAll(label)) {
    if (looksLikeReference(candidate)) return candidate;
  }
  return null;
}
