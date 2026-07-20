// Task 11 — agenda-item sizing (task 28 design §3.2). Every fill/fit computation in the planner
// routes through plannedMinutes(); nothing in ./planner.ts reads `estimated_duration` raw. This
// is the retrofit-bill item 1 the task-33 report handed to this task.
//
// Two distinct duration treatments fall out of `duration_type` + `work_state`:
//   - countdown: an estimate-typed task with a believable remaining estimate; the timer counts
//     DOWN from plannedMinutes.
//   - open block: a floor-typed task, or an estimate-typed in-progress task whose accumulated
//     time has already met/exceeded its estimate (it has PROVEN open-ended, design §3.2's last
//     row — planning treatment only, no stored field mutates). It fills whatever block it is
//     placed in, the timer counts UP, and the BLOCK boundary — a planning quantity, not a task
//     property — is what ends the stretch, so overrun is never an estimation error.

import type { Task } from '../types/domain';

/**
 * True when planning must treat the task as open-ended: floor-typed, or a blown estimate
 * (in progress with accumulated ≥ estimate). Open-ended tasks fill their block and carry the
 * `openBlock` agenda kind; the execution screen runs a count-up face for them (task 13/24).
 */
export function treatedAsOpenEnded(task: Task): boolean {
  if (task.durationType === 'floor') return true;
  return task.workState === 'in_progress' && task.accumulatedMinutes >= task.estimatedDuration;
}

/**
 * The minimum block size an open-ended task may be placed into (design §3.2's placement floor):
 * `estimated_duration` holds the floor value for floor-typed tasks, and a blown estimate is
 * treated as a floor at its original estimate. Never place "at least an hour" work into a
 * 20-minute slot — offer-to-split (via breakdown) is the fallback, not shortening.
 */
export function placementFloorMinutes(task: Task): number | null {
  return treatedAsOpenEnded(task) ? task.estimatedDuration : null;
}

/**
 * Can this task go into a block of `blockMinutes` gross minutes (with `workMinutes` of planned
 * work after the deep-focus overrun buffer, for estimate-typed sizing)?
 *
 * The floor comparison deliberately uses the GROSS block minutes, not the buffered work minutes:
 * the 25% overrun buffer exists to absorb an estimate overrun, and an open-ended task has no
 * estimate to overrun — its block boundary IS the plan. A 60-minute block genuinely offers 60
 * minutes of "at least an hour" work. (Recorded in the task-11 findings report.)
 */
export function isPlaceableInBlock(task: Task, blockMinutes: number, workMinutes: number): boolean {
  const floor = placementFloorMinutes(task);
  if (floor != null) return blockMinutes >= floor;
  return plannedMinutes(task, workMinutes) <= workMinutes;
}

/**
 * Minutes this task occupies when placed into a block offering `blockWorkMinutes` of work
 * (design §3.2 — `blockWorkMinutes` already accounts for the §5.3.1 overrun buffer where one
 * applies; this function adds no second buffer):
 *
 *   floor-type / blown estimate → fills its block (blockWorkMinutes)
 *   estimate-type, not started  → estimated_duration
 *   estimate-type, in progress  → remaining = estimate − accumulated
 */
export function plannedMinutes(task: Task, blockWorkMinutes: number): number {
  if (treatedAsOpenEnded(task)) return blockWorkMinutes;
  if (task.workState === 'in_progress') {
    return Math.max(1, task.estimatedDuration - task.accumulatedMinutes);
  }
  return task.estimatedDuration;
}
