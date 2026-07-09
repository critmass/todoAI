// zod validator + cross-field rules for task_breakdown.v1 (D10). Hand-mirrored from
// task_breakdown.v1.json (D2) - see __tests__/schemaDrift.test.ts for the fixture-based
// agreement check between this file and the JSON Schema.
import { z } from 'zod';
import { LlmOutputValidationError } from '../errors';

const subtaskSchema = z.strictObject({
  title: z.string().min(1).max(80),
  estimated_duration_minutes: z.number().int().min(1).max(1440),
  duration_from_user: z.boolean(),
});

export const taskBreakdownSchema = z.strictObject({
  parent_task_id: z.number().int().min(1),
  ordered: z.boolean(),
  subtasks: z.array(subtaskSchema).min(2).max(8),
});

export type TaskBreakdownV1 = z.infer<typeof taskBreakdownSchema>;

const SURFACE = 'task_breakdown.v1';

/** zod parse, then cross-field rules (D10's generic invariants applied per subtask): each
 *  subtask's title non-empty after trim; each subtask's duration in [1,1440] (redundant with
 *  the zod bounds, kept explicit per D10's "at minimum" list). */
export function validate(raw: unknown): TaskBreakdownV1 {
  const parsed = taskBreakdownSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new LlmOutputValidationError(SURFACE, issues);
  }

  const data = parsed.data;
  const issues: string[] = [];

  data.subtasks.forEach((subtask, index) => {
    if (subtask.title.trim().length === 0) {
      issues.push(`subtasks[${index}].title: must be non-empty after trim`);
    }
    if (subtask.estimated_duration_minutes < 1 || subtask.estimated_duration_minutes > 1440) {
      issues.push(`subtasks[${index}].estimated_duration_minutes: must be in [1,1440]`);
    }
  });

  if (issues.length > 0) {
    throw new LlmOutputValidationError(SURFACE, issues);
  }
  return data;
}
