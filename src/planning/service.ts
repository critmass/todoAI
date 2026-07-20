// Task 11 — the async edge of the planner: performs the repository reads that feed the pure
// selection boundary (./planner.ts), in the required order. THIS is where task 25's R7 hold
// seam closes: pendingBreakdownCompleteTaskIds() is finally wired into
// filterDependencyBlocked's third argument, so a parent whose last subtask just completed is
// held out of the pool until the user's check-off conversation resolves.
//
// LLM SEAM (Jason's task-11 §2a ruling: deterministic v1, seam kept). Planning makes NO model
// call in v1 — the agenda is pure, reproducible logic, and at on-device speeds a planning call
// would cost real seconds before the user starts working. The `adjustPlan` hook below is the
// one sanctioned injection point: a future task (18/19's planning-scope skills) may pass an
// async adjustment that receives the deterministic plan and returns a (possibly modified) plan.
// v1 passes nothing; nothing else in the planner may acquire an LLM dependency.

import type { TasksRepository } from '../db/repositories/tasks';
import type { DependenciesRepository } from '../db/repositories/dependencies';
import type { CoachingRepository } from '../db/repositories/coaching';
import { pendingBreakdownCompleteTaskIds } from '../services/breakdownLifecycle';
import type { Rng } from '../scoring/score';
import type { SessionPlan } from './agenda';
import {
  planSession,
  replanRemaining,
  runSelectionBoundary,
  type PlanRequest,
  type ReplanOptions,
  type SelectionBoundaryResult,
} from './planner';

export interface PlanningRepositories {
  tasks: Pick<TasksRepository, 'listActiveByNeglect'>;
  dependencies: Pick<DependenciesRepository, 'listUnresolvedBlockersForActiveTasks'>;
  coaching: Pick<CoachingRepository, 'priorityQueue'>;
}

/** The sanctioned LLM/skill seam: receives the deterministic plan, returns the plan to use.
 *  Adjustments may reorder or annotate but must preserve the plan's contracts (the selection
 *  boundary has already run; an adjuster must never introduce a task that was filtered out). */
export type PlanAdjustment = (plan: SessionPlan) => Promise<SessionPlan> | SessionPlan;

/** Reads the three planning inputs and runs the selection boundary (both hard pre-filters,
 *  in order, rejects retained). Exposed separately so replan callers mid-session can reuse it. */
export async function loadSelectionBoundary(
  repos: PlanningRepositories,
  checkIn: PlanRequest['checkIn'],
): Promise<SelectionBoundaryResult> {
  const pool = await repos.tasks.listActiveByNeglect();
  const unresolvedBlockers = await repos.dependencies.listUnresolvedBlockersForActiveTasks();
  const pendingBreakdownComplete = await pendingBreakdownCompleteTaskIds(repos.coaching);
  return runSelectionBoundary(pool, checkIn, unresolvedBlockers, pendingBreakdownComplete);
}

/** Session-start planning over live repository state (spec §6.2's "plan generated (hidden)"). */
export async function planSessionFromRepositories(
  repos: PlanningRepositories,
  request: PlanRequest,
  now: number,
  rng: Rng = Math.random,
  adjustPlan?: PlanAdjustment,
): Promise<SessionPlan> {
  const boundary = await loadSelectionBoundary(repos, request.checkIn);
  const plan = planSession(boundary, request, now, rng);
  return adjustPlan ? adjustPlan(plan) : plan;
}

/** Mid-session tail regeneration over live repository state — the escape valve, break-overrun,
 *  and extend callers (task 28 design §4.2) all route here. Re-reads the repositories so a task
 *  completed or parked minutes ago is reflected; `options.excludeTaskIds` covers what state
 *  alone can't (e.g. skipped-this-session tasks that are still active). */
export async function replanRemainingFromRepositories(
  repos: PlanningRepositories,
  request: Omit<PlanRequest, 'sessionMinutes'>,
  remainingMinutes: number,
  now: number,
  rng: Rng = Math.random,
  options: ReplanOptions = {},
  adjustPlan?: PlanAdjustment,
): Promise<SessionPlan> {
  const boundary = await loadSelectionBoundary(repos, request.checkIn);
  const plan = replanRemaining(boundary, request, remainingMinutes, now, rng, options);
  return adjustPlan ? adjustPlan(plan) : plan;
}
