import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficeList, officeResult, pickBest, summarize, formatSummary, FOUND, NO_AVAILABILITY, ERROR } from '../src/offices.js';

const office = (term) => ({ term, isZip: /^\d{5}$/.test(term) });

test('parseOfficeList splits, trims and classifies entries', () => {
  const offices = parseOfficeList(' Poway , San Marcos ,92101 ');
  assert.deepEqual(offices.map((o) => o.term), ['Poway', 'San Marcos', '92101']);
  assert.deepEqual(offices.map((o) => o.isZip), [false, false, true]);
});

test('parseOfficeList drops blanks and case-insensitive duplicates', () => {
  assert.deepEqual(parseOfficeList('Poway,,poway, POWAY ').map((o) => o.term), ['Poway']);
  assert.deepEqual(parseOfficeList('').length, 0);
  assert.deepEqual(parseOfficeList(undefined).length, 0);
});

test('parseOfficeList treats only bare 5-digit entries as ZIPs', () => {
  assert.equal(parseOfficeList('92101')[0].isZip, true);
  assert.equal(parseOfficeList('9210')[0].isZip, false);
  assert.equal(parseOfficeList('921011')[0].isZip, false);
  assert.equal(parseOfficeList('Suite 92101')[0].isZip, false);
});

test('pickBest returns the earliest date across offices', () => {
  const results = [
    officeResult(office('Poway'), FOUND, { date: new Date(2026, 9, 20), label: '20 Open Times' }),
    officeResult(office('San Marcos'), FOUND, { date: new Date(2026, 9, 8), label: '8 Open Times' }),
    officeResult(office('El Cajon'), FOUND, { date: new Date(2026, 9, 14), label: '14 Open Times' }),
  ];
  assert.equal(pickBest(results).office, 'San Marcos');
});

test('pickBest ignores offices with nothing found or an error', () => {
  const results = [
    officeResult(office('Poway'), ERROR, { error: 'timeout' }),
    officeResult(office('San Marcos'), NO_AVAILABILITY),
    officeResult(office('El Cajon'), FOUND, { date: new Date(2026, 9, 14), label: '14' }),
  ];
  assert.equal(pickBest(results).office, 'El Cajon');
});

test('pickBest returns null when nothing was found anywhere', () => {
  assert.equal(pickBest([officeResult(office('Poway'), NO_AVAILABILITY)]), null);
  assert.equal(pickBest([]), null);
});

test('ties keep the office listed first, so ordering is a preference', () => {
  const same = new Date(2026, 9, 10);
  const results = [
    officeResult(office('Poway'), FOUND, { date: same, label: '10' }),
    officeResult(office('San Marcos'), FOUND, { date: same, label: '10' }),
  ];
  assert.equal(pickBest(results).office, 'Poway');
});

test('summarize counts outcomes', () => {
  const results = [
    officeResult(office('a'), FOUND, { date: new Date(2026, 9, 5), label: '5' }),
    officeResult(office('b'), NO_AVAILABILITY),
    officeResult(office('c'), ERROR, { error: 'boom' }),
  ];
  const s = summarize(results);
  assert.equal(s.checked, 3);
  assert.equal(s.found, 1);
  assert.equal(s.errored, 1);
  assert.equal(s.best.office, 'a');
});

test('formatSummary reports every office and names the winner', () => {
  const out = formatSummary([
    officeResult(office('Poway'), FOUND, { date: new Date(2026, 9, 20), label: '20 Open Times' }),
    officeResult(office('San Marcos'), NO_AVAILABILITY),
    officeResult(office('El Cajon'), ERROR, { error: 'timeout' }),
  ]);
  assert.match(out, /Poway: .*Oct 20 2026/);
  assert.match(out, /San Marcos: nothing in window/);
  assert.match(out, /El Cajon: error — timeout/);
  assert.match(out, /→ earliest: Poway/);
});

test('formatSummary says so when nothing was found', () => {
  assert.match(formatSummary([officeResult(office('Poway'), NO_AVAILABILITY)]), /no availability at any office/);
});
