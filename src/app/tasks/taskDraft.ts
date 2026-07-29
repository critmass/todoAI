// Task 24 — the task editor's data model, and the only place the six user-facing recurrence kinds
// meet the `Recurrence` discriminated union.
//
// THE SIX KINDS ARE THE UNION, RENAMED FOR HUMANS. That is the whole design: the editor cannot
// express a state the data model rejects, because each kind maps onto exactly one union member (or,
// for a one-off, onto the ABSENCE of a `task_recurrence` row).
//
//   One-time     → no recurrence at all (undefined)            + an optional due date
//   Schedule     → { type: 'scheduled' }                        weekdays
//   Quota        → { type: 'quota' }                            N times per day/week/month
//   Quota + days → { type: 'scheduled_quota' }                  N per period, on these weekdays
//   Ongoing      → { type: 'unscheduled' }                      resurfaces by neglect alone
//   N times      → { type: 'count' }                            target, then done
//
// CONSTRAINT #7 LIVES HERE. "One-time" is `undefined`, NOT `{type:'unscheduled'}`. They look alike
// in a picker and have opposite completion semantics: completing a one-off closes it, completing an
// unscheduled task resets its neglect clock and leaves it active forever. The editor keeps them two
// visibly different choices ("One-time" vs "Ongoing") for exactly that reason.
//
// WHAT THE PROTOTYPE HAD THAT THIS DOES NOT: an "every N weeks" interval on the schedule kind. The
// `scheduled` union member carries weekdays and nothing else, so an interval would be a control
// that silently discards its own value. Dropped rather than faked — see the findings report.

import type { Period, Recurrence, Task, TaskWriteInput, Weekday } from '../../types/domain';
import { internalToUserEnergy, userToInternalEnergy, type UserEnergy } from '../../types/scales';

export type RecurrenceKind =
  | 'once'
  | 'schedule'
  | 'quota'
  | 'quota_schedule'
  | 'ongoing'
  | 'count';

export const RECURRENCE_KINDS: ReadonlyArray<{ kind: RecurrenceKind; label: string }> = [
  { kind: 'once', label: 'One-time' },
  { kind: 'schedule', label: 'Schedule' },
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

export const PERIODS: readonly Period[] = ['day', 'week', 'month'];

/**
 * What the editor holds while the user types. Everything is a STRING because half of it comes out
 * of a text field mid-edit and "" is a legal intermediate state that a number cannot represent;
 * `draftToWrite` is where it becomes typed data or an error.
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
  /** `schedule` and `quota_schedule`. */
  scheduledDays: Weekday[];
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

export function emptyDraft(): TaskDraft {
  return {
    id: null,
    title: '',
    description: '',
    estimatedDuration: '25',
    openEnded: false,
    energy: 'med',
    kind: 'once',
    dueDate: '',
    scheduledDays: [],
    quota: '',
    period: 'week',
    target: '',
    progress: 0,
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
  const draft: TaskDraft = {
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
  };
  if (!recurrence) return draft; // a true one-off — no row, and that is the meaningful fact
  switch (recurrence.type) {
    case 'scheduled':
      return { ...draft, kind: 'schedule', scheduledDays: [...recurrence.scheduledDays] };
    case 'quota':
      return {
        ...draft,
        kind: 'quota',
        quota: String(recurrence.quota),
        period: recurrence.period,
      };
    case 'scheduled_quota':
      return {
        ...draft,
        kind: 'quota_schedule',
        quota: String(recurrence.quota),
        period: recurrence.period,
        scheduledDays: [...recurrence.scheduledDays],
      };
    case 'unscheduled':
      return { ...draft, kind: 'ongoing' };
    case 'count':
      return {
        ...draft,
        kind: 'count',
        target: String(recurrence.target),
        progress: recurrence.progress,
      };
  }
}

export interface DraftValidation {
  /** Field-keyed messages. Empty ⇒ the draft is saveable. */
  errors: Partial<Record<'title' | 'estimatedDuration' | 'quota' | 'target' | 'days', string>>;
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
    (draft.kind === 'schedule' || draft.kind === 'quota_schedule') &&
    draft.scheduledDays.length === 0
  ) {
    errors.days = 'Pick at least one day.';
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

function recurrenceFromDraft(draft: TaskDraft): Recurrence | undefined {
  switch (draft.kind) {
    case 'once':
      return undefined;
    case 'schedule':
      return { type: 'scheduled', scheduledDays: [...draft.scheduledDays] };
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
      return `Every ${recurrence.scheduledDays.map(shortDay).join('/') || 'week'}`;
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

function shortDay(day: Weekday): string {
  return day.charAt(0).toUpperCase() + day.slice(1, 3);
}
