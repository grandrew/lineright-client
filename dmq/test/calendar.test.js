import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDayNumber,
  parseMonthHeading,
  buildCandidateDates,
  shouldAdvanceMonth,
} from '../src/calendar.js';

test('extractDayNumber reads the day off a calendar button label', () => {
  assert.equal(extractDayNumber('15 Open Times'), 15);
  assert.equal(extractDayNumber('3  Open Times'), 3);
  assert.equal(extractDayNumber('7'), 7);
});

test('extractDayNumber rejects labels that are not days', () => {
  assert.equal(extractDayNumber('No Open Times'), null);
  assert.equal(extractDayNumber(''), null);
  assert.equal(extractDayNumber(undefined), null);
  assert.equal(extractDayNumber('99 Open Times'), null, '99 is not a valid day');
  assert.equal(extractDayNumber('0 Open Times'), null, '0 is not a valid day');
});

test('parseMonthHeading reads month and year from the calendar heading', () => {
  assert.deepEqual(parseMonthHeading('September 2026'), { year: 2026, month: 8 });
  assert.deepEqual(parseMonthHeading('Choose a date — November 2026'), { year: 2026, month: 10 });
  assert.equal(parseMonthHeading('no month here'), null);
  assert.equal(parseMonthHeading(null), null);
});

test('buildCandidateDates resolves days against the displayed month, not DATE_START', () => {
  // Regression test for the original bug: the calendar opens on the first month
  // with availability (November), while the requested window starts in September.
  const startDate = new Date(2026, 8, 1);   // 2026-09-01
  const endDate = new Date(2026, 11, 31);   // 2026-12-31
  const displayedMonth = { year: 2026, month: 10 }; // November

  const candidates = buildCandidateDates({
    dayLabels: ['20 Open Times', '25 Open Times'],
    displayedMonth,
    startDate,
    endDate,
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].date.getMonth(), 10, 'must be November, not September');
  assert.equal(candidates[0].date.getDate(), 20);
  assert.equal(candidates[1].date.getMonth(), 10);

  // The old formula: new Date(startDate.getFullYear(), startDate.getMonth(), day)
  const oldResult = new Date(startDate.getFullYear(), startDate.getMonth(), 20);
  assert.notDeepEqual(
    oldResult.getTime(),
    candidates[0].date.getTime(),
    'the previous behaviour produced a September date for a November slot'
  );
});

test('buildCandidateDates filters out dates outside the requested window', () => {
  const candidates = buildCandidateDates({
    dayLabels: ['1 Open Times', '10 Open Times', '28 Open Times'],
    displayedMonth: { year: 2026, month: 8 }, // September 2026
    startDate: new Date(2026, 8, 5),
    endDate: new Date(2026, 8, 20),
  });
  assert.deepEqual(candidates.map((c) => c.date.getDate()), [10]);
});

test('buildCandidateDates drops days that overflow the displayed month', () => {
  const candidates = buildCandidateDates({
    dayLabels: ['31 Open Times'], // September has 30 days
    displayedMonth: { year: 2026, month: 8 },
    startDate: new Date(2026, 0, 1),
    endDate: new Date(2027, 0, 1),
  });
  assert.equal(candidates.length, 0, '31 September must not roll over into October');
});

test('buildCandidateDates returns earliest first', () => {
  const candidates = buildCandidateDates({
    dayLabels: ['22 Open Times', '4 Open Times', '13 Open Times'],
    displayedMonth: { year: 2026, month: 8 },
    startDate: new Date(2026, 8, 1),
    endDate: new Date(2026, 8, 30),
  });
  assert.deepEqual(candidates.map((c) => c.date.getDate()), [4, 13, 22]);
});

test('buildCandidateDates refuses to guess the month', () => {
  assert.throws(
    () =>
      buildCandidateDates({
        dayLabels: ['5 Open Times'],
        displayedMonth: null,
        startDate: new Date(2026, 8, 1),
        endDate: new Date(2026, 8, 30),
      }),
    /displayedMonth is required/
  );
});

test('shouldAdvanceMonth is true only when the window runs past the shown month', () => {
  const displayedMonth = { year: 2026, month: 8 }; // September
  assert.equal(shouldAdvanceMonth({ displayedMonth, endDate: new Date(2026, 9, 5) }), true);
  assert.equal(shouldAdvanceMonth({ displayedMonth, endDate: new Date(2026, 8, 30) }), false);
});
