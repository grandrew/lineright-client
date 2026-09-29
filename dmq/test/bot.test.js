import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/bot.js';
import { parseConfirmation } from '../src/selectors.js';

test('run() rejects bad config before launching a browser', async () => {
  const started = Date.now();
  await assert.rejects(() => run({ DATE_START: '2026-10-01' }), /DATE_END is required/);
  assert.ok(Date.now() - started < 800, 'validation must short-circuit before browser launch');
});

test('run() names the offending variable', async () => {
  await assert.rejects(
    () => run({ DATE_START: '2026-10-01', DATE_END: '2026-10-31', DMV_SERVICE: 'VR' }),
    /DMV_OFFICES is required/
  );
});

test('run() refuses a drive test without credentials, before launching', async () => {
  const started = Date.now();
  await assert.rejects(
    () => run({ DATE_START: '2026-10-01', DATE_END: '2026-10-31', DMV_SERVICE: 'DT', DMV_OFFICES: 'Poway' }),
    /DMV_LICENSE is required for Drive test/
  );
  assert.ok(Date.now() - started < 800);
});

test('run() refuses to book without contact details, before launching', async () => {
  await assert.rejects(
    () =>
      run({
        DATE_START: '2026-10-01',
        DATE_END: '2026-10-31',
        DMV_SERVICE: 'VR',
        DMV_OFFICES: 'Poway',
        AUTO_SUBMIT: 'true',
      }),
    /FIRST_NAME is required when AUTO_SUBMIT=true/
  );
});

// ------------------------------------------------ reading the confirmation
test('the confirmation number is read from the confirmation page URL', () => {
  assert.equal(
    parseConfirmation({ url: 'http://127.0.0.1:8787/portal/appointments/confirmation?ref=TS-1A2B3C4D' }),
    'TS-1A2B3C4D'
  );
});

test('or from the number printed after a "Confirmation number" label', () => {
  const url = 'http://127.0.0.1:8787/portal/appointments/details?hold=ab12';
  assert.equal(parseConfirmation({ url, text: 'Appointment confirmed. Confirmation number TS-1A2B3C4D' }),
    'TS-1A2B3C4D');
  assert.equal(parseConfirmation({ text: 'Confirmation #: 48213377' }), '48213377');
  assert.equal(parseConfirmation({ text: 'Your confirmation code is Q7XK2P9' }), 'Q7XK2P9');
});

test('a page that only mentions a confirmation has none to read', () => {
  // The stand-in's own confirmation page says this, and "with" is not a number.
  assert.equal(parseConfirmation({ text: 'Bring the confirmation number with you.' }), null);
  assert.equal(parseConfirmation({ text: 'We use these to send your confirmation.' }), null);
  // A ref off anything but a confirmation page is somebody else's parameter.
  assert.equal(parseConfirmation({ url: 'https://example.invalid/portal/?ref=campaign2026' }), null);
  assert.equal(parseConfirmation({}), null);
});
