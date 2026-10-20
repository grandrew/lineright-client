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

/**
 * The full date painted on a day cell, when the cell carries one.
 *
 * The live calendar puts "December 1, 2026" in a span that is hidden on a
 * desktop layout, then the day-of-month "1", then "Open Times". Reading only
 * the visible day number and the month heading turns that December cell into
 * November 1 whenever November is the month on screen.
 */
export function dateFromCellText(text) {
  // The next span is glued on, so the year is followed by the day number:
  // "December 1, 2026" + "1" + "Open Times" is "December 1, 20261Open Times".
  // Four digits is the year either way.
  const match = String(text ?? '').match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s+(\d{4})/i
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

/** A month named by the cell's own class, such as `rbc-event december`. */
export function monthFromClass(className) {
  const match = String(className ?? '').toLowerCase().match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/
  );
  return match ? MONTHS.indexOf(match[1]) : null;
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
    const source = typeof label === 'string' ? label : `${label.full || ''} ${label.text || ''}`;
    // A full date on the cell wins over heading + day number. An off-range
    // day (December 1 shown on the November grid) would otherwise inherit
    // the heading's month.
    let date = dateFromCellText(source);
    if (!date) {
      const day = extractDayNumber(label.text ?? label);
      if (day === null) continue;
      const fromClass = typeof label === 'string' ? null : monthFromClass(label.className);
      let month = displayedMonth.month;
      let year = displayedMonth.year;
      // The live cell's class names its own month. A December cell on the
      // November grid must not become November 1, which would sort first and
      // be the day the scout opens.
      if (fromClass !== null) {
        month = fromClass;
        if (fromClass === 11 && displayedMonth.month === 0) year -= 1;
        if (fromClass === 0 && displayedMonth.month === 11) year += 1;
      }
      date = new Date(year, month, day);
      if (date.getMonth() !== month) continue;
    }
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
