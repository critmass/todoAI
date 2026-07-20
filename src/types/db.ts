// Raw types for src/db/migrations/001_initial_schema.sql (schema v2.2).
// Row interfaces mirror table columns exactly: snake_case, nullability follows the DDL's
// NOT NULL/PRIMARY KEY constraints (not its DEFAULTs — SQLite still allows an explicit NULL
// on a column that merely has a DEFAULT), JSON columns typed as the raw TEXT the driver returns.
// This is what op-sqlite hands back before any parsing; see domain.ts for the parsed shape.

// =====================================================================
// Enums (one per CHECK (... IN (...)) column)
// =====================================================================

export type TaskStatus = 'active' | 'completed' | 'archived' | 'deleted';
export type DurationSource = 'user' | 'model_guess';
/** Whether `estimated_duration` is a best-guess estimate or a FLOOR ("at least an hour") for
 *  open-ended work (task 28 §3.1, migration 003). A 'floor' task counts UP and has no overrun. */
export type DurationType = 'estimate' | 'floor';
/** Whether a task has an open, partially-worked stretch toward its current completion (task 28
 *  §1, migration 003). Orthogonal to `status` — a parked task stays `status='active'`. */
export type WorkState = 'none' | 'in_progress';
export type RecurrenceType =
  | 'scheduled_quota'
  | 'quota'
  | 'scheduled'
  | 'unscheduled'
  | 'count';
export type ExternalDependencyStatus = 'waiting' | 'overdue' | 'resolved' | 'cancelled';
export type InteractionType =
  | 'work_session'
  | 'coaching_conversation'
  | 'task_input'
  | 'energy_checkin'
  | 'pattern_recognition'
  | 'task_completion'
  | 'task_skip'
  | 'task_progress'; // task 28 §1.1: the park episode's interaction row (migration 003)
export type CompletionStatus = 'completed' | 'skipped' | 'ended_early' | 'abandoned' | 'progress'; // 'progress' = parked (task 28, migration 003)
export type SessionType = 'quick' | 'moderate' | 'deep_focus';
export type SessionStatus = 'completed' | 'abandoned';
export type ModelTier = '8B' | '4B' | '1.7B';
// context_fit removed by migration 004 (v2.5): R3 dropped it from the weighted sum in favor of
// a hard pre-filter (src/scoring/filter.ts), and the table CHECK no longer accepts it either.
export type AlgorithmFactorName = 'importance' | 'urgency' | 'energy_match' | 'historical_success';
export type PatternType = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type SkillScope = 'coaching' | 'planning' | 'both';
export type ConditionOp = 'eq' | 'neq' | 'in' | 'gte' | 'lte';
export type EvidenceType = 'origin' | 'corroboration' | 'contradiction';
export type CoachingTrigger =
  | 'task_skipped'
  | 'session_recalibration'
  | 'app_reorientation'
  | 'session_ended_early'
  | 'task_ended_early'
  | 'repeated_failures'
  | 'pattern_detected'
  | 'buried_task' // R4: buried out-of-context/tool task trigger (migration 002)
  | 'breakdown_complete'; // R7: parent-confirmation trigger, fires with urgency='immediate' (migration 002)
export type SkillEvidenceSource = 'distiller' | 'outcome';
export type CoachingUrgency = 'immediate' | 'next_start' | 'next_open';
export type CoachingQueueStatus = 'pending' | 'resolved';
export type BackupType = 'automatic' | 'manual' | 'pre_session';
export type RetentionPolicy = 'detailed_30_days' | 'summary_90_days' | 'permanent';

/** SQLite has no boolean type; BOOLEAN columns are stored/returned as 0 | 1. */
export type SqliteBoolean = 0 | 1;

// =====================================================================
// Raw row types (one per table)
// =====================================================================

export interface SchemaMetadataRow {
  key: string;
  value: string;
  updated_at: string | null;
}

export interface BackupLogRow {
  id: number;
  backup_type: BackupType;
  backup_path: string | null;
  backup_size_bytes: number | null;
  created_at: string | null;
  restored_at: string | null;
  success: SqliteBoolean | null;
  error_message: string | null;
}

export interface DataRetentionRow {
  table_name: string;
  retention_policy: RetentionPolicy;
  last_cleanup_at: string | null;
  records_cleaned: number | null;
}

export interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  importance: number | null;
  urgency_level: number | null;
  next_due_at: string | null;
  estimated_duration: number;
  duration_source: DurationSource | null;
  actual_duration_history: string | null;
  average_actual_duration: number | null;
  energy_requirement: number | null;
  average_energy_cost: number | null;
  context_tags: string | null;
  tool_requirements: string | null;
  status: TaskStatus | null;
  parent_task_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  completion_count: number | null;
  skip_count: number | null;
  skip_reasons: string | null;
  last_completed_at: string | null;
  success_rate: number | null;
  // Task 28 / migration 003 (all NOT NULL DEFAULT except last_worked_at, which is nullable).
  duration_type: DurationType | null;
  work_state: WorkState | null;
  accumulated_minutes: number | null;
  last_worked_at: string | null;
}

export interface TaskRecurrenceRow {
  id: number;
  task_id: number;
  recurrence_type: RecurrenceType;
  recurrence_pattern: string;
  target_count: number | null;
  current_period_progress: number | null;
  reset_date: string | null;
  is_currently_active: SqliteBoolean | null;
  created_at: string | null;
}

export interface TaskUpdateRow {
  id: number;
  task_id: number;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  updated_at: string | null;
  update_source: string | null;
}

export interface TaskDependencyRow {
  id: number;
  task_id: number;
  depends_on_task_id: number;
  created_at: string | null;
}

export interface DependencyCheckCacheRow {
  task_id: number;
  depends_on_task_id: number;
  dependency_path: string | null;
  is_circular: SqliteBoolean | null;
  last_checked: string | null;
}

export interface ExternalDependencyRow {
  id: number;
  title: string;
  description: string | null;
  expected_completion_date: string | null;
  external_party: string | null;
  follow_up_actions: string | null;
  status: ExternalDependencyStatus | null;
  last_follow_up_date: string | null;
  resolution_notes: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

export interface TaskExternalDependencyRow {
  id: number;
  task_id: number;
  external_dependency_id: number;
  created_at: string | null;
}

export interface InteractionRow {
  id: number;
  timestamp: string | null;
  interaction_type: InteractionType;
  session_id: string | null;
  user_energy_level_start: number | null;
  user_energy_level_end: number | null;
  conclusions: string | null;
  learning_data: string | null;
  conversation_summary: string | null;
  summary_schema_version: string | null;
  duration_minutes: number | null;
  completion_status: CompletionStatus | null;
  context_used: string | null;
  user_feedback_rating: number | null;
  notes: string | null;
}

export interface SessionRow {
  id: string;
  session_type: SessionType;
  planned_duration: number;
  actual_duration: number | null;
  user_energy_start: number | null;
  user_energy_end: number | null;
  status: SessionStatus;
  tasks_completed: number | null;
  tasks_skipped: number | null;
  tasks_progressed: number | null; // task 28 / migration 003: parked tasks count here
  escape_valve_used: SqliteBoolean | null;
  extended: SqliteBoolean | null;
  model_tier: ModelTier | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface AlgorithmWeightRow {
  id: number;
  factor_name: AlgorithmFactorName;
  weight_percentage: number;
  context_specific_weights: string | null;
  last_updated: string | null;
  confidence_level: number | null;
  data_points_count: number | null;
  created_at: string | null;
}

export interface EnergyPatternRow {
  id: number;
  pattern_type: PatternType;
  pattern_key: string;
  average_energy: number | null;
  energy_variance: number | null;
  sample_count: number | null;
  last_updated: string | null;
  confidence_score: number | null;
  created_at: string | null;
}

export interface ContextEffectivenessRow {
  id: number;
  context_name: string;
  task_type: string | null;
  completion_rate: number | null;
  average_duration_accuracy: number | null;
  user_satisfaction_avg: number | null;
  sample_count: number | null;
  last_updated: string | null;
  effectiveness_score: number | null;
  confidence_level: number | null;
  created_at: string | null;
}

export interface SkillRow {
  id: number;
  instruction: string;
  scope: SkillScope | null;
  schema_version: string | null;
  confidence: number | null;
  is_active: SqliteBoolean | null;
  times_fired: number | null;
  times_corroborated: number | null;
  times_contradicted: number | null;
  created_at: string | null;
  last_updated: string | null;
  last_fired_at: string | null;
}

export interface SkillConditionRow {
  id: number;
  skill_id: number;
  condition_key: string;
  condition_op: ConditionOp | null;
  condition_value: string;
}

export interface SkillEvidenceRow {
  id: number;
  skill_id: number;
  interaction_id: number | null;
  evidence_type: EvidenceType;
  created_at: string | null;
  source: SkillEvidenceSource | null;
}

/** Key/value store for the skill layer's distillation watermarks and runtime-tunable
 *  parameters (migration 002) - task 19 is the consumer; no domain mapper or repository exists
 *  yet, matching this file's existing precedent of declaring a row type per table ahead of the
 *  repo that will use it (e.g. BackupLogRow, DataRetentionRow above). */
export interface LearningStateRow {
  key: string;
  value: string;
  updated_at: string | null;
}

export interface CoachingQueueRow {
  id: number;
  trigger_type: CoachingTrigger;
  urgency: CoachingUrgency | null;
  trigger_data: string | null;
  status: CoachingQueueStatus | null;
  created_at: string | null;
}

export interface CoachingTaskRow {
  id: number;
  coaching_id: number;
  task_id: number;
}

export interface CoachingSessionRow {
  id: number;
  coaching_id: number;
  session_id: string;
}

export interface CoachingExternalDependencyRow {
  id: number;
  coaching_id: number;
  external_dependency_id: number;
}

export interface InteractionTaskRow {
  id: number;
  interaction_id: number;
  task_id: number;
}

export interface InteractionExternalDependencyRow {
  id: number;
  interaction_id: number;
  external_dependency_id: number;
}

// =====================================================================
// View row types (only for views the repositories actually read)
// =====================================================================

/**
 * There is no row type here for active_tasks_with_neglect: migration 004 (v2.5) dropped that
 * view outright (it computed the retired weeks^2 curve via POWER(), which op-sqlite's Android
 * build does not compile in, and had been dead code since task 10's linear curve landed). See
 * repositories/tasks.ts's TaskWithNeglect doc comment — weeksNeglected/neglectMultiplier are
 * computed in TypeScript instead, and always were even before the view was removed.
 */
export interface CoachingPriorityQueueRow extends CoachingQueueRow {
  related_task_ids: string | null;
  related_session_ids: string | null;
  related_external_dependency_ids: string | null;
}

export interface FireableSkillsRow extends SkillRow {
  conditions: string | null;
}

export interface RecentSessionPerformanceRow {
  session_type: SessionType;
  session_count: number;
  avg_duration: number | null;
  completion_rate: number | null;
  avg_energy_start: number | null;
  avg_energy_end: number | null;
  avg_tasks_completed: number | null;
  avg_tasks_skipped: number | null;
}
