// Task 24 — the six-kind recurrence editor's model. The tests that matter here are the ones that
// pin constraint #7: "One-time" and "Ongoing" look like neighbours in a picker and have opposite
// completion semantics, and every one of the six kinds has to survive a round trip through the
// editor unchanged.

import type { Recurrence, Task } from '../../../types/domain';
import {
  RECURRENCE_KINDS,
  describeRecurrence,
  draftFromTask,
  draftToWrite,
  emptyDraft,
  validateDraft,
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
  it('offers exactly the six kinds the data model can express', () => {
    expect(RECURRENCE_KINDS.map((entry) => entry.kind)).toEqual([
      'once',
      'schedule',
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
