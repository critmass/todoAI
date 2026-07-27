// Task 13 — executing a TailDirective against the planner.
//
// The episode service DECIDES what should happen to the rest of the agenda (task 28 design §4.2:
// regenerate after a hyperfocus stretch, leave it alone otherwise, summary when no time remains);
// this is the thin edge that carries out the decision. They are separate so the decision stays
// testable without planning repositories, and so the episode service never grows a dependency on
// the planner's pool reads.
//
// The tail is REGENERATED, never shifted or shrunk in place. A shifted tail is stale — it was
// arranged for an energy ramp and a context grouping that a 75-minute stretch has invalidated —
// and the plan is hidden from the user anyway (spec §2.2/§6.2), so tasks that fall out were never
// promised and carry no guilt.

import type { Rng } from '../scoring/score';
import type { SessionPlan } from '../planning/agenda';
import type { PlanRequest } from '../planning/planner';
import {
  replanRemainingFromRepositories,
  type PlanningRepositories,
} from '../planning/service';
import type { TailDirective } from './episodeService';

/**
 * Runs a directive, returning the regenerated plan or `null` when there is nothing to replan
 * (`continue` keeps the existing tail; `summary` means the session is out of time).
 *
 * `precededByStretchMinutes` is passed straight through: task 11 owns the break-first rule and its
 * 50-minute threshold (`LONG_STRETCH_BREAK_FIRST_MINUTES`). Call it, do not reimplement it.
 */
export async function runTailDirective(
  repos: PlanningRepositories,
  request: Omit<PlanRequest, 'sessionMinutes'>,
  directive: TailDirective,
  now: number,
  rng?: Rng,
): Promise<SessionPlan | null> {
  if (directive.kind !== 'regenerate') return null;
  return replanRemainingFromRepositories(repos, request, directive.remainingMinutes, now, rng, {
    easier: directive.easier,
    precededByStretchMinutes: directive.precededByStretchMinutes,
    excludeTaskIds: new Set(directive.excludeTaskIds),
  });
}
