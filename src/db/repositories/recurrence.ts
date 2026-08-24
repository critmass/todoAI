import type { SqliteConnection } from '../connection';
import { NotFoundError, RecurrenceValidationError } from '../errors';
import {
  recurrenceRepeatIssue,
  recurrenceToRow,
  taskRecurrenceRowToDomain,
  type Recurrence,
  type TaskRecurrenceEntity,
} from '../../types/domain';
import type { TaskRecurrenceRow } from '../../types/db';

/** What the period sweep (task 36) reads for one task: its recurrence entity plus the two `tasks`
 *  columns the sweep decides against. Not a domain entity - a read model for exactly one consumer,
 *  `src/services/recurrence/advance.ts`. */
export interface SweepableRecurrence {
  entity: TaskRecurrenceEntity;
  nextDueAt: string | null;
  lastCompletedAt: string | null;
}

function translateConstraintError(err: unknown, recurrence: Recurrence): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/CHECK constraint failed/i.test(message)) {
    return new RecurrenceValidationError(
      `Invalid recurrence for type '${recurrence.type}': target_count must be set iff type is 'count' (${message})`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * Task 46 — the write-side gate on `scheduled.repeat`.
 *
 * `recurrence_pattern` is free-form JSON (`CHECK (json_valid(...))` and nothing more), which is
 * exactly why the four repeat modes needed no migration — and equally why the schema cannot say
 * anything about their legality. This is the one place that can, and it runs on BOTH writers, so
 * the rule "dayOfMonth carries no weekdays" is structural rather than a convention the next editor
 * screen is trusted to remember.
 */
function requireValidRepeat(recurrence: Recurrence): void {
  const issue = recurrenceRepeatIssue(recurrence);
  if (issue !== null) {
    throw new RecurrenceValidationError(`Invalid recurrence for type '${recurrence.type}': ${issue}`);
  }
}

export function createRecurrenceRepository(db: SqliteConnection) {
  async function getEntityByTaskId(taskId: number): Promise<TaskRecurrenceEntity | undefined> {
    const result = await db.execute('SELECT * FROM task_recurrence WHERE task_id = ?', [taskId]);
    const row = result.rows[0] as unknown as TaskRecurrenceRow | undefined;
    return row ? taskRecurrenceRowToDomain(row) : undefined;
  }

  /** Queries task_recurrence directly - undefined means "no row exists" (true one-off),
   *  never "not fetched" (see the doc comment on TaskRecurrenceEntity in domain.ts). */
  async function getByTaskId(taskId: number): Promise<Recurrence | undefined> {
    const entity = await getEntityByTaskId(taskId);
    return entity?.recurrence;
  }

  async function create(taskId: number, recurrence: Recurrence): Promise<TaskRecurrenceEntity> {
    requireValidRepeat(recurrence);
    const row = recurrenceToRow(recurrence);
    try {
      await db.execute(
        `INSERT INTO task_recurrence
           (task_id, recurrence_type, recurrence_pattern, target_count, current_period_progress)
         VALUES (?, ?, ?, ?, ?)`,
        [
          taskId,
          row.recurrence_type,
          row.recurrence_pattern,
          row.target_count,
          row.current_period_progress,
        ],
      );
    } catch (err) {
      throw translateConstraintError(err, recurrence);
    }
    const created = await getEntityByTaskId(taskId);
    if (!created) {
      throw new NotFoundError('task_recurrence for task', taskId);
    }
    return created;
  }

  /** Replaces the recurrence definition. RESTARTS THE PERIOD ACCOUNTING with it (task 36): the
   *  existing mapper already zeroes `current_period_progress`, so the recorded shortfall goes with
   *  it — a quota of 10 missed by 8 must not keep boosting a task the user has just redefined as
   *  "2× a week". And a change TO 'unscheduled'/'count' clears `reset_date`, both because neither
   *  type has a period (§4.2) and because migration 006's CHECK now refuses one; leaving the old
   *  boundary behind would turn an ordinary edit into a constraint failure. */
  async function update(taskId: number, recurrence: Recurrence): Promise<TaskRecurrenceEntity> {
    requireValidRepeat(recurrence);
    const row = recurrenceToRow(recurrence);
    const keepsPeriod = recurrence.type !== 'unscheduled' && recurrence.type !== 'count';
    try {
      await db.execute(
        `UPDATE task_recurrence
         SET recurrence_type = ?, recurrence_pattern = ?, target_count = ?, current_period_progress = ?,
             reset_date = CASE WHEN ? = 1 THEN reset_date ELSE NULL END,
             last_period_shortfall = 0
         WHERE task_id = ?`,
        [
          row.recurrence_type,
          row.recurrence_pattern,
          row.target_count,
          row.current_period_progress,
          keepsPeriod ? 1 : 0,
          taskId,
        ],
      );
    } catch (err) {
      throw translateConstraintError(err, recurrence);
    }
    const updated = await getEntityByTaskId(taskId);
    if (!updated) {
      throw new NotFoundError('task_recurrence for task', taskId);
    }
    return updated;
  }

  async function remove(taskId: number): Promise<void> {
    await db.execute('DELETE FROM task_recurrence WHERE task_id = ?', [taskId]);
  }

  /** Primitive for 'count'-recurrence completion (spec §4.2): increments current_period_progress
   *  by one and reports whether target_count was reached. Whether the task itself flips to done
   *  (and unblocks dependents) is a service-layer decision (task 9+) - this DAO method only
   *  performs the write and hands back the fact the caller needs. */
  async function incrementCountProgress(
    taskId: number,
  ): Promise<{ progress: number; targetReached: boolean }> {
    const entity = await getEntityByTaskId(taskId);
    if (!entity) {
      throw new NotFoundError('task_recurrence for task', taskId);
    }
    if (entity.recurrence.type !== 'count') {
      throw new RecurrenceValidationError(
        `incrementCountProgress: task ${taskId}'s recurrence is '${entity.recurrence.type}', not 'count'`,
      );
    }
    const nextProgress = entity.currentPeriodProgress + 1;
    await db.execute('UPDATE task_recurrence SET current_period_progress = ? WHERE task_id = ?', [
      nextProgress,
      taskId,
    ]);
    return { progress: nextProgress, targetReached: nextProgress >= entity.recurrence.target };
  }

  /** Primitive for quota-bearing completion (spec §4.2: 'quota' / 'scheduled_quota'): increments
   *  current_period_progress by one within the CURRENT period and reports whether the per-period
   *  quota is now met. It does NOT reset the period, advance reset_date, or apply the missed-quota
   *  importance boost - those are time-driven period-rollover concerns (a period boundary passing),
   *  owned by the recurrence period engine (task 36's `rollPeriod` below), not by completion.
   *  Throws for any type that has no per-period quota ('scheduled', 'unscheduled', 'count').
   *  Service-layer completion policy
   *  (task 9, ../../scoring / services) decides when to call this by checking the recurrence type. */
  async function incrementPeriodProgress(
    taskId: number,
  ): Promise<{ progress: number; quota: number; quotaReached: boolean }> {
    const entity = await getEntityByTaskId(taskId);
    if (!entity) {
      throw new NotFoundError('task_recurrence for task', taskId);
    }
    const { recurrence } = entity;
    if (recurrence.type !== 'quota' && recurrence.type !== 'scheduled_quota') {
      throw new RecurrenceValidationError(
        `incrementPeriodProgress: task ${taskId}'s recurrence is '${recurrence.type}', which has no per-period quota`,
      );
    }
    const nextProgress = entity.currentPeriodProgress + 1;
    await db.execute('UPDATE task_recurrence SET current_period_progress = ? WHERE task_id = ?', [
      nextProgress,
      taskId,
    ]);
    return { progress: nextProgress, quota: recurrence.quota, quotaReached: nextProgress >= recurrence.quota };
  }

  /** One row of the recurrence period sweep's read (task 36) - a period-bearing recurrence on an
   *  ACTIVE task, with the two task columns the sweep decides against (`next_due_at`, and
   *  `last_completed_at` to tell an occurrence that has been done from one that was missed) so the
   *  whole sweep is one query rather than one per task. */
  async function listSweepable(): Promise<SweepableRecurrence[]> {
    // THE THREE EXCLUSIONS THE SWEEP MUST NEVER GET WRONG ARE IN THIS QUERY, not in a downstream
    // `if` that a refactor could drop (orientation constraint #7):
    //   • one-offs      - excluded by the INNER JOIN: no task_recurrence row, no result row.
    //   • 'unscheduled' - excluded by the type list. Its resurfacing IS the neglect clock (§4.2);
    //                     a period or a due date would be a fabricated one.
    //   • 'count'       - excluded by the type list. N total ever, no period to roll.
    // Deleted/completed tasks are excluded too: advancing the due date of something the user has
    // finished with would resurface it.
    const result = await db.execute(
      `SELECT tr.*,
              t.next_due_at       AS task_next_due_at,
              t.last_completed_at AS task_last_completed_at
         FROM task_recurrence tr
         JOIN tasks t ON t.id = tr.task_id
        WHERE t.status = 'active'
          AND tr.recurrence_type IN ('scheduled', 'quota', 'scheduled_quota')
        ORDER BY tr.task_id`,
    );
    return (
      result.rows as unknown as Array<
        TaskRecurrenceRow & { task_next_due_at: string | null; task_last_completed_at: string | null }
      >
    ).map((row) => ({
      entity: taskRecurrenceRowToDomain(row),
      nextDueAt: row.task_next_due_at,
      lastCompletedAt: row.task_last_completed_at,
    }));
  }

  function requirePeriodBearing(entity: TaskRecurrenceEntity, method: string): void {
    const { type } = entity.recurrence;
    if (type === 'unscheduled' || type === 'count') {
      throw new RecurrenceValidationError(
        `${method}: task ${entity.taskId}'s recurrence is '${type}', which has no period (spec §4.2)`,
      );
    }
  }

  /** Seeds the period boundary of a period-bearing recurrence that has never had one (task 36).
   *  NOT a roll: progress and the recorded shortfall are untouched, because nothing has closed. */
  async function setResetDate(taskId: number, resetDate: string): Promise<TaskRecurrenceEntity> {
    const entity = await getEntityByTaskId(taskId);
    if (!entity) throw new NotFoundError('task_recurrence for task', taskId);
    requirePeriodBearing(entity, 'setResetDate');
    await db.execute('UPDATE task_recurrence SET reset_date = ? WHERE task_id = ?', [resetDate, taskId]);
    const updated = await getEntityByTaskId(taskId);
    if (!updated) throw new NotFoundError('task_recurrence for task', taskId);
    return updated;
  }

  /** The PERIOD ROLLOVER primitive (spec §4.2, task 36) - the time-driven counterpart to
   *  `incrementPeriodProgress`'s completion-driven write. Zeroes the quota progress, moves the
   *  boundary to the new period's end, and records what the period that just closed came up short
   *  by. `shortfall` REPLACES the stored value and is never added to it: missed occurrences reset,
   *  they do not stack (§4.2, "no guilt stacking") - the caller caps it at the quota for the same
   *  reason. Throws for the two types that have no period; the schema now also refuses a reset_date
   *  on them (migration 006). */
  async function rollPeriod(
    taskId: number,
    next: { resetDate: string; shortfall: number },
  ): Promise<TaskRecurrenceEntity> {
    const entity = await getEntityByTaskId(taskId);
    if (!entity) throw new NotFoundError('task_recurrence for task', taskId);
    requirePeriodBearing(entity, 'rollPeriod');
    if (next.shortfall < 0) {
      throw new RecurrenceValidationError(`rollPeriod: shortfall must not be negative (${next.shortfall})`);
    }
    await db.execute(
      `UPDATE task_recurrence
          SET current_period_progress = 0, reset_date = ?, last_period_shortfall = ?
        WHERE task_id = ?`,
      [next.resetDate, next.shortfall, taskId],
    );
    const updated = await getEntityByTaskId(taskId);
    if (!updated) throw new NotFoundError('task_recurrence for task', taskId);
    return updated;
  }

  return {
    getByTaskId,
    getEntityByTaskId,
    create,
    update,
    remove,
    incrementCountProgress,
    incrementPeriodProgress,
    listSweepable,
    setResetDate,
    rollPeriod,
  };
}

export type RecurrenceRepository = ReturnType<typeof createRecurrenceRepository>;
