'use strict';
/**
 * How the app speaks of each booking system it books on: the DMV, and
 * Recreation.gov for the Yosemite campsites.
 *
 * A turn says which it is by its robot's envelope (`target.connector`); a
 * booking the site lists, by its `connector`, or failing that by the host of
 * its own page. Anything that says neither is the DMV's, as everything was
 * before there were two.
 */

const SITES = {
  'dmv.ca.gov.qmatic': {
    connector: 'dmv.ca.gov.qmatic',
    key: 'dmv',
    name: 'the DMV',
    Name: 'The DMV',
    their: "the DMV's",
    Their: "The DMV's",
    host: 'dmv.ca.gov',
    thing: 'appointment',
    form: "the DMV's form",
    pages: "the DMV's pages",
  },
  'recreation.gov.camps': {
    connector: 'recreation.gov.camps',
    key: 'rgov',
    name: 'Recreation.gov',
    Name: 'Recreation.gov',
    their: "Recreation.gov's",
    Their: "Recreation.gov's",
    host: 'recreation.gov',
    thing: 'reservation',
    form: "Recreation.gov's checkout",
    pages: "Recreation.gov's pages",
    // Cancelled in the person's own account, never by the app: Recreation.gov
    // keeps a fee, and more close to arrival, and that is the person's to accept.
    // A booking's own page (`manage_url`) is opened when the site sends one;
    // this is where the account lists them otherwise. Not yet checked live.
    reservations: 'https://www.recreation.gov/account/reservations',
  },
};

const DMV = SITES['dmv.ca.gov.qmatic'];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The connector a hand-off's robot works, or '' — kept on what the app shows for it, to word it later. */
function connectorOf(h) {
  const envelope = h && h.robot && h.robot.request;
  return (envelope && envelope.target && envelope.target.connector) || '';
}

/**
 * The words for one booking system. `of` is a hand-off (its robot's envelope),
 * a booking record, an envelope, or a connector's name.
 */
function siteOf(of) {
  if (!of) return DMV;
  if (typeof of === 'string') return SITES[of] || DMV;
  const envelope = (of.robot && of.robot.request) || of;
  const connector = of.connector || (envelope.target && envelope.target.connector);
  if (connector && SITES[connector]) return SITES[connector];
  for (const url of [of.manage_url, of.open_url, of.portal_url, of.robot && of.robot.base_url]) {
    const host = hostOf(url);
    if (!host) continue;
    const found = Object.values(SITES).find((s) => host === s.host || host.endsWith(`.${s.host}`));
    if (found) return found;
  }
  return DMV;
}

/** What the renderer needs of it, for a booking it shows. */
function siteWords(of) {
  const s = siteOf(of);
  return { key: s.key, name: s.name, Name: s.Name, their: s.their, thing: s.thing };
}

module.exports = { SITES, siteOf, siteWords, connectorOf };
