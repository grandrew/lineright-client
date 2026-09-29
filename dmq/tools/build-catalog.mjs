#!/usr/bin/env node
/**
 * Regenerate catalog/ca-dmv-offices.json from the DMV's own public endpoints.
 *
 * Two of them, joined on publicId:
 *   /appointment/branches  231 bookable branches — the name the booking API uses
 *   /field-offices         187 state offices — the public name, plus lat/lng
 *
 * The join matters because the two disagree on 25 names: the office the site
 * calls "Hollywood" books as "HOLLYWOOD COLE". Storing only one of them means
 * either the search box or the API lookup fails, so we keep both.
 *
 * The 44 branches with no field-office record are partner counters (AAA and
 * friends). They are bookable but ungeocoded, so they are listed separately and
 * never returned by a radius search.
 *
 *   node tools/build-catalog.mjs [--out catalog/ca-dmv-offices.json]
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://www.dmv.ca.gov/portal/wp-json/dmv/v1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** "8:00 am" -> "08:00". Anything that isn't a clock time (notably "Closed")
 *  returns null, which is how a closed day is represented. */
export function parseClock(raw) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*$/i.exec(String(raw || ''));
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') hour += 12;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };

/** Only the days the office is actually open, as [open, close] in 24h. */
export function parseHours(raw) {
  const out = {};
  for (const day of DAYS) {
    const from = parseClock(raw?.[day]?.start);
    const to = parseClock(raw?.[day]?.end);
    if (from && to) out[SHORT[day]] = [from, to];
  }
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildCatalogue(branches, fieldOffices) {
  const branchById = new Map(branches.map((b) => [b.publicId, b]));
  const offices = [];
  const seen = new Set();

  for (const office of fieldOffices) {
    const meta = office.meta || {};
    const code = meta.dmv_field_office_public_id;
    const lat = num(meta.dmv_field_office_latitude);
    const lng = num(meta.dmv_field_office_longitude);
    // A record without a code can't be booked and one without coordinates
    // can't be ranged over; either way it has no business in the catalogue.
    if (!code || lat === null || lng === null) continue;
    const branch = branchById.get(code);
    seen.add(code);
    offices.push({
      code,
      slug: office.slug,
      name: (office.title?.rendered || '').trim(),
      branch: (branch?.name || office.title?.rendered || '').trim(),
      street: (meta.dmv_field_office_street || '').trim(),
      city: (meta.dmv_field_office_city || '').trim(),
      zip: (meta.dmv_field_office_zipcode || '').trim(),
      lat,
      lng,
      open: office.is_open !== false,
      hours: parseHours(meta.dmv_field_office_hours),
    });
  }

  const partners = branches
    .filter((b) => !seen.has(b.publicId))
    .map((b) => ({
      code: b.publicId,
      branch: (b.name || '').trim(),
      street: (b.addressLine1 || '').trim(),
      zip: (b.addressZip || '').trim(),
    }));

  offices.sort((a, b) => a.slug.localeCompare(b.slug));
  partners.sort((a, b) => a.branch.localeCompare(b.branch));
  return {
    source: `${BASE}/field-offices + ${BASE}/appointment/branches`,
    generated: new Date().toISOString().slice(0, 10),
    note: 'Regenerate with: node tools/build-catalog.mjs',
    offices,
    partners,
  };
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > -1
    ? path.resolve(process.argv[outFlag + 1])
    : path.join(HERE, '..', 'catalog', 'ca-dmv-offices.json');

  const [branches, fieldOffices] = await Promise.all([
    getJson(`${BASE}/appointment/branches`),
    getJson(`${BASE}/field-offices?per_page=500`),
  ]);
  const catalogue = buildCatalogue(branches, fieldOffices);
  await writeFile(out, `${JSON.stringify(catalogue, null, 1)}\n`);

  const renamed = catalogue.offices.filter((o) => o.name.toLowerCase() !== o.branch.toLowerCase());
  console.log(`${catalogue.offices.length} offices, ${catalogue.partners.length} partner branches -> ${out}`);
  console.log(`${renamed.length} offices book under a different name than they advertise`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
