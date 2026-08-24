// Domain entities: camelCase, JSON columns parsed into real types. Internal importance (1-1000)
// and energy (1-5) values are carried through unconverted — see scales.ts for the user-facing
// projection; that conversion happens at the input/display boundary, not here.
import type {
  ActiveEpisodeRow,
  AlgorithmFactorName,
  AlgorithmWeightRow,
  BackupLogRow,
  BackupType,
  CoachingExternalDependencyRow,
  CoachingPriorityQueueRow,
  CoachingQueueRow,
  CoachingQueueStatus,
  CoachingSessionRow,
  CoachingTaskRow,
  CoachingTrigger,
  CoachingUrgency,
  CompletionStatus,
  ConditionOp,
  ContextEffectivenessRow,
  DataRetentionRow,
  DurationSource,
  DurationType,
  EnergyPatternRow,
  EpisodeBlockKind,
  EvidenceType,
  ExternalDependencyRow,
  ExternalDependencyStatus,
  FireableSkillsRow,
  InteractionExternalDependencyRow,
  InteractionRow,
  InteractionTaskRow,
  InteractionType,
  ModelTier,
  PatternType,
  RecentSessionPerformanceRow,
  RetentionPolicy,
  SessionOrigin,
  SessionRow,
  SessionRuntimeRow,
  SessionStatus,
  SessionTaskExtensionRow,
  SessionType,
  SkillConditionRow,
  SkillEvidenceRow,
  SkillEvidenceSource,
  SkillRow,
  SkillScope,
  SqliteBoolean,
  TaskDependencyRow,
  TaskExternalDependencyRow,
  TaskRecurrenceRow,
  TaskRow,
  TaskStatus,
  WorkState,
} from './db';

// =====================================================================
// JSON parsing helpers
// =====================================================================

function parseJsonArray<T>(text: string | null): T[] {
  if (text == null) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array, got: ${text}`);
  }
  return parsed as T[];
}

function parseJsonObject<T extends Record<string, unknown>>(text: string | null): T | null {
  if (text == null) return null;
  const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object, got: ${text}`);
  }
  return parsed as T;
}

function boolFromRow(value: SqliteBoolean | null, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === 1;
}

function boolToRow(value: boolean): SqliteBoolean {
  return value ? 1 : 0;
}

// =====================================================================
// Recurrence — the discriminated union (spec §4.2). Illegal states unrepresentable:
// quota/period only exist on the types that have them; only 'count' carries a target/progress.
// =====================================================================

export type Period = 'day' | 'week' | 'month'; // spec only illustrates 'week'; day/month are the obvious extensions
export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

/**
 * Which occurrence of a weekday within a month — one ROW of the editor's 6×7 grid (1st, 2nd, 3rd,
 * 4th, 5th, Last).
 *
 * A LITERAL `5` AND `'last'` ARE DIFFERENT, and both are wanted. A month holds four or five of any
 * weekday: where it holds five they name the same date, but where it holds four, `5` does not fire
 * at all that month while `'last'` lands on the 4th. "The last Friday of the month" and "the fifth
 * Friday, when there is one" are both ordinary requests, and neither can stand in for the other.
 */
export type Ordinal = 1 | 2 | 3 | 4 | 5 | 'last';

/** One ticked box in that grid: a column (weekday) and a row (ordinal). EACH CELL IS ONE
 *  OCCURRENCE — the ticked set IS the schedule, never a product of two lists. */
export type OrdinalCell = { ordinal: Ordinal; weekday: Weekday };

/**
 * Task 46 — how often a `scheduled` recurrence's weekdays actually come round.
 *
 * WHY A TAGGED `mode` RATHER THAN INFERRING FROM WHICH FIELD IS PRESENT. Distinguishing states by
 * absence is the exact shape that already cost this project real pain (`null` vs `unscheduled` —
 * constraint #7, two absent-ish states with opposite semantics). The tag also gives every switch
 * over this union compile-time exhaustiveness, so a fifth mode later cannot silently fall through
 * to "weekly".
 *
 * `undefined` (the field absent altogether) is DEFINED to mean `everyWeek`, byte for byte the
 * pre-task-46 behaviour: the live alpha rows have no `repeat` key and must keep meaning what they
 * have always meant. `recurrenceToPattern` normalises an explicit `everyWeek` back to absent for
 * the same reason — one canonical on-disk shape for "weekly", not two.
 *
 * All strides (`weeks`, `months`) are counted from the TASK'S CREATION DATE. That is a ruling, not
 * an implementation detail: it gives a fixed cadence with no drift and, decisively, requires no
 * date-picker — the app has none and this deliberately does not introduce one.
 *
 * WHY `ordinal` CARRIES CELLS RATHER THAN A CROSS PRODUCT of ordinals × `scheduledDays`. The
 * editor's control is a 6×7 grid of checkboxes and each ticked cell is one occurrence, so a
 * product cannot represent it: "1st Monday + 3rd Wednesday" is two ticks, but `[1,3] × [Mon,Wed]`
 * is four occurrences — the grid would have to fill in two cells the user never checked. Cells are
 * a strict superset (everything a product could say, it can still say) and they make the count
 * plain everywhere downstream: occurrences per month is `cells.length`.
 *
 * WHICH LEAVES ONE RULE ABOUT `scheduledDays`: it is used by `everyWeek` and `interval` ONLY, and
 * must be EMPTY in `ordinal` (the weekday rides inside each cell) and `dayOfMonth` (there is no
 * weekday at all). Enforced by `recurrenceRepeatIssue` at both writers, not merely documented.
 */
export type ScheduledRepeat =
  | { mode: 'everyWeek' } // identical to the field being absent
  | { mode: 'interval'; weeks: number } // every N weeks, on scheduledDays; N ≥ 1
  | { mode: 'ordinal'; cells: OrdinalCell[]; months?: number } // 1st Mon + 3rd Wed; every N months
  | { mode: 'dayOfMonth'; days: number[]; months?: number }; // the 1st & 15th; every N months

export type Recurrence =
  | { type: 'scheduled_quota'; quota: number; period: Period; scheduledDays: Weekday[] }
  | { type: 'quota'; quota: number; period: Period }
  /** `repeat` absent === `{ mode: 'everyWeek' }`. `scheduledDays` is used by `everyWeek` and
   *  `interval` only, and MUST be empty in `ordinal` and `dayOfMonth` — see
   *  `recurrenceRepeatIssue`, which the repository enforces on create and update alike. */
  | { type: 'scheduled'; scheduledDays: Weekday[]; repeat?: ScheduledRepeat }
  | { type: 'unscheduled' } // reopens on completion; neglect-only; never a fake period/quota
  | { type: 'count'; target: number; progress: number }; // done only when progress reaches target

const ORDINALS: readonly unknown[] = [1, 2, 3, 4, 5, 'last'];

const WEEKDAYS: readonly unknown[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * THE ONE RULE ABOUT `scheduledDays`, enforced rather than commented: it belongs to `everyWeek`
 * and `interval`, and must be empty in the two month-driven modes. `ordinal` carries its weekday
 * inside each cell and `dayOfMonth` has no weekday at all, so a non-empty list in either is stale
 * data left by a mode switch — dead, invisible, and waiting for a later reader to trust it.
 */
function monthModeScheduledDaysIssue(
  mode: 'ordinal' | 'dayOfMonth',
  scheduledDays: Weekday[],
): string | null {
  return scheduledDays.length === 0
    ? null
    : `${mode} repeat does not use scheduledDays — it must be empty (scheduledDays is for everyWeek and interval only)`;
}

/**
 * The legality rules for `repeat`, as a message or null — ONE predicate, used in both directions:
 * the repository refuses to WRITE anything this rejects, and `recurrencePatternToRecurrence`
 * refuses to LOAD it (degrading to weekly). What cannot be stored therefore cannot be read back
 * either, whoever hand-edited the database in between.
 *
 * Note what is deliberately NOT rejected: an empty `scheduledDays` on a weekday-driven mode. That
 * has always been legal for `scheduled` (the sweep answers "no occurrence" rather than inventing
 * one — task 36), and task 46 does not tighten it.
 */
export function recurrenceRepeatIssue(recurrence: Recurrence): string | null {
  if (recurrence.type !== 'scheduled' || recurrence.repeat === undefined) return null;
  const { repeat, scheduledDays } = recurrence;
  switch (repeat.mode) {
    case 'everyWeek':
      return null;
    case 'interval':
      return isPositiveInt(repeat.weeks)
        ? null
        : `interval repeat needs a whole number of weeks ≥ 1, got ${String(repeat.weeks)}`;
    case 'ordinal': {
      if (!Array.isArray(repeat.cells) || repeat.cells.length === 0) {
        return 'ordinal repeat needs at least one (ordinal, weekday) cell — one per ticked box';
      }
      // findIndex, not find: a cell that is literally `undefined` is exactly the kind of junk this
      // has to catch, and `find` would hand it back indistinguishable from "nothing wrong".
      const badIndex = repeat.cells.findIndex(
        (cell) =>
          typeof cell !== 'object' ||
          cell === null ||
          !ORDINALS.includes(cell.ordinal) ||
          !WEEKDAYS.includes(cell.weekday),
      );
      if (badIndex !== -1) {
        return `ordinal repeat cells are { ordinal: 1–5 or "last", weekday }; cell ${badIndex} is ${JSON.stringify(
          repeat.cells[badIndex],
        )}`;
      }
      if (repeat.months !== undefined && !isPositiveInt(repeat.months)) {
        return `ordinal repeat's month stride must be a whole number ≥ 1, got ${String(repeat.months)}`;
      }
      return monthModeScheduledDaysIssue('ordinal', scheduledDays);
    }
    case 'dayOfMonth': {
      if (!Array.isArray(repeat.days) || repeat.days.length === 0) {
        return 'dayOfMonth repeat needs at least one day of the month';
      }
      const bad = repeat.days.find((day) => !isPositiveInt(day) || day > 31);
      if (bad !== undefined) {
        return `dayOfMonth repeat accepts whole days 1–31, got ${String(bad)}`;
      }
      if (repeat.months !== undefined && !isPositiveInt(repeat.months)) {
        return `dayOfMonth repeat's month stride must be a whole number ≥ 1, got ${String(repeat.months)}`;
      }
      return monthModeScheduledDaysIssue('dayOfMonth', scheduledDays);
    }
  }
}

/** Reads a stored `repeat` value, or undefined for absent/unreadable. Anything illegal degrades to
 *  weekly rather than throwing: refusing to open a user's own database over a malformed field is
 *  the worse failure, and weekly is the behaviour every such row had before task 46 anyway. */
function parseScheduledRepeat(value: unknown, scheduledDays: Weekday[]): ScheduledRepeat | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const repeat = value as ScheduledRepeat;
  if (!['everyWeek', 'interval', 'ordinal', 'dayOfMonth'].includes(repeat.mode)) return undefined;
  if (recurrenceRepeatIssue({ type: 'scheduled', scheduledDays, repeat }) !== null) return undefined;
  return repeat.mode === 'everyWeek' ? undefined : repeat;
}

/**
 * A task's relationship to recurrence is intentionally NOT a field on `Task` — tasks.ts and
 * recurrence.ts are separate repositories (task_recurrence is a distinct, optional 1:1 table).
 * Folding an optional `recurrence?` onto `Task` would make `undefined` ambiguous between
 * "no task_recurrence row" (true one-off) and "not joined/not fetched", which is exactly the
 * null-vs-unscheduled confusion the spec warns against (constraint #5). Instead,
 * `recurrenceRepository.getByTaskId()` queries task_recurrence directly and returns
 * `Recurrence | undefined`, where `undefined` truthfully means "no row exists".
 */
export interface TaskRecurrenceEntity {
  id: number;
  taskId: number;
  recurrence: Recurrence;
  /** Raw task_recurrence.current_period_progress: authoritative quota progress for period
   *  types; for 'count' it mirrors recurrence.progress (same underlying column). */
  currentPeriodProgress: number;
  /** 'YYYY-MM-DD' local calendar date the CURRENT period ends, EXCLUSIVE — the period that is
   *  running is `[resetDate − one period, resetDate)` and the sweep rolls when today >= resetDate
   *  (task 36, migration 006). Null for 'unscheduled'/'count' (they have no period at all — CHECK
   *  enforced) and for a period type no sweep has seeded yet. */
  resetDate: string | null;
  /** How many occurrences the immediately PRECEDING period ended short by (0 if it was met, or if
   *  no period has closed yet). The missed-quota importance boost (spec §4.2) is DERIVED from this
   *  at scoring time — see `src/scoring/factors.ts`. Replaced at each roll and capped at the quota,
   *  never summed across missed periods: missed occurrences reset, they do not stack guilt. */
  lastPeriodShortfall: number;
  isCurrentlyActive: boolean;
  createdAt: string | null;
}

function recurrencePatternToRecurrence(
  type: TaskRecurrenceRow['recurrence_type'],
  pattern: Record<string, unknown>,
  targetCount: number | null,
  currentPeriodProgress: number,
): Recurrence {
  switch (type) {
    case 'scheduled_quota':
      return {
        type,
        quota: pattern.quota as number,
        period: pattern.period as Period,
        scheduledDays: (pattern.scheduledDays as Weekday[]) ?? [],
      };
    case 'quota':
      return { type, quota: pattern.quota as number, period: pattern.period as Period };
    case 'scheduled': {
      const scheduledDays = (pattern.scheduledDays as Weekday[]) ?? [];
      const repeat = parseScheduledRepeat(pattern.repeat, scheduledDays);
      // Absent, not `{mode:'everyWeek'}`: nothing downstream may start telling a pre-task-46 row
      // apart from a new weekly one, because there is no difference.
      return repeat === undefined ? { type, scheduledDays } : { type, scheduledDays, repeat };
    }
    case 'unscheduled':
      return { type };
    case 'count':
      if (targetCount == null) {
        throw new Error("recurrence_type 'count' requires target_count to be set");
      }
      return { type, target: targetCount, progress: currentPeriodProgress };
  }
}

function recurrenceToPattern(recurrence: Recurrence): Record<string, unknown> {
  switch (recurrence.type) {
    case 'scheduled_quota':
      return {
        quota: recurrence.quota,
        period: recurrence.period,
        scheduledDays: recurrence.scheduledDays,
      };
    case 'quota':
      return { quota: recurrence.quota, period: recurrence.period };
    case 'scheduled':
      // `everyWeek` is normalised away, so a weekly schedule is written in EXACTLY the shape it
      // had before task 46 — `{"scheduledDays":[…]}`. Saving an untouched weekly task from the
      // Phase 2 editor must not rewrite live rows into a new shape.
      return recurrence.repeat === undefined || recurrence.repeat.mode === 'everyWeek'
        ? { scheduledDays: recurrence.scheduledDays }
        : { scheduledDays: recurrence.scheduledDays, repeat: recurrence.repeat };
    case 'unscheduled':
      return {};
    case 'count':
      return {};
  }
}

export function taskRecurrenceRowToDomain(row: TaskRecurrenceRow): TaskRecurrenceEntity {
  const pattern = parseJsonObject<Record<string, unknown>>(row.recurrence_pattern) ?? {};
  const currentPeriodProgress = row.current_period_progress ?? 0;
  return {
    id: row.id,
    taskId: row.task_id,
    recurrence: recurrencePatternToRecurrence(
      row.recurrence_type,
      pattern,
      row.target_count,
      currentPeriodProgress,
    ),
    currentPeriodProgress,
    resetDate: row.reset_date,
    lastPeriodShortfall: row.last_period_shortfall ?? 0,
    isCurrentlyActive: boolFromRow(row.is_currently_active, true),
    createdAt: row.created_at,
  };
}

/** Produces the columns derived purely from the Recurrence union (create path). Progress for
 *  period types starts at the schema default (0); use a dedicated update for later progress. */
export function recurrenceToRow(
  recurrence: Recurrence,
): Pick<TaskRecurrenceRow, 'recurrence_type' | 'recurrence_pattern' | 'target_count' | 'current_period_progress'> {
  return {
    recurrence_type: recurrence.type,
    recurrence_pattern: JSON.stringify(recurrenceToPattern(recurrence)),
    target_count: recurrence.type === 'count' ? recurrence.target : null,
    current_period_progress: recurrence.type === 'count' ? recurrence.progress : 0,
  };
}

// =====================================================================
// Task
// =====================================================================

export interface Task {
  id: number;
  title: string;
  description: string | null;
  importance: number | null; // internal 1-1000; see scales.ts
  urgencyLevel: number; // optional base sensitivity only; effective urgency is derived elsewhere
  nextDueAt: string | null;
  estimatedDuration: number;
  durationSource: DurationSource;
  actualDurationHistory: number[];
  averageActualDuration: number | null;
  energyRequirement: number; // internal 1-5; see scales.ts
  averageEnergyCost: number;
  contextTags: string[];
  toolRequirements: string[];
  status: TaskStatus;
  parentTaskId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  completionCount: number;
  skipCount: number;
  skipReasons: string[];
  lastCompletedAt: string | null;
  successRate: number;
  // Task 28 / migration 003 — multi-session work.
  durationType: DurationType; // 'estimate' | 'floor'; for 'floor', estimatedDuration holds the floor
  workState: WorkState; // 'none' | 'in_progress'; orthogonal to status (a parked task stays active)
  accumulatedMinutes: number; // minutes worked toward the current completion; folds to history at completion
  lastWorkedAt: string | null; // re-anchors the neglect clock (working a task is attention)
}

export function taskRowToDomain(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    importance: row.importance,
    urgencyLevel: row.urgency_level ?? 3,
    nextDueAt: row.next_due_at,
    estimatedDuration: row.estimated_duration,
    durationSource: row.duration_source ?? 'model_guess',
    actualDurationHistory: parseJsonArray<number>(row.actual_duration_history),
    averageActualDuration: row.average_actual_duration,
    energyRequirement: row.energy_requirement ?? 3,
    averageEnergyCost: row.average_energy_cost ?? 0,
    contextTags: parseJsonArray<string>(row.context_tags),
    toolRequirements: parseJsonArray<string>(row.tool_requirements),
    status: row.status ?? 'active',
    parentTaskId: row.parent_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completionCount: row.completion_count ?? 0,
    skipCount: row.skip_count ?? 0,
    skipReasons: parseJsonArray<string>(row.skip_reasons),
    lastCompletedAt: row.last_completed_at,
    successRate: row.success_rate ?? 0,
    durationType: row.duration_type ?? 'estimate', // mirrors the migration-003 DEFAULT
    workState: row.work_state ?? 'none', // mirrors the migration-003 DEFAULT
    accumulatedMinutes: row.accumulated_minutes ?? 0,
    lastWorkedAt: row.last_worked_at,
  };
}

/** Partial row for inserts/updates — only fields that came from the domain object. Timestamps
 *  and computed columns (id, created_at, updated_at) are left to the DB. Fully partial: the
 *  tasks repository's create() adds the title/estimatedDuration-required constraint at its own
 *  boundary so this one mapper serves both create (INSERT) and update (partial UPDATE). */
export type TaskWriteInput = Partial<
  Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'completionCount' | 'skipCount' | 'successRate'>
>;

export function taskDomainToRow(
  task: TaskWriteInput,
): Partial<TaskRow> {
  const row: Partial<TaskRow> = {};
  if (task.title !== undefined) row.title = task.title;
  if (task.description !== undefined) row.description = task.description;
  if (task.importance !== undefined) row.importance = task.importance;
  if (task.urgencyLevel !== undefined) row.urgency_level = task.urgencyLevel;
  if (task.nextDueAt !== undefined) row.next_due_at = task.nextDueAt;
  if (task.estimatedDuration !== undefined) row.estimated_duration = task.estimatedDuration;
  if (task.durationSource !== undefined) row.duration_source = task.durationSource;
  if (task.actualDurationHistory !== undefined) {
    row.actual_duration_history = JSON.stringify(task.actualDurationHistory);
  }
  if (task.averageActualDuration !== undefined) {
    row.average_actual_duration = task.averageActualDuration;
  }
  if (task.energyRequirement !== undefined) row.energy_requirement = task.energyRequirement;
  if (task.averageEnergyCost !== undefined) row.average_energy_cost = task.averageEnergyCost;
  if (task.contextTags !== undefined) row.context_tags = JSON.stringify(task.contextTags);
  if (task.toolRequirements !== undefined) {
    row.tool_requirements = JSON.stringify(task.toolRequirements);
  }
  if (task.status !== undefined) row.status = task.status;
  if (task.parentTaskId !== undefined) row.parent_task_id = task.parentTaskId;
  if (task.skipReasons !== undefined) row.skip_reasons = JSON.stringify(task.skipReasons);
  if (task.lastCompletedAt !== undefined) row.last_completed_at = task.lastCompletedAt;
  if (task.durationType !== undefined) row.duration_type = task.durationType;
  if (task.workState !== undefined) row.work_state = task.workState;
  if (task.accumulatedMinutes !== undefined) row.accumulated_minutes = task.accumulatedMinutes;
  if (task.lastWorkedAt !== undefined) row.last_worked_at = task.lastWorkedAt;
  return row;
}

// =====================================================================
// Task dependencies / external dependencies
// =====================================================================

export interface TaskDependency {
  id: number;
  taskId: number;
  dependsOnTaskId: number;
  createdAt: string | null;
}

export function taskDependencyRowToDomain(row: TaskDependencyRow): TaskDependency {
  return {
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at,
  };
}

export interface ExternalDependency {
  id: number;
  title: string;
  description: string | null;
  expectedCompletionDate: string | null;
  externalParty: string | null;
  followUpActions: string | null;
  status: ExternalDependencyStatus;
  lastFollowUpDate: string | null;
  resolutionNotes: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

export function externalDependencyRowToDomain(row: ExternalDependencyRow): ExternalDependency {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    expectedCompletionDate: row.expected_completion_date,
    externalParty: row.external_party,
    followUpActions: row.follow_up_actions,
    status: row.status ?? 'waiting',
    lastFollowUpDate: row.last_follow_up_date,
    resolutionNotes: row.resolution_notes,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export interface TaskExternalDependency {
  id: number;
  taskId: number;
  externalDependencyId: number;
  createdAt: string | null;
}

export function taskExternalDependencyRowToDomain(
  row: TaskExternalDependencyRow,
): TaskExternalDependency {
  return {
    id: row.id,
    taskId: row.task_id,
    externalDependencyId: row.external_dependency_id,
    createdAt: row.created_at,
  };
}

// =====================================================================
// Interactions
// =====================================================================

export interface Interaction {
  id: number;
  timestamp: string | null;
  interactionType: InteractionType;
  sessionId: string | null;
  userEnergyLevelStart: number | null;
  userEnergyLevelEnd: number | null;
  conclusions: string[];
  /** Free-form JSON; the skill layer (task 19) populates it as `{ snapshot, skillsFired }`
   *  (task 18 design §1.2/§2.3). Any writer of that shape must embed an internal `"v": 1` field
   *  at the top level - mirroring summarySchemaVersion's discipline below, just inside the JSON
   *  instead of a dedicated column - so future readers can branch on version (migration 002,
   *  design report §2 item 6). No writer exists yet; this is the convention task 19 must follow. */
  learningData: Record<string, unknown> | null;
  conversationSummary: string | null;
  summarySchemaVersion: string | null;
  durationMinutes: number | null;
  completionStatus: CompletionStatus | null;
  contextUsed: string[];
  userFeedbackRating: number | null;
  notes: string | null;
}

export function interactionRowToDomain(row: InteractionRow): Interaction {
  return {
    id: row.id,
    timestamp: row.timestamp,
    interactionType: row.interaction_type,
    sessionId: row.session_id,
    userEnergyLevelStart: row.user_energy_level_start,
    userEnergyLevelEnd: row.user_energy_level_end,
    conclusions: parseJsonArray<string>(row.conclusions),
    learningData: parseJsonObject<Record<string, unknown>>(row.learning_data),
    conversationSummary: row.conversation_summary,
    summarySchemaVersion: row.summary_schema_version,
    durationMinutes: row.duration_minutes,
    completionStatus: row.completion_status,
    contextUsed: parseJsonArray<string>(row.context_used),
    userFeedbackRating: row.user_feedback_rating,
    notes: row.notes,
  };
}

/** Fully partial - the interactions repository's create() adds the interactionType-required
 *  constraint at its own boundary so this one mapper serves both create and update. */
export type InteractionWriteInput = Partial<Omit<Interaction, 'id' | 'timestamp'>>;

export function interactionDomainToRow(input: InteractionWriteInput): Partial<InteractionRow> {
  const row: Partial<InteractionRow> = {};
  if (input.interactionType !== undefined) row.interaction_type = input.interactionType;
  if (input.sessionId !== undefined) row.session_id = input.sessionId;
  if (input.userEnergyLevelStart !== undefined) {
    row.user_energy_level_start = input.userEnergyLevelStart;
  }
  if (input.userEnergyLevelEnd !== undefined) row.user_energy_level_end = input.userEnergyLevelEnd;
  if (input.conclusions !== undefined) row.conclusions = JSON.stringify(input.conclusions);
  if (input.learningData !== undefined) {
    row.learning_data = input.learningData == null ? null : JSON.stringify(input.learningData);
  }
  if (input.conversationSummary !== undefined) row.conversation_summary = input.conversationSummary;
  if (input.summarySchemaVersion !== undefined) {
    row.summary_schema_version = input.summarySchemaVersion;
  }
  if (input.durationMinutes !== undefined) row.duration_minutes = input.durationMinutes;
  if (input.completionStatus !== undefined) row.completion_status = input.completionStatus;
  if (input.contextUsed !== undefined) row.context_used = JSON.stringify(input.contextUsed);
  if (input.userFeedbackRating !== undefined) row.user_feedback_rating = input.userFeedbackRating;
  if (input.notes !== undefined) row.notes = input.notes;
  return row;
}

// =====================================================================
// Sessions
// =====================================================================

export interface Session {
  id: string;
  sessionType: SessionType;
  plannedDuration: number;
  actualDuration: number | null;
  userEnergyStart: number | null;
  userEnergyEnd: number | null;
  status: SessionStatus;
  tasksCompleted: number;
  tasksSkipped: number;
  tasksProgressed: number; // task 28 / migration 003: parked tasks counted here, not completed/skipped
  escapeValveUsed: boolean;
  extended: boolean;
  modelTier: ModelTier | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Migration 007 (task 44). NULL for every row born before this column existed — see SessionRow. */
  origin: SessionOrigin | null;
}

export function sessionRowToDomain(row: SessionRow): Session {
  return {
    id: row.id,
    sessionType: row.session_type,
    plannedDuration: row.planned_duration,
    actualDuration: row.actual_duration,
    userEnergyStart: row.user_energy_start,
    userEnergyEnd: row.user_energy_end,
    status: row.status,
    tasksCompleted: row.tasks_completed ?? 0,
    tasksSkipped: row.tasks_skipped ?? 0,
    tasksProgressed: row.tasks_progressed ?? 0,
    escapeValveUsed: boolFromRow(row.escape_valve_used, false),
    extended: boolFromRow(row.extended, false),
    modelTier: row.model_tier,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    origin: row.origin ?? null,
  };
}

/** Fully partial and excludes id - sessions.id is caller-supplied (not autoincrement) but is
 *  always passed as its own parameter to create()/update(), never inside the patch body, so
 *  this one mapper serves both. The sessions repository's create() adds the
 *  sessionType/plannedDuration/status-required constraint at its own boundary.
 *
 *  `startedAt` stays excluded because the column has a CURRENT_TIMESTAMP default - the DB fills
 *  it. `completedAt` does NOT have a default, so excluding it (as this type originally did) left
 *  the column permanently NULL with no writer anywhere: not a deliberate omission but a gap,
 *  closed by task 13's session close. */
export type SessionWriteInput = Partial<Omit<Session, 'id' | 'startedAt'>>;

export function sessionDomainToRow(input: SessionWriteInput): Partial<SessionRow> {
  const row: Partial<SessionRow> = {};
  if (input.sessionType !== undefined) row.session_type = input.sessionType;
  if (input.plannedDuration !== undefined) row.planned_duration = input.plannedDuration;
  if (input.status !== undefined) row.status = input.status;
  if (input.actualDuration !== undefined) row.actual_duration = input.actualDuration;
  if (input.userEnergyStart !== undefined) row.user_energy_start = input.userEnergyStart;
  if (input.userEnergyEnd !== undefined) row.user_energy_end = input.userEnergyEnd;
  if (input.tasksCompleted !== undefined) row.tasks_completed = input.tasksCompleted;
  if (input.tasksSkipped !== undefined) row.tasks_skipped = input.tasksSkipped;
  if (input.tasksProgressed !== undefined) row.tasks_progressed = input.tasksProgressed;
  if (input.escapeValveUsed !== undefined) row.escape_valve_used = boolToRow(input.escapeValveUsed);
  if (input.extended !== undefined) row.extended = boolToRow(input.extended);
  if (input.modelTier !== undefined) row.model_tier = input.modelTier;
  if (input.completedAt !== undefined) row.completed_at = input.completedAt;
  if (input.origin !== undefined) row.origin = input.origin;
  return row;
}

export type { SessionOrigin };

// =====================================================================
// Session runtime (migration 005, task 13) - the live timer state that must survive a process
// kill. Epoch-millisecond fields keep the `Ms` suffix in the domain shape too: they are the same
// unit the engine's injected clock computes in, and hiding that behind a bare name would invite
// someone to pass a DATETIME string. See 005_session_runtime.sql for the format decision.
// =====================================================================

export interface SessionRuntime {
  sessionId: string;
  /** When the session started, in the engine's own clock unit - the other half of the
   *  `sessions.actual_duration` computation at close. */
  startedAtMs: number;
  /** The session's planned end. MOVABLE - a hyperfocus extend that crosses it moves it (task 28
   *  design §4.1.2), and a `+5` moves it only when the block end itself passes it. */
  plannedEndAtMs: number;
  updatedAt: string | null;
}

export function sessionRuntimeRowToDomain(row: SessionRuntimeRow): SessionRuntime {
  return {
    sessionId: row.session_id,
    startedAtMs: row.started_at_ms,
    plannedEndAtMs: row.planned_end_at_ms,
    updatedAt: row.updated_at,
  };
}

export interface ActiveEpisode {
  sessionId: string;
  taskId: number;
  blockKind: EpisodeBlockKind;
  /** The ORIGINAL block size. Never mutated by an extension - the guardrail's "beyond 2x the
   *  original block" test needs a fixed reference after blockEndAtMs has moved. */
  plannedMinutes: number;
  startedAtMs: number;
  /** Mutated by both extension paths and by resuming from a pause (a pause pushes the end out so
   *  the interruption does not eat the block). */
  blockEndAtMs: number;
  /** Non-null iff the timer is paused right now, recording when the pause began. */
  pausedAtMs: number | null;
  /** Total CLOSED pause time. The open pause (if any) is not included here. */
  pausedMs: number;
  pauseCount: number;
  /** "Keep going" presses only. `+5` never counts here - the guardrail must not reach it. */
  hyperfocusQuanta: number;
  longExtendEnqueued: boolean;
}

export function activeEpisodeRowToDomain(row: ActiveEpisodeRow): ActiveEpisode {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    blockKind: row.block_kind,
    plannedMinutes: row.planned_minutes,
    startedAtMs: row.started_at_ms,
    blockEndAtMs: row.block_end_at_ms,
    pausedAtMs: row.paused_at_ms,
    pausedMs: row.paused_ms,
    pauseCount: row.pause_count,
    hyperfocusQuanta: row.hyperfocus_quanta,
    longExtendEnqueued: boolFromRow(row.long_extend_enqueued, false),
  };
}

export interface SessionTaskExtension {
  sessionId: string;
  taskId: number;
  presses: number;
  minutes: number;
  /** Set once the `repeated_extension` row has been enqueued for this (session, task) - the
   *  "one row per task per session" deduplication (task 28 amendment §3). */
  coachingEnqueued: boolean;
}

export function sessionTaskExtensionRowToDomain(row: SessionTaskExtensionRow): SessionTaskExtension {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    presses: row.presses,
    minutes: row.minutes,
    coachingEnqueued: boolFromRow(row.coaching_enqueued, false),
  };
}

/** Aggregated stats from the recent_session_performance view (last 30 days, grouped by
 *  session_type). */
export interface SessionPerformanceStats {
  sessionType: SessionType;
  sessionCount: number;
  avgDuration: number | null;
  completionRate: number | null;
  avgEnergyStart: number | null;
  avgEnergyEnd: number | null;
  avgTasksCompleted: number | null;
  avgTasksSkipped: number | null;
}

export function recentSessionPerformanceRowToDomain(
  row: RecentSessionPerformanceRow,
): SessionPerformanceStats {
  return {
    sessionType: row.session_type,
    sessionCount: row.session_count,
    avgDuration: row.avg_duration,
    completionRate: row.completion_rate,
    avgEnergyStart: row.avg_energy_start,
    avgEnergyEnd: row.avg_energy_end,
    avgTasksCompleted: row.avg_tasks_completed,
    avgTasksSkipped: row.avg_tasks_skipped,
  };
}

// =====================================================================
// Learning: algorithm_weights, energy_patterns, context_effectiveness
// =====================================================================

export interface AlgorithmWeight {
  id: number;
  factorName: AlgorithmFactorName;
  weightPercentage: number;
  contextSpecificWeights: Record<string, number> | null;
  lastUpdated: string | null;
  confidenceLevel: number;
  dataPointsCount: number;
  createdAt: string | null;
}

export function algorithmWeightRowToDomain(row: AlgorithmWeightRow): AlgorithmWeight {
  return {
    id: row.id,
    factorName: row.factor_name,
    weightPercentage: row.weight_percentage,
    contextSpecificWeights: parseJsonObject<Record<string, number>>(row.context_specific_weights),
    lastUpdated: row.last_updated,
    confidenceLevel: row.confidence_level ?? 0,
    dataPointsCount: row.data_points_count ?? 0,
    createdAt: row.created_at,
  };
}

/** Fully partial - the learning repository's create() adds the factorName/weightPercentage-
 *  required constraint at its own boundary so this one mapper serves both create and update.
 *  In practice migration 001 seeds all four surviving rows already (a fifth, context_fit, was
 *  seeded through v2.4 and removed by migration 004); update() is the common path. */
export type AlgorithmWeightWriteInput = Partial<Omit<AlgorithmWeight, 'id' | 'createdAt'>>;

export function algorithmWeightDomainToRow(
  input: AlgorithmWeightWriteInput,
): Partial<AlgorithmWeightRow> {
  const row: Partial<AlgorithmWeightRow> = {};
  if (input.factorName !== undefined) row.factor_name = input.factorName;
  if (input.weightPercentage !== undefined) row.weight_percentage = input.weightPercentage;
  if (input.contextSpecificWeights !== undefined) {
    row.context_specific_weights =
      input.contextSpecificWeights == null ? null : JSON.stringify(input.contextSpecificWeights);
  }
  if (input.confidenceLevel !== undefined) row.confidence_level = input.confidenceLevel;
  if (input.dataPointsCount !== undefined) row.data_points_count = input.dataPointsCount;
  return row;
}

export interface EnergyPattern {
  id: number;
  patternType: PatternType;
  patternKey: string;
  averageEnergy: number | null;
  energyVariance: number | null;
  sampleCount: number;
  lastUpdated: string | null;
  confidenceScore: number;
  createdAt: string | null;
}

export function energyPatternRowToDomain(row: EnergyPatternRow): EnergyPattern {
  return {
    id: row.id,
    patternType: row.pattern_type,
    patternKey: row.pattern_key,
    averageEnergy: row.average_energy,
    energyVariance: row.energy_variance,
    sampleCount: row.sample_count ?? 0,
    lastUpdated: row.last_updated,
    confidenceScore: row.confidence_score ?? 0,
    createdAt: row.created_at,
  };
}

/** Fully partial - the learning repository's create() adds the patternType/patternKey-required
 *  constraint at its own boundary so this one mapper serves both create and update. */
export type EnergyPatternWriteInput = Partial<Omit<EnergyPattern, 'id' | 'createdAt'>>;

export function energyPatternDomainToRow(input: EnergyPatternWriteInput): Partial<EnergyPatternRow> {
  const row: Partial<EnergyPatternRow> = {};
  if (input.patternType !== undefined) row.pattern_type = input.patternType;
  if (input.patternKey !== undefined) row.pattern_key = input.patternKey;
  if (input.averageEnergy !== undefined) row.average_energy = input.averageEnergy;
  if (input.energyVariance !== undefined) row.energy_variance = input.energyVariance;
  if (input.sampleCount !== undefined) row.sample_count = input.sampleCount;
  if (input.confidenceScore !== undefined) row.confidence_score = input.confidenceScore;
  return row;
}

export interface ContextEffectiveness {
  id: number;
  contextName: string;
  taskType: string | null;
  completionRate: number | null;
  averageDurationAccuracy: number | null;
  userSatisfactionAvg: number | null;
  sampleCount: number;
  lastUpdated: string | null;
  effectivenessScore: number;
  confidenceLevel: number;
  createdAt: string | null;
}

export function contextEffectivenessRowToDomain(row: ContextEffectivenessRow): ContextEffectiveness {
  return {
    id: row.id,
    contextName: row.context_name,
    taskType: row.task_type,
    completionRate: row.completion_rate,
    averageDurationAccuracy: row.average_duration_accuracy,
    userSatisfactionAvg: row.user_satisfaction_avg,
    sampleCount: row.sample_count ?? 0,
    lastUpdated: row.last_updated,
    effectivenessScore: row.effectiveness_score ?? 0,
    confidenceLevel: row.confidence_level ?? 0,
    createdAt: row.created_at,
  };
}

/** Fully partial - the learning repository's create() adds the contextName-required
 *  constraint at its own boundary so this one mapper serves both create and update. */
export type ContextEffectivenessWriteInput = Partial<Omit<ContextEffectiveness, 'id' | 'createdAt'>>;

export function contextEffectivenessDomainToRow(
  input: ContextEffectivenessWriteInput,
): Partial<ContextEffectivenessRow> {
  const row: Partial<ContextEffectivenessRow> = {};
  if (input.contextName !== undefined) row.context_name = input.contextName;
  if (input.taskType !== undefined) row.task_type = input.taskType;
  if (input.completionRate !== undefined) row.completion_rate = input.completionRate;
  if (input.averageDurationAccuracy !== undefined) {
    row.average_duration_accuracy = input.averageDurationAccuracy;
  }
  if (input.userSatisfactionAvg !== undefined) row.user_satisfaction_avg = input.userSatisfactionAvg;
  if (input.sampleCount !== undefined) row.sample_count = input.sampleCount;
  if (input.effectivenessScore !== undefined) row.effectiveness_score = input.effectivenessScore;
  if (input.confidenceLevel !== undefined) row.confidence_level = input.confidenceLevel;
  return row;
}

// =====================================================================
// Skills
// =====================================================================

export interface Skill {
  id: number;
  instruction: string;
  scope: SkillScope;
  schemaVersion: string | null;
  confidence: number;
  isActive: boolean;
  timesFired: number;
  timesCorroborated: number;
  timesContradicted: number;
  createdAt: string | null;
  lastUpdated: string | null;
  lastFiredAt: string | null;
}

export function skillRowToDomain(row: SkillRow): Skill {
  return {
    id: row.id,
    instruction: row.instruction,
    scope: row.scope ?? 'both',
    schemaVersion: row.schema_version,
    confidence: row.confidence ?? 0,
    isActive: boolFromRow(row.is_active, false), // mirrors the DB default (born inactive; migration 002)
    timesFired: row.times_fired ?? 0,
    timesCorroborated: row.times_corroborated ?? 0,
    timesContradicted: row.times_contradicted ?? 0,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    lastFiredAt: row.last_fired_at,
  };
}

/** Fully partial - the skills repository's create() adds the instruction-required constraint
 *  at its own boundary so this one mapper serves both create and update. */
export type SkillWriteInput = Partial<Omit<Skill, 'id' | 'createdAt' | 'lastUpdated'>>;

export function skillDomainToRow(input: SkillWriteInput): Partial<SkillRow> {
  const row: Partial<SkillRow> = {};
  if (input.instruction !== undefined) row.instruction = input.instruction;
  if (input.scope !== undefined) row.scope = input.scope;
  if (input.schemaVersion !== undefined) row.schema_version = input.schemaVersion;
  if (input.confidence !== undefined) row.confidence = input.confidence;
  if (input.isActive !== undefined) row.is_active = boolToRow(input.isActive);
  if (input.timesFired !== undefined) row.times_fired = input.timesFired;
  if (input.timesCorroborated !== undefined) row.times_corroborated = input.timesCorroborated;
  if (input.timesContradicted !== undefined) row.times_contradicted = input.timesContradicted;
  if (input.lastFiredAt !== undefined) row.last_fired_at = input.lastFiredAt;
  return row;
}

export interface SkillCondition {
  id: number;
  skillId: number;
  conditionKey: string;
  conditionOp: ConditionOp;
  conditionValue: string;
}

export function skillConditionRowToDomain(row: SkillConditionRow): SkillCondition {
  return {
    id: row.id,
    skillId: row.skill_id,
    conditionKey: row.condition_key,
    conditionOp: row.condition_op ?? 'eq',
    conditionValue: row.condition_value,
  };
}

export interface SkillEvidence {
  id: number;
  skillId: number;
  interactionId: number | null;
  evidenceType: EvidenceType;
  createdAt: string | null;
  /** Optional provenance: 'distiller' (Channel A, friction re-derivation) vs 'outcome'
   *  (Channel B, fired-skill result) - audit-only, the confidence math weighs both equally
   *  (task 18 design §3.1, migration 002). */
  source: SkillEvidenceSource | null;
}

export function skillEvidenceRowToDomain(row: SkillEvidenceRow): SkillEvidence {
  return {
    id: row.id,
    skillId: row.skill_id,
    interactionId: row.interaction_id,
    evidenceType: row.evidence_type,
    createdAt: row.created_at,
    source: row.source,
  };
}

/** From the fireable_skills view: active skills with their conditions parsed out of the view's
 *  GROUP_CONCAT(condition_key || condition_op || condition_value) column. Note the view's
 *  concatenation is lossy - if a condition_value itself contains an 'eq'/'neq'/'in'/'gte'/'lte'
 *  substring adjacent to the key, splitting can't perfectly disambiguate. This is a schema view
 *  characteristic (constraint #8: don't alter it), so conditions are exposed as the raw joined
 *  strings here; use skillsRepository.listConditions() for an unambiguous read. */
export interface FireableSkill extends Skill {
  conditions: string[];
}

export function fireableSkillRowToDomain(row: FireableSkillsRow): FireableSkill {
  return {
    ...skillRowToDomain(row),
    conditions: row.conditions == null || row.conditions === '' ? [] : row.conditions.split(','),
  };
}

// =====================================================================
// Coaching
// =====================================================================

export interface CoachingQueueEntry {
  id: number;
  triggerType: CoachingTrigger;
  urgency: CoachingUrgency;
  triggerData: Record<string, unknown> | null;
  status: CoachingQueueStatus;
  createdAt: string | null;
}

export function coachingQueueRowToDomain(row: CoachingQueueRow): CoachingQueueEntry {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    urgency: row.urgency ?? 'next_start',
    triggerData: parseJsonObject<Record<string, unknown>>(row.trigger_data),
    status: row.status ?? 'pending',
    createdAt: row.created_at,
  };
}

/** Fully partial - the coaching repository's create() adds the triggerType-required
 *  constraint at its own boundary so this one mapper serves both create and update. */
export type CoachingQueueWriteInput = Partial<Omit<CoachingQueueEntry, 'id' | 'createdAt'>>;

export function coachingQueueDomainToRow(input: CoachingQueueWriteInput): Partial<CoachingQueueRow> {
  const row: Partial<CoachingQueueRow> = {};
  if (input.triggerType !== undefined) row.trigger_type = input.triggerType;
  if (input.urgency !== undefined) row.urgency = input.urgency;
  if (input.triggerData !== undefined) {
    row.trigger_data = input.triggerData == null ? null : JSON.stringify(input.triggerData);
  }
  if (input.status !== undefined) row.status = input.status;
  return row;
}

export interface CoachingTaskLink {
  id: number;
  coachingId: number;
  taskId: number;
}

export function coachingTaskRowToDomain(row: CoachingTaskRow): CoachingTaskLink {
  return { id: row.id, coachingId: row.coaching_id, taskId: row.task_id };
}

export interface CoachingSessionLink {
  id: number;
  coachingId: number;
  sessionId: string;
}

export function coachingSessionRowToDomain(row: CoachingSessionRow): CoachingSessionLink {
  return { id: row.id, coachingId: row.coaching_id, sessionId: row.session_id };
}

export interface CoachingExternalDependencyLink {
  id: number;
  coachingId: number;
  externalDependencyId: number;
}

export function coachingExternalDependencyRowToDomain(
  row: CoachingExternalDependencyRow,
): CoachingExternalDependencyLink {
  return {
    id: row.id,
    coachingId: row.coaching_id,
    externalDependencyId: row.external_dependency_id,
  };
}

/** From the coaching_priority_queue view: pending entries with their linked task/session/
 *  external-dependency ids, ordered urgency-first then oldest-first (the view's own ORDER BY). */
export interface CoachingPriorityQueueEntry extends CoachingQueueEntry {
  relatedTaskIds: number[];
  relatedSessionIds: string[];
  relatedExternalDependencyIds: number[];
}

function parseGroupConcatIds(value: string | null): number[] {
  if (value == null || value === '') return [];
  return value.split(',').map(Number);
}

function parseGroupConcatStrings(value: string | null): string[] {
  if (value == null || value === '') return [];
  return value.split(',');
}

export function coachingPriorityQueueRowToDomain(
  row: CoachingPriorityQueueRow,
): CoachingPriorityQueueEntry {
  return {
    ...coachingQueueRowToDomain(row),
    relatedTaskIds: parseGroupConcatIds(row.related_task_ids),
    relatedSessionIds: parseGroupConcatStrings(row.related_session_ids),
    relatedExternalDependencyIds: parseGroupConcatIds(row.related_external_dependency_ids),
  };
}

// =====================================================================
// Interaction junction tables
// =====================================================================

export interface InteractionTaskLink {
  id: number;
  interactionId: number;
  taskId: number;
}

export function interactionTaskRowToDomain(row: InteractionTaskRow): InteractionTaskLink {
  return { id: row.id, interactionId: row.interaction_id, taskId: row.task_id };
}

export interface InteractionExternalDependencyLink {
  id: number;
  interactionId: number;
  externalDependencyId: number;
}

export function interactionExternalDependencyRowToDomain(
  row: InteractionExternalDependencyRow,
): InteractionExternalDependencyLink {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    externalDependencyId: row.external_dependency_id,
  };
}

// =====================================================================
// Metadata / backups / retention
// =====================================================================

export interface BackupLogEntry {
  id: number;
  backupType: BackupType;
  backupPath: string | null;
  backupSizeBytes: number | null;
  createdAt: string | null;
  restoredAt: string | null;
  success: boolean;
  errorMessage: string | null;
}

export function backupLogRowToDomain(row: BackupLogRow): BackupLogEntry {
  return {
    id: row.id,
    backupType: row.backup_type,
    backupPath: row.backup_path,
    backupSizeBytes: row.backup_size_bytes,
    createdAt: row.created_at,
    restoredAt: row.restored_at,
    success: boolFromRow(row.success, true),
    errorMessage: row.error_message,
  };
}

export interface DataRetentionEntry {
  tableName: string;
  retentionPolicy: RetentionPolicy;
  lastCleanupAt: string | null;
  recordsCleaned: number;
}

export function dataRetentionRowToDomain(row: DataRetentionRow): DataRetentionEntry {
  return {
    tableName: row.table_name,
    retentionPolicy: row.retention_policy,
    lastCleanupAt: row.last_cleanup_at,
    recordsCleaned: row.records_cleaned ?? 0,
  };
}
