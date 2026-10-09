'use strict';
/**
 * What a line asks for, against what the profile holds.
 *
 * A site publishes a form schema. The fields that are preferences — which
 * office, which date, how many people — travel with the bid and are typed into
 * the join form. The rest are personal: a name, a licence number, an email,
 * and they never leave this machine. The app keeps them in the profile and
 * types them into the booking page when the slot is yours.
 *
 * Which means a bid placed with an empty profile is a promise the app cannot
 * keep: the person's turn comes, the page opens, and there is nothing to fill
 * it in with — on a clock, at the one moment they can least afford to go
 * hunting for their licence. So bidding and booking both go through here
 * first, and the profile screen opens when something is missing.
 *
 * Only fields the profile can actually hold are required. A site is free to
 * ask for a fan-club membership number or an insurance member id; nothing here
 * can store one, so those stay what they always were — something the person
 * types on the site's own form — and they never block a bid. Demanding what
 * cannot be supplied would make five of the six seeded sites unbiddable.
 *
 * Nor what the line says its form does not need (`required: false`): the DMV
 * asks a drive test for a licence number and a date of birth, and a REAL ID
 * appointment for neither, so a REAL ID turn opens its page without them.
 */

/**
 * Site field key -> profile field key.
 *
 * Sites name the same things differently (`licence_no`, `license_no`,
 * `dl_number`), so the mapping is by hand and deliberately small: a wrong
 * guess here would either block a bid for no reason or promise a form fill
 * that never happens.
 */
const PROFILE_KEY = {
  first_name: 'first_name',
  last_name: 'last_name',
  full_name: 'full_name',
  dob: 'dob',
  date_of_birth: 'dob',
  birth_date: 'dob',
  dl_number: 'dl_number',
  licence_no: 'dl_number',
  license_no: 'dl_number',
  drivers_license: 'dl_number',
  email: 'email',
  phone: 'phone',
  mobile: 'phone',
  passport_no: 'passport',
  passport_number: 'passport',
  ssn: 'ssn',
  street: 'street',
  city: 'city',
  state: 'state',
  zip: 'zip',
};

/** The profile key a site field maps to, or null when nothing here holds it. */
function profileKeyFor(fieldKey) {
  return PROFILE_KEY[String(fieldKey || '').toLowerCase()] || null;
}

/** Does the profile have something for this profile key? */
function held(values, profileKey) {
  const data = values || {};
  if (profileKey === 'full_name') {
    return Boolean(String(data.full_name || '').trim()
      || (String(data.first_name || '').trim() && String(data.last_name || '').trim()));
  }
  return Boolean(String(data[profileKey] || '').trim());
}

/**
 * How each field of a line stands: held, missing, or not something the profile
 * can keep. `fields` is a `kept_on_device` list as the server sends it.
 */
function status(fields, values) {
  return (fields || []).map((f) => {
    const key = profileKeyFor(f.key);
    return {
      key: f.key,
      label: f.label || f.key,
      profileKey: key,
      state: key === null ? 'on-form' : held(values, key) ? 'held' : f.required === false ? 'optional' : 'missing',
    };
  });
}

/** The fields this line asks for that the profile could hold and does not. */
function missing(fields, values) {
  return status(fields, values).filter((f) => f.state === 'missing');
}

/** Ready to bid on, or to be handed, this line? */
function ready(fields, values) {
  return missing(fields, values).length === 0;
}

/** "your first name, last name and email" — for saying what is wanted. */
function phrase(list) {
  const labels = list.map((f) => String(f.label).toLowerCase());
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

module.exports = { PROFILE_KEY, profileKeyFor, held, status, missing, ready, phrase };
