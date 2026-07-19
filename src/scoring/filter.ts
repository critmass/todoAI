// Task 10, R3 — the context/tool hard pre-filter (spec §5.1 fork 4, resolved: filter, not
// weight). A task whose context_tags aren't satisfied by the current session, or whose
// tool_requirements aren't all present, is unrankable right now — not merely down-weighted —
// so this runs at the selection boundary BEFORE scoring, not as one of the summed factors (see
// ./factors.ts's FACTOR_WEIGHTS, which no longer carries contextFit).
//
// The filter RETAINS its rejects rather than discarding them: R4 (a separate, later trigger —
// out of scope here) scans the filtered-out set at app open to catch tasks buried out of
// context/tool reach. Callers that just want a scoreable pool can ignore `.rejected`; callers
// building the buried-task scan need it. An empty `.eligible` pool is the caller's cue to route
// to the existing §8.1 "no available tasks" coaching path — that dispatch is task 11 territory,
// not built here.

import type { TaskWithNeglect } from '../db/repositories/tasks';
import type { SessionCheckIn } from './score';

/** A task dropped by the hard filter, with enough detail for R4's later coaching conversation
 *  to distinguish "wrong context" from "missing tool" (and which ones). */
export interface FilterReject {
  item: TaskWithNeglect;
  /** Context tags the task requires that this session doesn't have. Non-empty iff context-blocked. */
  missingContexts: readonly string[];
  /** Tools the task requires that this session doesn't have. Non-empty iff tool-blocked. */
  missingTools: readonly string[];
}

export interface FilterResult {
  /** The pool that passed the hard filter — safe to hand to scoreTasks/rankWithContextNovelty. */
  eligible: TaskWithNeglect[];
  /** Everything dropped, retained (not discarded) so a later trigger can read it. */
  rejected: FilterReject[];
}

function missingEntries(required: readonly string[], available: readonly string[]): string[] {
  if (required.length === 0) return []; // no requirement → nothing missing (flexible)
  const have = new Set(available);
  return required.filter((entry) => !have.has(entry));
}

// =====================================================================
// U1 — the dependency-blocked hard pre-filter (task 10 review, mandatory follow-up).
//
// R2 gave ordered breakdowns REAL dependency edges, but ordered siblings from one breakdown
// share created_at (equal neglect clocks) and inherit the parent's context_tags (same shuffle
// group), so the fan-out importance offset separates adjacent steps by only ≈0.2–0.4% of
// finalScore — noise to weightedShuffle's proportional sampler. rankWithContextNovelty therefore
// serves an ordered chain in NEAR-RANDOM order, and no offset tuning fixes it: the fix is to keep
// blocked tasks out of the pool entirely. This runs as a SECOND hard pre-filter beside
// filterBySessionCapability at the selection boundary (task 11), BEFORE either ranker.
//
// It is pure: the caller supplies the two blocking signals (a repository read produces them —
// dependenciesRepository.listUnresolvedBlockersForActiveTasks() and coachingRepository
// .priorityQueue() filtered to 'breakdown_complete'), and this partitions accordingly, following
// filterBySessionCapability's exact partition-and-retain contract so R4's buried-task scan and
// the §8.1 "no available tasks" coaching path can read the rejects.
// =====================================================================

/** A task held out of the pool by the dependency filter, with why. At least one of the two
 *  signals is set on every reject (both may be, e.g. a blocked parent also pending confirmation). */
export interface DependencyReject {
  item: TaskWithNeglect;
  /** Task ids this task depends_on that are not yet completed. Non-empty iff dependency-blocked
   *  (the R2 chain case). Empty when the task is held ONLY for a pending breakdown confirmation. */
  blockedBy: readonly number[];
  /** True iff held out pending a `breakdown_complete` coaching resolution (R7c): the parent
   *  unblocked when its last subtask completed, but must not re-enter the ranked pool before the
   *  user's check-off conversation resolves — the U2 bug otherwise returns through the side door. */
  pendingBreakdownComplete: boolean;
}

export interface DependencyFilterResult {
  /** The pool with no unresolved blockers and no pending breakdown confirmation — safe to rank. */
  eligible: TaskWithNeglect[];
  /** Everything held out, retained (not discarded) with its reason(s). */
  rejected: DependencyReject[];
}

/**
 * Partitions a neglect-annotated pool into what is actually startable right now vs. what is
 * blocked, by two signals the caller precomputes:
 *
 * - `unresolvedBlockers`: taskId → the ids of tasks it depends_on that are NOT yet completed.
 *   A task absent from the map, or mapped to an empty array, has no live blockers.
 * - `pendingBreakdownComplete`: task ids with an open `breakdown_complete` coaching row (R7c).
 *
 * A task is eligible iff it has no unresolved blockers AND is not awaiting a breakdown
 * confirmation. Rejects carry the blocking task ids so R4's scan and the §8.1 coaching path can
 * use them. Pure and synchronous, exactly like filterBySessionCapability — the DB read that
 * produces the two signals lives at the selection boundary (task 11), not here.
 */
export function filterDependencyBlocked(
  items: readonly TaskWithNeglect[],
  unresolvedBlockers: ReadonlyMap<number, readonly number[]>,
  pendingBreakdownComplete: ReadonlySet<number> = new Set<number>(),
): DependencyFilterResult {
  const eligible: TaskWithNeglect[] = [];
  const rejected: DependencyReject[] = [];

  for (const item of items) {
    const blockedBy = unresolvedBlockers.get(item.task.id) ?? [];
    const held = pendingBreakdownComplete.has(item.task.id);
    if (blockedBy.length === 0 && !held) {
      eligible.push(item);
    } else {
      rejected.push({ item, blockedBy, pendingBreakdownComplete: held });
    }
  }

  return { eligible, rejected };
}

/**
 * Partitions a neglect-annotated pool into what the current session can actually attempt vs.
 * what it can't, by exact tag match against `checkIn.contexts` / `checkIn.tools` (mirrors the
 * extraction vocabulary's normalized tags — case-sensitive, same as the former contextFitFactor).
 * A task with no context_tags and no tool_requirements always passes (context/tool-flexible).
 */
export function filterBySessionCapability(
  items: readonly TaskWithNeglect[],
  checkIn: SessionCheckIn,
): FilterResult {
  const eligible: TaskWithNeglect[] = [];
  const rejected: FilterReject[] = [];

  for (const item of items) {
    const missingContexts = missingEntries(item.task.contextTags, checkIn.contexts);
    const missingTools = missingEntries(item.task.toolRequirements, checkIn.tools);
    if (missingContexts.length === 0 && missingTools.length === 0) {
      eligible.push(item);
    } else {
      rejected.push({ item, missingContexts, missingTools });
    }
  }

  return { eligible, rejected };
}
