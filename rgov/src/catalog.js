/**
 * The Yosemite campgrounds, as Recreation.gov knows them.
 *
 * catalog/yosemite-campgrounds.json is generated (tools/build-catalog.mjs), not
 * written by hand. Every campground is found by its facility id, its slug, its
 * full name or its short one — `232447`, `upper-pines`, `Upper Pines
 * Campground`, `Upper Pines` — because a bid, a campsite page and a person each
 * say it differently, and all three have to land on the same record.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { milesBetween, isCoordinate } from './shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.RGOV_DATA_DIR
  ? path.resolve(process.env.RGOV_DATA_DIR)
  : path.join(HERE, '..', 'catalog');

const FILE = 'yosemite-campgrounds.json';

export function normaliseKey(term) {
  return String(term ?? '').trim().toLowerCase().replace(/\bcampground\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

let cache = null;

export function loadCatalogue(dir = DATA_DIR) {
  if (cache?.dir === dir) return cache;
  const file = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  const byKey = new Map();
  for (const campground of file.campgrounds) {
    for (const key of [campground.id, campground.slug, campground.name, campground.short]) {
      byKey.set(normaliseKey(key), campground);
    }
  }
  cache = { dir, park: file.park, campgrounds: file.campgrounds, byKey };
  return cache;
}

/** Test seam: forget what was read, so the next lookup reads `dir` afresh. */
export function resetCatalogue() { cache = null; }

export function allCampgrounds(dir = DATA_DIR) {
  return loadCatalogue(dir).campgrounds;
}

export function findCampground(term, dir = DATA_DIR) {
  const key = normaliseKey(term);
  if (!key) return null;
  return loadCatalogue(dir).byKey.get(key) ?? null;
}

/** The campgrounds of one kind ('family', 'walk-in', 'horse'), and of one area if given. */
export function campgroundsOfKind(kind, { area = null, dir = DATA_DIR } = {}) {
  const wanted = area ? String(area).trim().toLowerCase() : null;
  return allCampgrounds(dir).filter((c) => c.kind === kind && (!wanted || String(c.area).toLowerCase() === wanted));
}

/** The campgrounds within `miles` of `origin` ({lat, lng}), nearest first, with how far. */
export function campgroundsWithin(origin, miles, { kind = null, dir = DATA_DIR } = {}) {
  if (!isCoordinate(origin)) return [];
  return allCampgrounds(dir)
    .filter((c) => !kind || c.kind === kind)
    .map((campground) => ({ campground, miles: milesBetween(origin, campground) }))
    .filter((hit) => hit.miles <= miles)
    .sort((a, b) => a.miles - b.miles);
}
