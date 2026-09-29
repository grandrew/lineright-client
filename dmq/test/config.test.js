import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadConfig, parseDateOnly } from '../src/config.js';

const DT_ENV = {
  DATE_START: '2026-10-01',
  DATE_END: '2026-10-31',
  DMV_SERVICE: 'DT',
  DMV_OFFICES: 'Poway',
  DMV_LICENSE: 'X1234567',
  DMV_DOB: '01/02/1990',
};

const VR_ENV = {
  DATE_START: '2026-10-01',
  DATE_END: '2026-10-31',
  DMV_SERVICE: 'VR',
  DMV_OFFICES: 'Poway',
};

const CONTACT = {
  FIRST_NAME: 'Test',
  LAST_NAME: 'User',
  EMAIL_ADDRESS: 'test@example.com',
  PHONE_NUMBER: '5555550123',
};

test('parseDateOnly accepts a real date and rejects junk', () => {
  assert.equal(parseDateOnly('2026-02-28', 'D').getDate(), 28);
  assert.throws(() => parseDateOnly('2026-02-30', 'D'), /not a real calendar date/);
  assert.throws(() => parseDateOnly('10/01/2026', 'D'), /must be YYYY-MM-DD/);
  assert.throws(() => parseDateOnly(undefined, 'DATE_START'), /DATE_START is required/);
});

test('loadConfig defaults to the drive test service', () => {
  const { DMV_SERVICE, ...rest } = DT_ENV;
  assert.equal(loadConfig(rest).service.code, 'DT');
});

test('loadConfig requires credentials for drive tests', () => {
  for (const key of ['DMV_LICENSE', 'DMV_DOB']) {
    const env = { ...DT_ENV };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  }
});

test('loadConfig does not require credentials for office-visit services', () => {
  // The whole point of the VR/CID/RID flows: DMV shows a calendar without them.
  const cfg = loadConfig(VR_ENV);
  assert.equal(cfg.licenseNumber, null);
  assert.equal(cfg.dob, null);
  assert.equal(cfg.service.needsCredentials, false);
});

test('contact details are only required when actually booking', () => {
  assert.equal(loadConfig(VR_ENV).firstName, null, 'dry run needs no contact details');
  assert.throws(() => loadConfig({ ...VR_ENV, AUTO_SUBMIT: 'true' }), /FIRST_NAME is required when AUTO_SUBMIT=true/);
  const booking = loadConfig({ ...VR_ENV, ...CONTACT, AUTO_SUBMIT: 'true' });
  assert.equal(booking.firstName, 'Test');
});

test('loadConfig rejects an unknown service', () => {
  assert.throws(() => loadConfig({ ...VR_ENV, DMV_SERVICE: 'BOAT' }), /Unknown DMV_SERVICE "BOAT"/);
});

test('loadConfig accepts service codes case-insensitively', () => {
  assert.equal(loadConfig({ ...VR_ENV, DMV_SERVICE: 'vr' }).service.code, 'VR');
});

test('loadConfig parses a multi-office list', () => {
  const cfg = loadConfig({ ...VR_ENV, DMV_OFFICES: 'Poway, San Marcos ,92101' });
  assert.deepEqual(cfg.offices.map((o) => o.term), ['Poway', 'San Marcos', '92101']);
  assert.deepEqual(cfg.offices.map((o) => o.isZip), [false, false, true]);
});

test('loadConfig still honours the older single-office variables', () => {
  const { DMV_OFFICES, ...rest } = VR_ENV;
  assert.deepEqual(loadConfig({ ...rest, DMV_LOCATION_NAME: 'Poway' }).offices.map((o) => o.term), ['Poway']);
  assert.deepEqual(loadConfig({ ...rest, DMV_ZIP: '92064' }).offices.map((o) => o.term), ['92064']);
});

test('loadConfig requires at least one office', () => {
  const { DMV_OFFICES, ...rest } = VR_ENV;
  assert.throws(() => loadConfig(rest), /DMV_OFFICES is required/);
  assert.throws(() => loadConfig({ ...rest, DMV_OFFICES: ' , , ' }), /DMV_OFFICES is required/);
});

test('loadConfig rejects an inverted date range', () => {
  assert.throws(
    () => loadConfig({ ...VR_ENV, DATE_START: '2026-10-31', DATE_END: '2026-10-01' }),
    /DATE_END .* is before DATE_START/
  );
});

test('loadConfig validates date-of-birth shape', () => {
  assert.throws(() => loadConfig({ ...DT_ENV, DMV_DOB: '1990-01-02' }), /DMV_DOB must look like/);
  assert.equal(loadConfig({ ...DT_ENV, DMV_DOB: '01021990' }).dob, '01021990');
});

test('run log defaults to the working directory, not a hardcoded home path', () => {
  const cfg = loadConfig(VR_ENV);
  assert.equal(cfg.runLogPath, path.resolve(process.cwd(), 'dmv_bot_run_log.txt'));
  assert.ok(!cfg.runLogPath.includes('/Users/'), 'must not point at somebody else’s Desktop');
});

test('AUTO_SUBMIT is only enabled by the exact string "true"', () => {
  assert.equal(loadConfig({ ...VR_ENV, ...CONTACT, AUTO_SUBMIT: 'true' }).autoSubmit, true);
  for (const v of ['TRUE', 'yes', '1', '', 'false']) {
    assert.equal(loadConfig({ ...VR_ENV, AUTO_SUBMIT: v }).autoSubmit, false, `AUTO_SUBMIT=${v}`);
  }
});

// ------------------------------------------------------------ the solver
test('a solving service must be on loopback, and so must the site it is aimed at', () => {
  // This is the whole safety property of the simulated-solver path, so it is a
  // test rather than a comment. A setting that turns into a real solving
  // service by editing one variable is not a simulation of one.
  const base = {
    DATE_START: '2026-10-01', DATE_END: '2026-10-31',
    DMV_SERVICE: 'VR', DMV_OFFICES: 'Poway',
  };
  const local = { ...base, DMV_BASE_URL: 'http://127.0.0.1:8787' };

  assert.equal(loadConfig({ ...local, CAPTCHA_SOLVER_URL: 'http://127.0.0.1:8787/__captcha/solve' })
    .solverUrl, 'http://127.0.0.1:8787/__captcha/solve');
  assert.equal(loadConfig(local).solverUrl, null, 'unset is the ordinary case');

  assert.throws(
    () => loadConfig({ ...local, CAPTCHA_SOLVER_URL: 'https://2captcha.com/in.php' }),
    /loopback/i,
    'a real solving service must not be reachable through this setting');
  assert.throws(
    () => loadConfig({ ...base, CAPTCHA_SOLVER_URL: 'http://127.0.0.1:8787/__captcha/solve' }),
    /stand-in/i,
    'bought solves must never be aimed at dmv.ca.gov');
});
