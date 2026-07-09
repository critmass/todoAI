// Domain entities: camelCase, JSON columns parsed into real types. Internal importance (1-1000)
// and energy (1-5) values are carried through unconverted — see scales.ts for the user-facing
// projection; that conversion happens at the input/display boundary, not here.
import type {
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
  EnergyPatternRow,
  EvidenceType,
  ExternalDependencyRow,
  ExternalDependencyStatus,
  InteractionExternalDependencyRow,
  InteractionRow,
  InteractionTaskRow,
  InteractionType,
  ModelTier,
  PatternType,
  RecentSessionPerformanceRow,
  RetentionPolicy,
  SessionRow,
  SessionStatus,
  SessionType,
  SkillConditionRow,
  SkillEvidenceRow,
  SkillRow,
  SkillScope,
  SqliteBoolean,
  TaskDependencyRow,
  TaskExternalDependencyRow,
  TaskRecurrenceRow,
  TaskRow,
  TaskStatus,
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

export type Recurrence =
  | { type: 'scheduled_quota'; quota: number; period: Period; scheduledDays: Weekday[] }
  | { type: 'quota'; quota: number; period: Period }
  | { type: 'scheduled'; scheduledDays: Weekday[] }
  | { type: 'unscheduled' } // reopens on completion; neglect-only; never a fake period/quota
  | { type: 'count'; target: number; progress: number }; // done only when progress reaches target

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
  resetDate: string | null;
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
    case 'scheduled':
      return { type, scheduledDays: (pattern.scheduledDays as Weekday[]) ?? [] };
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
      return { scheduledDays: recurrence.scheduledDays };
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
  escapeValveUsed: boolean;
  extended: boolean;
  modelTier: ModelTier | null;
  startedAt: string | null;
  completedAt: string | null;
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
    escapeValveUsed: boolFromRow(row.escape_valve_used, false),
    extended: boolFromRow(row.extended, false),
    modelTier: row.model_tier,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Fully partial and excludes id - sessions.id is caller-supplied (not autoincrement) but is
 *  always passed as its own parameter to create()/update(), never inside the patch body, so
 *  this one mapper serves both. The sessions repository's create() adds the
 *  sessionType/plannedDuration/status-required constraint at its own boundary. */
export type SessionWriteInput = Partial<Omit<Session, 'id' | 'startedAt' | 'completedAt'>>;

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
  if (input.escapeValveUsed !== undefined) row.escape_valve_used = boolToRow(input.escapeValveUsed);
  if (input.extended !== undefined) row.extended = boolToRow(input.extended);
  if (input.modelTier !== undefined) row.model_tier = input.modelTier;
  return row;
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
    isActive: boolFromRow(row.is_active, true),
    timesFired: row.times_fired ?? 0,
    timesCorroborated: row.times_corroborated ?? 0,
    timesContradicted: row.times_contradicted ?? 0,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    lastFiredAt: row.last_fired_at,
  };
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
}

export function skillEvidenceRowToDomain(row: SkillEvidenceRow): SkillEvidence {
  return {
    id: row.id,
    skillId: row.skill_id,
    interactionId: row.interaction_id,
    evidenceType: row.evidence_type,
    createdAt: row.created_at,
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
