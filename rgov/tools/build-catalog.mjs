#!/usr/bin/env node
/**
 * Regenerate catalog/yosemite-campgrounds.json from Recreation.gov's own public
 * search, which is what the campground page's search box asks.
 *
 *   /api/search?q=Yosemite National Park&fq=entity_type:campground
 *
 * answers with the park's campgrounds and, around it, the national forests'
 * ones nearby. Only the park's are kept: a Yosemite line is for the campgrounds
 * the National Park Service runs inside the park, and a Stanislaus National
 * Forest site twenty miles out is somebody else's line.
 *
 * The facility id is the one the availability feed, the campground page and
 * the campsite pages all use, so it is the key everything else is joined on.
 *
 *   node tools/build-catalog.mjs [--from saved-search.json] [--out catalog/yosemite-campgrounds.json]
 *
 * `--from` reads a search answer saved earlier instead of asking the site again.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEARCH = 'https://www.recreation.gov/api/search?q=Yosemite%20National%20Park&fq=entity_type%3Acampground&size=100';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARK = 'Yosemite National Park';

/**
 * Where in the park each campground is. Not in the feed, and it is what people
 * choose by: "anywhere in the Valley" is a constraint, "within 12 miles of
 * 37.74,-119.57" is the same thing said worse. Keyed on the facility id.
 */
const AREAS = {
  232447: 'Yosemite Valley',     // Upper Pines
  232450: 'Yosemite Valley',     // Lower Pines
  232449: 'Yosemite Valley',     // North Pines
  10004152: 'Yosemite Valley',   // Camp 4
  232446: 'Wawona',
  10220609: 'Wawona',            // Wawona Horse Campsites
  232451: 'Big Oak Flat Road',   // Hodgdon Meadow
  232452: 'Big Oak Flat Road',   // Crane Flat
  232453: 'Glacier Point Road',  // Bridalveil Creek
  10390880: 'Glacier Point Road',// Bridalveil Creek Horse Campsites
  10083845: 'Tioga Road',        // Tamarack Flat
  10083567: 'Tioga Road',        // White Wolf
  10083840: 'Tioga Road',        // Yosemite Creek
  10083831: 'Tioga Road',        // Porcupine Flat
  232448: 'Tioga Road',          // Tuolumne Meadows
  10346420: 'Tioga Road',        // Tuolumne Horse Campsites
};

/** 'Upper Pines Campground' -> 'upper-pines'. */
export function slugFor(name) {
  return String(name).toLowerCase().replace(/\bcampground\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Which kind of line a campground belongs to. Camp 4 is its own: a walk-in
 * campground booked by the person a week ahead, not a family site five months
 * out. Horse sites are for people bringing stock, and nobody else may take one.
 */
export function kindFor(name) {
  if (/^camp 4$/i.test(String(name).trim())) return 'walk-in';
  if (/\bhorse\b/i.test(name)) return 'horse';
  return 'family';
}

export function toCampground(hit) {
  const id = String(hit.entity_id);
  const name = String(hit.name).trim();
  return {
    id,
    slug: slugFor(name),
    name,
    short: name.replace(/\s+Campground$/i, ''),
    kind: kindFor(name),
    area: AREAS[id] ?? null,
    lat: Number(Number(hit.latitude).toFixed(6)),
    lng: Number(Number(hit.longitude).toFixed(6)),
    campsites: Number(hit.campsites_count) || null,
    has_lottery: Boolean(hit.has_lottery),
    time_zone: hit.time_zone || 'America/Los_Angeles',
  };
}

export function campgroundsFrom(search) {
  return (search.results ?? [])
    .filter((hit) => hit.parent_name === PARK && hit.entity_type === 'campground' && hit.reservable)
    .map(toCampground)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const from = arg('--from');
  const out = path.resolve(arg('--out') ?? path.join(HERE, '..', 'catalog', 'yosemite-campgrounds.json'));
  let search;
  if (from) {
    search = JSON.parse(await readFile(from, 'utf8'));
  } else {
    const res = await fetch(SEARCH, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${SEARCH} -> HTTP ${res.status}`);
    search = await res.json();
  }
  const campgrounds = campgroundsFrom(search);
  const unplaced = campgrounds.filter((c) => !c.area).map((c) => c.name);
  if (unplaced.length) console.warn(`No area known for: ${unplaced.join(', ')} — add them to AREAS.`);
  const file = {
    park: PARK,
    source: 'https://www.recreation.gov/api/search (entity_type:campground)',
    generated_at: new Date().toISOString().slice(0, 10),
    campgrounds,
  };
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${campgrounds.length} campgrounds -> ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
