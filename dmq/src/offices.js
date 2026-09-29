/**
 * Pure helpers for checking several offices in one run.
 * No Playwright here so the decision logic stays unit-testable.
 */

export const FOUND = 'FOUND';
export const NO_AVAILABILITY = 'NO_AVAILABILITY';
export const ERROR = 'ERROR';

export function parseOfficeList(raw) {
  const entries = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const offices = [];
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    offices.push({
      term: entry,
      // A bare 5-digit entry is a ZIP; anything else is treated as an office name.
      isZip: /^\d{5}$/.test(entry),
    });
  }
  return offices;
}

export function officeResult(office, status, extra = {}) {
  return { office: office.term, status, date: null, label: null, error: null, ...extra };
}

/**
 * Pick the office with the earliest available date. Ties go to the office
 * listed first in DMV_OFFICES, so the user's ordering acts as a preference.
 */
/** A result's date as 'YYYY-MM-DD' in local terms. Results carry a Date; an
 *  allocated target arrives as a string, and UTC would shift it a day. */
export function dateKey(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-`
      + String(value.getDate()).padStart(2, '0');
  }
  return String(value ?? '');
}

export function pickBest(results, { target = null } = {}) {
  // When regbot has already allocated this bid a specific slot, that slot wins
  // outright if it is still there. It was chosen by the board, and quietly
  // taking an earlier one at a different office would hand the applicant an
  // appointment nobody agreed to — and strand the slot they were allocated.
  if (target?.office && target?.date) {
    const exact = results.find((r) => r.status === FOUND && dateKey(r.date) === dateKey(target.date)
      && String(r.office).toLowerCase() === String(target.office).toLowerCase());
    if (exact) return exact;
  }
  let best = null;
  for (const result of results) {
    if (result.status !== FOUND || !result.date) continue;
    if (best === null || result.date < best.date) best = result;
  }
  return best;
}

export function summarize(results, options = {}) {
  const best = pickBest(results, options);
  return {
    best,
    found: results.filter((r) => r.status === FOUND).length,
    errored: results.filter((r) => r.status === ERROR).length,
    checked: results.length,
  };
}

export function formatSummary(results) {
  const lines = results.map((r) => {
    if (r.status === FOUND) return `  ${r.office}: ${r.date.toDateString()} (${r.label})`;
    if (r.status === ERROR) return `  ${r.office}: error — ${r.error}`;
    return `  ${r.office}: nothing in window`;
  });
  const { best } = summarize(results);
  lines.push(
    best
      ? `  → earliest: ${best.office} on ${best.date.toDateString()}`
      : '  → no availability at any office in the window'
  );
  return lines.join('\n');
}
