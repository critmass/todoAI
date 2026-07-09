// zod validator for summary.v1 (D10). Hand-mirrored from summary.v1.json (D2) - see
// __tests__/schemaDrift.test.ts for the fixture-based agreement check. Validator only;
// persistence mapping is light and left to the summary writer (a later task).
import { z } from 'zod';
import { LlmOutputValidationError } from '../errors';
import type { InteractionType } from '../../types/db';

// Mirrors src/types/db.ts's InteractionType exactly - imported as a type above (constraint:
// don't edit domain/db types), duplicated here as a runtime literal tuple only because zod
// needs a runtime value, not just a type, to build the enum.
const INTERACTION_TYPE_VALUES = [
  'work_session',
  'coaching_conversation',
  'task_input',
  'energy_checkin',
  'pattern_recognition',
  'task_completion',
  'task_skip',
] as const satisfies readonly InteractionType[];

export const summarySchema = z.strictObject({
  summary_schema_version: z.literal('1'),
  kind: z.enum(INTERACTION_TYPE_VALUES),
  key_points: z.array(z.string().min(1).max(120)).min(1).max(3),
  disposition: z.string().min(1).max(120).nullable(),
  energy_note: z.string().min(1).max(80).nullable(),
});

export type SummaryV1 = z.infer<typeof summarySchema>;

const SURFACE = 'summary.v1';

/** zod parse, then cross-field rules (D10): each key_point, disposition, and energy_note
 *  non-empty after trim (mostly redundant with zod's own min-length bounds, kept explicit
 *  per D10's "at minimum" list). */
export function validate(raw: unknown): SummaryV1 {
  const parsed = summarySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new LlmOutputValidationError(SURFACE, issues);
  }

  const data = parsed.data;
  const issues: string[] = [];

  data.key_points.forEach((point, index) => {
    if (point.trim().length === 0) {
      issues.push(`key_points[${index}]: must be non-empty after trim`);
    }
  });
  if (data.disposition !== null && data.disposition.trim().length === 0) {
    issues.push('disposition: must be non-empty after trim (or null)');
  }
  if (data.energy_note !== null && data.energy_note.trim().length === 0) {
    issues.push('energy_note: must be non-empty after trim (or null)');
  }

  if (issues.length > 0) {
    throw new LlmOutputValidationError(SURFACE, issues);
  }
  return data;
}
