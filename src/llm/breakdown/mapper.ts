// Pure, model-free mapper: subtask importance banding (spec §4.1) + assembling domain write
// inputs for each subtask. No persistence, no repository calls.
import type { TaskWriteInput } from '../../types/domain';
import type { TaskBreakdownV1 } from './validator';

/**
 * Bands a subtask's importance within its parent's 1-99 sub-band (spec §4.1): `ordered` gives
 * each sibling a sequential offset (parent 700 -> 701, 702, ...); unordered siblings all share
 * one value (parent 700 -> all 701, per the spec's own example - not the parent's own 700,
 * which would collapse the subtask into the parent's exact rank). The model never manufactures
 * these values itself - it only emits the `ordered` flag (this function does the arithmetic).
 *
 * `index` is the subtask's 0-based position in generation order. Throws if the resulting
 * offset would reach 100 (colliding with the next hundred's band) - unreachable at the
 * schema's own 2-8 subtask cap, but guarded rather than assumed.
 */
export function subtaskImportance(parentImportance: number, index: number, ordered: boolean): number {
  const offset = ordered ? index + 1 : 1;
  if (offset > 99) {
    throw new Error(
      `subtaskImportance: offset ${offset} would collide with the next hundred's band (parent ${parentImportance})`,
    );
  }
  return parentImportance + offset;
}

/** Subtask context/energy default to the parent's (spec §4.2) - the coach edits after via
 *  modify_task if the conversation said otherwise. */
export interface ParentContext {
  importance: number; // internal 1-1000
  energyRequirement: number; // internal 1-5
  contextTags: string[];
}

export function breakdownToSubtaskWrites(
  valid: TaskBreakdownV1,
  parent: ParentContext,
): TaskWriteInput[] {
  return valid.subtasks.map((subtask, index) => ({
    title: subtask.title,
    estimatedDuration: subtask.estimated_duration_minutes,
    durationSource: subtask.duration_from_user ? 'user' : 'model_guess',
    importance: subtaskImportance(parent.importance, index, valid.ordered),
    energyRequirement: parent.energyRequirement,
    contextTags: parent.contextTags,
    parentTaskId: valid.parent_task_id,
  }));
}
