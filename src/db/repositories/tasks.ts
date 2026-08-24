import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  taskDomainToRow,
  taskRecurrenceRowToDomain,
  taskRowToDomain,
  type Period,
  type Recurrence,
  type ScheduledRepeat,
  type Task,
  type TaskRecurrenceEntity,
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
/**
 * Task 46 — how long one turn of a `scheduled` schedule takes, and how many occurrences it holds.
 * Both halves of R8's `cycle / (1 + occurrences)` fraction, for one repeat mode.
 *
 * `month` stays the same conventional 30-day approximation the rest of this gate uses: it is a
 * fail-safe start condition, not a scheduling calculation, and the real dates come from
 * `src/services/recurrence/period.ts`. The worked example from the brief falls out — 1st & 3rd
 * Wednesday is 30 / (1 + 2) = 10 days.
 */
function scheduledCycle(
  repeat: ScheduledRepeat | undefined,
  weekdays: number,
): { cycleDays: number; occurrences: number } {
  const mode = repeat ?? { mode: 'everyWeek' as const };
  switch (mode.mode) {
    case 'everyWeek':
      return { cycleDays: NEGLECT_PERIOD_DAYS.week, occurrences: weekdays };
    case 'interval':
      // Every scheduled weekday still fires, but only in one week out of `weeks`.
      return { cycleDays: NEGLECT_PERIOD_DAYS.week * Math.max(1, mode.weeks), occurrences: weekdays };
    case 'ordinal':
      return {
        cycleDays: NEGLECT_PERIOD_DAYS.month * Math.max(1, mode.months ?? 1),
        occurrences: Math.max(1, mode.ordinals.length) * weekdays,
      };
    case 'dayOfMonth':
      // Weekdays play no part here — the occurrences are the named dates.
      return {
        cycleDays: NEGLECT_PERIOD_DAYS.month * Math.max(1, mode.months ?? 1),
        occurrences: Math.max(1, mode.days.length),
      };
  }
}

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
      const weekdays = Math.max(1, recurrence.scheduledDays.length);
      // Task 46: a repeat mode changes the CYCLE and the OCCURRENCES PER CYCLE, and nothing else —
      // the formula, and the fact that this is a start condition rather than a cap (constraint #5),
      // are untouched. An absent repeat is `everyWeek` and lands on the identical pre-task-46 value.
      const { cycleDays, occurrences } = scheduledCycle(recurrence.repeat, weekdays);
      return cycleDays / (1 + occurrences);
    }
  }
}

/** The missed-quota FACT a task carries into scoring (spec §4.2, task 36) — never the boost itself.
 *
 *  Present only when a quota-bearing task's immediately preceding period closed with the quota
 *  unmet; `null` otherwise, including for every type that has no quota. The importance boost is
 *  DERIVED from this at scoring time (`src/scoring/factors.ts`), exactly as urgency is derived from
 *  `next_due_at` — nothing writes a boost into `tasks.importance`, which is the user's own 1–10
 *  projection (constraint #6) and is banded 1–99 per hundred for subtasks, with no room for a
 *  silent bump. See the task 36 findings report §3b. */
export interface MissedQuota {
  /** How many occurrences the period that just closed came up short by. Always ≥ 1 here, and never
   *  more than `quota`: one period's worth, replaced at each roll rather than accumulated, because
   *  missed occurrences reset (§4.2 — no guilt stacking). */
  shortfall: number;
  /** The per-period quota, so the shortfall can be read as a fraction rather than a raw count. */
  quota: number;
  /** Progress inside the CURRENT (new) period. The boost is for the occurrences still remaining in
   *  it, so a period whose quota is already met carries none. */
  progress: number;
}

/** A task from the active pool, annotated with its neglect standing (spec §5.2).
 *
 *  Deliberately NOT sourced from a SQL view. An `active_tasks_with_neglect` view existed through
 *  schema v2.4 but is DROPPED as of migration 004 (v2.5) — it called SQLite's POWER(), and
 *  op-sqlite's Android build compiles SQLite without SQLITE_ENABLE_MATH_FUNCTIONS (see
 *  android/build.gradle's defaultSqliteFlags - FTS5 and RTREE are explicitly enabled there; math
 *  functions are not), so POWER() was unavailable on-device and the view could never actually
 *  run. weeksNeglected uses the same pure-arithmetic formula the view used to. `neglectMultiplier` here is
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
  /** Task 36 — see `MissedQuota`. Null for everything without a quota, and for a quota task whose
   *  last period was met. Read by scoring; nothing here mutates the task. */
  missedQuota: MissedQuota | null;
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
  last_period_shortfall: number | null;
  is_currently_active: TaskRecurrenceRow['is_currently_active'];
  rec_created_at: string | null;
}

/** Reconstructs the domain recurrence entity from the neglect read's joined columns, or undefined
 *  for a one-off (no task_recurrence row). Reuses the canonical mapper so the parse stays in one
 *  place. */
function recurrenceEntityFromJoin(row: NeglectJoinColumns): TaskRecurrenceEntity | undefined {
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
    last_period_shortfall: row.last_period_shortfall ?? 0,
    is_currently_active: row.is_currently_active,
    created_at: row.rec_created_at,
  };
  return taskRecurrenceRowToDomain(recRow);
}

/** The missed-quota fact, read off the same join (task 36). Null unless this is a quota-bearing
 *  recurrence whose last closed period came up short — the boost policy itself lives in scoring. */
function missedQuotaFromEntity(entity: TaskRecurrenceEntity | undefined): MissedQuota | null {
  if (!entity) return null;
  const { recurrence } = entity;
  if (recurrence.type !== 'quota' && recurrence.type !== 'scheduled_quota') return null;
  if (entity.lastPeriodShortfall <= 0) return null;
  return {
    shortfall: Math.min(entity.lastPeriodShortfall, recurrence.quota),
    quota: recurrence.quota,
    progress: entity.currentPeriodProgress,
  };
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

  /** The PARK primitive (task 28 §1.3/§7.1): records a progress episode — accumulates `minutes`
   *  toward the current completion, stamps last_worked_at (which re-anchors the neglect clock,
   *  §5), and marks the task in_progress. It NEVER writes skip_count, NEVER writes completion_count and
   *  NEVER touches success_rate — parking is structurally not a skip, not a failure, and (task 17
   *  Phase A) not an ATTEMPT: it cannot move the historical-success signal in either direction. The task stays status='active'
   *  throughout, so every pool query works unchanged. The accumulated minutes fold into ONE
   *  actual_duration_history entry when the task is finally completed (see completeTask). */
  async function recordProgressEpisode(id: number, minutes: number): Promise<Task> {
    await db.execute(
      `UPDATE tasks
         SET accumulated_minutes = accumulated_minutes + ?,
             last_worked_at = CURRENT_TIMESTAMP,
             work_state = 'in_progress'
       WHERE id = ?`,
      [minutes, id],
    );
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('task', id);
    }
    return updated;
  }

  /** TASK 17 PHASE A - THE HISTORICAL-SUCCESS INVARIANT, maintained by exactly two primitives:
   *  this one and `recordSkipEpisode` below. Every other write in this repository leaves both
   *  columns alone, and that is load-bearing, not incidental.
   *
   *      success_rate = completion_count / (completion_count + skip_count)
   *
   *  which makes the denominator IDENTICAL to the evidence count `scoreTask` already passes to
   *  `historicalSuccessFactor` (`task.completionCount + task.skipCount`, src/scoring/score.ts).
   *  Holding the invariant collapses R6's shrinkage to the Laplace form
   *
   *      (rate*n + 0.5*k)/(n + k)  =  (C + 1)/(C + S + 2)      with k = 2
   *
   *  - the posterior mean of a Beta(1,1) prior over "did this task get done when it came up". The
   *  scorer and the writer therefore encode ONE definition of "attempt", not two that happen to
   *  agree today. (The definition itself - an attempt is a completion or a skip, never a park and
   *  never a crash-recovered abandonment - is PRODUCT INTENT and provisional until Jason rules on
   *  it; see docs/eval/task17_phaseA_findings_report.md.)
   *
   *  Written as ONE statement on purpose. SQLite evaluates every right-hand side against the
   *  pre-UPDATE row, so `completion_count + 1` means the same thing in both assignments, and the
   *  two columns can never be observed disagreeing - which is exactly the half-written state task
   *  44 rejected (a `completion_count` that moves while `success_rate` stays fictional at 0.0).
   *  The CAST is not decoration: `1 / 4` on two INTEGER columns is 0 in SQLite, so without it the
   *  rate would be a step function that reads 0 for every task not completed every single time.
   *
   *  No migration is needed to adopt this. Every row predating this writer has
   *  `completion_count = 0` (there was no writer) and `success_rate` at its 0.0 default, and
   *  0/(0 + S) = 0 - so the existing data already satisfies the invariant, including rows with
   *  nonzero `skip_count`. */
  async function recordHistoricalCompletion(id: number): Promise<Task> {
    const existing = await getById(id);
    if (!existing) {
      throw new NotFoundError('task', id);
    }
    await db.execute(
      `UPDATE tasks
          SET completion_count = completion_count + 1,
              success_rate = CAST(completion_count + 1 AS REAL)
                             / (completion_count + 1 + skip_count)
        WHERE id = ?`,
      [id],
    );
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('task', id);
    }
    return updated;
  }

  /** The SKIP primitive (task 13; the counterpart the park primitive above must never be confused
   *  with). The user was served this task and declined it: `skip_count` goes up and the optional
   *  one-word reason chip (spec §7.2) is appended to `skip_reasons`. `accumulated_minutes` and
   *  `work_state` are untouched, so skipping an in-progress task RETAINS its time (task 28 design
   *  §1.3's transition table).
   *
   *  TASK 17 PHASE A: `success_rate` IS now recomputed here, from the same invariant
   *  `recordHistoricalCompletion` maintains - a skip is an attempt that did not succeed, so it
   *  moves the denominator. (Before task 17 no writer for that column existed anywhere; the
   *  omission was flagged rather than silently invented, and this is the task that owns it.) The
   *  recompute is folded into the SAME statement as the increment for the reason given above: the
   *  two columns must never be observable in disagreement.
   *
   *  This exists as a repository primitive rather than a `tasks.update` call because
   *  TaskWriteInput deliberately omits `skipCount`: counters are incremented, never set. Keeping
   *  the two outcomes on separate primitives is the structural half of "a park is never a skip"
   *  (constraint #11) - there is no code path where one can reach the other's columns. */
  async function recordSkipEpisode(id: number, reason?: string): Promise<Task> {
    const existing = await getById(id);
    if (!existing) {
      throw new NotFoundError('task', id);
    }
    const rate = `success_rate = CAST(completion_count AS REAL) / (completion_count + skip_count + 1)`;
    if (reason === undefined) {
      await db.execute(
        `UPDATE tasks SET skip_count = skip_count + 1, ${rate} WHERE id = ?`,
        [id],
      );
    } else {
      const reasons = JSON.stringify([...existing.skipReasons, reason]);
      await db.execute(
        `UPDATE tasks SET skip_count = skip_count + 1, skip_reasons = ?, ${rate} WHERE id = ?`,
        [reasons, id],
      );
    }
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
   *    anchor         = MAX(created_at, last_completed_at, last_worked_at)   -- latest attention
   *
   *  Two composed rulings, both START CONDITIONS not caps (constraint #5 — growth after the anchor
   *  is linear and unbounded, nothing saturates):
   *   • R8 (task 25): recurring tasks don't accrue neglect until half the occurrence gap has
   *     elapsed (`neglectAccrualGapDays`) — a task inside its gap reads weeksNeglected 0
   *     (multiplier 1.0, scored on merit).
   *   • task 33 (§5): working a task re-anchors its clock. `last_worked_at` joins the anchor as a
   *     third input via SQLite's scalar `MAX()` (a core function — NOT the POWER()-class math
   *     extension, so it's safe on op-sqlite). A parked task accrues neglect from the moment it was
   *     last worked and MUST resurface; it can only stay quiet by being worked again, which is a
   *     surfacing loop, not hiding.
   *
   *  The gap needs recurrence data, so this LEFT JOINs task_recurrence in the same read (one query,
   *  no N+1) and reconstructs the Recurrence via the existing domain mapper. The POWER()-free
   *  elapsed arithmetic stays in SQL; the R8 gate subtracts in TypeScript. */
  async function listActiveByNeglect(): Promise<TaskWithNeglect[]> {
    const result = await db.execute(
      `SELECT t.*,
         (julianday('now') - MAX(
            julianday(t.created_at),
            julianday(COALESCE(t.last_completed_at, t.created_at)),
            julianday(COALESCE(t.last_worked_at,    t.created_at))
         )) / 7.0
           AS weeks_from_anchor,
         tr.id                       AS rec_id,
         tr.task_id                  AS rec_task_id,
         tr.recurrence_type          AS recurrence_type,
         tr.recurrence_pattern       AS recurrence_pattern,
         tr.target_count             AS target_count,
         tr.current_period_progress  AS current_period_progress,
         tr.reset_date               AS reset_date,
         tr.last_period_shortfall    AS last_period_shortfall,
         tr.is_currently_active      AS is_currently_active,
         tr.created_at               AS rec_created_at
       FROM tasks t
       LEFT JOIN task_recurrence tr ON tr.task_id = t.id
       WHERE t.status = 'active'`,
    );
    const withNeglect = (
      result.rows as unknown as Array<TaskRow & NeglectJoinColumns>
    ).map((row): TaskWithNeglect => {
      const entity = recurrenceEntityFromJoin(row);
      const gapDays = neglectAccrualGapDays(entity?.recurrence);
      // R8 gate: shift the clock start forward by the gap; a task still inside its gap clamps to 0
      // (multiplier 1.0). Uncapped ABOVE (task 10, R1: linear) — never cap this (spec §5.2).
      const weeksNeglected = Math.max(0, row.weeks_from_anchor - gapDays / 7);
      return {
        task: taskRowToDomain(row),
        weeksNeglected,
        neglectMultiplier: weeksNeglected,
        missedQuota: missedQuotaFromEntity(entity),
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
    recordProgressEpisode,
    recordHistoricalCompletion,
    recordSkipEpisode,
    listActive,
    listActiveByNeglect,
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;
