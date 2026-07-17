// Pure, model-free mapper: subtask importance banding (spec §4.1) + assembling domain write
// inputs for each subtask. No persistence, no repository calls.
//
// Task 10, R2: sequence rides on the dependency graph, not on generation order. `ordered: true`
// still produces a straight-line chain today (subtask i+1 depends on subtask i - the schema has
// no branching structure yet), but the sub-band offset is computed from each subtask's
// TRANSITIVE FAN-OUT (how many siblings it transitively unlocks) via a real graph walk over
// that chain, not from its raw index. For a straight chain this reduces to "position from the
// end", but the walk is written generally so it stays correct if a future breakdown schema ever
// expresses non-linear structure. Higher fan-out -> higher offset -> a high-leverage unblocker
// outscores (and thus is selected before) the things it blocks, which is what makes
// descending-by-score a valid execution order (a prerequisite's fan-out is always >= its
// descendants'). This replaces the old ascending-by-index offset, which put the LAST step of an
// ordered breakdown first.
import type { TaskWriteInput } from '../../types/domain';
import type { TaskBreakdownV1 } from './validator';

/**
 * The "unlocks" adjacency for an ordered breakdown of `count` subtasks: index i unlocks i+1
 * (i.e. i+1 depends on i), a straight chain in generation order. Empty (no edges) when
 * unordered - there is nothing to fan out from. Acyclic by construction (strictly increasing
 * indices), so no separate cycle guard is needed here - the real DAG guard for arbitrary,
 * persisted dependency edges lives in db/repositories/dependencies.ts (`add`'s wouldCreateCycle),
 * which this chain is written through at persistence time.
 */
export function sequentialUnlocks(count: number, ordered: boolean): ReadonlyMap<number, readonly number[]> {
  const unlocks = new Map<number, number[]>();
  for (let i = 0; i < count; i++) unlocks.set(i, []);
  if (!ordered) return unlocks;
  for (let i = 0; i < count - 1; i++) {
    unlocks.get(i)!.push(i + 1);
  }
  return unlocks;
}

/**
 * Transitive fan-out of `start`: the count of distinct nodes reachable by following `unlocks`
 * edges (direct + indirect descendants). A plain BFS/DFS reachability count - assumes `unlocks`
 * is acyclic (see sequentialUnlocks's doc comment for why that always holds here).
 */
function transitiveFanOut(unlocks: ReadonlyMap<number, readonly number[]>, start: number): number {
  const seen = new Set<number>();
  const stack = [...(unlocks.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(unlocks.get(next) ?? []));
  }
  return seen.size;
}

/**
 * Bands a subtask's importance within its parent's 1-99 sub-band (spec §4.1): `ordered` gives
 * each sibling an offset by transitive fan-out (task 10, R2) - a subtask that unlocks more
 * downstream work outranks the work it unlocks; unordered siblings all share one value (parent
 * 700 -> all 701, per the spec's own example - not the parent's own 700, which would collapse
 * the subtask into the parent's exact rank). The model never manufactures these values itself -
 * it only emits the `ordered` flag (this function does the arithmetic).
 *
 * `fanOut` is the subtask's transitive fan-out (see `transitiveFanOut`), not its generation
 * index. Throws if the resulting offset would reach 100 (colliding with the next hundred's
 * band) - unreachable at the schema's own 2-8 subtask cap, but guarded rather than assumed.
 */
export function subtaskImportance(parentImportance: number, fanOut: number, ordered: boolean): number {
  const offset = ordered ? fanOut + 1 : 1;
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

/** A subtask write with `title`/`estimatedDuration` guaranteed present (the breakdown schema
 *  requires both on every subtask) - structurally identical to db/repositories/tasks.ts's
 *  CreateTaskInput, declared independently so this module stays decoupled from the db layer. */
export type SubtaskWrite = TaskWriteInput & { title: string; estimatedDuration: number };

export function breakdownToSubtaskWrites(
  valid: TaskBreakdownV1,
  parent: ParentContext,
): SubtaskWrite[] {
  const unlocks = sequentialUnlocks(valid.subtasks.length, valid.ordered);
  return valid.subtasks.map((subtask, index) => ({
    title: subtask.title,
    estimatedDuration: subtask.estimated_duration_minutes,
    durationSource: subtask.duration_from_user ? 'user' : 'model_guess',
    importance: subtaskImportance(parent.importance, transitiveFanOut(unlocks, index), valid.ordered),
    energyRequirement: parent.energyRequirement,
    contextTags: parent.contextTags,
    parentTaskId: valid.parent_task_id,
  }));
}
