// Task 46 Phase 1 — the arithmetic for the four `scheduled` repeat modes. Pure functions, literal
// dates, no clock and no database: a month boundary, a year boundary and a DST crossing are all
// ordinary test cases here.
//
// FIXTURE CALENDAR (all real, all checked):
//   2026-08-03 Mon.  Wednesdays: Aug 5/12/19/26 (FOUR), Sep 2/9/16/23/30 (FIVE),
//   Oct 7/14/21/28, Nov 4/11/18/25, Dec 2/9/16/23/30 (FIVE), 2027 Jan 6/13/20/27.
//   Mondays: Aug 3/10/17/24/31 (FIVE), Sep 7/14/21/28 (FOUR), Oct 5/12/19/26.
//   The four- vs five-Wednesday pair (Aug vs Sep 2026) is what makes 'last' — and the literal
//   5th, which is NOT the same thing — testable.

import type { Ordinal, OrdinalCell, Weekday } from '../../../types/domain';
import {
  nextScheduledAfter,
  nextScheduledOnOrAfter,
  type ScheduleSpec,
} from '../period';

const MONDAY = '2026-08-03';

/** Walks a schedule forward, collecting `count` consecutive occurrences from `start`. */
function sequence(start: string, spec: ScheduleSpec, count: number): string[] {
  const out: string[] = [];
  let cursor = nextScheduledOnOrAfter(start, spec);
  while (cursor !== null && out.length < count) {
    out.push(cursor);
    cursor = nextScheduledAfter(cursor, spec);
  }
  return out;
}

describe('everyWeek — the default, and it must stay byte-identical to pre-task-46', () => {
  const days = ['monday', 'wednesday', 'friday'] as const;

  it('an ABSENT repeat behaves exactly as the old weekday-only schedule did', () => {
    // The alpha DB's three recurring rows have no `repeat` key at all. Absent === everyWeek.
    const spec: ScheduleSpec = { scheduledDays: days, anchor: MONDAY };
    expect(nextScheduledOnOrAfter('2026-08-04', spec)).toBe('2026-08-05'); // Tue -> Wed
    expect(nextScheduledOnOrAfter('2026-08-08', spec)).toBe('2026-08-10'); // Sat -> Mon
    expect(nextScheduledOnOrAfter('2026-08-03', spec)).toBe('2026-08-03'); // today counts
    expect(nextScheduledAfter('2026-08-03', spec)).toBe('2026-08-05'); // strictly forward
  });

  it('an EXPLICIT everyWeek is the same schedule, occurrence for occurrence', () => {
    const implicit: ScheduleSpec = { scheduledDays: days, anchor: MONDAY };
    const explicit: ScheduleSpec = { scheduledDays: days, repeat: { mode: 'everyWeek' }, anchor: MONDAY };
    expect(sequence(MONDAY, explicit, 10)).toEqual(sequence(MONDAY, implicit, 10));
  });

  it('still refuses to invent a day when the schedule names none', () => {
    expect(nextScheduledOnOrAfter(MONDAY, { scheduledDays: [], anchor: MONDAY })).toBeNull();
    expect(
      nextScheduledOnOrAfter(MONDAY, { scheduledDays: [], repeat: { mode: 'everyWeek' }, anchor: MONDAY }),
    ).toBeNull();
  });
});

describe("interval — 'every other Wednesday'", () => {
  const everyOtherWed: ScheduleSpec = {
    scheduledDays: ['wednesday'],
    repeat: { mode: 'interval', weeks: 2 },
    anchor: MONDAY, // task created Mon 3 Aug 2026
  };

  it('fires on alternate weeks, counted from the task’s creation date', () => {
    expect(sequence(MONDAY, everyOtherWed, 6)).toEqual([
      '2026-08-05',
      '2026-08-19',
      '2026-09-02',
      '2026-09-16',
      '2026-09-30',
      '2026-10-14',
    ]);
  });

  it('ignores month boundaries entirely — the stride just keeps counting fortnights', () => {
    // Sep 30 -> Oct 14 crosses a month end with no reset. This is the property that makes it a
    // DIFFERENT schedule from "1st & 3rd Wednesday" (see the drift test below).
    expect(nextScheduledAfter('2026-09-30', everyOtherWed)).toBe('2026-10-14');
    expect(nextScheduledAfter('2026-12-23', everyOtherWed)).toBe('2027-01-06'); // and a year end
  });

  it('skips an OFF week rather than firing in it', () => {
    // Wed 12 Aug is in an off week; asking on that very day must give the 19th, not the 12th.
    expect(nextScheduledOnOrAfter('2026-08-12', everyOtherWed)).toBe('2026-08-19');
  });

  it('weeks: 1 collapses to plain weekly', () => {
    const weekly: ScheduleSpec = {
      scheduledDays: ['wednesday'],
      repeat: { mode: 'interval', weeks: 1 },
      anchor: MONDAY,
    };
    expect(sequence(MONDAY, weekly, 4)).toEqual([
      '2026-08-05',
      '2026-08-12',
      '2026-08-19',
      '2026-08-26',
    ]);
  });

  it('handles a three-week stride and a multi-day schedule inside the on-week', () => {
    const spec: ScheduleSpec = {
      scheduledDays: ['tuesday', 'thursday'],
      repeat: { mode: 'interval', weeks: 3 },
      anchor: MONDAY,
    };
    expect(sequence(MONDAY, spec, 6)).toEqual([
      '2026-08-04', // on-week 0
      '2026-08-06',
      '2026-08-25', // on-week 3
      '2026-08-27',
      '2026-09-15', // on-week 6
      '2026-09-17',
    ]);
  });

  it('changes phase when the anchor changes — that IS the creation-date anchoring', () => {
    const laterAnchor: ScheduleSpec = { ...everyOtherWed, anchor: '2026-08-10' };
    // Created a week later, so the on-weeks are the other ones.
    expect(sequence('2026-08-10', laterAnchor, 3)).toEqual([
      '2026-08-12',
      '2026-08-26',
      '2026-09-09',
    ]);
  });

  it('names no occurrence for a schedule with no days', () => {
    expect(
      nextScheduledOnOrAfter(MONDAY, {
        scheduledDays: [],
        repeat: { mode: 'interval', weeks: 2 },
        anchor: MONDAY,
      }),
    ).toBeNull();
  });
});

describe('ordinal — the editor’s 6×7 grid, as (ordinal, weekday) CELLS', () => {
  // The control is a grid: columns Sunday–Saturday, rows 1st/2nd/3rd/4th/5th/Last, and EACH
  // TICKED CELL IS ONE OCCURRENCE. The weekday therefore lives inside the cell; `scheduledDays`
  // plays no part in this mode at all and is required empty on write. The mixed-cell test below is
  // the case the amendment exists for — a cross product of ordinals × weekdays cannot express it.
  const cell = (ordinal: Ordinal, weekday: Weekday): OrdinalCell => ({ ordinal, weekday });
  const grid = (cells: OrdinalCell[], months?: number): ScheduleSpec => ({
    scheduledDays: [],
    repeat: months === undefined ? { mode: 'ordinal', cells } : { mode: 'ordinal', cells, months },
    anchor: MONDAY,
  });
  /** Every occurrence inside one 'YYYY-MM' month — the direct way to say "exactly these and no
   *  others", which is what a grid of ticked boxes promises. */
  const inMonth = (spec: ScheduleSpec, month: string): string[] =>
    sequence(`${month}-01`, spec, 12).filter(date => date.startsWith(month));

  const firstAndThirdWed = grid([cell(1, 'wednesday'), cell(3, 'wednesday')]);

  it('resets every month: the 1st and 3rd Wednesday of each one', () => {
    expect(sequence(MONDAY, firstAndThirdWed, 8)).toEqual([
      '2026-08-05',
      '2026-08-19',
      '2026-09-02',
      '2026-09-16',
      '2026-10-07',
      '2026-10-21',
      '2026-11-04',
      '2026-11-18',
    ]);
  });

  it('🔴 mixes cells freely: 1st Monday + 3rd Wednesday is TWO occurrences a month, not four', () => {
    // THE CASE THIS AMENDMENT EXISTS FOR. Phase 1's cross product (`[1,3] × [Mon,Wed]`) had to
    // fabricate the 1st Wednesday and the 3rd Monday — two cells the user never ticked. Asserting
    // the WHOLE month, rather than one next-occurrence, is what makes the absent two absent.
    const spec = grid([cell(1, 'monday'), cell(3, 'wednesday')]);
    expect(inMonth(spec, '2026-08')).toEqual(['2026-08-03', '2026-08-19']);
    expect(inMonth(spec, '2026-09')).toEqual(['2026-09-07', '2026-09-16']);
    expect(inMonth(spec, '2026-10')).toEqual(['2026-10-05', '2026-10-21']);
    // Named explicitly, because these are exactly the dates the old shape invented:
    expect(inMonth(spec, '2026-08')).not.toContain('2026-08-05'); // 1st Wednesday
    expect(inMonth(spec, '2026-08')).not.toContain('2026-08-17'); // 3rd Monday
  });

  it("🔴 a literal 5th and 'last' are DIFFERENT ordinals, across both shapes of month", () => {
    // Aug 2026 has FOUR Wednesdays (5, 12, 19, 26); Sep 2026 has FIVE (2, 9, 16, 23, 30). Both
    // ordinals are wanted, and this is the assertion that stops a later "simplification" folding
    // one into the other.
    const fifth = grid([cell(5, 'wednesday')]);
    const last = grid([cell('last', 'wednesday')]);

    // In a FIVE-Wednesday month they resolve to the same date — which is precisely why they look
    // interchangeable.
    expect(nextScheduledOnOrAfter('2026-09-01', fifth)).toBe('2026-09-30');
    expect(nextScheduledOnOrAfter('2026-09-01', last)).toBe('2026-09-30');

    // In a FOUR-Wednesday month they do not. 'last' lands on the 4th Wednesday; the literal 5th
    // does not fire AT ALL that month and waits for one that has a fifth.
    expect(inMonth(last, '2026-08')).toEqual(['2026-08-26']);
    expect(inMonth(fifth, '2026-08')).toEqual([]);
    expect(nextScheduledOnOrAfter('2026-08-01', fifth)).toBe('2026-09-30');

    // So they are not the same schedule over any stretch: 'last' fires every month, the 5th only
    // in the months that have one.
    expect(sequence('2026-08-01', last, 6)).toEqual([
      '2026-08-26',
      '2026-09-30',
      '2026-10-28',
      '2026-11-25',
      '2026-12-30',
      '2027-01-27',
    ]);
    expect(sequence('2026-08-01', fifth, 4)).toEqual([
      '2026-09-30',
      '2026-12-30',
      '2027-03-31',
      '2027-06-30',
    ]);
  });

  it('a literal 5th on a month stride waits as long as it has to, rather than giving up', () => {
    // On-months every 3rd from Aug 2026: Aug/Nov 26, Feb/May/Aug/Nov 27, Feb/May 28 — and the
    // first of those with a fifth Wednesday is May 2028. A scan that tried only the next couple of
    // on-months would answer "never" here, which is why the horizon is generous.
    const quarterlyFifthWed = grid([cell(5, 'wednesday')], 3);
    expect(nextScheduledOnOrAfter(MONDAY, quarterlyFifthWed)).toBe('2028-05-31');
  });

  it("'last' equals the 4th in a four-Wednesday month", () => {
    // August 2026: 5, 12, 19, 26.
    expect(nextScheduledOnOrAfter('2026-08-20', grid([cell('last', 'wednesday')]))).toBe(
      '2026-08-26',
    );
    expect(nextScheduledOnOrAfter('2026-08-20', grid([cell(4, 'wednesday')]))).toBe('2026-08-26');
  });

  it("'last' equals the FIFTH in a five-Wednesday month, where the 4th does not", () => {
    // September 2026: 2, 9, 16, 23, 30.
    expect(nextScheduledOnOrAfter('2026-09-17', grid([cell('last', 'wednesday')]))).toBe(
      '2026-09-30',
    );
    expect(nextScheduledOnOrAfter('2026-09-17', grid([cell(4, 'wednesday')]))).toBe('2026-09-23');
  });

  it('collapses two cells that name the same date instead of firing twice', () => {
    // 4th and last ARE the same Wednesday in a four-Wednesday month; 5th and last are the same one
    // in a five-Wednesday month. Either way the day comes round once.
    expect(inMonth(grid([cell(4, 'wednesday'), cell('last', 'wednesday')]), '2026-08')).toEqual([
      '2026-08-26',
    ]);
    expect(inMonth(grid([cell(5, 'wednesday'), cell('last', 'wednesday')]), '2026-09')).toEqual([
      '2026-09-30',
    ]);
  });

  it('sorts a month’s ticked cells into date order, whatever order they were ticked in', () => {
    // Aug 2026 Mondays: 3, 10, 17, 24, 31 (last = 31). Fridays: 7, 14, 21, 28 (last = 28).
    const spec = grid([
      cell('last', 'monday'),
      cell(1, 'friday'),
      cell('last', 'friday'),
      cell(1, 'monday'),
    ]);
    expect(inMonth(spec, '2026-08')).toEqual([
      '2026-08-03', // 1st Monday
      '2026-08-07', // 1st Friday
      '2026-08-28', // last Friday
      '2026-08-31', // last Monday
    ]);
  });

  it('strides whole months, crossing a year boundary', () => {
    const everyOtherMonth: ScheduleSpec = {
      ...grid([cell(1, 'wednesday')], 2),
      anchor: '2026-11-02', // created in November: on-months are Nov, Jan, Mar…
    };
    expect(sequence('2026-11-02', everyOtherMonth, 3)).toEqual([
      '2026-11-04',
      '2027-01-06',
      '2027-03-03',
    ]);
  });

  it('takes its weekday from the CELL, never from scheduledDays', () => {
    // scheduledDays is used by everyWeek and interval only and must be empty here (both writers
    // refuse it, and a hand-edited row carrying one degrades to weekly on read). This pins the
    // arithmetic itself: even handed a stray list, the mode reads nothing but its cells.
    const stray: ScheduleSpec = { ...firstAndThirdWed, scheduledDays: ['friday'] };
    expect(sequence(MONDAY, stray, 6)).toEqual(sequence(MONDAY, firstAndThirdWed, 6));
  });

  it('names no occurrence when no cell is ticked', () => {
    expect(nextScheduledOnOrAfter(MONDAY, grid([]))).toBeNull();
    expect(nextScheduledOnOrAfter(MONDAY, { ...grid([]), scheduledDays: ['wednesday'] })).toBeNull();
  });
});

describe("dayOfMonth — 'the 15th'", () => {
  const fifteenth: ScheduleSpec = {
    scheduledDays: [],
    repeat: { mode: 'dayOfMonth', days: [15] },
    anchor: MONDAY,
  };

  it('fires on that date every month', () => {
    expect(sequence(MONDAY, fifteenth, 4)).toEqual([
      '2026-08-15',
      '2026-09-15',
      '2026-10-15',
      '2026-11-15',
    ]);
  });

  it('handles several days a month, in date order', () => {
    const spec: ScheduleSpec = {
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [15, 1] },
      anchor: MONDAY,
    };
    expect(sequence(MONDAY, spec, 4)).toEqual([
      '2026-08-15',
      '2026-09-01',
      '2026-09-15',
      '2026-10-01',
    ]);
  });

  it('CLAMPS 29/30/31 to the last day of a short month rather than skipping it', () => {
    // The product choice (brief §3): a rent reminder that silently skips February is the worse
    // failure. "The 31st" fires on 28 Feb 2027, and on 29 Feb in a leap year.
    const thirtyFirst: ScheduleSpec = {
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [31] },
      anchor: '2027-01-01',
    };
    expect(sequence('2027-01-01', thirtyFirst, 5)).toEqual([
      '2027-01-31',
      '2027-02-28', // clamped — 2027 is not a leap year
      '2027-03-31',
      '2027-04-30', // clamped
      '2027-05-31',
    ]);
    expect(nextScheduledOnOrAfter('2028-02-01', { ...thirtyFirst, anchor: '2028-01-01' })).toBe(
      '2028-02-29', // leap year
    );
  });

  it('collapses days that clamp onto the same date instead of firing twice', () => {
    const spec: ScheduleSpec = {
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [30, 31] },
      anchor: '2027-02-01',
    };
    expect(sequence('2027-02-01', spec, 3)).toEqual([
      '2027-02-28', // both 30 and 31 clamp here — one occurrence, not two
      '2027-03-30',
      '2027-03-31',
    ]);
  });

  it('strides whole months, crossing a year boundary', () => {
    const quarterly: ScheduleSpec = {
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [15], months: 3 },
      anchor: '2026-11-01',
    };
    expect(sequence('2026-11-01', quarterly, 3)).toEqual([
      '2026-11-15',
      '2027-02-15',
      '2027-05-15',
    ]);
  });

  it('names no occurrence when no days are given', () => {
    expect(
      nextScheduledOnOrAfter(MONDAY, {
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [] },
        anchor: MONDAY,
      }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The test this task exists to make permanent (brief §5).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('“every other Wednesday” is NOT “1st & 3rd Wednesday”', () => {
  const anchor = MONDAY;
  const fortnightly: ScheduleSpec = {
    scheduledDays: ['wednesday'],
    repeat: { mode: 'interval', weeks: 2 },
    anchor,
  };
  const firstAndThird: ScheduleSpec = {
    // Two ticked cells — the same schedule the cross product used to spell `[1,3] × [Wednesday]`.
    scheduledDays: [],
    repeat: {
      mode: 'ordinal',
      cells: [
        { ordinal: 1, weekday: 'wednesday' },
        { ordinal: 3, weekday: 'wednesday' },
      ],
    },
    anchor,
  };

  it('starts identically and then drifts apart — people habitually assume it never does', () => {
    const a = sequence(anchor, fortnightly, 12);
    const b = sequence(anchor, firstAndThird, 12);

    expect(a).not.toEqual(b); // the headline fact

    // They agree for the first four occurrences, which is exactly why the confusion is durable…
    expect(a.slice(0, 4)).toEqual(b.slice(0, 4));
    expect(a.slice(0, 4)).toEqual(['2026-08-05', '2026-08-19', '2026-09-02', '2026-09-16']);

    // …and then September's FIFTH Wednesday separates them permanently.
    expect(a[4]).toBe('2026-09-30'); // fortnightly: 14 days after 16 Sep, month irrelevant
    expect(b[4]).toBe('2026-10-07'); // ordinal: September is spent; the next 1st Wednesday
  });

  it('the ordinal schedule periodically leaves a THREE-week gap; the fortnightly one never does', () => {
    const gaps = (dates: string[]): number[] =>
      dates.slice(1).map((date, i) => Math.round((Date.parse(date) - Date.parse(dates[i])) / 86400000));

    const fortnightGaps = gaps(sequence(anchor, fortnightly, 12));
    const ordinalGaps = gaps(sequence(anchor, firstAndThird, 12));

    expect(new Set(fortnightGaps)).toEqual(new Set([14]));
    expect(ordinalGaps).toContain(21); // 16 Sep -> 7 Oct
    expect(ordinalGaps).toContain(14);
  });

  it('over six months they do not even fire the same NUMBER of times', () => {
    const until = (spec: ScheduleSpec, end: string): string[] => {
      const out: string[] = [];
      let cursor = nextScheduledOnOrAfter(anchor, spec);
      while (cursor !== null && cursor <= end) {
        out.push(cursor);
        cursor = nextScheduledAfter(cursor, spec);
      }
      return out;
    };
    const a = until(fortnightly, '2027-01-31');
    const b = until(firstAndThird, '2027-01-31');
    expect(a.length).toBe(13); // 26 weeks of fortnights
    expect(b.length).toBe(12); // 6 months x 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DST — the module's whole reason for being calendar arithmetic (brief §6).
// US 2027: forward 14 March, back 7 November. EU: forward 28 March, back 31 October.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('DST transitions, in every mode', () => {
  it('everyWeek lands on the right weekday across both transitions', () => {
    const spec: ScheduleSpec = { scheduledDays: ['sunday'], anchor: '2027-03-01' };
    expect(nextScheduledOnOrAfter('2027-03-08', spec)).toBe('2027-03-14'); // the 23-hour day
    expect(nextScheduledAfter('2027-03-14', spec)).toBe('2027-03-21');
    expect(nextScheduledOnOrAfter('2027-11-01', spec)).toBe('2027-11-07'); // the 25-hour day
  });

  it('interval keeps an exact 14-day stride across spring-forward and fall-back', () => {
    const spec: ScheduleSpec = {
      scheduledDays: ['sunday'],
      repeat: { mode: 'interval', weeks: 2 },
      anchor: '2027-03-01', // Monday
    };
    // On-weeks from 1 Mar: 1–7, 15–21, 29–4 Apr…  The transition days fall where they fall.
    expect(sequence('2027-03-01', spec, 4)).toEqual([
      '2027-03-07',
      '2027-03-21',
      '2027-04-04',
      '2027-04-18',
    ]);
    const fall: ScheduleSpec = { ...spec, anchor: '2027-10-25' };
    expect(sequence('2027-10-25', fall, 3)).toEqual(['2027-10-31', '2027-11-14', '2027-11-28']);
  });

  it('ordinal picks the same Sunday whether or not the clocks changed that day', () => {
    const spec: ScheduleSpec = {
      scheduledDays: [],
      repeat: {
        mode: 'ordinal',
        cells: [
          { ordinal: 2, weekday: 'sunday' },
          { ordinal: 'last', weekday: 'sunday' },
        ],
      },
      anchor: '2027-03-01',
    };
    // March 2027 Sundays: 7, 14, 21, 28 — the 2nd IS the US transition, the last IS the EU one.
    expect(sequence('2027-03-01', spec, 2)).toEqual(['2027-03-14', '2027-03-28']);
    // November 2027 Sundays: 7, 14, 21, 28 — the 1st is the US fall-back.
    expect(
      nextScheduledOnOrAfter('2027-11-01', {
        ...spec,
        repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'sunday' }] },
      }),
    ).toBe('2027-11-07');
  });

  it('dayOfMonth is unaffected: a calendar date has no hours to lose', () => {
    const spec: ScheduleSpec = {
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [14, 31] },
      anchor: '2027-03-01',
    };
    expect(sequence('2027-03-01', spec, 3)).toEqual(['2027-03-14', '2027-03-31', '2027-04-14']);
    expect(nextScheduledOnOrAfter('2027-11-01', { ...spec, repeat: { mode: 'dayOfMonth', days: [7] } })).toBe(
      '2027-11-07',
    );
  });
});
