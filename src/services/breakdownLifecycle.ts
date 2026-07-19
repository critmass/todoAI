// Task 25 R7 — parent-task lifecycle after breakdown (post-completion side of it).
//
// R7 keeps the broken-down parent alive and, when its LAST subtask completes, fires an immediate
// `breakdown_complete` coaching conversation asking the user to check the parent off. The parent
// is NEVER auto-completed — the check-off is the user's (constraint: no "looks done, closing it"
// path). Until that conversation resolves, the parent is held out of the ranked pool by the U1
// filter's `pendingBreakdownComplete` signal (scoring/filter.ts + `pendingBreakdownCompleteTaskIds`
// below), so the U2 bug can't return through the side door in the window between "last subtask
// done" and "user confirms".
//
// Resolution semantics live at the coaching seam (task 24/13 wire them; noted here so they aren't
// reinvented):
//   • Confirmed done → complete the PARENT via services/taskCompletion.ts `completeTask`, which
//     already selects the correct primitive by recurrence type (constraint #7: an `unscheduled`
//     or recurring parent goes through recordUnscheduledCompletion, a one-off closes). Completing
//     the parent then re-runs this hook on IT — so a nested breakdown (parent is itself a
//     grandparent's subtask) chains its confirmation. Auto-completion is out of scope.
//   • Not actually done → `add_missing_task`, which re-blocks the parent with a fresh subtask and
//     the chain continues. (add_missing_task dispatch is still unexercised on-device — task 32.)
//
// This module only ENQUEUES the trigger at the right moment with the right precedence; running the
// conversation is the dispatcher's job.

import type { TasksRepository } from '../db/repositories/tasks';
import type { DependenciesRepository } from '../db/repositories/dependencies';
import type { CoachingRepository } from '../db/repositories/coaching';
import type { CoachingQueueEntry } from '../types/domain';
import type { CoachingUrgency } from '../types/db';
import { enqueueCoachingTrigger } from './coaching/triggers';

export interface BreakdownLifecycleDeps {
  tasks: Pick<TasksRepository, 'getById'>;
  dependencies: Pick<DependenciesRepository, 'listForTask'>;
  coaching: Pick<CoachingRepository, 'create' | 'linkTask' | 'linkSession' | 'priorityQueue'>;
}

export type BreakdownCompleteFireResult =
  | {
      fired: false;
      /** Why nothing was enqueued. */
      reason: 'no_parent' | 'parent_inactive' | 'parent_still_blocked' | 'already_pending';
    }
  | {
      fired: true;
      parentTaskId: number;
      entry: CoachingQueueEntry;
      /** 'immediate' normally; downgraded to 'next_start' when another `breakdown_complete` is
       *  already pending, so chained confirmations queue instead of stacking two immediates
       *  (R7 nested-breakdown edge). */
      urgency: CoachingUrgency;
      /** True iff a pending `session_recalibration` (3-skip) exists. That trigger WINS the
       *  immediate slot — the user is struggling, the celebration waits one beat. The
       *  coaching_priority_queue view realizes the ordering (both are 'immediate', so the older
       *  recalibration drains first); this flag records the precedence for the caller. */
      precededByRecalibration: boolean;
    };

/**
 * Call after ANY task completion in the execution flow, with the just-completed task's id. If that
 * task was the last incomplete subtask of a broken-down parent — i.e. completing it leaves the
 * parent with no unresolved `depends_on` blockers — this enqueues a `breakdown_complete` coaching
 * row for the parent (R7b). A no-op (with a reason) otherwise, so it's always safe to call.
 */
export async function fireBreakdownCompleteIfParentUnblocked(
  deps: BreakdownLifecycleDeps,
  completedTaskId: number,
  opts?: { sessionId?: string },
): Promise<BreakdownCompleteFireResult> {
  const completed = await deps.tasks.getById(completedTaskId);
  if (!completed || completed.parentTaskId == null) {
    return { fired: false, reason: 'no_parent' };
  }
  const parentId = completed.parentTaskId;

  const parent = await deps.tasks.getById(parentId);
  if (!parent || parent.status !== 'active') {
    // Parent already closed/eliminated — nothing to confirm.
    return { fired: false, reason: 'parent_inactive' };
  }

  // Parent unblocks only when EVERY task it depends_on is completed. The R7a edges make those the
  // subtasks; any add_dependency edges count too — the parent is genuinely unblocked or it isn't.
  const blockers = await deps.dependencies.listForTask(parentId);
  for (const blocker of blockers) {
    const blockerTask = await deps.tasks.getById(blocker.dependsOnTaskId);
    if (!blockerTask || blockerTask.status !== 'completed') {
      return { fired: false, reason: 'parent_still_blocked' };
    }
  }

  const pending = await deps.coaching.priorityQueue();

  // Idempotence: never enqueue a second confirmation for the same parent.
  const alreadyForParent = pending.some(
    (e) => e.triggerType === 'breakdown_complete' && e.relatedTaskIds.includes(parentId),
  );
  if (alreadyForParent) {
    return { fired: false, reason: 'already_pending' };
  }

  const hasPendingBreakdownComplete = pending.some((e) => e.triggerType === 'breakdown_complete');
  const precededByRecalibration = pending.some(
    (e) => e.triggerType === 'session_recalibration',
  );

  // Nested chain: queue behind an already-pending confirmation rather than firing two immediates.
  const urgency: CoachingUrgency = hasPendingBreakdownComplete ? 'next_start' : 'immediate';

  const entry = await enqueueCoachingTrigger(deps.coaching, {
    trigger: 'breakdown_complete',
    urgency,
    relatedTaskIds: [parentId],
    relatedSessionIds: opts?.sessionId ? [opts.sessionId] : undefined,
    triggerData: { parentTaskId: parentId, lastSubtaskId: completedTaskId },
  });

  return { fired: true, parentTaskId: parentId, entry, urgency, precededByRecalibration };
}

/**
 * The set of task ids currently held out of the pool by a pending `breakdown_complete` row (R7c) —
 * feeds scoring/filter.ts `filterDependencyBlocked`'s `pendingBreakdownComplete` argument at the
 * selection boundary. Derived from the coaching priority queue so no new task state is invented
 * (the design decision recorded in the findings report: the U1 filter, not an R4 sentinel).
 */
export async function pendingBreakdownCompleteTaskIds(
  coaching: Pick<CoachingRepository, 'priorityQueue'>,
): Promise<Set<number>> {
  const pending = await coaching.priorityQueue();
  const ids = new Set<number>();
  for (const entry of pending) {
    if (entry.triggerType === 'breakdown_complete') {
      for (const taskId of entry.relatedTaskIds) ids.add(taskId);
    }
  }
  return ids;
}
