// zod validator + cross-field rules for task_extraction.v1 (D10). Hand-mirrored from
// task_extraction.v1.json (D2) - see __tests__/schemaDrift.test.ts for the fixture-based
// agreement check between this file and the JSON Schema.
import { z } from 'zod';
import { LlmOutputValidationError } from '../errors';
import { resolveDue } from '../due/dueSpec';

const WEEKDAY_VALUES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
const PERIOD_VALUES = ['day', 'week', 'month'] as const;

const dueSpecSchema = z.union([
  z.null(),
  z.strictObject({ kind: z.literal('on_date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.strictObject({ kind: z.literal('in_days'), days: z.number().int().min(1).max(365) }),
  z.strictObject({
    kind: z.literal('weekday'),
    day: z.enum(WEEKDAY_VALUES),
    which: z.enum(['this', 'next']),
  }),
]);

const recurrenceSpecSchema = z.union([
  z.null(),
  z.strictObject({
    type: z.literal('scheduled_quota'),
    quota: z.number().int().min(1),
    period: z.enum(PERIOD_VALUES),
    days: z.array(z.enum(WEEKDAY_VALUES)).min(1).max(7),
  }),
  z.strictObject({
    type: z.literal('quota'),
    quota: z.number().int().min(1),
    period: z.enum(PERIOD_VALUES),
  }),
  z.strictObject({
    type: z.literal('scheduled'),
    days: z.array(z.enum(WEEKDAY_VALUES)).min(1).max(7),
  }),
  z.strictObject({ type: z.literal('unscheduled') }),
  z.strictObject({ type: z.literal('count'), target: z.number().int().min(1) }),
]);

export const taskExtractionSchema = z.strictObject({
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(200).nullable(),
  estimated_duration_minutes: z.number().int().min(1).max(1440),
  duration_from_user: z.boolean(),
  due: dueSpecSchema,
  context_tags: z.array(z.string().min(1).max(20)).min(0).max(5),
  tool_requirements: z.array(z.string().min(1).max(20)).min(0).max(5),
  energy: z.enum(['low', 'med', 'high']).nullable(),
  importance_user: z.number().int().min(1).max(10).nullable(),
  recurrence: recurrenceSpecSchema,
});

export type TaskExtractionV1 = z.infer<typeof taskExtractionSchema>;

const SURFACE = 'task_extraction.v1';

/**
 * zod parse, then cross-field rules (D10): title non-empty after trim; count target >= 1;
 * scheduled/scheduled_quota days non-empty; quota/scheduled_quota quota >= 1; duration in
 * [1,1440]; resolved due date not in the past. Most of these are also enforced by the zod
 * schema's own bounds - kept explicit here too per D10's "at minimum" list and so a future
 * schema loosening can't silently drop them. Throws LlmOutputValidationError; never returns
 * a Result wrapper, matching src/db/errors.ts's throw-typed-errors convention.
 */
export function validate(raw: unknown, todayISO: string): TaskExtractionV1 {
  const parsed = taskExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new LlmOutputValidationError(SURFACE, issues);
  }

  const data = parsed.data;
  const issues: string[] = [];

  if (data.title.trim().length === 0) {
    issues.push('title: must be non-empty after trim');
  }
  if (data.estimated_duration_minutes < 1 || data.estimated_duration_minutes > 1440) {
    issues.push('estimated_duration_minutes: must be in [1,1440]');
  }
  if (data.recurrence?.type === 'count' && data.recurrence.target < 1) {
    issues.push('recurrence.target: must be >= 1 for count');
  }
  if (
    (data.recurrence?.type === 'scheduled' || data.recurrence?.type === 'scheduled_quota') &&
    data.recurrence.days.length === 0
  ) {
    issues.push('recurrence.days: must be non-empty for scheduled/scheduled_quota');
  }
  if (
    (data.recurrence?.type === 'quota' || data.recurrence?.type === 'scheduled_quota') &&
    data.recurrence.quota < 1
  ) {
    issues.push('recurrence.quota: must be >= 1');
  }

  const resolvedDue = resolveDue(data.due, todayISO);
  if (resolvedDue !== null && resolvedDue < todayISO) {
    issues.push(`due: resolved date ${resolvedDue} is in the past (today ${todayISO})`);
  }

  if (issues.length > 0) {
    throw new LlmOutputValidationError(SURFACE, issues);
  }
  return data;
}
