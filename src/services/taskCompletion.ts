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
 * Completes `taskId`, choosing the correct primitive by recurrence type (spec §4.2).
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
): Promise<CompletionResult> {
  await requireTask(deps, taskId);
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
