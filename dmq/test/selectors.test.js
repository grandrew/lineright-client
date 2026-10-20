import test from 'node:test';
import assert from 'node:assert/strict';
import { officeNameMatches, officeSelectButton } from '../src/selectors.js';

test('a reversed branch title is the same office', () => {
  const card = '1. IBC Mountain View Field Office 595 Showers Dr. Mountain View CA 94040 Select Location';
  assert.equal(officeNameMatches('Mountain View IBC', card), true);
});

test('the catalogue title matches its own card', () => {
  const card = '1. Mountain View IBC Field Office 595 Showers Dr. Mountain View CA 94040 Select Location';
  assert.equal(officeNameMatches('Mountain View IBC', card), true);
});

test('the two Mountain View names do not share a card', () => {
  const short = '1. Mountain View IBC Field Office 595 Showers Dr. Mountain View CA 94040';
  const long = '1. Mountain View Industry Business Center Field Office 595 Showers Drive Mountain View CA 94040';
  assert.equal(officeNameMatches('Mountain View Industry Business Center', short), false);
  assert.equal(officeNameMatches('Mountain View IBC', long), false);
  assert.equal(officeNameMatches('Mountain View Industry Business Center', long), true);
});

test('the only card is not taken when it is a different office', async () => {
  const page = pageOf(['1. Santa Clara Field Office 3665 Flora Vista Ave. Santa Clara CA 95051 Select Location']);
  await assert.rejects(
    () => officeSelectButton(page, { term: 'Mountain View IBC', isZip: false }),
    /No office matching "Mountain View IBC" in 1 result\(s\): 1\. Santa Clara/
  );
});

test('a card whose words are the office name is the one selected', async () => {
  const page = pageOf([
    '1. Santa Clara Field Office Select Location',
    '2. IBC Mountain View Field Office Select Location',
  ]);
  const button = await officeSelectButton(page, { term: 'Mountain View IBC', isZip: false });
  assert.equal(button.id, 1);
});

function pageOf(texts) {
  const cards = texts.map((text, i) => ({
    innerText: async () => text,
    getByRole() {
      return { first: () => ({ id: i, count: async () => 1 }) };
    },
  }));
  return {
    locator() {
      return {
        count: async () => cards.length,
        nth: (index) => cards[index],
        first: () => cards[0],
      };
    },
  };
}
