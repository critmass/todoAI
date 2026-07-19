import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  taskDomainToRow,
  taskRecurrenceRowToDomain,
  taskRowToDomain,
  type Period,
  type Recurrence,
  type Task,
  type TaskWriteInput,
} from '../../types/domain';
import type { TaskRecurrenceRow, TaskRow } from '../../types/db';

export type CreateTaskInput = TaskWriteInput & { title: string; estimatedDuration: number };

/** Days per recurrence period, for the R8 accrual gate. `month` is the conventional 30-day
 *  approximation — the gate is a fail-safe START condition, not a scheduling calculation, so
 *  calendar-exact month length isn't warranted. */
const NEGLECT_PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };

/**
 * R8 (task 25) — the neglect accrual gate for RECURRING tasks (spec §5.2, as re-ruled). On a
 * recurring task, neglect does not begin accruing until half the distance between occurrences has
 * elapsed; the occurrence gap is `period / (1 + quota)`. This returns that gap **in days**; the
 * caller offsets the neglect clock's anchor by it (`accrualStart = anchor + gap`).
 *
 * By type (the `(1 + quota)` denominator collapses to exactly "half the period" at quota = 1, so
 * there is no separate halving step):
 *   • quota / scheduled_quota → period_days / (1 + quota)         — the explicit occurrence count
 *   • scheduled               → 7 / (1 + occurrencesPerWeek)      — weekday schedules are weekly;
 *                                occurrencesPerWeek = scheduledDays.length (≥1). A single-day
 *                                weekly schedule → 7/2 = 3.5 d, matching R8's worked example.
 *   • unscheduled             → 0  (neglect IS its whole resurfacing mechanism, §4.2 — never gate)
 *   • count                   → 0  (no period to halve)
 *   • one-off (undefined)     → 0  (ruled: accrue from creation, no horizon fallback)
 *
 * This is a START CONDITION, NOT A CAP (constraint #5). Growth after `accrualStart` is unbounded;
 * nothing here saturates. Do not let a refactor turn this into a ceiling. Task 13's period
 * rollover composes with this rather than re-deriving it (brief §4).
 */
export function neglectAccrualGapDays(recurrence: Recurrence | undefined): number {
  if (recurrence === undefined) return 0; // one-off: accrue from created_at, as today
  switch (recurrence.type) {
    case 'unscheduled':
    case 'count':
      return 0;
    case 'quota':
    case 'scheduled_quota':
      return NEGLECT_PERIOD_DAYS[recurrence.period] / (1 + recurrence.quota);
    case 'scheduled': {
      // scheduledDays are weekdays → a weekly cycle. More scheduled days = more occurrences =
      // a shorter gap (surfaces sooner), which is both faithful to "half the distance between
      // occurrences" and the safe direction for a fail-safe. Empty list defaults to one/week.
      const occurrencesPerWeek = Math.max(1, recurrence.scheduledDays.length);
      return NEGLECT_PERIOD_DAYS.week / (1 + occurrencesPerWeek);
    }
  }
}

/** A task from the active pool, annotated with its neglect standing (spec §5.2).
 *
 *  Deliberately NOT sourced from the `active_tasks_with_neglect` view: that view historically
 *  called SQLite's POWER(), and op-sqlite's Android build compiles SQLite without
 *  SQLITE_ENABLE_MATH_FUNCTIONS (see android/build.gradle's defaultSqliteFlags - FTS5 and RTREE
 *  are explicitly enabled there; math functions are not), so POWER() was unavailable on-device.
 *  weeksNeglected uses the same pure-arithmetic formula as the view. `neglectMultiplier` here is
 *  the raw weeksNeglected value (task 10, R1: the curve is LINEAR, not squared — see
 *  `../../scoring/score.ts`'s `neglectCurve`, the actual swappable seam scoring routes through).
 *  Still uncapped by design (constraint: never cap this - spec §5.2 fail-safe).
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

/** The recurrence columns the neglect read pulls in via its LEFT JOIN (aliased where they would
 *  collide with the task's own `id`/`created_at`). All null when the task has no recurrence row. */
interface NeglectJoinColumns {
  weeks_from_anchor: number;
  rec_id: number | null;
  rec_task_id: number | null;
  recurrence_type: TaskRecurrenceRow['recurrence_type'] | null;
  recurrence_pattern: string | null;
  target_count: number | null;
  current_period_progress: number | null;
  reset_date: string | null;
  is_currently_active: TaskRecurrenceRow['is_currently_active'];
  rec_created_at: string | null;
}

/** Reconstructs the domain Recurrence from the neglect read's joined columns, or undefined for a
 *  one-off (no task_recurrence row). Reuses the canonical mapper so the parse stays in one place. */
function recurrenceFromJoin(row: NeglectJoinColumns): Recurrence | undefined {
  if (row.recurrence_type == null || row.recurrence_pattern == null || row.rec_id == null) {
    return undefined;
  }
  const recRow: TaskRecurrenceRow = {
    id: row.rec_id,
    task_id: row.rec_task_id ?? 0,
    recurrence_type: row.recurrence_type,
    recurrence_pattern: row.recurrence_pattern,
    target_count: row.target_count,
    current_period_progress: row.current_period_progress,
    reset_date: row.reset_date,
    is_currently_active: row.is_currently_active,
    created_at: row.rec_created_at,
  };
  return taskRecurrenceRowToDomain(recRow).recurrence;
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
   *  comment for why this bypasses the active_tasks_with_neglect view.
   *
   *  The neglect clock (spec §5.2):
   *    weeksNeglected = max(0, (now - accrualStart) / 7 days)
   *    accrualStart   = anchor + R8 gap(recurrence)
   *    anchor         = COALESCE(last_completed_at, created_at)
   *
   *  R8 (task 25): recurring tasks don't accrue neglect until half the occurrence gap has
   *  elapsed (see `neglectAccrualGapDays`) — a task inside its gap reads weeksNeglected 0
   *  (multiplier 1.0, scored on merit), then accrues linearly and WITHOUT BOUND from accrualStart.
   *  This is a start condition, not a cap; constraint #5 is untouched. The gap needs recurrence
   *  data, so this LEFT JOINs task_recurrence in the same read (the simplest correct option — one
   *  query, no N+1) and reconstructs the Recurrence via the existing domain mapper. The
   *  `POWER()`-free elapsed arithmetic stays in SQL (op-sqlite has no POWER()); the gate subtracts
   *  in TypeScript. NOTE for task 33: this anchor becomes a three-way max that also folds in
   *  `last_worked_at` — the one-line merge lands there. */
  async function listActiveByNeglect(): Promise<TaskWithNeglect[]> {
    const result = await db.execute(
      `SELECT t.*,
         (julianday('now') - julianday(COALESCE(t.last_completed_at, t.created_at))) / 7.0
           AS weeks_from_anchor,
         tr.id                       AS rec_id,
         tr.task_id                  AS rec_task_id,
         tr.recurrence_type          AS recurrence_type,
         tr.recurrence_pattern       AS recurrence_pattern,
         tr.target_count             AS target_count,
         tr.current_period_progress  AS current_period_progress,
         tr.reset_date               AS reset_date,
         tr.is_currently_active      AS is_currently_active,
         tr.created_at               AS rec_created_at
       FROM tasks t
       LEFT JOIN task_recurrence tr ON tr.task_id = t.id
       WHERE t.status = 'active'`,
    );
    const withNeglect = (
      result.rows as unknown as Array<TaskRow & NeglectJoinColumns>
    ).map((row): TaskWithNeglect => {
      const gapDays = neglectAccrualGapDays(recurrenceFromJoin(row));
      // R8 gate: shift the clock start forward by the gap; a task still inside its gap clamps to 0
      // (multiplier 1.0). Uncapped ABOVE (task 10, R1: linear) — never cap this (spec §5.2).
      const weeksNeglected = Math.max(0, row.weeks_from_anchor - gapDays / 7);
      return {
        task: taskRowToDomain(row),
        weeksNeglected,
        neglectMultiplier: weeksNeglected,
      };
    });
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
