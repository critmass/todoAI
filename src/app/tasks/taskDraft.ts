// Task 24 — the task editor's data model, and the only place the user-facing recurrence kinds
// meet the `Recurrence` discriminated union.
//
// THE KINDS ARE THE UNION, RENAMED FOR HUMANS. That is the whole design: the editor cannot
// express a state the data model rejects, because each kind maps onto exactly one union member (or,
// for a one-off, onto the ABSENCE of a `task_recurrence` row).
//
//   One-time           → no recurrence at all (undefined)      + an optional due date
//   Weekly             → { type: 'scheduled' }                  weekdays, no `repeat` key at all
//   Every N weeks      → { type: 'scheduled', repeat: interval }    weekdays, every N weeks
//   Weeks of the month → { type: 'scheduled', repeat: ordinal }     the 6×7 grid's ticked cells
//   Dates              → { type: 'scheduled', repeat: dayOfMonth }  the 31-cell grid's ticked days
//   Quota              → { type: 'quota' }                      N times per day/week/month
//   Quota + days       → { type: 'scheduled_quota' }            N per period, on these weekdays
//   Ongoing            → { type: 'unscheduled' }                resurfaces by neglect alone
//   N times            → { type: 'count' }                      target, then done
//
// CONSTRAINT #7 LIVES HERE. "One-time" is `undefined`, NOT `{type:'unscheduled'}`. They look alike
// in a picker and have opposite completion semantics: completing a one-off closes it, completing an
// unscheduled task resets its neglect clock and leaves it active forever. The editor keeps them two
// visibly different choices ("One-time" vs "Ongoing") for exactly that reason.
//
// TASK 46 PHASE 2 — the four scheduled repeat modes reach the user. Phase 1 shipped a complete,
// tested engine that nothing in the app could construct a `repeat` for; the three kinds added here
// (`schedule_interval`, `schedule_ordinal`, `schedule_dates`) are what make it reachable. Two rules
// this file exists to keep, both learned the hard way:
//
//   1. WEEKLY EMITS NO `repeat` KEY. Not `{mode:'everyWeek'}` — the live alpha rows have no such
//      key, `recurrenceToPattern` normalises an explicit one back to absent, and a save that added
//      one to every existing row would be a silent data migration nobody asked for.
//   2. THE TWO MONTH-DRIVEN MODES CARRY NO `scheduledDays`. `recurrenceRepeatIssue` enforces that
//      at both writers, so stale weekdays left behind by a mode switch would make the repository
//      throw in the user's face on save. Cleared on the way in (`recurrenceKindPatch`) AND ignored
//      on the way out (`recurrenceFromDraft`) — a UI slip cannot get past both.
//
// WHAT THE PROTOTYPE HAD THAT THIS DID NOT, until now: an "every N weeks" interval. Task 24 dropped
// it rather than faking it, because the union carried nowhere to put it. Task 46 gave the union
// somewhere, so it is here.

import type {
  Ordinal,
  OrdinalCell,
  Period,
  Recurrence,
  ScheduledRepeat,
  Task,
  TaskWriteInput,
  Weekday,
} from '../../types/domain';
import { internalToUserEnergy, userToInternalEnergy, type UserEnergy } from '../../types/scales';

export type RecurrenceKind =
  | 'once'
  | 'schedule'
  | 'schedule_interval'
  | 'schedule_ordinal'
  | 'schedule_dates'
  | 'quota'
  | 'quota_schedule'
  | 'ongoing'
  | 'count';

/** The dropdown's list, flat and in this order (ruled by Jason, 2026-08-24). One line at the top
 *  of the editor however many options exist, with the region beneath re-shaping to the choice. */
export const RECURRENCE_KINDS: ReadonlyArray<{ kind: RecurrenceKind; label: string }> = [
  { kind: 'once', label: 'One-time' },
  { kind: 'schedule', label: 'Weekly' },
  { kind: 'schedule_interval', label: 'Every N weeks' },
  { kind: 'schedule_ordinal', label: 'Weeks of the month' },
  { kind: 'schedule_dates', label: 'Dates' },
  { kind: 'quota', label: 'Quota' },
  { kind: 'quota_schedule', label: 'Quota + days' },
  { kind: 'ongoing', label: 'Ongoing' },
  { kind: 'count', label: 'N times total' },
];

/** TWO letters, not one. The prototype used single initials, which makes Tuesday/Thursday and
 *  Saturday/Sunday indistinguishable — and task 23's review named the recurrence editor's
 *  real-device usability as the one thing a mock could not settle. Two letters costs nothing and
 *  removes the ambiguity outright. */
export const WEEKDAYS: ReadonlyArray<{ day: Weekday; short: string }> = [
  { day: 'monday', short: 'Mo' },
  { day: 'tuesday', short: 'Tu' },
  { day: 'wednesday', short: 'We' },
  { day: 'thursday', short: 'Th' },
  { day: 'friday', short: 'Fr' },
  { day: 'saturday', short: 'Sa' },
  { day: 'sunday', short: 'Su' },
];

/** The COLUMNS of the "weeks of the month" grid, Sunday-first because that is how a wall calendar
 *  reads. `WEEKDAYS` above stays Monday-first: it is a row of chips for a working week, not a
 *  calendar, and re-ordering it would move controls under the fingers of an existing user. */
export const GRID_WEEKDAYS: ReadonlyArray<{ day: Weekday; short: string }> = [
  { day: 'sunday', short: 'Su' },
  { day: 'monday', short: 'Mo' },
  { day: 'tuesday', short: 'Tu' },
  { day: 'wednesday', short: 'We' },
  { day: 'thursday', short: 'Th' },
  { day: 'friday', short: 'Fr' },
  { day: 'saturday', short: 'Sa' },
];

/** The ROWS of that grid. A literal 5th and Last are DIFFERENT rows and both are wanted: in a month
 *  with only four Wednesdays the 5th does not fire at all, while Last lands on the 4th. */
export const ORDINAL_ROWS: ReadonlyArray<{ ordinal: Ordinal; label: string }> = [
  { ordinal: 1, label: '1st' },
  { ordinal: 2, label: '2nd' },
  { ordinal: 3, label: '3rd' },
  { ordinal: 4, label: '4th' },
  { ordinal: 5, label: '5th' },
  { ordinal: 'last', label: 'Last' },
];

/** The 31 checkboxes of the "dates" grid. */
export const MONTH_DAYS: readonly number[] = Array.from({ length: 31 }, (_, index) => index + 1);

export const PERIODS: readonly Period[] = ['day', 'week', 'month'];

/** The two kinds whose `repeat` is month-driven, and which therefore must carry NO weekdays. */
const MONTH_DRIVEN_KINDS: readonly RecurrenceKind[] = ['schedule_ordinal', 'schedule_dates'];

/**
 * What the editor holds while the user types. Everything numeric is a STRING because half of it
 * comes out of a text field mid-edit and "" is a legal intermediate state that a number cannot
 * represent; `draftToWrite` is where it becomes typed data or an error.
 *
 * NO IMPORTANCE FIELD, deliberately. Importance is coach-inferred (spec §4.1) — asking an ADHD
 * user to rank every task on a 1–10 scale is precisely the executive-function tax this app exists
 * to remove. The design prototype omits it too, correctly.
 */
export interface TaskDraft {
  id: number | null;
  title: string;
  description: string;
  /** Minutes, as typed. For `durationType: 'floor'` this is the "at least" value. */
  estimatedDuration: string;
  /** 'floor' is open-ended work: the timer counts UP and the block boundary ends it, so running
   *  long is never an estimation error (spec §8.7). */
  openEnded: boolean;
  energy: UserEnergy;
  kind: RecurrenceKind;
  /** `once` only. YYYY-MM-DD, or '' for no due date. */
  dueDate: string;
  /** `schedule`, `schedule_interval` and `quota_schedule`. EMPTY in the two month-driven kinds. */
  scheduledDays: Weekday[];
  /** `schedule_interval`. Every N weeks, as typed. */
  weekInterval: string;
  /** `schedule_ordinal`. Every ticked cell of the 6×7 grid is ONE occurrence — never a product of
   *  a row list and a column list (see `OrdinalCell` in ../../types/domain). */
  ordinalCells: OrdinalCell[];
  /** `schedule_dates`. The ticked days of the month, 1–31. */
  monthDays: number[];
  /** `schedule_ordinal` and `schedule_dates`. Every N months, as typed. */
  monthInterval: string;
  /** `quota` and `quota_schedule`. */
  quota: string;
  period: Period;
  /** `count`. */
  target: string;
  /** `count` progress so far — displayed, never edited. */
  progress: number;
  contextTags: string[];
  toolRequirements: string[];
}

/** The recurrence half of a draft: exactly the fields `recurrenceFromDraft` reads, and nothing
 *  else. Naming it is what lets `draftFromRecurrence` → `recurrenceFromDraft` be asserted as an
 *  identity without dragging a title and a duration through the round trip. */
export type RecurrenceDraft = Pick<
  TaskDraft,
  | 'kind'
  | 'scheduledDays'
  | 'weekInterval'
  | 'ordinalCells'
  | 'monthDays'
  | 'monthInterval'
  | 'quota'
  | 'period'
  | 'target'
  | 'progress'
>;

function emptyRecurrenceDraft(): RecurrenceDraft {
  return {
    kind: 'once',
    scheduledDays: [],
    // 1 would be plain "Weekly", which is its own option — so the interval this mode adds starts
    // at the smallest value that means anything different.
    weekInterval: '2',
    ordinalCells: [],
    monthDays: [],
    monthInterval: '1',
    quota: '',
    period: 'week',
    target: '',
    progress: 0,
  };
}

export function emptyDraft(): TaskDraft {
  return {
    id: null,
    title: '',
    description: '',
    estimatedDuration: '25',
    openEnded: false,
    energy: 'med',
    dueDate: '',
    ...emptyRecurrenceDraft(),
    contextTags: [],
    toolRequirements: [],
  };
}

/** Internal energy 1–5 → the three user-facing levels. The even values (2 and 4) are the app's own
 *  behavioural discounting and are never user-entered, so they round to the nearest label rather
 *  than going through `internalToUserEnergy`, which rejects them by design. */
function energyLabel(internal: number): UserEnergy {
  if (internal <= 2) return 'low';
  if (internal >= 4) return 'high';
  return internalToUserEnergy(3);
}

export function draftFromTask(task: Task, recurrence: Recurrence | undefined): TaskDraft {
  return {
    ...emptyDraft(),
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    estimatedDuration: String(task.estimatedDuration),
    openEnded: task.durationType === 'floor',
    energy: energyLabel(task.energyRequirement),
    dueDate: task.nextDueAt ? task.nextDueAt.slice(0, 10) : '',
    contextTags: [...task.contextTags],
    toolRequirements: [...task.toolRequirements],
    ...draftFromRecurrence(recurrence),
  };
}

/**
 * Hydrates a stored recurrence back into the fields the editor edits. `undefined` — a task with no
 * `task_recurrence` row at all — opens as "One-time", never as "Ongoing" (constraint #7).
 *
 * The `scheduled` branch is where task 46 lives: an absent `repeat` and an explicit
 * `{mode:'everyWeek'}` both open as plain Weekly, because the union defines them as the same
 * thing, and each of the other three modes opens as its own dropdown option rather than as a
 * weekly schedule that has quietly lost its `repeat`.
 */
export function draftFromRecurrence(recurrence: Recurrence | undefined): RecurrenceDraft {
  const base = emptyRecurrenceDraft();
  if (!recurrence) return base; // a true one-off — no row, and that is the meaningful fact
  switch (recurrence.type) {
    case 'scheduled':
      return scheduledDraft(base, recurrence.scheduledDays, recurrence.repeat);
    case 'quota':
      return { ...base, kind: 'quota', quota: String(recurrence.quota), period: recurrence.period };
    case 'scheduled_quota':
      return {
        ...base,
        kind: 'quota_schedule',
        quota: String(recurrence.quota),
        period: recurrence.period,
        scheduledDays: [...recurrence.scheduledDays],
      };
    case 'unscheduled':
      return { ...base, kind: 'ongoing' };
    case 'count':
      return { ...base, kind: 'count', target: String(recurrence.target), progress: recurrence.progress };
  }
}

/** The four scheduled modes, unpacked into the fields the editor edits. An absent `repeat` and an
 *  explicit `{mode:'everyWeek'}` both land on plain Weekly, because the union defines them as the
 *  same thing; a stride of 1 shows as "1" whether it was stored or merely implied. */
function scheduledDraft(
  base: RecurrenceDraft,
  scheduledDays: Weekday[],
  repeat: ScheduledRepeat | undefined,
): RecurrenceDraft {
  if (repeat === undefined || repeat.mode === 'everyWeek') {
    return { ...base, kind: 'schedule', scheduledDays: [...scheduledDays] };
  }
  switch (repeat.mode) {
    case 'interval':
      return {
        ...base,
        kind: 'schedule_interval',
        scheduledDays: [...scheduledDays],
        weekInterval: String(repeat.weeks),
      };
    case 'ordinal':
      return {
        ...base,
        kind: 'schedule_ordinal',
        ordinalCells: repeat.cells.map((cell) => ({ ...cell })),
        monthInterval: String(repeat.months ?? 1),
      };
    case 'dayOfMonth':
      return {
        ...base,
        kind: 'schedule_dates',
        monthDays: [...repeat.days],
        monthInterval: String(repeat.months ?? 1),
      };
  }
}

/**
 * 🔴 THE PATCH THE DROPDOWN SENDS WHEN THE USER CHANGES OPTION.
 *
 * Switching into "Weeks of the month" or "Dates" CLEARS the weekdays. That is not tidiness:
 * `recurrenceRepeatIssue` rejects a month-driven repeat that still carries `scheduledDays`, at
 * both writers, so leaving them behind means the repository throws a `RecurrenceValidationError`
 * at the user the moment they press Save.
 *
 * The other direction is deliberately NOT symmetrical — leaving Dates keeps the ticked dates, so a
 * user who looks at Weekly and changes their mind still has them. Nothing reads them in another
 * mode (`recurrenceFromDraft` only ever reads the current kind's own fields), so they are invisible
 * rather than stale.
 */
export function recurrenceKindPatch(kind: RecurrenceKind): Partial<TaskDraft> {
  return MONTH_DRIVEN_KINDS.includes(kind) ? { kind, scheduledDays: [] } : { kind };
}

function sameCell(a: OrdinalCell, b: OrdinalCell): boolean {
  return a.ordinal === b.ordinal && a.weekday === b.weekday;
}

/** Ticks or un-ticks ONE box of the 6×7 grid. One cell, one occurrence. */
export function toggleOrdinalCell(cells: OrdinalCell[], cell: OrdinalCell): OrdinalCell[] {
  return cells.some((existing) => sameCell(existing, cell))
    ? cells.filter((existing) => !sameCell(existing, cell))
    : [...cells, { ...cell }];
}

export function isOrdinalCellTicked(cells: OrdinalCell[], cell: OrdinalCell): boolean {
  return cells.some((existing) => sameCell(existing, cell));
}

/** Ticks or un-ticks one of the 31 date checkboxes. */
export function toggleMonthDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((existing) => existing !== day) : [...days, day];
}

export interface DraftValidation {
  /** Field-keyed messages. Empty ⇒ the draft is saveable. */
  errors: Partial<
    Record<
      | 'title'
      | 'estimatedDuration'
      | 'quota'
      | 'target'
      | 'days'
      | 'weekInterval'
      | 'cells'
      | 'monthDays'
      | 'monthInterval',
      string
    >
  >;
}

function positiveInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value > 0 ? value : null;
}

export function validateDraft(draft: TaskDraft): DraftValidation {
  const errors: DraftValidation['errors'] = {};
  if (draft.title.trim().length === 0) errors.title = 'Give it a name.';
  if (positiveInt(draft.estimatedDuration) == null) {
    errors.estimatedDuration = draft.openEnded
      ? 'How long is "at least", in minutes?'
      : 'How many minutes, roughly?';
  }
  if (draft.kind === 'quota' || draft.kind === 'quota_schedule') {
    if (positiveInt(draft.quota) == null) errors.quota = 'How many times?';
  }
  if (draft.kind === 'count' && positiveInt(draft.target) == null) {
    errors.target = 'How many times in total?';
  }
  if (
    (draft.kind === 'schedule' ||
      draft.kind === 'schedule_interval' ||
      draft.kind === 'quota_schedule') &&
    draft.scheduledDays.length === 0
  ) {
    errors.days = 'Pick at least one day.';
  }
  if (draft.kind === 'schedule_interval' && positiveInt(draft.weekInterval) == null) {
    errors.weekInterval = 'Every how many weeks?';
  }
  if (draft.kind === 'schedule_ordinal' && draft.ordinalCells.length === 0) {
    errors.cells = 'Tick at least one box.';
  }
  if (draft.kind === 'schedule_dates' && draft.monthDays.length === 0) {
    errors.monthDays = 'Pick at least one date.';
  }
  if (
    MONTH_DRIVEN_KINDS.includes(draft.kind) &&
    positiveInt(draft.monthInterval) == null
  ) {
    errors.monthInterval = 'Every how many months?';
  }
  return { errors };
}

export interface DraftWrite {
  taskWrite: TaskWriteInput & { title: string; estimatedDuration: number };
  /** `undefined` means a true one-off: DELETE any existing row, never write `unscheduled`. */
  recurrence: Recurrence | undefined;
}

/** Converts a validated draft into the two writes it implies. Throws if the draft is invalid —
 *  the editor calls `validateDraft` first and only enables Save when it is clean. */
export function draftToWrite(draft: TaskDraft): DraftWrite {
  const { errors } = validateDraft(draft);
  if (Object.keys(errors).length > 0) {
    throw new Error(`draftToWrite: draft is not valid (${Object.values(errors).join(' ')})`);
  }
  const minutes = positiveInt(draft.estimatedDuration) as number;
  const taskWrite: DraftWrite['taskWrite'] = {
    title: draft.title.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    estimatedDuration: minutes,
    durationType: draft.openEnded ? 'floor' : 'estimate',
    // The user typed it, so it is not a model guess — that distinction is what lets the numeric
    // learning loop (§5.4) replace a guess off the first real completion instead of waiting.
    durationSource: 'user',
    energyRequirement: userToInternalEnergy(draft.energy),
    contextTags: [...draft.contextTags],
    toolRequirements: [...draft.toolRequirements],
    // Only a one-off carries a standalone due date; every other kind derives its timing from the
    // recurrence, and task 36 owns advancing it.
    nextDueAt: draft.kind === 'once' && draft.dueDate.trim() !== '' ? draft.dueDate.trim() : null,
  };

  return { taskWrite, recurrence: recurrenceFromDraft(draft) };
}

/** A month stride of 1 is spelled by ABSENCE, exactly as `everyWeek` is: `period.ts` reads
 *  `repeat.months ?? 1`, so one canonical on-disk shape for "every month" rather than two. */
function monthStride(text: string): { months?: number } {
  const months = positiveInt(text);
  return months === null || months === 1 ? {} : { months };
}

/**
 * The draft → union mapping. Exported because round-trip fidelity is the test that matters most
 * here: `draftFromRecurrence` → `recurrenceFromDraft` must be the IDENTITY, so that opening a task
 * and saving it untouched cannot quietly rewrite what it repeats.
 */
export function recurrenceFromDraft(draft: RecurrenceDraft): Recurrence | undefined {
  switch (draft.kind) {
    case 'once':
      return undefined;
    case 'schedule':
      // 🔴 NO `repeat` KEY. `{mode:'everyWeek'}` would mean the same thing and serialise to a
      // different row: the live alpha schedules have no such key and must keep not having one.
      return { type: 'scheduled', scheduledDays: [...draft.scheduledDays] };
    case 'schedule_interval':
      return {
        type: 'scheduled',
        scheduledDays: [...draft.scheduledDays],
        repeat: { mode: 'interval', weeks: positiveInt(draft.weekInterval) as number },
      };
    case 'schedule_ordinal':
      return {
        type: 'scheduled',
        // 🔴 EMPTY, whatever the draft still holds. The weekday rides inside each cell, and the
        // repository refuses to write a month-driven repeat that carries weekdays.
        scheduledDays: [],
        repeat: {
          mode: 'ordinal',
          cells: draft.ordinalCells.map((cell) => ({ ...cell })),
          ...monthStride(draft.monthInterval),
        },
      };
    case 'schedule_dates':
      return {
        type: 'scheduled',
        scheduledDays: [],
        repeat: {
          mode: 'dayOfMonth',
          days: [...draft.monthDays],
          ...monthStride(draft.monthInterval),
        },
      };
    case 'quota':
      return { type: 'quota', quota: positiveInt(draft.quota) as number, period: draft.period };
    case 'quota_schedule':
      return {
        type: 'scheduled_quota',
        quota: positiveInt(draft.quota) as number,
        period: draft.period,
        scheduledDays: [...draft.scheduledDays],
      };
    case 'ongoing':
      return { type: 'unscheduled' };
    case 'count':
      return { type: 'count', target: positiveInt(draft.target) as number, progress: draft.progress };
  }
}

/** The one-line "what is this task" summary in the task list. */
export function describeRecurrence(recurrence: Recurrence | undefined, task: Task): string {
  if (!recurrence) return task.nextDueAt ? `Due ${task.nextDueAt.slice(0, 10)}` : 'One-time';
  switch (recurrence.type) {
    case 'scheduled':
      return describeSchedule(recurrence.scheduledDays, recurrence.repeat);
    case 'quota':
      return `${recurrence.quota}× a ${recurrence.period}`;
    case 'scheduled_quota':
      return `${recurrence.quota}× a ${recurrence.period} on ${recurrence.scheduledDays
        .map(shortDay)
        .join('/')}`;
    case 'unscheduled':
      return 'Ongoing';
    case 'count':
      return `${recurrence.progress} of ${recurrence.target} times`;
  }
}

/** A scheduled task's summary. The weekly wording is byte-for-byte what it was before task 46 —
 *  an existing row's list entry must not change because a new mode exists beside it. */
function describeSchedule(scheduledDays: Weekday[], repeat: ScheduledRepeat | undefined): string {
  const days = scheduledDays.map(shortDay).join('/');
  if (repeat === undefined || repeat.mode === 'everyWeek') return `Every ${days || 'week'}`;
  switch (repeat.mode) {
    case 'interval':
      return days ? `Every ${repeat.weeks} weeks on ${days}` : `Every ${repeat.weeks} weeks`;
    case 'ordinal': {
      const cells = repeat.cells.map(describeCell).join(', ');
      return cells ? `${cells} ${everyMonths(repeat.months)}` : 'Monthly';
    }
    case 'dayOfMonth': {
      const dates = repeat.days.join(', ');
      return dates ? `Day ${dates} ${everyMonths(repeat.months)}` : 'Monthly';
    }
  }
}

function everyMonths(months: number | undefined): string {
  return months === undefined || months === 1 ? 'each month' : `every ${months} months`;
}

function describeCell(cell: OrdinalCell): string {
  const row = ORDINAL_ROWS.find((entry) => entry.ordinal === cell.ordinal);
  return `${row ? row.label : String(cell.ordinal)} ${shortDay(cell.weekday)}`;
}

function shortDay(day: Weekday): string {
  return day.charAt(0).toUpperCase() + day.slice(1, 3);
}
