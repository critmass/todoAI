// Task 44 §0 ruling 1 — "a task blocked by other tasks gets BOTH buttons disabled: quick-start
// AND self-complete." Two real predicates, and exactly two, count as "blocked" here:
//
//   - dependency-blocked: an incomplete prerequisite (U1's pre-filter — task 10 review; without
//     it ordered chains were served out of order, a real defect fixed for tasks 10/25).
//   - held for R7 `breakdown_complete`: a parent awaiting the user's check-off is blocked BY its
//     own subtasks, same rule, same reason (R7 deliberately holds it out of the pool).
//
// This is the SAME shape `src/scoring/filter.ts`'s `filterDependencyBlocked` partitions on, but
// scoped to one task and phrased for a UI reason string rather than a reject list a scanner reads
// later — filterDependencyBlocked itself isn't reused here because it always returns the WHOLE
// pool partitioned, and the task-list row only wants a yes/no plus a sentence for one task at a
// time. The two SIGNALS it reads (`unresolvedBlockers`, `pendingBreakdownComplete`) are the exact
// same repository reads task 11's planning service uses, so this cannot drift from what actually
// blocks a task at session-planning time.

export interface BlockedStatus {
  blocked: boolean;
  /** A visible reason, never a hidden button (task 44 brief §3: "a missing button is a bug
   *  report, a disabled one with a reason is an explanation"). Null iff not blocked. */
  reason: string | null;
}

const NOT_BLOCKED: BlockedStatus = { blocked: false, reason: null };

/** Describes why `taskId` is blocked, if it is. `titleFor` resolves a blocker's title for a
 *  readable reason ("blocked by X") rather than a bare id; falls back to `#<id>` if the blocking
 *  task isn't in the caller's already-loaded set (shouldn't happen for an active-pool blocker, but
 *  a stale read is not a reason to crash a task-list row). */
export function describeBlocked(
  taskId: number,
  unresolvedBlockers: ReadonlyMap<number, readonly number[]>,
  pendingBreakdownComplete: ReadonlySet<number>,
  titleFor: (blockerId: number) => string | undefined,
): BlockedStatus {
  const blockers = unresolvedBlockers.get(taskId) ?? [];
  if (blockers.length > 0) {
    const names = blockers.map((id) => titleFor(id) ?? `task #${id}`);
    return { blocked: true, reason: `blocked by ${names.join(', ')}` };
  }
  if (pendingBreakdownComplete.has(taskId)) {
    return { blocked: true, reason: "blocked — waiting on your breakdown check-off" };
  }
  return NOT_BLOCKED;
}
