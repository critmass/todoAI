import { validate, taskExtractionSchema } from '../validator';
import { LlmOutputValidationError } from '../../errors';

const TODAY = '2026-07-08';

function baseValid() {
  return {
    title: 'Take out trash',
    description: null,
    estimated_duration_minutes: 10,
    duration_from_user: false,
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  };
}

describe('validate - accepts well-formed objects', () => {
  it('accepts the minimal all-null-where-optional object', () => {
    expect(() => validate(baseValid(), TODAY)).not.toThrow();
  });

  it('accepts every field populated, including a DueSpec and each recurrence type', () => {
    const cases = [
      { type: 'scheduled_quota', quota: 3, period: 'week', days: ['monday', 'wednesday', 'friday'] },
      { type: 'quota', quota: 15, period: 'week' },
      { type: 'scheduled', days: ['tuesday'] },
      { type: 'unscheduled' },
      { type: 'count', target: 10 },
      null,
    ];
    for (const recurrence of cases) {
      const obj = {
        ...baseValid(),
        description: 'a description',
        due: { kind: 'in_days', days: 5 },
        context_tags: ['home', 'phone'],
        tool_requirements: ['laptop'],
        energy: 'high',
        importance_user: 7,
        recurrence,
      };
      expect(() => validate(obj, TODAY)).not.toThrow();
    }
  });

  it('accepts all three DueSpec branches', () => {
    const dues = [
      { kind: 'on_date', date: '2026-12-03' },
      { kind: 'in_days', days: 14 },
      { kind: 'weekday', day: 'friday', which: 'this' },
    ];
    for (const due of dues) {
      expect(() => validate({ ...baseValid(), due }, TODAY)).not.toThrow();
    }
  });
});

describe('validate - rejects malformed structure (zod layer)', () => {
  it('rejects a missing required key', () => {
    const missingTitle: Record<string, unknown> = baseValid();
    delete missingTitle.title;
    expect(() => validate(missingTitle, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects an unknown extra key (strict object)', () => {
    expect(() => validate({ ...baseValid(), extra: 'nope' }, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects a recurrence variant carrying keys from another variant', () => {
    const obj = { ...baseValid(), recurrence: { type: 'unscheduled', quota: 3 } };
    expect(() => validate(obj, TODAY)).toThrow(LlmOutputValidationError);
  });
});

describe('validate - cross-field rules (D10)', () => {
  it('rejects a count recurrence with target < 1', () => {
    // zod's own min(1) already rejects this at the schema layer - confirms the rule exists
    // end to end regardless of which layer catches it.
    const obj = { ...baseValid(), recurrence: { type: 'count', target: 0 } };
    expect(() => validate(obj, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects a scheduled recurrence with empty days', () => {
    const obj = { ...baseValid(), recurrence: { type: 'scheduled', days: [] } };
    expect(() => validate(obj, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects a quota recurrence with quota < 1', () => {
    const obj = { ...baseValid(), recurrence: { type: 'quota', quota: 0, period: 'week' } };
    expect(() => validate(obj, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects out-of-range duration', () => {
    expect(() => validate({ ...baseValid(), estimated_duration_minutes: 0 }, TODAY)).toThrow(
      LlmOutputValidationError,
    );
    expect(() => validate({ ...baseValid(), estimated_duration_minutes: 1441 }, TODAY)).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects a title that is empty after trim', () => {
    expect(() => validate({ ...baseValid(), title: '   ' }, TODAY)).toThrow(LlmOutputValidationError);
  });

  it('rejects a resolved due date in the past', () => {
    // "in_days: -0" isn't representable (min 1), so use on_date with a date before today that
    // would NOT roll forward (rolling only applies when the naive date is before today, which
    // is exactly this case - so this must construct a date that's still in the past after any
    // rollover: a same-year past date rolls forward to next year and is no longer "past". Use a
    // date so far in the past that rollover still lands in the past relative to a differently-set today.
    const obj = { ...baseValid(), due: { kind: 'on_date', date: '2020-01-01' } };
    // today is far in the future relative to a rolled-forward 2021-01-01, so it's still in the past.
    expect(() => validate(obj, '2026-07-08')).toThrow(LlmOutputValidationError);
  });

  it('accepts a due date resolving to exactly today (the boundary is inclusive)', () => {
    const obj = { ...baseValid(), due: { kind: 'on_date', date: TODAY } };
    expect(() => validate(obj, TODAY)).not.toThrow();
  });
});

describe('taskExtractionSchema export', () => {
  it('is usable directly for a plain zod parse (used by the drift test)', () => {
    expect(taskExtractionSchema.safeParse(baseValid()).success).toBe(true);
  });
});
