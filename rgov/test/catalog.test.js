import test from 'node:test';
import assert from 'node:assert/strict';
import { findCampground, allCampgrounds, campgroundsOfKind, campgroundsWithin } from '../src/catalog.js';
import { slugFor, kindFor, campgroundsFrom } from '../tools/build-catalog.mjs';

test('a campground is found by id, slug, full name or short name', () => {
  for (const term of ['232447', 'upper-pines', 'Upper Pines Campground', 'upper pines', ' UPPER PINES ']) {
    assert.equal(findCampground(term)?.id, '232447', term);
  }
  assert.equal(findCampground('Camp 4')?.id, '10004152');
  assert.equal(findCampground('Pines'), null);
  assert.equal(findCampground(''), null);
});

test('the catalogue is the park only, every campground placed in an area', () => {
  const all = allCampgrounds();
  assert.ok(all.length >= 13, `only ${all.length} campgrounds`);
  for (const c of all) {
    assert.ok(c.area, `${c.name} has no area`);
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lng), `${c.name} has no coordinates`);
  }
  assert.ok(!all.some((c) => /stanislaus|sierra|inyo/i.test(c.name)));
});

test('kinds keep lines apart: Camp 4 is walk-in, horse sites are horse', () => {
  assert.equal(findCampground('Camp 4').kind, 'walk-in');
  assert.equal(findCampground('Wawona Horse Campsites').kind, 'horse');
  assert.equal(findCampground('North Pines').kind, 'family');
  const valley = campgroundsOfKind('family', { area: 'Yosemite Valley' }).map((c) => c.short).sort();
  assert.deepEqual(valley, ['Lower Pines', 'North Pines', 'Upper Pines']);
});

test('within so many miles is a distance, nearest first', () => {
  const hits = campgroundsWithin({ lat: 37.7397, lng: -119.5737 }, 3, { kind: 'family' }); // Yosemite Village
  assert.deepEqual(hits.map((h) => h.campground.short).sort(), ['Lower Pines', 'North Pines', 'Upper Pines']);
  assert.ok(hits[0].miles <= hits.at(-1).miles);
  assert.deepEqual(campgroundsWithin({ lat: 'x', lng: 1 }, 10), []);
});

test('the builder keeps the park and names things the way the catalogue does', () => {
  assert.equal(slugFor('Upper Pines Campground'), 'upper-pines');
  assert.equal(kindFor('Camp 4'), 'walk-in');
  assert.equal(kindFor('Tuolumne Horse Campsites'), 'horse');
  const kept = campgroundsFrom({ results: [
    { entity_id: '232447', name: 'Upper Pines Campground', parent_name: 'Yosemite National Park', entity_type: 'campground', reservable: true, latitude: '37.7', longitude: '-119.5' },
    { entity_id: '233772', name: 'DIMOND O', parent_name: 'Stanislaus National Forest', entity_type: 'campground', reservable: true, latitude: '37.8', longitude: '-119.8' },
  ] });
  assert.deepEqual(kept.map((c) => c.id), ['232447']);
});
