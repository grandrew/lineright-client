import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestToEnv, discoveryRequestToEnv, outcomeToResult, errorToResult, offersToResult, cardDigits, cardExpiry,
  campgroundsForConstraint, LINES, RqpError, ACK, NACK_FATAL, NACK_RETRY,
} from '../src/rqp.js';

const TARGET = { site: 'yosemite', connector: 'recreation.gov.camps', queue: 'yosemite-campsite' };
const PERSON = {
  campground_mode: 'specific', campgrounds: ['Upper Pines', 'North Pines'], nights: 2, party_size: 4, vehicles: 1,
  equipment: 'tent', first_name: 'Ada', last_name: 'Camper', email: 'ada@example.com', phone: '5555550123',
  card_number: '4242 4242 4242 4242', card_exp_month: '12', card_exp_year: '2030', card_cvc: '123',
  street: '1 Main St', city: 'Fresno', state: 'CA', zip: '93701',
};
const booking = (over = {}) => ({
  protocol: 'RQP/1', kind: 'booking.request', idempotency_key: 'job-1', target: TARGET,
  slot: { window: ['2027-06-01', '2027-06-05'] }, personal_data: { ...PERSON }, ...over,
});
const permanent = (fn, pattern) => assert.throws(fn, (e) => e instanceof RqpError && e.permanent && pattern.test(e.message));

test('a rehearsal comes from the process, never from the envelope', () => {
  const asked = requestToEnv(booking({ personal_data: { ...PERSON, RGOV_REHEARSE: 'true' } }), { RQP_ALLOW_BOOKING: 'true' });
  assert.equal(asked.RGOV_REHEARSE, undefined);
  assert.equal(requestToEnv(booking(), { RQP_ALLOW_BOOKING: 'true', RGOV_REHEARSE: 'true' }).RGOV_REHEARSE, 'true');
  const r = outcomeToResult({ status: 'REHEARSED', campground: 'Upper Pines', site: '044', arrival: '2027-06-03', nights: 2,
    held_until: '7:14 AM' });
  assert.equal(r.status, NACK_RETRY);
  assert.match(r.message, /stopped before paying\. Nothing was charged; it is in the Recreation\.gov cart until 7:14 AM/);
});

test('a dry probe needs no card, no contact and books nothing', () => {
  const env = requestToEnv(booking({ personal_data: { campgrounds: ['Upper Pines'], nights: 2 } }));
  assert.equal(env.AUTO_SUBMIT, 'false');
  assert.equal(env.RGOV_CAMPGROUNDS, '232447');
  assert.equal(env.CARD_NUMBER, undefined);
  assert.equal(env.FIRST_NAME, undefined);
});

test('booking is on only when the process says so, and then the card comes along, checked', () => {
  const env = requestToEnv(booking(), { RQP_ALLOW_BOOKING: 'true' });
  assert.equal(env.AUTO_SUBMIT, 'true');
  assert.equal(env.CARD_NUMBER, '4242424242424242');
  assert.equal(env.CARD_EXP_MONTH, '12');
  assert.equal(env.CARD_NAME, 'Ada Camper');
  assert.equal(env.RGOV_PARTY_SIZE, '4');
  assert.equal(requestToEnv(booking(), { RQP_ALLOW_BOOKING: '1' }).AUTO_SUBMIT, 'false');
});

test('a card that cannot work ends the bid before a browser opens', () => {
  const allow = { RQP_ALLOW_BOOKING: 'true' };
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, card_number: '4242424242424241' } }), allow), /not a valid card/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, card_exp_year: '2020' } }), allow), /expired/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, card_cvc: '12' } }), allow), /security code/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, zip: '' } }), allow), /Billing ZIP/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, party_size: 0 } }), allow), /Party size/);
});

test('card checks: Luhn, and a card works through its expiry month', () => {
  assert.equal(cardDigits('4242-4242-4242-4242'), '4242424242424242');
  assert.equal(cardDigits('1234'), null);
  const now = new Date(2027, 5, 15);
  assert.deepEqual(cardExpiry('6', '27', now), { month: '06', year: '2027' });
  assert.equal(cardExpiry('5', '2027', now), null);
  assert.equal(cardExpiry('13', '2030', now), null);
});

test('the allocated campsite goes first and is booked directly', () => {
  const env = requestToEnv(booking({ slot: { window: ['2027-06-01', '2027-06-05'],
    allocated: { office_code: '232449', office_name: 'North Pines', campsite_id: '555', site: '012', date: '2027-06-03', nights: 3 } } }));
  assert.equal(env.RGOV_CAMPGROUNDS, '232449,232447');
  assert.equal(env.RGOV_TARGET_CAMPSITE, '555');
  assert.equal(env.RGOV_TARGET_ARRIVAL, '2027-06-03');
  assert.equal(env.RGOV_NIGHTS, '3');
});

test('a bid cannot name a campground of another line', () => {
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, campgrounds: ['Camp 4'] } })), /not a Yosemite campsite/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, campgrounds: ['Nowhere Flat'] } })), /Unknown Yosemite campground/);
  permanent(() => requestToEnv(booking({ target: { ...TARGET, queue: 'half-dome' } })), /No Yosemite line/);
  permanent(() => requestToEnv(booking({ personal_data: { ...PERSON, nights: 30 } })), /Nights/);
  permanent(() => requestToEnv(booking({ slot: { window: ['2027-06-05', '2027-06-01'] } })), /ends before it starts/);
});

test('constraints: area, radius and any keep to the line\'s kind', () => {
  const family = { kind: 'family', label: LINES['yosemite-campsite'].label };
  const valley = campgroundsForConstraint(family, { campground_mode: 'area', area: 'Yosemite Valley' }).map((c) => c.short);
  assert.ok(!valley.includes('Camp 4'));
  assert.equal(valley.length, 3);
  const near = campgroundsForConstraint(family, { campground_mode: 'radius', radius_miles: 3, origin_lat: 37.7397, origin_lng: -119.5737 });
  assert.equal(near.length, 3);
  const camp4 = campgroundsForConstraint({ kind: 'walk-in', label: 'Camp 4 (walk-in)' }, { campground_mode: 'any' });
  assert.deepEqual(camp4.map((c) => c.short), ['Camp 4']);
});

test('discovery: campgrounds, window, shortest stay — and nothing of anybody\'s', () => {
  const env = discoveryRequestToEnv({ protocol: 'RQP/1', kind: 'discovery.request', target: TARGET,
    offices: ['upper-pines', '232450'], window: ['2027-06-01', '2027-06-05'], nights: 2, personal_data: PERSON });
  assert.deepEqual(Object.keys(env).sort(), ['DATE_END', 'DATE_START', 'RGOV_CAMPGROUNDS', 'RGOV_KIND', 'RGOV_NIGHTS', 'RGOV_QUEUE', 'RUN_LOG_PATH']);
  assert.equal(env.RGOV_CAMPGROUNDS, '232447,232450');
});

const where = { campground: 'Upper Pines', campsite_id: '100', site: '044', arrival: '2027-06-03', nights: 2 };

test('booked only with the reservation number; unconfirmed is never retried', () => {
  const ok = outcomeToResult({ status: 'BOOKED_SUCCESS', ...where, reference: '0123456789-1' });
  assert.equal(ok.status, ACK);
  assert.equal(ok.confirmation, '0123456789-1');
  assert.equal(ok.booked_date, '2027-06-03');
  assert.match(ok.message, /site 044 at Upper Pines, arriving 2027-06-03, 2 nights/);
  const noRef = outcomeToResult({ status: 'BOOKED_SUCCESS', ...where });
  assert.equal(noRef.status, NACK_FATAL);
  assert.equal(noRef.unconfirmed, true);
  const unsure = outcomeToResult({ status: 'BOOKING_UNCONFIRMED', ...where, seen: 'still on /checkout' });
  assert.equal(unsure.status, NACK_FATAL);
  assert.match(unsure.message, /not booked or charged twice/);
});

test('a declined card is final for that card, and says where the held site is', () => {
  const r = outcomeToResult({ status: 'PAYMENT_DECLINED', ...where, cart_url: 'https://www.recreation.gov/cart', held_until: '7:14 AM' });
  assert.equal(r.status, NACK_FATAL);
  assert.equal(r.payment_declined, true);
  assert.equal(r.cart_url, 'https://www.recreation.gov/cart');
  assert.match(r.message, /Nothing was charged.*until 7:14 AM/);
});

test('gone and empty are worth another try; a gate travels as data', () => {
  assert.equal(outcomeToResult({ status: 'NO_AVAILABILITY', slot_gone: true }).slot_gone, true);
  assert.equal(outcomeToResult({ status: 'NO_AVAILABILITY' }).status, NACK_RETRY);
  const gated = errorToResult(Object.assign(new Error('Recreation.gov wants the person to sign in.'), { gate: { kind: 'signin' } }));
  assert.equal(gated.status, NACK_RETRY);
  assert.deepEqual(gated.gate, { kind: 'signin' });
  const scout = offersToResult({ offers: [], checked: [{ office: 'Upper Pines', error: 'x' }], gate: { kind: 'rate_limited' } });
  assert.match(scout.message, /asked for fewer requests/);
  assert.equal(scout.gate.kind, 'rate_limited');
});
