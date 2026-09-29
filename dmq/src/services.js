/**
 * The booking app is reached at
 *   /portal/appointments/select-appointment-type?option=<CODE>
 * and the code decides which of two flows you land in.
 *
 * Verified against the live site 2026-09-15.
 */

export const OFFICE_VISIT = 'office-visit';
export const DRIVE_TEST = 'drive-test';

export const SERVICES = {
  // Office-visit family: ?option=X jumps straight to location selection.
  // No driver's licence number or date of birth is required to see a calendar.
  VR: {
    code: 'VR',
    label: 'Vehicle or boat registration',
    family: OFFICE_VISIT,
    needsCredentials: false,
    expectDescription: /register a vehicle or boat/i,
  },
  CID: {
    code: 'CID',
    label: "Driver's license or ID card",
    family: OFFICE_VISIT,
    needsCredentials: false,
    expectDescription: /apply or renew a driver.s license or id/i,
  },
  RID: {
    code: 'RID',
    label: 'REAL ID',
    family: OFFICE_VISIT,
    needsCredentials: false,
    expectDescription: /apply for a real id/i,
  },
  IBC: {
    code: 'IBC',
    label: 'Industry Business Center',
    family: OFFICE_VISIT,
    needsCredentials: false,
    expectDescription: /industry business center/i,
  },

  // Drive-test family: the option code does not preselect anything, so the
  // vehicle card still has to be clicked, and DMV then demands a licence or
  // permit number plus date of birth before showing any availability.
  DT: {
    code: 'DT',
    label: 'Drive test (automobile)',
    family: DRIVE_TEST,
    needsCredentials: true,
    vehicleType: 'Automobile',
  },
  CDL: {
    code: 'CDL',
    label: 'Drive test (commercial)',
    family: DRIVE_TEST,
    needsCredentials: true,
    vehicleType: 'Commercial',
  },
  MC: {
    code: 'MC',
    label: 'Drive test (motorcycle)',
    family: DRIVE_TEST,
    needsCredentials: true,
    vehicleType: 'Motorcycle',
  },
  KTR: {
    code: 'KTR',
    label: 'Knowledge test re-evaluation',
    family: DRIVE_TEST,
    needsCredentials: true,
    vehicleType: 'Knowledge Test Re-Evaluation',
  },
};

export const SERVICE_CODES = Object.keys(SERVICES);

export function getService(code) {
  const key = String(code ?? '').trim().toUpperCase();
  const service = SERVICES[key];
  if (!service) {
    throw new Error(`Unknown DMV_SERVICE "${code}". Valid: ${SERVICE_CODES.join(', ')}`);
  }
  return service;
}

/**
 * Where the appointment site lives.
 *
 * Overridable so the robots can be pointed at a local stand-in of the site
 * (`DMV_BASE_URL=http://127.0.0.1:8787`) and driven end to end — gate, calendar,
 * booking and all — without touching dmv.ca.gov. Defaults to the real site, so
 * nothing changes unless somebody asks for it.
 */
export const DEFAULT_BASE_URL = 'https://www.dmv.ca.gov';

export function baseUrl(env = process.env) {
  return String(env.DMV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function appointmentUrl(service, base = baseUrl()) {
  return `${String(base).replace(/\/+$/, '')}/portal/appointments/select-appointment-type?option=${service.code}`;
}
