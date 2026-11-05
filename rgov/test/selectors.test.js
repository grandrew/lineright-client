import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfirmation, saysDeclined, saysGone, heldUntil, usDate, BILLING } from '../src/selectors.js';

test('the reservation number, however the page puts it', () => {
  assert.equal(parseConfirmation({ text: 'Thank you! Reservation # 0123456789-1' }), '0123456789-1');
  assert.equal(parseConfirmation({ text: 'Reservation Number: 0123456789-2' }), '0123456789-2');
  assert.equal(parseConfirmation({ text: 'Order Number 012345678901' }), '012345678901');
  assert.equal(parseConfirmation({ url: 'https://x/checkout/confirmation?reservation=0123456789-1' }), '0123456789-1');
  assert.equal(parseConfirmation({ text: 'Site 044, 2 nights, $72.00, call 5555550123' }), null);
});

test('declined, gone, and when the hold runs out', () => {
  assert.ok(saysDeclined('Your card was declined. Please try another card.'));
  assert.ok(!saysDeclined('Your reservation is confirmed.'));
  assert.ok(saysGone('This site is no longer available for your selected dates.'));
  assert.equal(heldUntil('Site held for you until 7:14 AM.'), '7:14 AM');
  assert.equal(heldUntil('Reserved until 11:02 p.m. today'), '11:02 p.m.');
  assert.equal(heldUntil('Nothing in your cart'), null);
});

test('dates as the inputs take them, and billing labels that do not catch their neighbours', () => {
  assert.equal(usDate('2027-06-02'), '06/02/2027');
  assert.ok(BILLING.state.test('State '));
  assert.ok(!BILLING.state.test('United States'));
  assert.ok(BILLING.street.test('Street Address'));
  assert.ok(!BILLING.street.test('Email Address'));
});
