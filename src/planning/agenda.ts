// Task 11 — the agenda vocabulary the planner produces and the execution surface (task 24)
// walks. THE PLAN IS HIDDEN FROM THE USER (spec §2.2, §6.2): the execution screen serves ONE
// task at a time off this structure. Do not build a plan-preview surface over it — the ordered
// list exists for the walker and for replanning, not for display.

import type { Task } from '../types/domain';
import type { SessionType } from '../types/db';
import type { FilterReject, DependencyReject } from '../scoring/filter';

/**
 * Which timer face the execution screen runs for an agenda task (task 28 design §3.1/§10 item 3
 * — carried from day one so adding it later is never a breaking change to task 24):
 *
 * - `countdown`: estimate-typed task with a live estimate; timer counts down plannedMinutes.
 * - `openBlock`: floor-typed or blown-estimate task; it fills its block, the timer counts UP,
 *   and the block boundary (plannedMinutes here) raises the end-of-block prompt. An extend
 *   stretch also runs count-up, but extend is a runtime affordance (task 13/24), not a planned
 *   kind.
 */
export type BlockKind = 'countdown' | 'openBlock';

export interface AgendaTaskItem {
  kind: 'task';
  task: Task;
  blockKind: BlockKind;
  /** countdown: minutes to count down. openBlock: the block's gross minutes (the boundary). */
  plannedMinutes: number;
  /** True for items placed in the reserved end-of-session deep-focus block (uninterruptible by
   *  breaks, spec §5.3.4). */
  deepFocus: boolean;
  /** True only for the single step-0 resume claim (task 28 design §3.3): the one in-progress
   *  task that took first refusal on the deep-focus block. At most one per plan. */
  resumeClaim: boolean;
}

export interface AgendaBreakItem {
  kind: 'break';
  plannedMinutes: number;
}

export type AgendaItem = AgendaTaskItem | AgendaBreakItem;

/** Why a plan came back without a servable agenda. `no_eligible_tasks` routes to §8.1's
 *  "no available tasks" coaching (read the retained rejects for the cause); `nothing_fits`
 *  offers to SPLIT `splitCandidate` rather than ending the session (spec §8.2). */
export type PlanOutcome = 'planned' | 'no_eligible_tasks' | 'nothing_fits';

export interface SessionPlan {
  sessionType: SessionType;
  /** Total wall minutes this plan was generated for. The session's planned END is movable
   *  (extend, task 28 §4.1) — the planner never assumes a fixed end-time; replanRemaining takes
   *  whatever time actually remains. */
  sessionMinutes: number;
  items: AgendaItem[];
  outcome: PlanOutcome;
  /** When `nothing_fits`: the task to offer splitting (via breakdown) — never shortened. */
  splitCandidate: Task | null;
  /** Retained rejects of the two hard pre-filters (spec §5.3): §8.1's coaching and R4's
   *  buried-task scan read these. Never discarded. */
  capabilityRejects: readonly FilterReject[];
  dependencyRejects: readonly DependencyReject[];
}

/** Union of tools the planned tasks require — the post-planning tools checklist (spec §6.2). */
export function planRequiredTools(plan: SessionPlan): string[] {
  const tools = new Set<string>();
  for (const item of plan.items) {
    if (item.kind !== 'task') continue;
    for (const tool of item.task.toolRequirements) tools.add(tool);
  }
  return [...tools].sort();
}

/**
 * The §6.2 missing-tools fallback's first half: the first NON-deep-focus task in the agenda
 * whose tool requirements are all present. The second half — rebuilding the rest of the agenda
 * against available tools — is a fresh planSession/replanRemaining call with the corrected
 * `checkIn.tools`.
 */
export function firstWorkableWithTools(
  plan: SessionPlan,
  presentTools: readonly string[],
): AgendaTaskItem | null {
  const have = new Set(presentTools);
  for (const item of plan.items) {
    if (item.kind !== 'task' || item.deepFocus) continue;
    if (item.task.toolRequirements.every((tool) => have.has(tool))) return item;
  }
  return null;
}
