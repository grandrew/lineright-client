const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function extractDayNumber(label) {
  const text = String(label ?? '').trim();
  const match = text.match(/^(\d{1,2})\s*Open Times$/i) || text.match(/^(\d{1,2})\b/);
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return day;
}

// The calendar widget renders a heading like "September 2026". The original
// code never read it, so day numbers were always interpreted as belonging to
// DATE_START's month -- see buildCandidateDates below.
export function parseMonthHeading(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b\s+(\d{4})/i
  );
  if (!match) return null;
  return { year: Number(match[2]), month: MONTHS.indexOf(match[1].toLowerCase()) };
}

/**
 * Turn calendar day labels into real dates inside [startDate, endDate].
 *
 * The original built each candidate as
 *     new Date(startDate.getFullYear(), startDate.getMonth(), dayNumber)
 * which is only correct while the calendar happens to be showing DATE_START's
 * month. The DMV calendar opens on the first month that has availability, so
 * as soon as that is a later month every candidate was silently mislabelled --
 * e.g. DATE_START=2026-09-01 with the calendar on November turned "20 Open
 * Times" into 2026-09-20, which then passed a range check it should have
 * failed. Taking the month from the calendar heading removes the guess.
 */
export function buildCandidateDates({ dayLabels, displayedMonth, startDate, endDate }) {
  if (!displayedMonth) {
    throw new Error('displayedMonth is required: refusing to guess which month the calendar is showing');
  }

  const seen = new Set();
  const candidates = [];

  for (const label of dayLabels) {
    const day = extractDayNumber(label.text ?? label);
    if (day === null) continue;

    const date = new Date(displayedMonth.year, displayedMonth.month, day);
    // Reject days that overflow the displayed month (e.g. 31 in a 30-day month).
    if (date.getMonth() !== displayedMonth.month) continue;
    if (date < startDate || date > endDate) continue;

    const key = date.getTime();
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({ date, label: label.text ?? label, index: label.index ?? null });
  }

  candidates.sort((a, b) => a.date - b.date);
  return candidates;
}

// Whether it is worth paging forward: the requested window extends past the
// month currently on screen. The original only ever looked at one month.
export function shouldAdvanceMonth({ displayedMonth, endDate }) {
  if (!displayedMonth) return false;
  const lastOfDisplayed = new Date(displayedMonth.year, displayedMonth.month + 1, 0);
  return endDate > lastOfDisplayed;
}

export function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
