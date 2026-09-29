/**
 * The California field-office catalogue: 187 geocoded offices, plus the ZIP
 * centroids used to turn "within 25 miles of 92064" into a set of offices.
 *
 * Both data files are generated, not hand-written — see tools/build-catalog.mjs
 * and the provenance header in catalog/ca-zip-centroids.csv.
 *
 * Two naming systems have to coexist. The public site calls an office
 * "Hollywood"; the appointment API books it as "HOLLYWOOD COLE". Twenty-five
 * offices disagree like this, so every lookup here accepts either name, plus
 * the slug and the raw publicId, and always answers with the canonical record.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { milesBetween, roundMiles, isCoordinate } from './geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Generated reference data, committed. Deliberately not `data/`, which is
// gitignored because it holds the RQP replay store — real booking references
// that must never reach a repository.
export const DATA_DIR = process.env.CADMV_DATA_DIR
  ? path.resolve(process.env.CADMV_DATA_DIR)
  : path.join(HERE, '..', 'catalog');

let cache = null;

/** Lookup key: case and punctuation are noise when a human types an office. */
export function normaliseKey(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isZip(term) {
  return /^\d{5}$/.test(String(term || '').trim());
}

function loadZips(dir) {
  const raw = readFileSync(path.join(dir, 'ca-zip-centroids.csv'), 'utf8');
  const zips = new Map();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [zip, lat, lng] = line.split(',');
    if (!zip) continue;
    zips.set(zip.trim(), { lat: Number(lat), lng: Number(lng) });
  }
  return zips;
}

export function loadCatalogue(dir = DATA_DIR) {
  if (cache && cache.dir === dir) return cache;
  const raw = JSON.parse(readFileSync(path.join(dir, 'ca-dmv-offices.json'), 'utf8'));
  const offices = raw.offices || [];
  const byKey = new Map();
  const remember = (key, office) => {
    const k = normaliseKey(key);
    // First writer wins: an office's own slug must never be shadowed by
    // another office that happens to share an alias.
    if (k && !byKey.has(k)) byKey.set(k, office);
  };
  for (const office of offices) {
    byKey.set(office.code, office);
    remember(office.slug, office);
    remember(office.name, office);
    remember(office.branch, office);
  }
  cache = {
    dir,
    generated: raw.generated,
    offices,
    partners: raw.partners || [],
    byKey,
    zips: loadZips(dir),
  };
  return cache;
}

/** Drop the cache — only the tests need this, after pointing DATA_DIR elsewhere. */
export function resetCatalogue() { cache = null; }

/** Resolve a name, slug, branch name or publicId to the canonical office. */
export function findOffice(term, dir = DATA_DIR) {
  const cat = loadCatalogue(dir);
  const raw = String(term || '').trim();
  if (!raw) return null;
  return cat.byKey.get(raw) || cat.byKey.get(normaliseKey(raw)) || null;
}

/** Offices whose ZIP matches exactly. A ZIP can host more than one. */
export function officesInZip(zip, dir = DATA_DIR) {
  return loadCatalogue(dir).offices.filter((o) => o.zip === String(zip).trim());
}

/**
 * Turn what a bidder typed into a point on the map.
 *
 * A ZIP resolves to its census centroid; anything else is treated as an office
 * name. Office ZIPs are checked against the catalogue first, because one office
 * ZIP (96162, Truckee) postdates the census file and would otherwise fail.
 */
export function resolveOrigin(term, dir = DATA_DIR) {
  const cat = loadCatalogue(dir);
  const raw = String(term || '').trim();
  if (!raw) return null;

  if (isZip(raw)) {
    const here = officesInZip(raw, dir);
    if (here.length) {
      return { kind: 'zip', label: raw, lat: here[0].lat, lng: here[0].lng, office: here[0] };
    }
    const point = cat.zips.get(raw);
    if (point) return { kind: 'zip', label: raw, lat: point.lat, lng: point.lng, office: null };
    return null;
  }

  const office = findOffice(raw, dir);
  if (office) {
    return { kind: 'office', label: office.name, lat: office.lat, lng: office.lng, office };
  }
  return null;
}

/**
 * Every office within `miles` of an origin, nearest first.
 *
 * Closed offices are excluded by default: offering someone a slot at an office
 * that has shut is worse than offering them nothing.
 */
export function officesWithin(origin, miles, { dir = DATA_DIR, includeClosed = false } = {}) {
  if (!isCoordinate(origin)) throw new Error('officesWithin needs an origin with {lat, lng}');
  const radius = Number(miles);
  if (!Number.isFinite(radius) || radius < 0) throw new Error(`Bad radius: ${miles}`);
  return loadCatalogue(dir).offices
    .filter((office) => includeClosed || office.open)
    .map((office) => ({ office, miles: roundMiles(milesBetween(origin, office)) }))
    .filter((hit) => hit.miles <= radius)
    .sort((a, b) => a.miles - b.miles || a.office.name.localeCompare(b.office.name));
}

/** The `n` closest offices regardless of radius — used to explain an empty result. */
export function nearestOffices(origin, n = 5, { dir = DATA_DIR, includeClosed = false } = {}) {
  if (!isCoordinate(origin)) throw new Error('nearestOffices needs an origin with {lat, lng}');
  return loadCatalogue(dir).offices
    .filter((office) => includeClosed || office.open)
    .map((office) => ({ office, miles: roundMiles(milesBetween(origin, office)) }))
    .sort((a, b) => a.miles - b.miles || a.office.name.localeCompare(b.office.name))
    .slice(0, n);
}

/** Distance from an origin to one office, or null if either side is unusable. */
export function distanceToOffice(origin, office) {
  if (!isCoordinate(origin) || !isCoordinate(office)) return null;
  return roundMiles(milesBetween(origin, office));
}
