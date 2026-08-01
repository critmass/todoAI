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

import type { Period, Weekday } from '../../types/domain';

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
