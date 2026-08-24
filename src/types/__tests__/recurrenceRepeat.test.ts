// Task 46 Phase 1 — the `repeat` field's on-disk shape, its round trip, and the legality rules.
//
// This file carries the BACKWARD-COMPATIBILITY PIN. Jason's alpha database has three real
// recurring rows whose `recurrence_pattern` JSON has no `repeat` key at all. Every one of them must
// keep meaning exactly what it meant before task 46, and a plain weekly schedule must still be
// WRITTEN in that same key-for-key shape — otherwise the next release silently rewrites live rows.

import {
  recurrenceRepeatIssue,
  recurrenceToRow,
  taskRecurrenceRowToDomain,
  type OrdinalCell,
  type Recurrence,
  type Weekday,
} from '../domain';
import type { TaskRecurrenceRow } from '../db';

function row(overrides: Partial<TaskRecurrenceRow>): TaskRecurrenceRow {
  return {
    id: 1,
    task_id: 1,
    recurrence_type: 'scheduled',
    recurrence_pattern: '{}',
    target_count: null,
    current_period_progress: 0,
    reset_date: null,
    last_period_shortfall: 0,
    is_currently_active: 1,
    created_at: '2026-08-03 09:00:00',
    ...overrides,
  };
}

describe('backward compatibility — a pre-task-46 row (the alpha DB)', () => {
  it('reads a row with NO repeat key as the schedule it has always been', () => {
    // Verbatim shape of what src/types/domain.ts wrote before task 46.
    const entity = taskRecurrenceRowToDomain(
      row({ recurrence_pattern: '{"scheduledDays":["monday","thursday"]}' }),
    );
    expect(entity.recurrence).toEqual({
      type: 'scheduled',
      scheduledDays: ['monday', 'thursday'],
    });
    // Not `repeat: {mode:'everyWeek'}` — ABSENT, so nothing downstream can start distinguishing
    // "an old row" from "a new weekly one".
    expect('repeat' in entity.recurrence).toBe(false);
  });

  it('writes a plain weekly schedule back in exactly that shape', () => {
    const written = recurrenceToRow({ type: 'scheduled', scheduledDays: ['monday', 'thursday'] });
    expect(JSON.parse(written.recurrence_pattern)).toEqual({ scheduledDays: ['monday', 'thursday'] });
    expect(written.recurrence_pattern).not.toContain('repeat');
  });

  it('normalises an EXPLICIT everyWeek to the same absent-key shape', () => {
    // The Phase 2 editor will always emit a mode. `everyWeek` is defined as identical to absent, so
    // saving an untouched weekly task must not rewrite its JSON into a new shape.
    const written = recurrenceToRow({
      type: 'scheduled',
      scheduledDays: ['monday'],
      repeat: { mode: 'everyWeek' },
    });
    expect(JSON.parse(written.recurrence_pattern)).toEqual({ scheduledDays: ['monday'] });
  });

  it('leaves every other recurrence type’s pattern untouched', () => {
    expect(JSON.parse(recurrenceToRow({ type: 'quota', quota: 3, period: 'week' }).recurrence_pattern)).toEqual({
      quota: 3,
      period: 'week',
    });
    expect(
      JSON.parse(
        recurrenceToRow({
          type: 'scheduled_quota',
          quota: 2,
          period: 'week',
          scheduledDays: ['friday'],
        }).recurrence_pattern,
      ),
    ).toEqual({ quota: 2, period: 'week', scheduledDays: ['friday'] });
  });
});

describe('round trip through the pattern JSON', () => {
  const cases: Recurrence[] = [
    { type: 'scheduled', scheduledDays: ['wednesday'], repeat: { mode: 'interval', weeks: 2 } },
    {
      type: 'scheduled',
      scheduledDays: [],
      repeat: {
        mode: 'ordinal',
        cells: [
          { ordinal: 1, weekday: 'wednesday' },
          { ordinal: 3, weekday: 'wednesday' },
        ],
      },
    },
    {
      // A grid whose ticked cells share no ordinal and no weekday — unrepresentable before the
      // amendment, and the reason `cells` exists.
      type: 'scheduled',
      scheduledDays: [],
      repeat: {
        mode: 'ordinal',
        cells: [
          { ordinal: 1, weekday: 'monday' },
          { ordinal: 5, weekday: 'wednesday' },
          { ordinal: 'last', weekday: 'friday' },
        ],
        months: 2,
      },
    },
    { type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [1, 15] } },
    { type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [31], months: 3 } },
  ];

  it.each(cases)('survives write-then-read unchanged: %j', (recurrence) => {
    const written = recurrenceToRow(recurrence);
    const back = taskRecurrenceRowToDomain(
      row({ recurrence_type: 'scheduled', recurrence_pattern: written.recurrence_pattern }),
    ).recurrence;
    expect(back).toEqual(recurrence);
  });

  it('does not add a recurrence_type value — repeat lives inside `scheduled`', () => {
    // Adding one would change the CHECK on an existing column and force constraint #12's full
    // DROP+RENAME rebuild. This assertion is the guard on that.
    for (const recurrence of cases) {
      expect(recurrenceToRow(recurrence).recurrence_type).toBe('scheduled');
    }
  });

  it('degrades an unreadable repeat to weekly rather than throwing on the user’s own database', () => {
    const junk = [
      '{"scheduledDays":["monday"],"repeat":{"mode":"fortnightly"}}', // a mode we do not know
      '{"scheduledDays":["monday"],"repeat":{"mode":"interval","weeks":0}}', // illegal stride
      '{"scheduledDays":["monday"],"repeat":"every other week"}', // not an object
      '{"scheduledDays":["monday"],"repeat":{"mode":"ordinal","ordinals":[1,3]}}', // no cells at all
      '{"scheduledDays":["monday"],"repeat":{"mode":"ordinal","cells":[{"ordinal":6,"weekday":"monday"}]}}',
      '{"scheduledDays":["monday"],"repeat":{"mode":"ordinal","cells":[{"ordinal":1,"weekday":"someday"}]}}',
      // Legal cells, but weekdays left behind on a mode switch: scheduledDays belongs to everyWeek
      // and interval ONLY, so this row is refused on read exactly as it is refused on write.
      '{"scheduledDays":["monday"],"repeat":{"mode":"ordinal","cells":[{"ordinal":1,"weekday":"monday"}]}}',
    ];
    for (const pattern of junk) {
      const back = taskRecurrenceRowToDomain(row({ recurrence_pattern: pattern })).recurrence;
      expect(back).toEqual({ type: 'scheduled', scheduledDays: ['monday'] });
    }
  });
});

describe('recurrenceRepeatIssue — what the data layer refuses to store', () => {
  const ok = (recurrence: Recurrence) => expect(recurrenceRepeatIssue(recurrence)).toBeNull();
  const bad = (recurrence: Recurrence) => expect(recurrenceRepeatIssue(recurrence)).toEqual(expect.any(String));

  it('accepts every legal shape, and every recurrence that has no repeat at all', () => {
    ok({ type: 'scheduled', scheduledDays: ['monday'] });
    ok({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'everyWeek' } });
    ok({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'interval', weeks: 1 } });
    ok({
      type: 'scheduled',
      scheduledDays: [],
      repeat: {
        mode: 'ordinal',
        cells: [
          { ordinal: 1, weekday: 'monday' },
          { ordinal: 5, weekday: 'wednesday' }, // a literal 5th is legal, and is NOT 'last'
          { ordinal: 'last', weekday: 'friday' },
        ],
      },
    });
    ok({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [1, 31], months: 2 } });
    ok({ type: 'quota', quota: 3, period: 'week' });
    ok({ type: 'unscheduled' });
    ok({ type: 'count', target: 5, progress: 0 });
  });

  it('rejects a stride that is not a whole number of weeks ≥ 1', () => {
    bad({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'interval', weeks: 0 } });
    bad({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'interval', weeks: -2 } });
    bad({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'interval', weeks: 1.5 } });
  });

  it('rejects an empty cell grid, or a cell that is not a real (ordinal, weekday) pair', () => {
    bad({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'ordinal', cells: [] } });
    bad({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 6 as 5, weekday: 'monday' }] }, // no 6th row
    });
    bad({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 0 as 1, weekday: 'monday' }] },
    });
    bad({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'someday' as Weekday }] },
    });
    bad({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'ordinal', cells: [null as unknown as OrdinalCell] },
    });
    bad({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'monday' }], months: 0 },
    });
  });

  it('rejects an empty or impossible day-of-month list', () => {
    bad({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [] } });
    bad({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [0] } });
    bad({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [32] } });
    bad({ type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [15.5] } });
  });

  it('🔴 ONE RULE: scheduledDays belongs to everyWeek and interval, and must be empty in the two month modes', () => {
    // `ordinal` carries its weekday inside each ticked cell and `dayOfMonth` has no weekday at all,
    // so a non-empty list in either is stale data from a mode switch — dead, invisible, and waiting
    // for a later reader to trust it. Enforced at both writers, not merely documented.
    const dayOfMonth = recurrenceRepeatIssue({
      type: 'scheduled',
      scheduledDays: ['monday'],
      repeat: { mode: 'dayOfMonth', days: [15] },
    });
    const ordinal = recurrenceRepeatIssue({
      type: 'scheduled',
      scheduledDays: ['monday'],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'monday' }] },
    });
    expect(dayOfMonth).toEqual(expect.stringContaining('scheduledDays'));
    expect(ordinal).toEqual(expect.stringContaining('scheduledDays'));

    // …and the two modes that DO use it are untouched by the rule.
    ok({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'everyWeek' } });
    ok({ type: 'scheduled', scheduledDays: ['monday'], repeat: { mode: 'interval', weeks: 2 } });
  });
});
