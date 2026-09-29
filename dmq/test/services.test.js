import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES, SERVICE_CODES, getService, appointmentUrl, OFFICE_VISIT, DRIVE_TEST } from '../src/services.js';

test('every service declares a consistent shape', () => {
  for (const code of SERVICE_CODES) {
    const s = SERVICES[code];
    assert.equal(s.code, code, `${code}: code must match its key`);
    assert.ok(s.label, `${code}: needs a label`);
    assert.ok([OFFICE_VISIT, DRIVE_TEST].includes(s.family), `${code}: unknown family ${s.family}`);
    if (s.family === DRIVE_TEST) {
      assert.equal(s.needsCredentials, true, `${code}: drive tests always need credentials`);
      assert.ok(s.vehicleType, `${code}: drive tests need a vehicleType to click`);
    } else {
      assert.equal(s.needsCredentials, false, `${code}: office visits need no credentials`);
      assert.ok(s.expectDescription instanceof RegExp, `${code}: needs a description matcher for live checks`);
    }
  }
});

test('the office-visit family is exactly the no-credential services', () => {
  const officeVisit = SERVICE_CODES.filter((c) => SERVICES[c].family === OFFICE_VISIT);
  assert.deepEqual(officeVisit.sort(), ['CID', 'IBC', 'RID', 'VR']);
});

test('the drive-test family maps to the vehicle cards on the page', () => {
  assert.equal(SERVICES.DT.vehicleType, 'Automobile');
  assert.equal(SERVICES.CDL.vehicleType, 'Commercial');
  assert.equal(SERVICES.MC.vehicleType, 'Motorcycle');
});

test('getService is case-insensitive and rejects unknown codes', () => {
  assert.equal(getService('vr').code, 'VR');
  assert.equal(getService(' Dt ').code, 'DT');
  assert.throws(() => getService('BOAT'), /Unknown DMV_SERVICE "BOAT"/);
  assert.throws(() => getService(undefined), /Unknown DMV_SERVICE/);
});

test('appointmentUrl carries the option code', () => {
  assert.equal(
    appointmentUrl(SERVICES.VR),
    'https://www.dmv.ca.gov/portal/appointments/select-appointment-type?option=VR'
  );
});
