// zod validator for coaching_resolution.v1 (D8/D10). Hand-mirrored from
// coaching_resolution.v1.json (D2) - see __tests__/schemaDrift.test.ts for the fixture-based
// agreement check between this file and the JSON Schema. Validator only: dispatch/applying a
// resolution through the repositories is task 6/12, not here.
import { z } from 'zod';
import { LlmOutputValidationError } from '../errors';

const WEEKDAY_VALUES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const untilSpecSchema = z.union([
  z.null(),
  z.strictObject({ kind: z.literal('on_date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.strictObject({ kind: z.literal('in_days'), days: z.number().int().min(1).max(365) }),
  z.strictObject({
    kind: z.literal('weekday'),
    day: z.enum(WEEKDAY_VALUES),
    which: z.enum(['this', 'next']),
  }),
  z.strictObject({ condition: z.string().min(1).max(120) }),
]);

const modifyTaskSchema = z.strictObject({
  action: z.literal('modify_task'),
  task_id: z.number().int().min(1),
  changes: z.strictObject({
    duration_minutes: z.number().int().min(1).max(1440).nullable(),
    context_tags: z.array(z.string().min(1).max(20)).min(0).max(5).nullable(),
    energy: z.enum(['low', 'med', 'high']).nullable(),
    approach_notes: z.string().min(1).max(200).nullable(),
  }),
});

const breakDownTaskSchema = z.strictObject({
  action: z.literal('break_down_task'),
  task_id: z.number().int().min(1),
});

const eliminateTaskSchema = z.strictObject({
  action: z.literal('eliminate_task'),
  task_id: z.number().int().min(1),
  reason: z.string().min(1).max(120),
});

const deferTaskSchema = z.strictObject({
  action: z.literal('defer_task'),
  task_id: z.number().int().min(1),
  until: untilSpecSchema,
});

const addDependencySchema = z.strictObject({
  action: z.literal('add_dependency'),
  task_id: z.number().int().min(1),
  depends_on_task_id: z.number().int().min(1),
});

const addMissingTaskSchema = z.strictObject({
  action: z.literal('add_missing_task'),
  title: z.string().min(1).max(80),
});

const noChangeSchema = z.strictObject({
  action: z.literal('no_change'),
  reason: z.string().min(1).max(120),
});

export const coachingResolutionSchema = z.union([
  modifyTaskSchema,
  breakDownTaskSchema,
  eliminateTaskSchema,
  deferTaskSchema,
  addDependencySchema,
  addMissingTaskSchema,
  noChangeSchema,
]);

export type CoachingResolutionV1 = z.infer<typeof coachingResolutionSchema>;

const SURFACE = 'coaching_resolution.v1';

/** zod parse, then cross-field rules (D10): title/reason/condition/approach_notes non-empty
 *  after trim; duration_minutes in [1,1440] when present (mostly redundant with zod's own
 *  bounds, kept explicit per D10's "at minimum" list). No task-id-in-candidate-set check here
 *  - that requires the runtime candidate list, which is a task 6/12 concern; this validator
 *  only confirms the shape zod already bounds structurally. */
export function validate(raw: unknown): CoachingResolutionV1 {
  const parsed = coachingResolutionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new LlmOutputValidationError(SURFACE, issues);
  }

  const data = parsed.data;
  const issues: string[] = [];

  switch (data.action) {
    case 'modify_task':
      if (data.changes.approach_notes !== null && data.changes.approach_notes.trim().length === 0) {
        issues.push('changes.approach_notes: must be non-empty after trim (or null)');
      }
      if (
        data.changes.duration_minutes !== null &&
        (data.changes.duration_minutes < 1 || data.changes.duration_minutes > 1440)
      ) {
        issues.push('changes.duration_minutes: must be in [1,1440]');
      }
      break;
    case 'eliminate_task':
    case 'no_change':
      if (data.reason.trim().length === 0) {
        issues.push('reason: must be non-empty after trim');
      }
      break;
    case 'defer_task':
      if (data.until !== null && 'condition' in data.until && data.until.condition.trim().length === 0) {
        issues.push('until.condition: must be non-empty after trim');
      }
      break;
    case 'add_missing_task':
      if (data.title.trim().length === 0) {
        issues.push('title: must be non-empty after trim');
      }
      break;
    case 'break_down_task':
    case 'add_dependency':
      break; // no free-text fields to trim-check
  }

  if (issues.length > 0) {
    throw new LlmOutputValidationError(SURFACE, issues);
  }
  return data;
}
