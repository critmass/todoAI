// Task 24 — the six-kind recurrence editor's model. The tests that matter here are the ones that
// pin constraint #7: "One-time" and "Ongoing" look like neighbours in a picker and have opposite
// completion semantics, and every one of the six kinds has to survive a round trip through the
// editor unchanged.

import type { OrdinalCell, Recurrence, Task } from '../../../types/domain';
import { recurrenceRepeatIssue } from '../../../types/domain';
import {
  GRID_WEEKDAYS,
  MONTH_DAYS,
  ORDINAL_ROWS,
  RECURRENCE_KINDS,
  describeRecurrence,
  draftFromRecurrence,
  draftFromTask,
  draftToWrite,
  emptyDraft,
  recurrenceFromDraft,
  recurrenceKindPatch,
  toggleMonthDay,
  toggleOrdinalCell,
  validateDraft,
  type TaskDraft,
} from '../taskDraft';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'Mix track',
    description: null,
    importance: 500,
    urgencyLevel: 3,
    nextDueAt: null,
    estimatedDuration: 25,
    durationSource: 'model_guess',
    actualDurationHistory: [],
    averageActualDuration: null,
    energyRequirement: 3,
    averageEnergyCost: 0,
    contextTags: [],
    toolRequirements: [],
    status: 'active',
    parentTaskId: null,
    createdAt: null,
    updatedAt: null,
    completionCount: 0,
    skipCount: 0,
    skipReasons: [],
    lastCompletedAt: null,
    successRate: 0,
    durationType: 'estimate',
    workState: 'none',
    accumulatedMinutes: 0,
    lastWorkedAt: null,
    ...overrides,
  };
}

describe('task draft (task 24)', () => {
  it('offers exactly the kinds the data model can express (task 46 phase 2: nine)', () => {
    expect(RECURRENCE_KINDS.map((entry) => entry.kind)).toEqual([
      'once',
      'schedule',
      'schedule_interval',
      'schedule_ordinal',
      'schedule_dates',
      'quota',
      'quota_schedule',
      'ongoing',
      'count',
    ]);
  });

  describe('constraint #7 — a one-off is not unscheduled', () => {
    it('"One-time" produces NO recurrence, not {type:"unscheduled"}', () => {
      const draft = { ...emptyDraft(), title: 'Renew passport', kind: 'once' as const };
      expect(draftToWrite(draft).recurrence).toBeUndefined();
    });

    it('"Ongoing" produces {type:"unscheduled"}', () => {
      const draft = { ...emptyDraft(), title: 'Tidy the desk', kind: 'ongoing' as const };
      expect(draftToWrite(draft).recurrence).toEqual({ type: 'unscheduled' });
    });

    it('a task with no recurrence row opens as "One-time", never as "Ongoing"', () => {
      expect(draftFromTask(task(), undefined).kind).toBe('once');
    });
  });

  describe('round trips', () => {
    const cases: Array<{ label: string; recurrence: Recurrence }> = [
      { label: 'scheduled', recurrence: { type: 'scheduled', scheduledDays: ['monday', 'friday'] } },
      { label: 'quota', recurrence: { type: 'quota', quota: 8, period: 'day' } },
      {
        label: 'scheduled_quota',
        recurrence: {
          type: 'scheduled_quota',
          quota: 3,
          period: 'week',
          scheduledDays: ['monday', 'wednesday', 'friday'],
        },
      },
      { label: 'unscheduled', recurrence: { type: 'unscheduled' } },
      { label: 'count', recurrence: { type: 'count', target: 10, progress: 3 } },
    ];

    it.each(cases)('$label survives the editor unchanged', ({ recurrence }) => {
      const draft = draftFromTask(task(), recurrence);
      expect(draftToWrite(draft).recurrence).toEqual(recurrence);
    });

    it('keeps a count task\'s progress rather than resetting it on save', () => {
      const draft = draftFromTask(task(), { type: 'count', target: 10, progress: 7 });
      expect(draftToWrite(draft).recurrence).toEqual({ type: 'count', target: 10, progress: 7 });
    });
  });

  describe('the task write', () => {
    it('marks a typed duration as user-sourced, not a model guess', () => {
      const draft = { ...emptyDraft(), title: 'Mix track', estimatedDuration: '40' };
      expect(draftToWrite(draft).taskWrite.durationSource).toBe('user');
      expect(draftToWrite(draft).taskWrite.estimatedDuration).toBe(40);
    });

    it('projects energy through scales rather than writing a label', () => {
      const draft = { ...emptyDraft(), title: 'Mix track', energy: 'high' as const };
      expect(draftToWrite(draft).taskWrite.energyRequirement).toBe(5);
    });

    it('open-ended work is floor-typed, so its estimate is a minimum', () => {
      const draft = { ...emptyDraft(), title: 'Write the thing', openEnded: true };
      expect(draftToWrite(draft).taskWrite.durationType).toBe('floor');
    });

    it('only a one-off carries a standalone due date', () => {
      const dated = { ...emptyDraft(), title: 'Taxes', kind: 'once' as const, dueDate: '2026-08-01' };
      expect(draftToWrite(dated).taskWrite.nextDueAt).toBe('2026-08-01');

      const repeating = {
        ...emptyDraft(),
        title: 'Stretch',
        kind: 'schedule' as const,
        scheduledDays: ['monday' as const],
        dueDate: '2026-08-01',
      };
      // Every other kind derives its timing from the recurrence; task 36 owns advancing it.
      expect(draftToWrite(repeating).taskWrite.nextDueAt).toBeNull();
    });
  });

  describe('validation', () => {
    it('needs a name and a believable duration', () => {
      const { errors } = validateDraft({ ...emptyDraft(), title: '  ', estimatedDuration: 'soon' });
      expect(errors.title).toBeDefined();
      expect(errors.estimatedDuration).toBeDefined();
    });

    it('asks for the numbers each kind actually needs', () => {
      expect(validateDraft({ ...emptyDraft(), title: 'x', kind: 'quota' }).errors.quota).toBeDefined();
      expect(validateDraft({ ...emptyDraft(), title: 'x', kind: 'count' }).errors.target).toBeDefined();
      expect(
        validateDraft({ ...emptyDraft(), title: 'x', kind: 'schedule' }).errors.days,
      ).toBeDefined();
    });

    it('is clean for a plain one-off', () => {
      expect(validateDraft({ ...emptyDraft(), title: 'Renew passport' }).errors).toEqual({});
    });

    it('refuses to build a write from an invalid draft', () => {
      expect(() => draftToWrite(emptyDraft())).toThrow(/not valid/);
    });
  });

  describe('list summaries', () => {
    it('describes each kind in plain words', () => {
      expect(describeRecurrence(undefined, task())).toBe('One-time');
      expect(describeRecurrence(undefined, task({ nextDueAt: '2026-08-01' }))).toBe('Due 2026-08-01');
      expect(describeRecurrence({ type: 'unscheduled' }, task())).toBe('Ongoing');
      expect(describeRecurrence({ type: 'quota', quota: 8, period: 'day' }, task())).toBe('8× a day');
      expect(describeRecurrence({ type: 'count', target: 10, progress: 3 }, task())).toBe(
        '3 of 10 times',
      );
      expect(
        describeRecurrence({ type: 'scheduled', scheduledDays: ['monday', 'friday'] }, task()),
      ).toBe('Every Mon/Fri');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Task 46 phase 2 — the four scheduled repeat modes reach the editor.
//
// The engine shipped in phase 1 was complete, tested and reachable by nobody: nothing in the app
// constructed a `repeat`. These tests pin the draft layer that now does, and the two rules that
// bite hardest if it gets them wrong — round-trip fidelity (Jason has three real recurring tasks
// in the live alpha DB) and the `scheduledDays` clearing rule (the repository THROWS on save if
// the editor leaves stale weekdays behind in a month-driven mode).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('task 46 phase 2 — the four scheduled repeat modes', () => {
  const legacyWeekly: Recurrence = { type: 'scheduled', scheduledDays: ['monday', 'friday'] };

  const modes: Array<{ label: string; recurrence: Recurrence }> = [
    { label: 'a legacy weekly schedule with NO repeat key', recurrence: legacyWeekly },
    {
      label: 'every 3 weeks, on Tuesdays',
      recurrence: {
        type: 'scheduled',
        scheduledDays: ['tuesday'],
        repeat: { mode: 'interval', weeks: 3 },
      },
    },
    {
      label: 'weeks of the month — a mixed grid, 1st Mon + 3rd Wed + last Fri',
      recurrence: {
        type: 'scheduled',
        scheduledDays: [],
        repeat: {
          mode: 'ordinal',
          cells: [
            { ordinal: 1, weekday: 'monday' },
            { ordinal: 3, weekday: 'wednesday' },
            { ordinal: 'last', weekday: 'friday' },
          ],
        },
      },
    },
    {
      label: 'weeks of the month, every 3 months, with a literal 5th',
      recurrence: {
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'ordinal', cells: [{ ordinal: 5, weekday: 'wednesday' }], months: 3 },
      },
    },
    {
      label: 'dates — the 1st and the 15th',
      recurrence: {
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [1, 15] },
      },
    },
    {
      label: 'dates, every 2 months',
      recurrence: {
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [31], months: 2 },
      },
    },
  ];

  describe('the dropdown carries every option, in the ruled order', () => {
    it('labels them exactly as ruled', () => {
      expect(RECURRENCE_KINDS.map((entry) => entry.label)).toEqual([
        'One-time',
        'Weekly',
        'Every N weeks',
        'Weeks of the month',
        'Dates',
        'Quota',
        'Quota + days',
        'Ongoing',
        'N times total',
      ]);
    });
  });

  describe('🔴 round-trip fidelity — opening a task and saving it untouched changes nothing', () => {
    it.each(modes)('$label survives the editor unchanged', ({ recurrence }) => {
      expect(recurrenceFromDraft(draftFromRecurrence(recurrence))).toEqual(recurrence);
    });

    it.each(modes)('$label round-trips to something the repository accepts', ({ recurrence }) => {
      const saved = recurrenceFromDraft(draftFromRecurrence(recurrence)) as Recurrence;
      expect(recurrenceRepeatIssue(saved)).toBeNull();
    });

    it('🔴 adds NO repeat key to a legacy weekly row — not even {mode:"everyWeek"}', () => {
      const saved = recurrenceFromDraft(draftFromRecurrence(legacyWeekly)) as Recurrence;
      expect('repeat' in saved).toBe(false);
      expect(Object.keys(saved).sort()).toEqual(['scheduledDays', 'type']);
    });

    it('normalises an EXPLICIT everyWeek back to the absent-key shape, as the repository does', () => {
      const explicit: Recurrence = {
        type: 'scheduled',
        scheduledDays: ['monday'],
        repeat: { mode: 'everyWeek' },
      };
      const saved = recurrenceFromDraft(draftFromRecurrence(explicit)) as Recurrence;
      expect(saved).toEqual({ type: 'scheduled', scheduledDays: ['monday'] });
      expect('repeat' in saved).toBe(false);
    });

    it('normalises an explicit months:1 to absent — one canonical shape for "every month"', () => {
      const explicit: Recurrence = {
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [4], months: 1 },
      };
      const saved = recurrenceFromDraft(draftFromRecurrence(explicit)) as Recurrence;
      expect(saved).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [4] },
      });
    });

    it.each(modes)('$label survives the WHOLE editor — draftFromTask → draftToWrite', ({ recurrence }) => {
      const draft = draftFromTask(task({ title: 'Water the plants' }), recurrence);
      expect(draftToWrite(draft).recurrence).toEqual(recurrence);
    });

    it('opens each mode as its own dropdown option rather than as plain Weekly', () => {
      expect(modes.map(({ recurrence }) => draftFromRecurrence(recurrence).kind)).toEqual([
        'schedule',
        'schedule_interval',
        'schedule_ordinal',
        'schedule_ordinal',
        'schedule_dates',
        'schedule_dates',
      ]);
    });
  });

  describe('🔴 switching into a month-driven mode clears scheduledDays', () => {
    const weekly = {
      ...emptyDraft(),
      title: 'Water the plants',
      kind: 'schedule' as const,
      scheduledDays: ['monday' as const, 'thursday' as const],
    };

    it('clears the weekdays when the user picks Weeks of the month', () => {
      expect(recurrenceKindPatch('schedule_ordinal')).toEqual({
        kind: 'schedule_ordinal',
        scheduledDays: [],
      });
    });

    it('clears the weekdays when the user picks Dates', () => {
      expect(recurrenceKindPatch('schedule_dates')).toEqual({
        kind: 'schedule_dates',
        scheduledDays: [],
      });
    });

    it('KEEPS the weekdays for Every N weeks, which is weekday-driven', () => {
      expect(recurrenceKindPatch('schedule_interval')).toEqual({
        kind: 'schedule_interval',
      });
    });

    it('🔴 weekdays picked under Weekly, switched to Dates, then SAVED — succeeds', () => {
      let draft: TaskDraft = { ...weekly };
      draft = { ...draft, ...recurrenceKindPatch('schedule_dates') };
      draft = { ...draft, monthDays: toggleMonthDay(toggleMonthDay(draft.monthDays, 1), 15) };

      expect(validateDraft(draft).errors).toEqual({});
      const { recurrence } = draftToWrite(draft);
      expect(recurrence).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [1, 15] },
      });
      // The predicate the repository itself refuses to write against, on create AND on update.
      expect(recurrenceRepeatIssue(recurrence as Recurrence)).toBeNull();
    });

    it('belt and braces: a draft that still carries stale weekdays emits none anyway', () => {
      const stale = {
        ...weekly,
        kind: 'schedule_ordinal' as const,
        ordinalCells: [{ ordinal: 1 as const, weekday: 'monday' as const }],
      };
      const saved = recurrenceFromDraft(stale) as Recurrence;
      expect(saved).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'monday' }] },
      });
      expect(recurrenceRepeatIssue(saved)).toBeNull();
    });
  });

  describe('validation asks for what each new mode actually needs', () => {
    const named = { ...emptyDraft(), title: 'Water the plants' };

    it('Every N weeks needs both days and a whole interval ≥ 1', () => {
      const bad = validateDraft({
        ...named,
        kind: 'schedule_interval',
        scheduledDays: [],
        weekInterval: '0',
      });
      expect(bad.errors.days).toBeDefined();
      expect(bad.errors.weekInterval).toBeDefined();

      const good = validateDraft({
        ...named,
        kind: 'schedule_interval',
        scheduledDays: ['tuesday'],
        weekInterval: '3',
      });
      expect(good.errors).toEqual({});
    });

    it('Weeks of the month needs at least one ticked cell', () => {
      expect(
        validateDraft({ ...named, kind: 'schedule_ordinal', ordinalCells: [] }).errors.cells,
      ).toBeDefined();
      expect(
        validateDraft({
          ...named,
          kind: 'schedule_ordinal',
          ordinalCells: [{ ordinal: 'last', weekday: 'friday' }],
        }).errors,
      ).toEqual({});
    });

    it('Dates needs at least one ticked date', () => {
      expect(
        validateDraft({ ...named, kind: 'schedule_dates', monthDays: [] }).errors.monthDays,
      ).toBeDefined();
      expect(validateDraft({ ...named, kind: 'schedule_dates', monthDays: [15] }).errors).toEqual(
        {},
      );
    });

    it('a month stride must be a whole number ≥ 1, in both month-driven modes', () => {
      expect(
        validateDraft({
          ...named,
          kind: 'schedule_dates',
          monthDays: [15],
          monthInterval: 'every so often',
        }).errors.monthInterval,
      ).toBeDefined();
      expect(
        validateDraft({
          ...named,
          kind: 'schedule_ordinal',
          ordinalCells: [{ ordinal: 1, weekday: 'monday' }],
          monthInterval: '0',
        }).errors.monthInterval,
      ).toBeDefined();
    });

    it('does not ask a weekly task for an interval, a cell or a date', () => {
      expect(
        validateDraft({ ...named, kind: 'schedule', scheduledDays: ['monday'], weekInterval: '' })
          .errors,
      ).toEqual({});
    });

    it('refuses to build a write from an empty grid', () => {
      expect(() => draftToWrite({ ...named, kind: 'schedule_ordinal' })).toThrow(/not valid/);
    });
  });

  describe('the two grids', () => {
    it('offers 6 ordinal rows and 7 weekday columns, Sunday-first', () => {
      expect(ORDINAL_ROWS.map((row) => row.label)).toEqual([
        '1st',
        '2nd',
        '3rd',
        '4th',
        '5th',
        'Last',
      ]);
      expect(ORDINAL_ROWS.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 'last']);
      expect(GRID_WEEKDAYS.map((column) => column.day)).toEqual([
        'sunday',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
      ]);
    });

    it('offers 31 dates', () => {
      expect(MONTH_DAYS).toHaveLength(31);
      expect(MONTH_DAYS[0]).toBe(1);
      expect(MONTH_DAYS[30]).toBe(31);
    });

    it('ticks one cell at a time — each cell is ONE occurrence, never a product', () => {
      const first: OrdinalCell = { ordinal: 1, weekday: 'monday' };
      const second: OrdinalCell = { ordinal: 3, weekday: 'wednesday' };
      const ticked = toggleOrdinalCell(toggleOrdinalCell([], first), second);
      expect(ticked).toEqual([first, second]);
      // The cross product this replaced would have produced FOUR cells here.
      expect(ticked).toHaveLength(2);
      expect(toggleOrdinalCell(ticked, first)).toEqual([second]);
    });

    it('tells a literal 5th apart from Last when ticking', () => {
      const fifth: OrdinalCell = { ordinal: 5, weekday: 'wednesday' };
      const last: OrdinalCell = { ordinal: 'last', weekday: 'wednesday' };
      const ticked = toggleOrdinalCell(toggleOrdinalCell([], fifth), last);
      expect(ticked).toHaveLength(2);
      expect(toggleOrdinalCell(ticked, fifth)).toEqual([last]);
    });

    it('ticks and un-ticks dates', () => {
      expect(toggleMonthDay(toggleMonthDay([], 15), 1)).toEqual([15, 1]);
      expect(toggleMonthDay([15, 1], 15)).toEqual([1]);
    });
  });

  describe('list summaries name the mode rather than calling everything weekly', () => {
    it('describes each new mode in plain words', () => {
      expect(
        describeRecurrence(
          { type: 'scheduled', scheduledDays: ['tuesday'], repeat: { mode: 'interval', weeks: 3 } },
          task(),
        ),
      ).toBe('Every 3 weeks on Tue');
      expect(
        describeRecurrence(
          {
            type: 'scheduled',
            scheduledDays: [],
            repeat: {
              mode: 'ordinal',
              cells: [
                { ordinal: 1, weekday: 'monday' },
                { ordinal: 'last', weekday: 'friday' },
              ],
            },
          },
          task(),
        ),
      ).toBe('1st Mon, Last Fri each month');
      expect(
        describeRecurrence(
          {
            type: 'scheduled',
            scheduledDays: [],
            repeat: { mode: 'dayOfMonth', days: [1, 15], months: 2 },
          },
          task(),
        ),
      ).toBe('Day 1, 15 every 2 months');
    });

    it('still describes a legacy weekly row exactly as it always did', () => {
      expect(describeRecurrence(legacyWeekly, task())).toBe('Every Mon/Fri');
    });
  });
});
