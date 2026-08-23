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
// SCOPE LINE. Completion here does the COMPLETION-driven work: close, or record progress + reset
// the neglect clock. It deliberately does NOT do the TIME-driven period machinery — advancing
// next_due_at to the next scheduled occurrence, rolling reset_date at a period boundary, applying
// the missed-quota importance boost (spec §4.2). Those fire when a period boundary passes, not when
// the user completes an occurrence.
//
// The other side of the line is BUILT as of task 36: `src/services/recurrence/` — an idempotent
// `advanceRecurrence(deps, today)` sweep at app open and session start. (It was split out of task
// 13 by ruling; 13 correctly built none of it.) Completing a 'scheduled'/'quota'/'scheduled_quota'
// task still leaves next_due_at exactly where it was, on purpose: the sweep notices that the
// occurrence has been completed — via `last_completed_at`, which the primitives below do write —
// and advances it. Do not move logic across this line in either direction.

import type { Task } from '../types/domain';
import type { TasksRepository } from '../db/repositories/tasks';
import type { RecurrenceRepository } from '../db/repositories/recurrence';
import type { InteractionsRepository } from '../db/repositories/interactions';
import { NotFoundError } from '../db/errors';

export interface TaskCompletionDeps {
  tasks: Pick<
    TasksRepository,
    'getById' | 'update' | 'recordUnscheduledCompletion' | 'recordHistoricalCompletion'
  >;
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
 * - scheduled: reset the neglect clock, stay active (next_due_at advancement → task 36's sweep).
 * - quota / scheduled_quota: increment period progress, reset the neglect clock, stay active
 *   (period rollover → task 36's sweep).
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

  // THE HISTORICAL-SUCCESS WRITE (task 17 Phase A) — the writer that did not exist anywhere until
  // now, so `historicalSuccessFactor` scored every task in the app off a permanent n = 0 on a 23 %
  // weight (task 13 report §7; task 44 §3 confirmed the omission rather than half-executing it).
  //
  // WHY HERE. It sits at the same single choke point as the duration fold, BEFORE recurrence
  // dispatch, for the same reason: it must be identical across all six branches and it must fire
  // exactly once per completion. Every completion in the app arrives through this function —
  // `completeEpisode`'s Done, `selfCompleteTask`, the R7 breakdown check-off — so counting here
  // counts each of them once, and the two dispositions that are NOT attempts (a park, and a
  // crash-recovered `abandoned` close) cannot reach it, because neither calls completeTask at all.
  // That is structural, exactly like constraint #11's park/skip split: not a policy check some
  // later refactor can drop.
  //
  // Placed before dispatch also means the `task` this function returns is already the post-write
  // row (every branch below re-reads), so no caller sees stale counters.
  //
  // WHAT COUNTS AS AN ATTEMPT — provisional PRODUCT INTENT, awaiting Jason's ruling (see
  // docs/eval/task17_phaseA_findings_report.md; task 44 §3 deliberately left it open for this
  // task). An attempt is a served-and-dispositioned encounter with a task: a completion or a skip.
  //   • completion → here, numerator and denominator.
  //   • skip       → tasks.recordSkipEpisode, denominator only.
  //   • park       → neither. The user is still working on it; nothing has been decided.
  //   • crash-recovered `abandoned` → neither. Constraint #11's spirit: a crash is not user
  //     failure, and must not drag a task's success rate down. (Task 19 owns the parallel
  //     friction-incident definition for the skill layer — divergence there is 19's call, not
  //     this task's.)
  //   • self-completion → a FULL completion. The task really is done; doing it away from the app
  //     does not make it a lesser success. `interactions.notes = 'self_completed'` remains the
  //     hook for DURATION-weighted aggregates, which are the ones with nothing to measure.
  // The definition is deliberately identical to the one `scoreTask` already encodes by passing
  // `completionCount + skipCount` as the evidence count — see recordHistoricalCompletion's
  // comment in the tasks repository for the invariant that keeps them one definition, not two.
  await deps.tasks.recordHistoricalCompletion(taskId);

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

// =====================================================================
// Task 44 §4 — self-complete: "mark a task done that you finished away from the app."
// =====================================================================

/** Marker written to `interactions.notes` on every self-completion (task 44 §4). Not a new
 *  column: `interactions` has no boolean "was this a self-completion" flag, and adding one for a
 *  single caller was judged more schema than the feature needs. A plain, greppable string is the
 *  convention task 17 should inherit for finding/excluding these rows — see the task 44 findings
 *  report for the reasoning.
 *
 *  TASK 17 PHASE A UPDATE: `tasks.completion_count`/`success_rate` ARE now written, by
 *  `completeTask`, which `selfCompleteTask` calls — so a self-completion counts as a full
 *  completion for the historical-success signal. Task 44 left that question open on purpose; the
 *  answer (and its provisional status) is recorded in `completeTask` above and in
 *  docs/eval/task17_phaseA_findings_report.md. This marker's job is unchanged and is now the more
 *  clearly separated one: it excludes these rows from DURATION-weighted aggregates, which have no
 *  episode to measure — not from the success COUNT, which is a real completion. */
export const SELF_COMPLETED_MARKER = 'self_completed';

export interface SelfCompleteDeps extends TaskCompletionDeps {
  interactions: Pick<InteractionsRepository, 'create' | 'linkTask'>;
}

/**
 * Marks `taskId` done from outside the app's own session flow. REUSES `completeTask` for the
 * entire recurrence-branching write (constraint #7, R7's fold, task 36's advance is unaffected —
 * completion still bumps `last_completed_at`, which is what the sweep reads) — this function adds
 * exactly one thing completeTask does not do: an `interactions` row recording that the completion
 * happened with NO EPISODE behind it.
 *
 * Ruling §0.2 ("self-completed tasks are excluded from completion-time calculations"), concretely:
 *   - `sessionId`, `userEnergyLevelStart/End`, `durationMinutes` are all EXPLICIT `null` — never
 *     invented. `completeTask` is called with no `episodeMinutes` (defaults to 0), so the
 *     cumulative-duration fold adds nothing beyond whatever was already `accumulatedMinutes` from
 *     real parked work — this call contributes zero NEW duration evidence.
 *   - `notes` carries `SELF_COMPLETED_MARKER` so a duration-weighted learner (task 17) can filter
 *     these out without a schema change.
 *   - It still COUNTS for completion and for the neglect clock, because `completeTask`'s own
 *     primitives (`recordUnscheduledCompletion` / `update({status:'completed'})`) are exactly what
 *     ordinary completion uses — there is no second completion path here, only a second CALLER.
 *     As of task 17 Phase A that includes the historical-success counters: `completeTask` calls
 *     `recordHistoricalCompletion`, so a self-completion is one successful attempt, indistinguish-
 *     able from an in-app one in `completion_count`/`success_rate` and distinguishable only
 *     through the marker below. Provisional product intent — see the Phase A findings report.
 *   - Recurring tasks still advance (task 36's sweep reads `last_completed_at`, which every
 *     `completeTask` branch writes) — nothing here bypasses that.
 */
export async function selfCompleteTask(
  deps: SelfCompleteDeps,
  taskId: number,
  opts?: CompleteTaskOptions,
): Promise<CompletionResult> {
  const result = await completeTask(deps, taskId, opts);
  const interaction = await deps.interactions.create({
    interactionType: 'task_completion',
    sessionId: null,
    userEnergyLevelStart: null,
    userEnergyLevelEnd: null,
    durationMinutes: null,
    completionStatus: 'completed',
    notes: SELF_COMPLETED_MARKER,
  });
  await deps.interactions.linkTask(interaction.id, taskId);
  return result;
}
