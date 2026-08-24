// Task 46 Phase 1 — the arithmetic for the four `scheduled` repeat modes. Pure functions, literal
// dates, no clock and no database: a month boundary, a year boundary and a DST crossing are all
// ordinary test cases here.
//
// FIXTURE CALENDAR (all real, all checked):
//   2026-08-03 Mon.  Wednesdays: Aug 5/12/19/26 (FOUR), Sep 2/9/16/23/30 (FIVE),
//   Oct 7/14/21/28, Nov 4/11/18/25, Dec 2/9/16/23/30 (FIVE), 2027 Jan 6/13/20/27.
//   The four- vs five-Wednesday pair (Aug vs Sep 2026) is what makes 'last' testable.

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

describe("ordinal — '1st & 3rd Wednesday'", () => {
  const firstAndThirdWed: ScheduleSpec = {
    scheduledDays: ['wednesday'],
    repeat: { mode: 'ordinal', ordinals: [1, 3] },
    anchor: MONDAY,
  };

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

  it("'last' equals the 4th in a four-Wednesday month", () => {
    const spec = (ordinals: (1 | 2 | 3 | 4 | 'last')[]): ScheduleSpec => ({
      scheduledDays: ['wednesday'],
      repeat: { mode: 'ordinal', ordinals },
      anchor: MONDAY,
    });
    // August 2026 has exactly four Wednesdays: 5, 12, 19, 26.
    expect(nextScheduledOnOrAfter('2026-08-20', spec(['last']))).toBe('2026-08-26');
    expect(nextScheduledOnOrAfter('2026-08-20', spec([4]))).toBe('2026-08-26');
  });

  it("'last' equals the FIFTH in a five-Wednesday month, where the 4th does not", () => {
    const spec = (ordinals: (1 | 2 | 3 | 4 | 'last')[]): ScheduleSpec => ({
      scheduledDays: ['wednesday'],
      repeat: { mode: 'ordinal', ordinals },
      anchor: MONDAY,
    });
    // September 2026 has five Wednesdays: 2, 9, 16, 23, 30.
    expect(nextScheduledOnOrAfter('2026-09-17', spec(['last']))).toBe('2026-09-30');
    expect(nextScheduledOnOrAfter('2026-09-17', spec([4]))).toBe('2026-09-23');
  });

  it('sorts a multi-weekday, multi-ordinal month into date order', () => {
    const spec: ScheduleSpec = {
      scheduledDays: ['monday', 'friday'],
      repeat: { mode: 'ordinal', ordinals: [1, 'last'] },
      anchor: MONDAY,
    };
    // Aug 2026 Mondays: 3, 10, 17, 24, 31 (last = 31). Fridays: 7, 14, 21, 28 (last = 28).
    expect(sequence(MONDAY, spec, 4)).toEqual([
      '2026-08-03', // 1st Monday
      '2026-08-07', // 1st Friday
      '2026-08-28', // last Friday
      '2026-08-31', // last Monday
    ]);
  });

  it('strides whole months, crossing a year boundary', () => {
    const everyOtherMonth: ScheduleSpec = {
      scheduledDays: ['wednesday'],
      repeat: { mode: 'ordinal', ordinals: [1], months: 2 },
      anchor: '2026-11-02', // created in November: on-months are Nov, Jan, Mar…
    };
    expect(sequence('2026-11-02', everyOtherMonth, 3)).toEqual([
      '2026-11-04',
      '2027-01-06',
      '2027-03-03',
    ]);
  });

  it('names no occurrence without days or without ordinals', () => {
    expect(
      nextScheduledOnOrAfter(MONDAY, {
        scheduledDays: [],
        repeat: { mode: 'ordinal', ordinals: [1] },
        anchor: MONDAY,
      }),
    ).toBeNull();
    expect(
      nextScheduledOnOrAfter(MONDAY, {
        scheduledDays: ['wednesday'],
        repeat: { mode: 'ordinal', ordinals: [], months: 1 },
        anchor: MONDAY,
      }),
    ).toBeNull();
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
    scheduledDays: ['wednesday'],
    repeat: { mode: 'ordinal', ordinals: [1, 3] },
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
      scheduledDays: ['sunday'],
      repeat: { mode: 'ordinal', ordinals: [2, 'last'] },
      anchor: '2027-03-01',
    };
    // March 2027 Sundays: 7, 14, 21, 28 — the 2nd IS the US transition, the last IS the EU one.
    expect(sequence('2027-03-01', spec, 2)).toEqual(['2027-03-14', '2027-03-28']);
    // November 2027 Sundays: 7, 14, 21, 28 — the 1st is the US fall-back.
    expect(nextScheduledOnOrAfter('2027-11-01', { ...spec, repeat: { mode: 'ordinal', ordinals: [1] } })).toBe(
      '2027-11-07',
    );
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
