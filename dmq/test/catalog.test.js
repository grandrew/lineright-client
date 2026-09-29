import test from 'node:test';
import assert from 'node:assert/strict';
import { milesBetween, roundMiles, isCoordinate } from '../src/geo.js';
import {
  loadCatalogue, findOffice, resolveOrigin, officesWithin, nearestOffices,
  officesInZip, normaliseKey, isZip,
} from '../src/catalog.js';

test('the catalogue covers every geocoded California field office', () => {
  const cat = loadCatalogue();
  assert.equal(cat.offices.length, 187);
  for (const office of cat.offices) {
    assert.ok(office.code, `${office.name} has no booking code`);
    assert.ok(isCoordinate(office), `${office.name} is not geocoded`);
  }
  // The partner counters (AAA and friends) are bookable but ungeocoded, so they
  // are catalogued separately and never returned by a radius search.
  assert.ok(cat.partners.length > 0);
});

test('an office is findable by every name it goes by', () => {
  // The public site says "Hollywood"; the appointment API says "HOLLYWOOD COLE".
  // Twenty-five offices disagree like this, and a lookup that knew only one of
  // them would break either the search box or the booking call.
  const office = findOffice('Hollywood');
  assert.equal(office.branch, 'HOLLYWOOD COLE');
  assert.equal(findOffice('HOLLYWOOD COLE').code, office.code);
  assert.equal(findOffice('hollywood').code, office.code);
  assert.equal(findOffice(office.slug).code, office.code);
  assert.equal(findOffice(office.code).code, office.code);
});

test('lookup ignores case and punctuation', () => {
  assert.equal(normaliseKey('  San   Diego-Clairemont '), 'san diego clairemont');
  assert.equal(findOffice('fresno-cdtc').branch, 'FRESNO CDTC');
});

test('an unknown office resolves to nothing rather than to something close', () => {
  assert.equal(findOffice('Atlantis'), null);
  assert.equal(findOffice(''), null);
  assert.equal(findOffice(null), null);
});

test('a ZIP resolves to a point on the map', () => {
  assert.ok(isZip('92064'));
  assert.ok(!isZip('9206'));
  const origin = resolveOrigin('92064');
  assert.equal(origin.kind, 'zip');
  assert.ok(isCoordinate(origin));
});

test('an office ZIP resolves through the office, not the census file', () => {
  // 96162 (Truckee) postdates the 2020 gazetteer. Consulting the catalogue
  // first is what stops that one office being unreachable by its own ZIP.
  const office = officesInZip('96162');
  assert.equal(office.length, 1);
  const origin = resolveOrigin('96162');
  assert.equal(origin.lat, office[0].lat);
  assert.equal(origin.office.name, office[0].name);
});

test('an unplaceable origin is null, never a guess', () => {
  assert.equal(resolveOrigin('00000'), null);
  assert.equal(resolveOrigin('Narnia'), null);
  assert.equal(resolveOrigin(''), null);
});

test('officesWithin returns everything in range, nearest first', () => {
  const origin = resolveOrigin('92064');
  const hits = officesWithin(origin, 25);
  assert.ok(hits.length >= 5);
  assert.equal(hits[0].office.name, 'Poway');   // the origin's own office
  assert.equal(hits[0].miles, 0);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].miles >= hits[i - 1].miles, 'not sorted by distance');
    assert.ok(hits[i].miles <= 25, 'returned an office outside the radius');
  }
});

test('a wider radius can only ever add offices', () => {
  const origin = resolveOrigin('92064');
  const near = officesWithin(origin, 15).map((h) => h.office.code);
  const far = officesWithin(origin, 40).map((h) => h.office.code);
  for (const code of near) assert.ok(far.includes(code));
  assert.ok(far.length >= near.length);
});

test('a radius of zero finds only offices at the exact point', () => {
  const origin = resolveOrigin('92064');
  const hits = officesWithin(origin, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].office.name, 'Poway');
});

test('officesWithin refuses an origin it cannot place', () => {
  assert.throws(() => officesWithin(null, 25), /origin/);
  assert.throws(() => officesWithin({ lat: 33, lng: -117 }, -1), /radius/i);
});

test('closed offices are never offered', () => {
  const cat = loadCatalogue();
  const closed = cat.offices.filter((o) => !o.open);
  if (!closed.length) return;                       // nothing shut today
  const at = { lat: closed[0].lat, lng: closed[0].lng };
  assert.ok(!officesWithin(at, 1).some((h) => h.office.code === closed[0].code));
  assert.ok(officesWithin(at, 1, { includeClosed: true }).some((h) => h.office.code === closed[0].code));
});

test('nearestOffices explains an empty radius result', () => {
  // The most remote corner of the state: the useful answer is not "none" but
  // "the nearest is this far away", which is what a bidder needs to act on.
  const middleOfNowhere = { lat: 36.0, lng: -117.5 };
  assert.equal(officesWithin(middleOfNowhere, 5).length, 0);
  const nearest = nearestOffices(middleOfNowhere, 3);
  assert.equal(nearest.length, 3);
  assert.ok(nearest[0].miles > 5);
});

test('haversine agrees with a known distance', () => {
  // Los Angeles to San Francisco city halls: ~347 straight-line miles.
  const miles = milesBetween({ lat: 34.0537, lng: -118.2428 }, { lat: 37.7793, lng: -122.4193 });
  assert.ok(Math.abs(miles - 347) < 5, `got ${miles}`);
  assert.equal(milesBetween({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);
  assert.equal(roundMiles(12.34567), 12.3);
});

test('distance is symmetric', () => {
  const a = findOffice('Poway');
  const b = findOffice('Oceanside');
  assert.equal(roundMiles(milesBetween(a, b)), roundMiles(milesBetween(b, a)));
});
