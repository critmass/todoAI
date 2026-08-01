// Task 36 — the recurrence period engine (spec §4.2, time-driven half). Barrel.
//
// The sweep is `advanceRecurrence(deps, today)`; `sweepDateFrom(Date.now())` is how a caller with a
// clock gets `today`. It runs at APP OPEN (after crash recovery — see src/app/launch.ts, that
// ordering is not negotiable) and at SESSION START, and is safe to run twice in the same second.
export {
  advanceRecurrence,
  sweepDateFrom,
  type RecurrenceAdvancement,
  type RecurrenceSweepDeps,
  type RecurrenceSweepResult,
} from './advance';
export {
  addDays,
  addPeriod,
  calendarDateOfTimestamp,
  compareDates,
  isCalendarDate,
  localCalendarDate,
  nextOccurrenceAfter,
  nextOccurrenceOnOrAfter,
  rollBoundaryPast,
  weekdayOf,
  type CalendarDate,
} from './period';
