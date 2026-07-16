import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import { taskDomainToRow, taskRowToDomain, type Task, type TaskWriteInput } from '../../types/domain';
import type { TaskRow } from '../../types/db';

export type CreateTaskInput = TaskWriteInput & { title: string; estimatedDuration: number };

/** A task from the active pool, annotated with its neglect standing (spec §5.2).
 *
 *  Deliberately NOT sourced from the `active_tasks_with_neglect` view: that view's
 *  neglect_multiplier column calls SQLite's POWER(), and op-sqlite's Android build compiles
 *  SQLite without SQLITE_ENABLE_MATH_FUNCTIONS (see android/build.gradle's defaultSqliteFlags -
 *  FTS5 and RTREE are explicitly enabled there; math functions are not), so POWER() is unavailable
 *  on-device. weeksNeglected uses the same pure-arithmetic formula as the view (safe - no POWER());
 *  neglectMultiplier is squared here in TypeScript instead, producing an identical, still-uncapped
 *  result (constraint: never cap this - spec §5.2 fail-safe).
 *
 *  CONFIRMED on-device 2026-07-16 (S23 FE, op-sqlite 17.1.2) - this closes the prior
 *  TODO(device verification): `SELECT POWER(2,2)` fails with "[op-sqlite] sqlite query error: no
 *  such function: POWER". The bypass is REQUIRED, not defensive - do not "simplify" it back to
 *  reading the view. See docs/eval/task12_phaseB_findings_report.md §1. (If a future op-sqlite
 *  build compiles in math functions, re-run that spike before changing anything here.) */
export interface TaskWithNeglect {
  task: Task;
  weeksNeglected: number;
  neglectMultiplier: number;
}

export function createTasksRepository(db: SqliteConnection) {
  async function getById(id: number): Promise<Task | undefined> {
    const result = await db.execute('SELECT * FROM tasks WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as TaskRow | undefined;
    return row ? taskRowToDomain(row) : undefined;
  }

  async function create(input: CreateTaskInput): Promise<Task> {
    const row = taskDomainToRow({
      ...input,
      durationSource: input.durationSource ?? 'model_guess',
    });
    const columns = Object.keys(row) as Array<keyof typeof row>;
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] as never);

    const result = await db.execute(
      `INSERT INTO tasks (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('tasksRepository.create: insert did not return an id');
    }
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('task', id);
    }
    return created;
  }

  async function update(id: number, patch: TaskWriteInput): Promise<Task> {
    const row = taskDomainToRow(patch);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    if (columns.length > 0) {
      const setClause = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => row[column] as never);
      await db.execute(`UPDATE tasks SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('task', id);
    }
    return updated;
  }

  /** Soft-delete: sets status='deleted', never removes the row (history/FKs depend on it). */
  async function softDelete(id: number): Promise<void> {
    await db.execute("UPDATE tasks SET status = 'deleted' WHERE id = ?", [id]);
  }

  /** Primitive for 'unscheduled'-recurrence completion (spec §4.2): resets the neglect clock
   *  via last_completed_at WITHOUT setting status='completed' - the task stays active and
   *  resurfaces via neglect only (constraint #5). This is a primitive, not the policy: whether
   *  a given task IS unscheduled-recurrence is a service-layer decision (task 9+) made by
   *  checking recurrenceRepository.getByTaskId() first. A true one-off (no recurrence row)
   *  must use update({ status: 'completed' }) instead - the two are not interchangeable. */
  async function recordUnscheduledCompletion(id: number): Promise<Task> {
    await db.execute('UPDATE tasks SET last_completed_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('task', id);
    }
    return updated;
  }

  async function listActive(): Promise<Task[]> {
    const result = await db.execute("SELECT * FROM tasks WHERE status = 'active' ORDER BY id");
    return (result.rows as unknown as TaskRow[]).map(taskRowToDomain);
  }

  /** The active list ordered by neglect (most-neglected first) - see TaskWithNeglect's doc
   *  comment for why this bypasses the active_tasks_with_neglect view. */
  async function listActiveByNeglect(): Promise<TaskWithNeglect[]> {
    const result = await db.execute(
      `SELECT *,
         (julianday('now') - julianday(COALESCE(last_completed_at, created_at))) / 7.0
           AS weeks_neglected
       FROM tasks
       WHERE status = 'active'`,
    );
    const withNeglect = (result.rows as unknown as Array<TaskRow & { weeks_neglected: number }>).map(
      (row): TaskWithNeglect => {
        const weeksNeglected = row.weeks_neglected;
        return {
          task: taskRowToDomain(row),
          weeksNeglected,
          neglectMultiplier: weeksNeglected ** 2, // uncapped by design (spec §5.2) - never cap this
        };
      },
    );
    return withNeglect.sort((a, b) => b.neglectMultiplier - a.neglectMultiplier);
  }

  return {
    getById,
    create,
    update,
    softDelete,
    recordUnscheduledCompletion,
    listActive,
    listActiveByNeglect,
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;
