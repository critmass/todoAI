// Task 36 — the calendar arithmetic the recurrence period engine runs on. Pure: no clock, no
// database, no timezone lookups. Everything here operates on a CALENDAR DATE ('YYYY-MM-DD'), and
// the only function that knows an instant exists is `localCalendarDate`, which converts one.
//
// WHY THAT SPLIT IS THE WHOLE DST ANSWER (brief §3d). Period and occurrence boundaries are
// device-local midnights, and a local day is not 24 hours: the day a DST transition lands on is 23
// or 25. Any arithmetic that adds `7 * 24 * 60 * 60 * 1000` to an instant therefore lands an hour
// early or late, and twice a year that hour crosses midnight and puts the occurrence on the wrong
// DAY. So the instant is converted to a local calendar date exactly once, at the edge, and every
// step after that is day/month arithmetic on that date — which is exact by construction, whatever
// the underlying days were worth in hours. A DST transition is invisible to it, which is the
// property a scheduler wants. (Internally the dates are carried through UTC-midnight `Date` objects
// purely as a calendar, never as an instant — the same technique src/llm/due/dueSpec.ts uses, and
// for the same reason.)
//
// NOT TASK 22's QUESTION. `nextOccurrenceOnOrAfter` answers "which day does this weekly schedule
// next land on", by plain arithmetic within a seven-day window. Task 22's open question is what a
// human means by the WORD "next" in "next Monday" (`which: 'next'` in a DueSpec, resolved at
// extraction time by `resolveDue`). Nothing here reads or writes a DueSpec, and nothing here
// resolves the word "next" — see the task 36 findings report §5.

import type { Ordinal, Period, ScheduledRepeat, Weekday } from '../../types/domain';

/** A calendar date, 'YYYY-MM-DD'. A DATE — not an instant, not a timezone-bearing timestamp. */
export type CalendarDate = string;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEEKDAY_BY_INDEX: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The one boundary between "an instant" and "a date": today's calendar date in the DEVICE's
 * timezone, from an injected epoch-ms clock. Uses the local getters deliberately —
 * `toISOString().slice(0,10)` would hand a user west of UTC tomorrow's date all evening, and every
 * period boundary would be a day out. (Same conversion, same reasoning, as
 * `src/app/chat/chatController.ts`'s private `localTodayISO`; that one belongs to the extraction
 * path and is left where it is rather than re-pointed at this module, which would make a UI
 * controller depend on the recurrence engine.)
 */
export function localCalendarDate(nowMs: number): CalendarDate {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses 'YYYY-MM-DD' into a UTC-midnight Date used purely as a calendar cursor. */
function toCursor(date: CalendarDate): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromCursor(cursor: Date): CalendarDate {
  return `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
}

/** True when `date` is a well-formed 'YYYY-MM-DD' that names a real day. */
export function isCalendarDate(date: string | null | undefined): date is CalendarDate {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return fromCursor(toCursor(date)) === date; // rejects 2026-02-30 and friends
}

/** Chronological comparison. Lexicographic order IS chronological order for this format, which is
 *  the reason the format is worth keeping everywhere (`next_due_at`, `reset_date`, SQL). */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromCursor(new Date(toCursor(date).getTime() + days * MS_PER_DAY));
}

export function weekdayOf(date: CalendarDate): Weekday {
  return WEEKDAY_BY_INDEX[toCursor(date).getUTCDay()];
}

/**
 * Adds one period. `month` CLAMPS to the end of the target month rather than overflowing: 31 Jan +
 * 1 month is 28 Feb, not 3 March (which is what `setUTCMonth` alone produces, and which would walk
 * a monthly period a few days further into the following month every February). The clamp is
 * one-way and the day-of-month does not spring back afterwards — a boundary that lands on the 31st
 * and clamps to the 28th continues from the 28th. That is a deliberate simplification: this is a
 * period boundary, not a calendar appointment, and no user-visible date depends on it.
 */
export function addPeriod(date: CalendarDate, period: Period): CalendarDate {
  if (period === 'day') return addDays(date, 1);
  if (period === 'week') return addDays(date, 7);
  const cursor = toCursor(date);
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const day = cursor.getUTCDate();
  const daysInTarget = new Date(Date.UTC(year, month + 2, 0)).getUTCDate(); // day 0 of month+2 = last of month+1
  return fromCursor(new Date(Date.UTC(year, month + 1, Math.min(day, daysInTarget))));
}

/**
 * The first day on or after `from` that falls on one of `days` — the next occurrence of a weekly
 * schedule. Returns `from` itself when today is a scheduled day. `null` when the schedule names no
 * days at all: an empty `scheduledDays` cannot produce an occurrence, and inventing one (defaulting
 * to "today", say) would fabricate a due date the user never asked for.
 */
export function nextOccurrenceOnOrAfter(from: CalendarDate, days: readonly Weekday[]): CalendarDate | null {
  if (days.length === 0) return null;
  const wanted = new Set(days);
  for (let ahead = 0; ahead < 7; ahead++) {
    const candidate = addDays(from, ahead);
    if (wanted.has(weekdayOf(candidate))) return candidate;
  }
  return null; // unreachable: seven consecutive days cover every weekday
}

/** The next occurrence STRICTLY after `from` — used when the occurrence on `from` is already done. */
export function nextOccurrenceAfter(from: CalendarDate, days: readonly Weekday[]): CalendarDate | null {
  return nextOccurrenceOnOrAfter(addDays(from, 1), days);
}

// =====================================================================
// Task 46 — the four repeat modes. Still pure local-calendar arithmetic: every step below is
// day/month counting on 'YYYY-MM-DD', so a 23- or 25-hour day is invisible to all of it.
// =====================================================================

/**
 * A weekday schedule, its repeat rule, and the date the strides are counted from. ONE entry point
 * (`nextScheduledOnOrAfter`) resolves every mode, switching exhaustively on `repeat.mode`, so a
 * fifth mode added to the union later fails to compile here rather than silently behaving weekly.
 */
export interface ScheduleSpec {
  scheduledDays: readonly Weekday[];
  /** Absent === `{ mode: 'everyWeek' }` — the pre-task-46 behaviour, unchanged. */
  repeat?: ScheduledRepeat;
  /** The stride anchor: the TASK'S CREATION DATE (ruled — a fixed cadence with no drift, and no
   *  date-picker, which the app does not have). Ignored by `everyWeek`. */
  anchor: CalendarDate;
}

function floorDiv(numerator: number, denominator: number): number {
  return Math.floor(numerator / denominator);
}

/** Whole days from `a` to `b`, signed. Exact: both sides are UTC-midnight calendar cursors. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((toCursor(b).getTime() - toCursor(a).getTime()) / MS_PER_DAY);
}

/** Months since year 0, so a stride can be counted without month/year bookkeeping at each step. */
function monthIndex(date: CalendarDate): number {
  const cursor = toCursor(date);
  return cursor.getUTCFullYear() * 12 + cursor.getUTCMonth();
}

function daysInMonth(index: number): number {
  return new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).getUTCDate();
}

function dateInMonth(index: number, day: number): CalendarDate {
  return fromCursor(new Date(Date.UTC(Math.floor(index / 12), index % 12, day)));
}

/** The first index ≥ `index` that is a whole number of `stride`s from `anchorIndex`. Handles
 *  `index` before the anchor too (a negative offset floors correctly). */
function alignToStride(index: number, anchorIndex: number, stride: number): number {
  const offset = index - anchorIndex;
  const remainder = ((offset % stride) + stride) % stride;
  return remainder === 0 ? index : index + (stride - remainder);
}

/** Every date in the given month that is one of `days`, in date order. */
function weekdayDatesInMonth(index: number, days: readonly Weekday[]): CalendarDate[] {
  const wanted = new Set(days);
  const dates: CalendarDate[] = [];
  const total = daysInMonth(index);
  for (let day = 1; day <= total; day++) {
    const date = dateInMonth(index, day);
    if (wanted.has(weekdayOf(date))) dates.push(date);
  }
  return dates;
}

/**
 * The dates an `ordinal` schedule names inside one month, sorted and de-duplicated.
 *
 * `'last'` is resolved per weekday, which is the whole point of having it: in a month with four
 * Wednesdays it lands on the same date as the 4th, and in a month with five it lands a week later.
 * Ordinals 1–4 always exist — every month contains at least four of every weekday.
 */
function ordinalDatesInMonth(
  index: number,
  days: readonly Weekday[],
  ordinals: readonly Ordinal[],
): CalendarDate[] {
  const dates = new Set<CalendarDate>();
  for (const day of days) {
    const occurrences = weekdayDatesInMonth(index, [day]);
    if (occurrences.length === 0) continue;
    for (const ordinal of ordinals) {
      const date = ordinal === 'last' ? occurrences[occurrences.length - 1] : occurrences[ordinal - 1];
      if (date !== undefined) dates.add(date);
    }
  }
  return [...dates].sort(compareDates);
}

/**
 * The dates a `dayOfMonth` schedule names inside one month, sorted and de-duplicated.
 *
 * SHORT MONTHS CLAMP, THEY DO NOT SKIP (a product-visible choice, brief §3): "the 31st" fires on
 * 28 February — or the 29th in a leap year — because a rent reminder that silently misses a month
 * is the worse failure by a distance. The de-duplication is what stops "the 30th and the 31st"
 * from firing twice on 28 February.
 */
function dayOfMonthDatesInMonth(index: number, days: readonly number[]): CalendarDate[] {
  const total = daysInMonth(index);
  const dates = new Set<CalendarDate>(days.map((day) => dateInMonth(index, Math.min(day, total))));
  return [...dates].sort(compareDates);
}

/** Walks on-months from `from` forward, returning the first named date on or after it. Two on-month
 *  attempts always suffice (the first may be spent), and the third is belt-and-braces. */
function nextMonthlyOccurrence(
  from: CalendarDate,
  anchor: CalendarDate,
  stride: number,
  datesIn: (index: number) => CalendarDate[],
): CalendarDate | null {
  let index = alignToStride(monthIndex(from), monthIndex(anchor), stride);
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = datesIn(index).find((date) => compareDates(date, from) >= 0);
    if (candidate !== undefined) return candidate;
    index += stride;
  }
  return null;
}

/**
 * THE ONE ENTRY POINT: the first day on or after `from` that this schedule actually lands on, or
 * null when it names none (an empty weekday list, an empty ordinal list — nothing is invented).
 *
 * The two week-driven modes and the two month-driven ones differ in exactly the way users get
 * wrong: `interval` counts fortnights straight through month ends, while `ordinal` restarts its
 * count every month, so the two drift apart permanently the first time a month holds five of the
 * chosen weekday. Both are implemented here, side by side, so that difference is visible rather
 * than folded into a shared helper.
 */
export function nextScheduledOnOrAfter(from: CalendarDate, spec: ScheduleSpec): CalendarDate | null {
  const { scheduledDays, anchor } = spec;
  const repeat: ScheduledRepeat = spec.repeat ?? { mode: 'everyWeek' };

  switch (repeat.mode) {
    case 'everyWeek':
      return nextOccurrenceOnOrAfter(from, scheduledDays);

    case 'interval': {
      if (scheduledDays.length === 0) return null;
      const stride = Math.max(1, Math.trunc(repeat.weeks));
      const wanted = new Set(scheduledDays);
      // Weeks are seven-day blocks measured from the anchor itself, NOT calendar (Mon–Sun) weeks:
      // "every other Wednesday" set up on a Saturday should fire on the Wednesday four days later,
      // not wait eleven days because the anchor happened to land late in an ISO week.
      let block = floorDiv(daysBetween(anchor, from), 7);
      const remainder = ((block % stride) + stride) % stride;
      if (remainder !== 0) block += stride - remainder;
      for (let attempt = 0; attempt < 2; attempt++) {
        const start = addDays(anchor, block * 7);
        const searchFrom = compareDates(start, from) > 0 ? start : from;
        for (let ahead = daysBetween(start, searchFrom); ahead < 7; ahead++) {
          const candidate = addDays(start, ahead);
          if (wanted.has(weekdayOf(candidate))) return candidate;
        }
        block += stride; // the rest of this on-block is spent; the next on-block covers all 7 days
      }
      return null; // unreachable: a whole on-block contains every weekday
    }

    case 'ordinal': {
      if (scheduledDays.length === 0 || repeat.ordinals.length === 0) return null;
      const stride = Math.max(1, Math.trunc(repeat.months ?? 1));
      return nextMonthlyOccurrence(from, anchor, stride, (index) =>
        ordinalDatesInMonth(index, scheduledDays, repeat.ordinals),
      );
    }

    case 'dayOfMonth': {
      // scheduledDays is unused here by construction and is required empty on write.
      if (repeat.days.length === 0) return null;
      const stride = Math.max(1, Math.trunc(repeat.months ?? 1));
      return nextMonthlyOccurrence(from, anchor, stride, (index) =>
        dayOfMonthDatesInMonth(index, repeat.days),
      );
    }
  }
}

/** The next occurrence STRICTLY after `from` — the "today's one is already done" case. */
export function nextScheduledAfter(from: CalendarDate, spec: ScheduleSpec): CalendarDate | null {
  return nextScheduledOnOrAfter(addDays(from, 1), spec);
}

/**
 * Rolls a period boundary forward until it is strictly after `today`, and reports how many periods
 * that took. One call handles a three-week absence exactly as it handles a single elapsed period —
 * the caller does not loop, and there is no per-period bookkeeping to accumulate, which is the
 * structural half of "missed occurrences reset, they do not stack" (spec §4.2).
 *
 * `periodsElapsed` is 0 when the boundary is still in the future (nothing to do), so it doubles as
 * the "did anything roll?" predicate and makes the sweep idempotent by construction.
 */
export function rollBoundaryPast(
  boundary: CalendarDate,
  period: Period,
  today: CalendarDate,
): { boundary: CalendarDate; periodsElapsed: number } {
  let next = boundary;
  let periodsElapsed = 0;
  // A yearly absence on a daily period is 365 iterations of integer date math — cheap, and bounded
  // by real elapsed time rather than by input, so there is nothing here to run away.
  while (compareDates(next, today) <= 0) {
    next = addPeriod(next, period);
    periodsElapsed += 1;
  }
  return { boundary: next, periodsElapsed };
}

/**
 * The calendar date of a stored DATETIME ('YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'), or null if it is
 * absent or unparseable.
 *
 * TIMEZONE CAVEAT, stated where it bites: SQLite's `CURRENT_TIMESTAMP` — which is what writes
 * `tasks.last_completed_at` — is UTC, while the dates here are device-local. For a user far enough
 * from UTC, a completion late in the local evening (or early in the local morning) carries the
 * neighbouring UTC date, so "was this occurrence completed?" can be a day out for one sweep. The
 * consequence is bounded and benign in both directions (a task reads due today for one more day,
 * or advances one occurrence early) and self-corrects on the next sweep. Fixing it properly means
 * recording completions with a local date, which is a writer change on someone else's column —
 * see the task 36 findings report §7.
 */
export function calendarDateOfTimestamp(timestamp: string | null): CalendarDate | null {
  if (timestamp == null) return null;
  const candidate = timestamp.slice(0, 10);
  return isCalendarDate(candidate) ? candidate : null;
}
