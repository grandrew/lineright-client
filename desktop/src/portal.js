'use strict';
/**
 * Reading a slot off the page somebody is looking at.
 *
 * When a person says "I found a slot", the office and date are usually in the
 * address bar already: the DMV flow (and the stand-in that mirrors it) carries
 * `branch`, `service` and `date` as query parameters. Prefilling the report
 * from the URL is the difference between a two-click report and a form.
 *
 * Read-only by construction: this parses a string. It never touches the page.
 */
const KNOWN = /\/portal\/appointments\/(select-date|times|details)/;

function prefillFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return {};
  }
  if (!KNOWN.test(parsed.pathname)) return {};
  const q = parsed.searchParams;
  const out = {};
  if (q.get('branch')) out.office_code = q.get('branch');
  if (q.get('service')) out.service = q.get('service').toUpperCase();
  if (q.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(q.get('date'))) out.slot_date = q.get('date');
  if (q.get('time') && /^\d{2}:\d{2}$/.test(q.get('time'))) out.slot_time = q.get('time');
  return out;
}

module.exports = { prefillFromUrl };
