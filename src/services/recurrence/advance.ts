// Task 36 — the recurrence period engine: the TIME-DRIVEN half of spec §4.2.
//
// THE OTHER SIDE OF taskCompletion.ts's SCOPE LINE. `completeTask` does the completion-driven work
// (close, or reset the neglect clock) and deliberately does not do this: advancing `next_due_at` to
// the next occurrence, rolling `reset_date` / `current_period_progress` at a period boundary, and
// recording the missed-quota fact. Those fire when A PERIOD BOUNDARY PASSES, not when a user checks
// something off — a different clock and a different trigger. Nothing did them until this file
// existed, which is why completing a `scheduled` task left it reading due-or-overdue forever.
//
// NO DAEMON, NO BACKGROUND SCHEDULER. This is an offline-first app with no server and (by
// constraint #13) exactly one platform alarm, which belongs to the episode timer. So the engine is
// a SWEEP, called at app open and at session start, and the entire design constraint is that it is
// IDEMPOTENT: running it three times in the same second must produce exactly one advancement, and
// running it after a three-week gap must produce exactly one too. Every write below is conditional
// on a comparison that the write itself makes false, which is what buys that.
//
// WHAT IT NEVER TOUCHES (orientation constraint #7 — these are structural, in the repository query
// this reads from, not in an `if` here that a refactor could quietly drop):
//   • one-offs (no task_recurrence row) — completing one closes it; a due date advancing under a
//     finished task would resurrect it.
//   • 'unscheduled' — reopens on completion and resurfaces through the uncapped neglect clock
//     ALONE (§4.2). A period or a due date here would be a fabricated schedule.
//   • 'count' — N total, ever. No period, no reset_date, nothing to roll.
//
// AND IT NEVER TOUCHES THE NEGLECT CLOCK. R8's accrual gate (`neglectAccrualGapDays`) and task 28's
// three-way anchor live in `listActiveByNeglect`; this file consumes nothing from them and writes
// nothing they read except the period data they were always meant to read. In particular it does
// NOT pause, cap, or delay accrual "while a task is between occurrences" — that convenience would
// be a saturation bug against constraint #5.

import type { Period, Weekday } from '../../types/domain';
import type { RecurrenceRepository, SweepableRecurrence } from '../../db/repositories/recurrence';
import type { TasksRepository } from '../../db/repositories/tasks';
import {
  addPeriod,
  calendarDateOfTimestamp,
  compareDates,
  isCalendarDate,
  localCalendarDate,
  nextOccurrenceAfter,
  nextOccurrenceOnOrAfter,
  rollBoundaryPast,
  type CalendarDate,
} from './period';

export interface RecurrenceSweepDeps {
  tasks: Pick<TasksRepository, 'update'>;
  recurrence: Pick<RecurrenceRepository, 'listSweepable' | 'setResetDate' | 'rollPeriod'>;
}

/** What changed for one task. Only tasks that actually changed appear in the result — a sweep that
 *  moves nothing reports an empty list, which is what the idempotency tests assert against. */
export interface RecurrenceAdvancement {
  taskId: number;
  /** Set when `next_due_at` moved (both scheduled types). */
  dueAdvancedTo?: CalendarDate;
  /** Set when a quota period rolled, or was seeded for the first time. */
  period?: {
    /** The new boundary: the date the CURRENT period ends, exclusive. */
    resetDate: CalendarDate;
    /** Periods that elapsed at once. >1 means the user was away; the shortfall is still ONE
     *  period's worth (§4.2 — missed occurrences reset, they never stack). 0 means "seeded". */
    periodsElapsed: number;
    /** What the period that just closed came up short by, capped at the quota. 0 when it was met
     *  or when this is the first seeding. */
    shortfall: number;
  };
}

export interface RecurrenceSweepResult {
  /** The local calendar date the sweep ran against. */
  today: CalendarDate;
  /** Rows considered: active tasks with a scheduled/quota/scheduled_quota recurrence. */
  scanned: number;
  advanced: RecurrenceAdvancement[];
}

/** Reads today's local calendar date from an epoch-ms clock — the conversion every caller of
 *  `advanceRecurrence` needs, exported so no call site rolls its own. */
export function sweepDateFrom(nowMs: number): CalendarDate {
  return localCalendarDate(nowMs);
}

/**
 * Advances every recurring task's time-driven state to `today`, and reports what moved.
 *
 * `today` is a LOCAL CALENDAR DATE, injected rather than read from a clock — the engine never calls
 * `Date.now()`. Production callers pass `sweepDateFrom(Date.now())`; tests pass a literal, which is
 * what makes a three-week absence and a DST crossing ordinary test cases instead of things you find
 * out about in March.
 *
 * Per type (spec §4.2):
 *
 * - **`scheduled`** — `next_due_at` becomes the next scheduled weekday on or after today, or the
 *   next one strictly after today when today's occurrence has already been completed. No period, no
 *   `reset_date`: the domain's `scheduled` carries weekdays and nothing else, there is no quota to
 *   count and no progress column in play for it, so a rollover would have nothing to reset. Its
 *   period IS its schedule, and `next_due_at` is where that lives. (The spec's §4.2 table marks
 *   `scheduled` "Period? Yes"; in the built data model that period is not separately represented —
 *   see the findings report §2.)
 * - **`quota`** — the period rolls; `next_due_at` is left alone. "15/week, whenever" has no day it
 *   is due on, and manufacturing one would put a false deadline on the least deadline-shaped
 *   recurrence in the model.
 * - **`scheduled_quota`** — both.
 *
 * CATCH-UP AFTER AN ABSENCE (brief §3c) is not a special case anywhere below; it is the ordinary
 * path. Each task's state is computed FROM `today`, never by replaying the days in between, so
 * returning after three weeks lands in exactly the state of someone who never left: due on the next
 * occurrence, current period fresh, and ONE period's shortfall recorded — never three. There is no
 * backlog to fabricate, and nothing accumulates guilt.
 */
export async function advanceRecurrence(
  deps: RecurrenceSweepDeps,
  today: CalendarDate,
): Promise<RecurrenceSweepResult> {
  if (!isCalendarDate(today)) {
    throw new Error(`advanceRecurrence: 'today' must be a YYYY-MM-DD calendar date, got '${today}'`);
  }

  const rows = await deps.recurrence.listSweepable();
  const advanced: RecurrenceAdvancement[] = [];

  for (const row of rows) {
    const change = await advanceOne(deps, row, today);
    if (change) advanced.push(change);
  }

  return { today, scanned: rows.length, advanced };
}

async function advanceOne(
  deps: RecurrenceSweepDeps,
  row: SweepableRecurrence,
  today: CalendarDate,
): Promise<RecurrenceAdvancement | null> {
  const { entity } = row;
  const { recurrence } = entity;
  const change: RecurrenceAdvancement = { taskId: entity.taskId };

  if (recurrence.type === 'scheduled' || recurrence.type === 'scheduled_quota') {
    const due = nextDueFor(recurrence.scheduledDays, row, today);
    if (due !== null && due !== row.nextDueAt) {
      await deps.tasks.update(entity.taskId, { nextDueAt: due });
      change.dueAdvancedTo = due;
    }
  }

  if (recurrence.type === 'quota' || recurrence.type === 'scheduled_quota') {
    const period = await rollQuotaPeriod(deps, row, recurrence.quota, recurrence.period, today);
    if (period) change.period = period;
  }

  return change.dueAdvancedTo === undefined && change.period === undefined ? null : change;
}

/**
 * The next date this schedule is due on, or null when it cannot be computed (no scheduled days).
 *
 * Two rules, and the second one is the live bug this task exists to fix:
 *
 * 1. A due date already pointing at today or later is LEFT ALONE. The sweep's job is to repair a
 *    stale date, not to overwrite a live one, and leaving it alone is half of what makes running
 *    the sweep twice a no-op.
 * 2. When today IS the scheduled day and the task has already been completed today, the due date
 *    moves to the NEXT occurrence. Completion cannot do this itself — `completeTask` owns the
 *    completion-driven half and is forbidden from reaching across the scope line — so if the sweep
 *    did not, a weekly task completed on its day would read "due today" until midnight and then
 *    "overdue" forever, which is precisely the reported bug.
 *
 * A MISSED occurrence simply falls out: the next occurrence on or after today is computed from
 * today, so Monday's missed slot is not carried anywhere and Thursday becomes the due date. Missed
 * occurrences reset (§4.2) — the fail-safe that surfaces a repeatedly-missed task is the uncapped
 * neglect clock (§5.2), which is deliberately not this engine's business.
 */
function nextDueFor(
  scheduledDays: readonly Weekday[],
  row: SweepableRecurrence,
  today: CalendarDate,
): CalendarDate | null {
  const current = isCalendarDate(row.nextDueAt?.slice(0, 10) ?? null) ? row.nextDueAt!.slice(0, 10) : null;
  const occurrence = nextOccurrenceOnOrAfter(today, scheduledDays);
  if (occurrence === null) return null; // no days named: nothing to schedule, nothing to fabricate

  if (occurrence === today) {
    const completedOn = calendarDateOfTimestamp(row.lastCompletedAt);
    if (completedOn !== null && compareDates(completedOn, today) >= 0) {
      return nextOccurrenceAfter(today, scheduledDays);
    }
    return today;
  }

  // The occurrence is in the future. Keep a due date that is already today-or-later (rule 1);
  // otherwise it is stale or missing and becomes the occurrence.
  if (current !== null && compareDates(current, today) >= 0) return current;
  return occurrence;
}

/**
 * Rolls (or first seeds) a quota period.
 *
 * `reset_date` has had no writer anywhere since migration 001, so nearly every existing row arrives
 * here null and gets SEEDED: the current period starts today and ends one period from today.
 * Seeding is not a rollover — nothing closed, so no shortfall is recorded and progress is left
 * exactly where completion put it. A user who has already logged two of three this week does not
 * lose them to the engine finally arriving.
 *
 * On a real roll the shortfall is `quota − progress`, floored at 0 and capped at the quota — the
 * shortfall of the ONE period the engine actually observed, the one that was open when it last ran.
 * When several periods elapse at once (an absence), the periods in between are NOT counted, in
 * either of the two ways one might be tempted to count them: not summed (three missed weeks at 3/wk
 * is not a debt of nine — that is the "guilt stacking" §4.2 forbids by name), and not collapsed
 * into "the last period was empty, so call it a full miss" either. An absence is not measured
 * evidence of failure; inferring a full miss from it fabricates the backlog brief §2.4 forbids, and
 * would hand a returning user a maximum boost on every quota task at once — right when spec §6.1's
 * re-orientation conversation is trying to disposition them gently.
 */
async function rollQuotaPeriod(
  deps: RecurrenceSweepDeps,
  row: SweepableRecurrence,
  quota: number,
  period: Period,
  today: CalendarDate,
): Promise<RecurrenceAdvancement['period'] | null> {
  const { entity } = row;
  const boundary = isCalendarDate(entity.resetDate) ? entity.resetDate : null;

  if (boundary === null) {
    const resetDate = addPeriod(today, period);
    await deps.recurrence.setResetDate(entity.taskId, resetDate);
    return { resetDate, periodsElapsed: 0, shortfall: 0 };
  }

  const rolled = rollBoundaryPast(boundary, period, today);
  if (rolled.periodsElapsed === 0) return null; // still inside the current period — nothing to do

  const shortfall = Math.min(quota, Math.max(0, quota - entity.currentPeriodProgress));
  await deps.recurrence.rollPeriod(entity.taskId, { resetDate: rolled.boundary, shortfall });
  return { resetDate: rolled.boundary, periodsElapsed: rolled.periodsElapsed, shortfall };
}
