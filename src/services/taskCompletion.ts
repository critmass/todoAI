// Task 9 — Completion-primitive policy (service layer). The repositories expose the completion
// *primitives* (tasks.update / tasks.recordUnscheduledCompletion / recurrence.increment*); THIS
// is the policy that, given a task, checks its recurrence type FIRST and dispatches to the right
// one. Getting this wrong corrupts recurring tasks invisibly (orientation §3, constraint #7), so
// the six-way mapping is spelled out explicitly and unit-tested against a real SQLite engine.
//
// The critical, opposite-semantics boundary (spec §4.2):
//   • true one-off (NO task_recurrence row)  → close permanently (status='completed').
//   • 'unscheduled'                          → reset the neglect clock, STAY active (never close).
// Both look period-less; they are not interchangeable.
//
// SCOPE LINE (flagged for task 13). Completion here does the COMPLETION-driven work: close, or
// record progress + reset the neglect clock. It deliberately does NOT do the TIME-driven period
// machinery — advancing next_due_at to the next scheduled occurrence, rolling reset_date at a
// period boundary, applying the missed-quota importance boost (spec §4.2). Those fire when a
// period boundary passes, not when the user completes an occurrence, and belong to the
// recurrence/timer engine (task 13). Completing a 'scheduled'/'quota'/'scheduled_quota' task
// therefore leaves next_due_at where it was for task 13 to advance.

import type { Task } from '../types/domain';
import type { TasksRepository } from '../db/repositories/tasks';
import type { RecurrenceRepository } from '../db/repositories/recurrence';
import { NotFoundError } from '../db/errors';

export interface TaskCompletionDeps {
  tasks: Pick<TasksRepository, 'getById' | 'update' | 'recordUnscheduledCompletion'>;
  recurrence: Pick<
    RecurrenceRepository,
    'getByTaskId' | 'incrementCountProgress' | 'incrementPeriodProgress'
  >;
}

/** Options for completeTask (task 28 §2.1). */
export interface CompleteTaskOptions {
  /** Minutes worked in the episode that ENDED in this completion. Folds together with any
   *  accumulated_minutes from earlier parked sittings into ONE actual_duration_history entry.
   *  Omit (coaching check-offs, R7 breakdown_complete confirmations) → 0: only accumulated folds. */
  episodeMinutes?: number;
}

/** What completion did, discriminated by recurrence category. `closed` says whether the task
 *  transitioned to 'completed' (dropping out of the active pool); everything else stays active. */
export type CompletionOutcome =
  | { recurrence: 'one_off'; closed: true }
  | { recurrence: 'unscheduled'; closed: false }
  | { recurrence: 'scheduled'; closed: false }
  | { recurrence: 'count'; closed: boolean; progress: number; target: number; targetReached: boolean }
  | {
      recurrence: 'quota' | 'scheduled_quota';
      closed: false;
      progress: number;
      quota: number;
      quotaReached: boolean;
    };

export interface CompletionResult {
  outcome: CompletionOutcome;
  /** The task row after the write. */
  task: Task;
}

async function requireTask(deps: TaskCompletionDeps, taskId: number): Promise<Task> {
  const task = await deps.tasks.getById(taskId);
  if (!task) throw new NotFoundError('task', taskId);
  return task;
}

/**
 * Completes `taskId`, choosing the correct primitive by recurrence type (spec §4.2). First folds
 * cumulative work time (accumulated parked minutes + this episode's `opts.episodeMinutes`) into a
 * single actual_duration_history entry (task 28 §2.1), then dispatches:
 *
 * - one-off (no recurrence row): close permanently.
 * - unscheduled: reset the neglect clock, stay active.
 * - count: increment the running total; close only when it reaches `target`, otherwise reset the
 *   neglect clock and stay active (§5.2: resetting on each incremental completion is fine).
 * - scheduled: reset the neglect clock, stay active (next_due_at advancement → task 13).
 * - quota / scheduled_quota: increment period progress, reset the neglect clock, stay active
 *   (period rollover / quota-satisfied hiding → task 13).
 */
export async function completeTask(
  deps: TaskCompletionDeps,
  taskId: number,
  opts?: CompleteTaskOptions,
): Promise<CompletionResult> {
  const existing = await requireTask(deps, taskId);

  // The cumulative-duration FOLD (task 28 §2.1), at the single choke point BEFORE recurrence
  // dispatch, so it is identical across all six branches (constraint #7 untouched — the fold is
  // orthogonal to which primitive closes or keeps the task). total = accumulated (earlier parked
  // sittings) + this episode. A completion with zero recorded work adds NO history entry — a 0 is
  // censored/no-data, not a "0-minute task", and would bias average_actual_duration low. It still
  // clears any parked state. This satisfies the invariant "one actual_duration_history entry per
  // completion equal to the total minutes worked toward it, every recurrence type".
  const total = existing.accumulatedMinutes + (opts?.episodeMinutes ?? 0);
  if (total > 0) {
    const history = [...existing.actualDurationHistory, total];
    const average = history.reduce((sum, minutes) => sum + minutes, 0) / history.length;
    await deps.tasks.update(taskId, {
      actualDurationHistory: history,
      averageActualDuration: average,
      accumulatedMinutes: 0,
      workState: 'none',
    });
  } else if (existing.accumulatedMinutes !== 0 || existing.workState !== 'none') {
    // Nothing to fold, but never leave parked state dangling on a completed task.
    await deps.tasks.update(taskId, { accumulatedMinutes: 0, workState: 'none' });
  }

  const recurrence = await deps.recurrence.getByTaskId(taskId);

  // true one-off: no task_recurrence row → close permanently. Dependents unblock implicitly
  // (dependency-blocking is resolved at query time — there is no stored 'blocked' flag).
  if (recurrence === undefined) {
    const task = await deps.tasks.update(taskId, { status: 'completed' });
    return { outcome: { recurrence: 'one_off', closed: true }, task };
  }

  switch (recurrence.type) {
    case 'unscheduled': {
      const task = await deps.tasks.recordUnscheduledCompletion(taskId);
      return { outcome: { recurrence: 'unscheduled', closed: false }, task };
    }

    case 'scheduled': {
      const task = await deps.tasks.recordUnscheduledCompletion(taskId);
      return { outcome: { recurrence: 'scheduled', closed: false }, task };
    }

    case 'count': {
      const { progress, targetReached } = await deps.recurrence.incrementCountProgress(taskId);
      const target = recurrence.target;
      if (targetReached) {
        const task = await deps.tasks.update(taskId, { status: 'completed' });
        return {
          outcome: { recurrence: 'count', closed: true, progress, target, targetReached: true },
          task,
        };
      }
      // not yet at target: reset the neglect clock, stay active.
      const task = await deps.tasks.recordUnscheduledCompletion(taskId);
      return {
        outcome: { recurrence: 'count', closed: false, progress, target, targetReached: false },
        task,
      };
    }

    case 'quota':
    case 'scheduled_quota': {
      const { progress, quota, quotaReached } = await deps.recurrence.incrementPeriodProgress(
        taskId,
      );
      const task = await deps.tasks.recordUnscheduledCompletion(taskId);
      return {
        outcome: { recurrence: recurrence.type, closed: false, progress, quota, quotaReached },
        task,
      };
    }
  }
}
