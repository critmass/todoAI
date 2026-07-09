import type { SqliteConnection } from '../connection';
import { NotFoundError, RecurrenceValidationError } from '../errors';
import {
  recurrenceToRow,
  taskRecurrenceRowToDomain,
  type Recurrence,
  type TaskRecurrenceEntity,
} from '../../types/domain';
import type { TaskRecurrenceRow } from '../../types/db';

function translateConstraintError(err: unknown, recurrence: Recurrence): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/CHECK constraint failed/i.test(message)) {
    return new RecurrenceValidationError(
      `Invalid recurrence for type '${recurrence.type}': target_count must be set iff type is 'count' (${message})`,
    );
  }
  return err instanceof Error ? err : new Error(message);
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

  async function update(taskId: number, recurrence: Recurrence): Promise<TaskRecurrenceEntity> {
    const row = recurrenceToRow(recurrence);
    try {
      await db.execute(
        `UPDATE task_recurrence
         SET recurrence_type = ?, recurrence_pattern = ?, target_count = ?, current_period_progress = ?
         WHERE task_id = ?`,
        [
          row.recurrence_type,
          row.recurrence_pattern,
          row.target_count,
          row.current_period_progress,
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

  return { getByTaskId, getEntityByTaskId, create, update, remove, incrementCountProgress };
}

export type RecurrenceRepository = ReturnType<typeof createRecurrenceRepository>;
