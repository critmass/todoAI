import { validate, coachingResolutionSchema } from '../validator';
import { LlmOutputValidationError } from '../../errors';

describe('validate - accepts one well-formed object per action', () => {
  it('modify_task, all changes fields null (no-op changes still valid)', () => {
    const obj = {
      action: 'modify_task',
      task_id: 12,
      changes: { duration_minutes: null, context_tags: null, energy: null, approach_notes: null },
    };
    expect(() => validate(obj)).not.toThrow();
  });

  it('modify_task, all changes fields populated', () => {
    const obj = {
      action: 'modify_task',
      task_id: 12,
      changes: {
        duration_minutes: 30,
        context_tags: ['home', 'phone'],
        energy: 'low',
        approach_notes: 'try after lunch',
      },
    };
    expect(() => validate(obj)).not.toThrow();
  });

  it('break_down_task (stub: id only)', () => {
    expect(() => validate({ action: 'break_down_task', task_id: 47 })).not.toThrow();
  });

  it('eliminate_task', () => {
    expect(() =>
      validate({ action: 'eliminate_task', task_id: 47, reason: 'no longer relevant' }),
    ).not.toThrow();
  });

  it('defer_task with each until branch', () => {
    const untils = [
      null,
      { kind: 'on_date', date: '2026-12-03' },
      { kind: 'in_days', days: 7 },
      { kind: 'weekday', day: 'friday', which: 'next' },
      { condition: 'once the estimate is redone' },
    ];
    for (const until of untils) {
      expect(() => validate({ action: 'defer_task', task_id: 12, until })).not.toThrow();
    }
  });

  it('add_dependency', () => {
    expect(() =>
      validate({ action: 'add_dependency', task_id: 12, depends_on_task_id: 47 }),
    ).not.toThrow();
  });

  it('add_missing_task (stub: title only)', () => {
    expect(() => validate({ action: 'add_missing_task', title: 'buy stamps' })).not.toThrow();
  });

  it('no_change (first-class action, D8)', () => {
    expect(() => validate({ action: 'no_change', reason: 'user wants to keep it as-is' })).not.toThrow();
  });
});

describe('validate - rejects malformed structure (zod layer)', () => {
  it('rejects an unknown action', () => {
    expect(() => validate({ action: 'delete_everything', task_id: 1 })).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects a variant carrying keys from another variant', () => {
    const obj = { action: 'no_change', reason: 'fine as is', task_id: 12 };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects modify_task with a missing changes key', () => {
    const obj = {
      action: 'modify_task',
      task_id: 12,
      changes: { duration_minutes: null, context_tags: null, energy: null }, // approach_notes missing
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects a non-positive task_id', () => {
    expect(() => validate({ action: 'break_down_task', task_id: 0 })).toThrow(LlmOutputValidationError);
  });
});

describe('validate - cross-field rules (D10)', () => {
  it('rejects an empty-after-trim reason on eliminate_task', () => {
    expect(() => validate({ action: 'eliminate_task', task_id: 1, reason: '   ' })).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects an empty-after-trim reason on no_change', () => {
    expect(() => validate({ action: 'no_change', reason: '   ' })).toThrow(LlmOutputValidationError);
  });

  it('rejects an empty-after-trim title on add_missing_task', () => {
    expect(() => validate({ action: 'add_missing_task', title: '   ' })).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects an empty-after-trim condition on defer_task', () => {
    const obj = { action: 'defer_task', task_id: 1, until: { condition: '   ' } };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects an empty-after-trim approach_notes on modify_task', () => {
    const obj = {
      action: 'modify_task',
      task_id: 1,
      changes: { duration_minutes: null, context_tags: null, energy: null, approach_notes: '   ' },
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects out-of-range duration_minutes in modify_task changes', () => {
    const obj = {
      action: 'modify_task',
      task_id: 1,
      changes: { duration_minutes: 1441, context_tags: null, energy: null, approach_notes: null },
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });
});

describe('coachingResolutionSchema export', () => {
  it('is usable directly for a plain zod parse (used by the drift test)', () => {
    expect(coachingResolutionSchema.safeParse({ action: 'no_change', reason: 'fine' }).success).toBe(
      true,
    );
  });
});
