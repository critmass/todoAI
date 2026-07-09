import { validate, taskBreakdownSchema } from '../validator';
import { LlmOutputValidationError } from '../../errors';

function baseValid() {
  return {
    parent_task_id: 42,
    ordered: false,
    subtasks: [
      { title: 'clear a shelf', estimated_duration_minutes: 20, duration_from_user: false },
      { title: 'sort into keep/donate/trash', estimated_duration_minutes: 30, duration_from_user: true },
    ],
  };
}

describe('validate - accepts well-formed objects', () => {
  it('accepts the minimal 2-subtask object', () => {
    expect(() => validate(baseValid())).not.toThrow();
  });

  it('accepts the maximum 8-subtask object, ordered', () => {
    const obj = {
      parent_task_id: 1,
      ordered: true,
      subtasks: Array.from({ length: 8 }, (_, i) => ({
        title: `step ${i + 1}`,
        estimated_duration_minutes: 15,
        duration_from_user: false,
      })),
    };
    expect(() => validate(obj)).not.toThrow();
  });
});

describe('validate - rejects malformed structure (zod layer)', () => {
  it('rejects fewer than 2 subtasks', () => {
    const obj = { ...baseValid(), subtasks: [baseValid().subtasks[0]] };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects more than 8 subtasks', () => {
    const obj = {
      ...baseValid(),
      subtasks: Array.from({ length: 9 }, () => baseValid().subtasks[0]),
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects an unknown extra key on the root object', () => {
    expect(() => validate({ ...baseValid(), extra: 'nope' })).toThrow(LlmOutputValidationError);
  });

  it('rejects an unknown extra key on a subtask', () => {
    const obj = {
      ...baseValid(),
      subtasks: [{ ...baseValid().subtasks[0], energy: 'high' }, baseValid().subtasks[1]],
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects a non-positive parent_task_id', () => {
    expect(() => validate({ ...baseValid(), parent_task_id: 0 })).toThrow(LlmOutputValidationError);
  });
});

describe('validate - cross-field rules (D10 generic invariants, per subtask)', () => {
  it('rejects a subtask title that is empty after trim', () => {
    const obj = {
      ...baseValid(),
      subtasks: [{ ...baseValid().subtasks[0], title: '   ' }, baseValid().subtasks[1]],
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });

  it('rejects out-of-range subtask duration', () => {
    const obj = {
      ...baseValid(),
      subtasks: [
        { ...baseValid().subtasks[0], estimated_duration_minutes: 0 },
        baseValid().subtasks[1],
      ],
    };
    expect(() => validate(obj)).toThrow(LlmOutputValidationError);
  });
});

describe('taskBreakdownSchema export', () => {
  it('is usable directly for a plain zod parse (used by the drift test)', () => {
    expect(taskBreakdownSchema.safeParse(baseValid()).success).toBe(true);
  });
});
