// Pure, model-free mapper: validated extraction + todayISO -> domain write inputs (D4/D5/D6).
// No persistence, no repository calls - see src/llm/extraction/__tests__/mapper.test.ts.
import type { Recurrence, TaskWriteInput } from '../../types/domain';
import {
  userToInternalEnergy,
  userToInternalImportance,
  type UserEnergy,
  type UserImportance,
} from '../../types/scales';
import { resolveDue } from '../due/dueSpec';
import type { TaskExtractionV1 } from './validator';

/** Code policy, not model output (D4): null importance/energy default to the internal
 *  mid-points, never emitted by the grammar itself. */
const DEFAULT_IMPORTANCE_INTERNAL = 500;
const DEFAULT_ENERGY_INTERNAL = 3;

function mapRecurrence(spec: TaskExtractionV1['recurrence']): Recurrence | undefined {
  if (spec === null) {
    // True one-off: no task_recurrence row. Must stay distinct from {type:'unscheduled'} -
    // opposite completion semantics (constraint #5, data-layer brief; D6).
    return undefined;
  }
  switch (spec.type) {
    case 'scheduled_quota':
      return {
        type: 'scheduled_quota',
        quota: spec.quota,
        period: spec.period,
        scheduledDays: spec.days,
      };
    case 'quota':
      return { type: 'quota', quota: spec.quota, period: spec.period };
    case 'scheduled':
      return { type: 'scheduled', scheduledDays: spec.days };
    case 'unscheduled':
      return { type: 'unscheduled' };
    case 'count':
      // A new task starts at 0 - the extraction RecurrenceSpec has no progress field (D6).
      return { type: 'count', target: spec.target, progress: 0 };
  }
}

export interface ExtractionMapped {
  taskWrite: TaskWriteInput;
  recurrence: Recurrence | undefined;
}

export function extractionToTaskWrite(valid: TaskExtractionV1, todayISO: string): ExtractionMapped {
  const taskWrite: TaskWriteInput = {
    title: valid.title,
    description: valid.description,
    estimatedDuration: valid.estimated_duration_minutes,
    durationSource: valid.duration_from_user ? 'user' : 'model_guess',
    durationType: valid.duration_type, // task 28 §3.1; for 'floor', estimatedDuration is the minimum
    nextDueAt: resolveDue(valid.due, todayISO),
    contextTags: valid.context_tags,
    toolRequirements: valid.tool_requirements,
    energyRequirement:
      valid.energy === null
        ? DEFAULT_ENERGY_INTERNAL
        : userToInternalEnergy(valid.energy as UserEnergy),
    importance:
      valid.importance_user === null
        ? DEFAULT_IMPORTANCE_INTERNAL
        : userToInternalImportance(valid.importance_user as UserImportance),
  };

  return { taskWrite, recurrence: mapRecurrence(valid.recurrence) };
}
