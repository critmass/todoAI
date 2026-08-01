// Task 36 — the calendar arithmetic under the period engine. Pure functions, no database, no
// clock: everything here takes a literal date, which is what lets a DST crossing be an ordinary
// test case instead of a March surprise.

import {
  addDays,
  addPeriod,
  calendarDateOfTimestamp,
  compareDates,
  isCalendarDate,
  localCalendarDate,
  nextOccurrenceAfter,
  nextOccurrenceOnOrAfter,
  rollBoundaryPast,
  weekdayOf,
} from '../period';

describe('calendar dates', () => {
  it('accepts real dates and rejects malformed or impossible ones', () => {
    expect(isCalendarDate('2026-07-31')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true); // leap year
    expect(isCalendarDate('2026-02-30')).toBe(false); // overflows into March
    expect(isCalendarDate('2026-7-31')).toBe(false);
    expect(isCalendarDate('2026-07-31 09:00:00')).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it('orders lexicographically, which is why the format is worth keeping', () => {
    expect(compareDates('2026-07-31', '2026-08-01')).toBe(-1);
    expect(compareDates('2026-08-01', '2026-07-31')).toBe(1);
    expect(compareDates('2026-08-01', '2026-08-01')).toBe(0);
  });

  it('names weekdays correctly, including across a month end', () => {
    expect(weekdayOf('2026-07-31')).toBe('friday');
    expect(weekdayOf('2026-08-01')).toBe('saturday');
    expect(weekdayOf('2026-08-03')).toBe('monday');
  });

  it('reads the date out of a stored DATETIME, and refuses a junk one', () => {
    expect(calendarDateOfTimestamp('2026-07-31 14:05:09')).toBe('2026-07-31');
    expect(calendarDateOfTimestamp('2026-07-31')).toBe('2026-07-31');
    expect(calendarDateOfTimestamp(null)).toBeNull();
    expect(calendarDateOfTimestamp('not a date')).toBeNull();
  });

  it('converts an instant to the DEVICE-local date, not the UTC one', () => {
    // Whatever zone this runs in, the answer must agree with the local calendar — a user west of
    // UTC must not get tomorrow's date all evening (the bug `toISOString().slice(0,10)` causes).
    const instant = Date.now();
    const local = new Date(instant);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
      local.getDate(),
    ).padStart(2, '0')}`;
    expect(localCalendarDate(instant)).toBe(expected);
  });
});

describe('addDays / addPeriod', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('adds one day / one week / one calendar month', () => {
    expect(addPeriod('2026-07-31', 'day')).toBe('2026-08-01');
    expect(addPeriod('2026-07-31', 'week')).toBe('2026-08-07');
    expect(addPeriod('2026-07-31', 'month')).toBe('2026-08-31');
  });

  it('clamps a monthly period to the end of a short month instead of overflowing', () => {
    // Plain setUTCMonth would give 2026-03-03 here, walking the boundary further into the next
    // month every February.
    expect(addPeriod('2026-01-31', 'month')).toBe('2026-02-28');
    expect(addPeriod('2028-01-31', 'month')).toBe('2028-02-29'); // leap year
    expect(addPeriod('2026-12-15', 'month')).toBe('2027-01-15');
  });
});

// The DST cases. These are the ones the brief asks to write down now rather than discover in March
// (§3d). US DST 2027: forward 14 March, back 7 November. EU: forward 28 March, back 31 October.
describe('DST transitions', () => {
  it('a weekly period crossing spring-forward advances exactly seven calendar days', () => {
    expect(addPeriod('2027-03-10', 'week')).toBe('2027-03-17'); // spans 14 March (23-hour day)
    expect(addPeriod('2027-03-24', 'week')).toBe('2027-03-31'); // spans 28 March (EU)
  });

  it('a weekly period crossing fall-back advances exactly seven calendar days', () => {
    expect(addPeriod('2027-11-03', 'week')).toBe('2027-11-10'); // spans 7 November (25-hour day)
    expect(addPeriod('2027-10-28', 'week')).toBe('2027-11-04'); // spans 31 October (EU)
  });

  it('the transition day itself is an ordinary day to every helper', () => {
    expect(addDays('2027-03-13', 1)).toBe('2027-03-14');
    expect(addDays('2027-03-14', 1)).toBe('2027-03-15');
    expect(weekdayOf('2027-03-14')).toBe('sunday');
    expect(nextOccurrenceOnOrAfter('2027-03-13', ['monday'])).toBe('2027-03-15');
  });

  it('a daily period crosses both transitions without skipping or repeating a day', () => {
    const days: string[] = [];
    let cursor = '2027-03-13';
    for (let i = 0; i < 3; i++) {
      cursor = addPeriod(cursor, 'day');
      days.push(cursor);
    }
    expect(days).toEqual(['2027-03-14', '2027-03-15', '2027-03-16']);

    let back = '2027-11-06';
    const fallDays: string[] = [];
    for (let i = 0; i < 3; i++) {
      back = addPeriod(back, 'day');
      fallDays.push(back);
    }
    expect(fallDays).toEqual(['2027-11-07', '2027-11-08', '2027-11-09']);
  });

  it('is the reason the engine never does millisecond arithmetic on instants', () => {
    // What a naive `+7 * 24h` on a LOCAL instant would produce across spring-forward: 23 hours of
    // wall clock short of the target midnight, i.e. the previous day. Pinned as documentation of
    // the hazard the calendar-date design avoids by construction.
    const localMidnight = new Date(2027, 2, 10).getTime(); // 10 March 2027, local
    const naive = new Date(localMidnight + 7 * 24 * 60 * 60 * 1000);
    const naiveDate = `${naive.getFullYear()}-${String(naive.getMonth() + 1).padStart(2, '0')}-${String(
      naive.getDate(),
    ).padStart(2, '0')}`;
    const correct = addPeriod('2027-03-10', 'week');
    // In a DST-observing zone the naive result lands on 16 March at 23:00; in UTC it is exact.
    // Either way the calendar answer is the one the engine uses.
    expect(correct).toBe('2027-03-17');
    expect(['2027-03-16', '2027-03-17']).toContain(naiveDate);
  });
});

describe('nextOccurrenceOnOrAfter', () => {
  // 2026-08-03 is a Monday.
  it('returns the day itself when today is a scheduled day', () => {
    expect(nextOccurrenceOnOrAfter('2026-08-03', ['monday'])).toBe('2026-08-03');
  });

  it('finds the nearest scheduled day of a multi-day schedule', () => {
    const days = ['monday', 'wednesday', 'friday'] as const;
    expect(nextOccurrenceOnOrAfter('2026-08-04', days)).toBe('2026-08-05'); // Tue -> Wed
    expect(nextOccurrenceOnOrAfter('2026-08-06', days)).toBe('2026-08-07'); // Thu -> Fri
    expect(nextOccurrenceOnOrAfter('2026-08-08', days)).toBe('2026-08-10'); // Sat -> Mon (next week)
  });

  it('wraps a full week for a single-day schedule', () => {
    expect(nextOccurrenceOnOrAfter('2026-08-04', ['monday'])).toBe('2026-08-10');
  });

  it('returns null rather than inventing a day when the schedule names none', () => {
    expect(nextOccurrenceOnOrAfter('2026-08-03', [])).toBeNull();
    expect(nextOccurrenceAfter('2026-08-03', [])).toBeNull();
  });

  it('nextOccurrenceAfter always moves strictly forward', () => {
    expect(nextOccurrenceAfter('2026-08-03', ['monday'])).toBe('2026-08-10');
    expect(nextOccurrenceAfter('2026-08-03', ['monday', 'tuesday'])).toBe('2026-08-04');
  });
});

describe('rollBoundaryPast', () => {
  it('does nothing while the boundary is still ahead', () => {
    expect(rollBoundaryPast('2026-08-10', 'week', '2026-08-03')).toEqual({
      boundary: '2026-08-10',
      periodsElapsed: 0,
    });
  });

  it('rolls once when exactly one period has elapsed', () => {
    expect(rollBoundaryPast('2026-08-03', 'week', '2026-08-03')).toEqual({
      boundary: '2026-08-10',
      periodsElapsed: 1,
    });
  });

  it('lands on the CURRENT period in one call after a long absence, however long', () => {
    // Three weeks away. The result is the period containing today - not three separate rollovers
    // to bookkeep, which is the structural half of "missed occurrences reset" (§4.2).
    expect(rollBoundaryPast('2026-08-03', 'week', '2026-08-24')).toEqual({
      boundary: '2026-08-31',
      periodsElapsed: 4,
    });
    expect(rollBoundaryPast('2026-01-05', 'month', '2026-07-31')).toEqual({
      boundary: '2026-08-05',
      periodsElapsed: 7,
    });
  });

  it('treats the boundary as exclusive: the day it names belongs to the NEW period', () => {
    const { boundary, periodsElapsed } = rollBoundaryPast('2026-08-03', 'day', '2026-08-03');
    expect(periodsElapsed).toBe(1);
    expect(boundary).toBe('2026-08-04');
  });
});
