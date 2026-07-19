-- ADHD Task Management App - SQLite Database Schema v2.3
-- Offline-first, local storage. Regenerated to match Specification v2.3.
-- Hand-maintained snapshot (not generated from src/db/migrations/) -- confirmed during the
-- task 27 spec fold-in; kept in sync by hand at each fold-in pass.
--
-- Changes from v2.2 (schema_metadata version 2.2.0 -> 2.3.0, applied by migration 002,
-- src/db/migrations/002_skill_layer_schema.sql -- the six skill-layer schema gaps from the
-- task 18 design, docs/eval/task18_design_report.md SS2):
--   1. New table learning_state (key, value, updated_at): watermarks + tunables for the
--      skill-injection distiller (task 19 owns the access pattern; no repository yet).
--   2. skills.is_active default flips TRUE -> FALSE (born-inactive defense-in-depth). Existing
--      rows keep their actual stored value; only the default for future inserts changes.
--   3. skill_evidence.source: optional nullable ('distiller' | 'outcome') provenance column.
--   4. coaching_queue.trigger_type CHECK gains 'buried_task' (R4) and 'breakdown_complete' (R7)
--      -- spec SS7.2's fourth and fifth coaching-trigger rows.
--   5. learning_data JSON gains a documented internal "v":1 convention (mirrors
--      summary_schema_version) -- a code-level convention, not a schema change; no .sql effect.
--   6. fireable_skills documented as an INDEX ONLY -- its GROUP_CONCAT'd conditions are lossy;
--      real condition matching reads skill_conditions via skillsRepository.listConditions().
--
-- NOT yet included: migration 003 (task 28's multi-session/hyperfocus columns -- tasks.duration_type
-- / work_state / accumulated_minutes / last_worked_at, sessions.tasks_progressed, and the
-- interactions 'task_progress'/'progress' enum values). Migration 003 is pending from task 33 as of
-- this snapshot; spec SS4.1/SS8.2 describe the design task 28 delivered, which this schema does not
-- yet implement. Update this file again when 003 lands.
--
-- STALE, NOT FIXED HERE: algorithm_weights' seed data (below) still lists 'context_fit' as a
-- factor_name option, seeded at the retired 25/20/20/15/20 split. No migration has ever touched
-- this table, so this snapshot mirrors real applied schema state, not the R3-revised 31/23/23/23
-- weights that src/scoring/factors.ts actually uses. Flagged in docs/eval/task27_findings_report.md.
--
-- Carried forward from v2.2: tasks.duration_source, task_recurrence.recurrence_type (five types)
-- + target_count, the uncapped neglect view, corrected schema_metadata strings, parent_task_id,
-- summary_schema_version, skill tables, neglect excluded from summed algorithm_weights,
-- importance 1-1000 / energy 1-5.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- Metadata, backups, retention
-- =====================================================================

CREATE TABLE schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE backup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_type TEXT CHECK (backup_type IN ('automatic', 'manual', 'pre_session')) NOT NULL,
    backup_path TEXT,
    backup_size_bytes INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    restored_at DATETIME,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT
);

CREATE TABLE data_retention (
    table_name TEXT PRIMARY KEY,
    retention_policy TEXT CHECK (retention_policy IN ('detailed_30_days', 'summary_90_days', 'permanent')) NOT NULL,
    last_cleanup_at DATETIME,
    records_cleaned INTEGER DEFAULT 0
);

-- =====================================================================
-- Tasks
-- =====================================================================
-- importance: INTERNAL 1-1000 (user 1-10 -> 100..1000; 1-99 band orders subtasks ONLY when
--   ordering matters; unordered siblings SHARE a value; spec 4.1).
-- energy_requirement: INTERNAL 1-5 (user low/med/high -> 1/3/5; 2 and 4 for behavioral discount).
-- estimated_duration: NOT NULL; coach guesses when the user doesn't supply one.
-- duration_source: whether estimated_duration came from the user or a model guess (spec 4.1/5.4).
-- urgency_level: optional BASE sensitivity only; effective urgency DERIVED from next_due_at.
-- NOTE: task 28's duration_type / work_state / accumulated_minutes / last_worked_at columns
--   (spec 4.1/8.7) are migration 003, PENDING -- not present in this table yet.

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    importance INTEGER CHECK (importance >= 1 AND importance <= 1000),
    urgency_level INTEGER DEFAULT 3 CHECK (urgency_level >= 1 AND urgency_level <= 5),
    next_due_at DATETIME,
    estimated_duration INTEGER NOT NULL, -- minutes; coach guesses if unspecified
    duration_source TEXT CHECK (duration_source IN ('user', 'model_guess')) DEFAULT 'model_guess',
    actual_duration_history TEXT CHECK (json_valid(actual_duration_history)), -- JSON array; one entry per completion (spec 5.4/8.7)
    average_actual_duration REAL,
    energy_requirement INTEGER DEFAULT 3 CHECK (energy_requirement >= 1 AND energy_requirement <= 5),
    average_energy_cost REAL DEFAULT 0.0 CHECK (average_energy_cost >= -4.0 AND average_energy_cost <= 4.0),
    context_tags TEXT CHECK (json_valid(context_tags)),
    tool_requirements TEXT CHECK (json_valid(tool_requirements)),
    status TEXT CHECK (status IN ('active', 'completed', 'archived', 'deleted')) DEFAULT 'active',
    parent_task_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completion_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    skip_reasons TEXT CHECK (json_valid(skip_reasons)),
    last_completed_at DATETIME,
    success_rate REAL DEFAULT 0.0 CHECK (success_rate >= 0.0 AND success_rate <= 1.0),
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Recurrence. NULL (no row) = true one-off. Five explicit types via recurrence_type (spec 4.2).
--   scheduled_quota / quota / scheduled : period-based; reset each period.
--   unscheduled : reopens on completion; resurfaces via neglect only; reset_date NULL; never period-resets.
--   count       : increments toward target_count; task flips to done only at target; reset_date NULL.
-- current_period_progress: running counter -> quota progress for period types; running total for 'count'.
CREATE TABLE task_recurrence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE,
    recurrence_type TEXT NOT NULL CHECK (recurrence_type IN (
        'scheduled_quota',
        'quota',
        'scheduled',
        'unscheduled',
        'count'
    )),
    recurrence_pattern TEXT NOT NULL CHECK (json_valid(recurrence_pattern)), -- full detail (days, quota, period, target)
    target_count INTEGER, -- set only when recurrence_type='count'; NULL otherwise
    current_period_progress INTEGER DEFAULT 0, -- quota progress (period types) or running total ('count')
    reset_date DATETIME, -- NULL for 'unscheduled' and 'count'
    is_currently_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CHECK ( (recurrence_type = 'count') = (target_count IS NOT NULL) ) -- target_count iff type is 'count'
);

CREATE TABLE task_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_source TEXT, -- 'user', 'system', 'algorithm_learning', 'skill_distillation', etc.
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- A parent task's dependency on each of its own subtasks (spec 4.1, R7) is stored as ordinary
-- rows here -- parent depends_on subtask -- no separate concept; parent_task_id above is a
-- column, not an edge, so this creates no cycle.
CREATE TABLE task_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    depends_on_task_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Note: a dependency on a 'count' task means "depends on N completions" for free,
    -- because a count task does not report done until target_count is reached (spec 4.2).
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(task_id, depends_on_task_id)
);

CREATE TABLE dependency_check_cache (
    task_id INTEGER NOT NULL,
    depends_on_task_id INTEGER NOT NULL,
    dependency_path TEXT,
    is_circular BOOLEAN DEFAULT FALSE,
    last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE external_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    expected_completion_date DATETIME,
    external_party TEXT,
    follow_up_actions TEXT,
    status TEXT CHECK (status IN ('waiting', 'overdue', 'resolved', 'cancelled')) DEFAULT 'waiting',
    last_follow_up_date DATETIME,
    resolution_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

CREATE TABLE task_external_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    external_dependency_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (external_dependency_id) REFERENCES external_dependencies(id) ON DELETE CASCADE,
    UNIQUE(task_id, external_dependency_id)
);

-- =====================================================================
-- Interactions
-- =====================================================================
-- NOTE: task 28's 'task_progress' interaction_type / 'progress' completion_status values
--   (spec 8.2/8.7) are migration 003, PENDING -- not present in this CHECK yet.

CREATE TABLE interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    interaction_type TEXT NOT NULL CHECK (interaction_type IN (
        'work_session',
        'coaching_conversation',
        'task_input',
        'energy_checkin',
        'pattern_recognition',
        'task_completion',
        'task_skip'
    )),
    session_id TEXT,
    user_energy_level_start INTEGER CHECK (user_energy_level_start >= 1 AND user_energy_level_start <= 5),
    user_energy_level_end INTEGER CHECK (user_energy_level_end >= 1 AND user_energy_level_end <= 5),
    conclusions TEXT CHECK (json_valid(conclusions)),
    learning_data TEXT CHECK (json_valid(learning_data)), -- {snapshot, skillsFired} shape carries an internal "v":1 (see src/types/domain.ts)
    conversation_summary TEXT, -- AI-generated, grammar-constrained; raw transcript never stored
    summary_schema_version TEXT,
    duration_minutes INTEGER,
    completion_status TEXT CHECK (completion_status IN ('completed', 'skipped', 'ended_early', 'abandoned')),
    context_used TEXT CHECK (json_valid(context_used)),
    user_feedback_rating INTEGER CHECK (user_feedback_rating >= 1 AND user_feedback_rating <= 5),
    notes TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- =====================================================================
-- Sessions
-- =====================================================================
-- NOTE: task 28's tasks_progressed column (spec 8.7) is migration 003, PENDING.

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    session_type TEXT CHECK (session_type IN ('quick', 'moderate', 'deep_focus')) NOT NULL,
    planned_duration INTEGER NOT NULL,
    actual_duration INTEGER,
    user_energy_start INTEGER CHECK (user_energy_start >= 1 AND user_energy_start <= 5),
    user_energy_end INTEGER CHECK (user_energy_end >= 1 AND user_energy_end <= 5),
    status TEXT CHECK (status IN ('completed', 'abandoned')) NOT NULL,
    tasks_completed INTEGER DEFAULT 0,
    tasks_skipped INTEGER DEFAULT 0,
    escape_valve_used BOOLEAN DEFAULT FALSE,
    extended BOOLEAN DEFAULT FALSE, -- session ran past planned length via 'extend' (spec 8.7, resolved)
    model_tier TEXT CHECK (model_tier IN ('8B', '4B', '1.7B')), -- tier locked for this session (spec 3.1)
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- =====================================================================
-- Algorithm weights (numeric learning)
-- =====================================================================
-- neglect_factor intentionally NOT a member of this set (uncapped post-sum multiplier; spec 5.1-5.2).
-- STALE (see header note): seed data below still reflects the pre-R3 25/20/20/15/20 + context_fit
-- split. src/scoring/factors.ts's actual FACTOR_WEIGHTS is 31/23/23/23 with context_fit removed
-- (spec 5.1). No migration has updated this table; left as-is to mirror real applied schema state.

CREATE TABLE algorithm_weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    factor_name TEXT NOT NULL UNIQUE CHECK (factor_name IN (
        'importance',
        'urgency',
        'energy_match',
        'context_fit',
        'historical_success'
    )),
    weight_percentage REAL NOT NULL CHECK (weight_percentage >= 0 AND weight_percentage <= 100),
    context_specific_weights TEXT CHECK (json_valid(context_specific_weights)),
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence_level REAL DEFAULT 0.0 CHECK (confidence_level >= 0.0 AND confidence_level <= 1.0),
    data_points_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE energy_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_type TEXT CHECK (pattern_type IN ('hourly', 'daily', 'weekly', 'monthly')) NOT NULL,
    pattern_key TEXT NOT NULL,
    average_energy REAL CHECK (average_energy >= 1.0 AND average_energy <= 5.0),
    energy_variance REAL,
    sample_count INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence_score REAL DEFAULT 0.0 CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pattern_type, pattern_key)
);

CREATE TABLE context_effectiveness (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_name TEXT NOT NULL,
    task_type TEXT,
    completion_rate REAL CHECK (completion_rate >= 0.0 AND completion_rate <= 1.0),
    average_duration_accuracy REAL,
    user_satisfaction_avg REAL CHECK (user_satisfaction_avg >= 1.0 AND user_satisfaction_avg <= 5.0),
    sample_count INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    effectiveness_score REAL DEFAULT 0.0,
    confidence_level REAL DEFAULT 0.0 CHECK (confidence_level >= 0.0 AND confidence_level <= 1.0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(context_name, task_type)
);

-- =====================================================================
-- Behavioral learning: local skill-injection layer (spec 5.5)
-- =====================================================================

-- is_active DEFAULT FALSE (was TRUE in v2.2) -- born-inactive defense-in-depth (migration 002,
-- task 18 design SS2.1). Existing rows keep their actual stored value; only the default changes.
CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instruction TEXT NOT NULL,
    scope TEXT CHECK (scope IN ('coaching', 'planning', 'both')) DEFAULT 'both',
    schema_version TEXT,
    confidence REAL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    is_active BOOLEAN DEFAULT FALSE,
    times_fired INTEGER DEFAULT 0,
    times_corroborated INTEGER DEFAULT 0,
    times_contradicted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_fired_at DATETIME
);

CREATE TABLE skill_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    condition_key TEXT NOT NULL,
    condition_op TEXT CHECK (condition_op IN ('eq', 'neq', 'in', 'gte', 'lte')) DEFAULT 'eq',
    condition_value TEXT NOT NULL,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

-- source: optional provenance of the evidence row (migration 002) -- 'distiller' (synthesized by
-- idle-window distillation) vs 'outcome' (a fired skill's later corroboration/contradiction).
CREATE TABLE skill_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    interaction_id INTEGER,
    evidence_type TEXT CHECK (evidence_type IN ('origin', 'corroboration', 'contradiction')) NOT NULL,
    source TEXT CHECK (source IN ('distiller', 'outcome')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE SET NULL
);

-- learning_state (migration 002, new table): watermarks + tunables for the skill-injection
-- distiller (task 19 is the consumer; no repository/domain mapper exists yet -- deliberate,
-- see docs/eval/task26_findings_report.md SS4, so as not to design ahead of the only consumer).
CREATE TABLE learning_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- Coaching queue (five trigger tiers; spec 7.2)
-- =====================================================================
-- trigger_type CHECK gains 'buried_task' (R4) and 'breakdown_complete' (R7) in migration 002 --
-- spec 7.2's fourth and fifth coaching-trigger rows. urgency's CHECK already covered
-- immediate/next_start/next_open and needed no change.

CREATE TABLE coaching_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'task_skipped',
        'session_recalibration',
        'app_reorientation',
        'session_ended_early',
        'task_ended_early',
        'repeated_failures',
        'pattern_detected',
        'buried_task',
        'breakdown_complete'
    )),
    urgency TEXT CHECK (urgency IN ('immediate', 'next_start', 'next_open')) DEFAULT 'next_start',
    trigger_data TEXT CHECK (json_valid(trigger_data)),
    status TEXT CHECK (status IN ('pending', 'resolved')) DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE coaching_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coaching_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    FOREIGN KEY (coaching_id) REFERENCES coaching_queue(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(coaching_id, task_id)
);

CREATE TABLE coaching_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coaching_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    FOREIGN KEY (coaching_id) REFERENCES coaching_queue(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(coaching_id, session_id)
);

CREATE TABLE coaching_external_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coaching_id INTEGER NOT NULL,
    external_dependency_id INTEGER NOT NULL,
    FOREIGN KEY (coaching_id) REFERENCES coaching_queue(id) ON DELETE CASCADE,
    FOREIGN KEY (external_dependency_id) REFERENCES external_dependencies(id) ON DELETE CASCADE,
    UNIQUE(coaching_id, external_dependency_id)
);

-- =====================================================================
-- Interaction junction tables
-- =====================================================================

CREATE TABLE interaction_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(interaction_id, task_id)
);

CREATE TABLE interaction_external_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_id INTEGER NOT NULL,
    external_dependency_id INTEGER NOT NULL,
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE CASCADE,
    FOREIGN KEY (external_dependency_id) REFERENCES external_dependencies(id) ON DELETE CASCADE,
    UNIQUE(interaction_id, external_dependency_id)
);

-- =====================================================================
-- Triggers
-- =====================================================================
-- NOTE: the multi-hop (transitive) circular-dependency guard (task 10, R2) lives in application
-- code (src/db/repositories/dependencies.ts's add(), which walks the graph via BFS before every
-- insert) because a DB trigger only catches a direct two-node cycle -- see below. The trigger
-- stays as a direct-cycle backstop; it does not by itself guarantee acyclicity.

CREATE TRIGGER prevent_circular_dependencies
    BEFORE INSERT ON task_dependencies
    FOR EACH ROW
    WHEN EXISTS (
        SELECT 1 FROM task_dependencies td
        WHERE td.task_id = NEW.depends_on_task_id
        AND td.depends_on_task_id = NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'Circular dependency detected');
    END;

CREATE TRIGGER update_tasks_timestamp
    AFTER UPDATE ON tasks
    FOR EACH ROW
    BEGIN
        UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

-- =====================================================================
-- Seed data
-- =====================================================================

INSERT INTO algorithm_weights (factor_name, weight_percentage) VALUES
    ('importance', 25.0),
    ('urgency', 20.0),
    ('energy_match', 20.0),
    ('context_fit', 15.0),
    ('historical_success', 20.0);

INSERT INTO schema_metadata (key, value) VALUES
    ('version', '2.3.0'),
    ('created_at', datetime('now')),
    ('app_name', 'ADHD Task Management'),
    ('model_family', 'Ternary Bonsai (4B default/validated; 8B/1.7B contingent)'),
    ('model_format', 'TQ1_0 (mainline-compatible repack) / Q2_0 (native, PrismML fork)'),
    ('last_migration', 'v2_3_skill_layer_schema');

INSERT INTO data_retention (table_name, retention_policy) VALUES
    ('interactions', 'detailed_30_days'),
    ('sessions', 'summary_90_days'),
    ('energy_patterns', 'permanent'),
    ('context_effectiveness', 'permanent'),
    ('algorithm_weights', 'permanent'),
    ('skills', 'permanent'),
    ('task_updates', 'detailed_30_days'),
    ('backup_log', 'summary_90_days');

-- =====================================================================
-- Indexes
-- =====================================================================

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_next_due ON tasks(next_due_at);
CREATE INDEX idx_tasks_updated ON tasks(updated_at);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_task_recurrence_type ON task_recurrence(recurrence_type);
CREATE INDEX idx_interactions_timestamp ON interactions(timestamp);
CREATE INDEX idx_interactions_type ON interactions(interaction_type);
CREATE INDEX idx_interactions_session ON interactions(session_id);
CREATE INDEX idx_coaching_queue_status ON coaching_queue(status);
CREATE INDEX idx_coaching_queue_urgency ON coaching_queue(urgency);
CREATE INDEX idx_coaching_tasks_coaching ON coaching_tasks(coaching_id);
CREATE INDEX idx_coaching_sessions_coaching ON coaching_sessions(coaching_id);
CREATE INDEX idx_coaching_external_deps_coaching ON coaching_external_dependencies(coaching_id);
CREATE INDEX idx_interaction_tasks_interaction ON interaction_tasks(interaction_id);
CREATE INDEX idx_interaction_external_deps_interaction ON interaction_external_dependencies(interaction_id);
CREATE INDEX idx_sessions_type ON sessions(session_type);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_backup_log_created ON backup_log(created_at);
CREATE INDEX idx_data_retention_cleanup ON data_retention(last_cleanup_at);
CREATE INDEX idx_energy_patterns_type ON energy_patterns(pattern_type, pattern_key);
CREATE INDEX idx_skills_active ON skills(is_active, scope);
CREATE INDEX idx_skill_conditions_skill ON skill_conditions(skill_id);
CREATE INDEX idx_skill_conditions_key ON skill_conditions(condition_key);
CREATE INDEX idx_skill_evidence_skill ON skill_evidence(skill_id);

-- =====================================================================
-- Views
-- =====================================================================

-- Active tasks with UNCAPPED neglect multiplier (spec 5.2). Do NOT cap.
-- STALE / BYPASSED, carried from v2.2: this view still computes weeks_neglected/neglect_multiplier
-- with POWER() (unavailable on op-sqlite/Android SQLite) and the retired weeks^2 curve -- it is
-- NOT what the app uses. The real computation is src/db/repositories/tasks.ts's
-- listActiveByNeglect(), which applies the LINEAR neglectCurve (task 10, R1: 1 + weeks) and, once
-- migration 003 lands, R8's accrual-start gate and task 28's three-way re-anchor (spec 5.2) --
-- none of which this SQL view reflects. Left as-is per the task 27 brief (refresh deferred to
-- whichever pass lands migration 003); do not trust this view's neglect columns for anything.
CREATE VIEW active_tasks_with_neglect AS
SELECT
    t.*,
    CASE
        WHEN t.last_completed_at IS NULL THEN
            (julianday('now') - julianday(t.created_at)) / 7.0
        ELSE
            (julianday('now') - julianday(t.last_completed_at)) / 7.0
    END as weeks_neglected,
    CASE
        WHEN t.last_completed_at IS NULL THEN
            POWER((julianday('now') - julianday(t.created_at)) / 7.0, 2)
        ELSE
            POWER((julianday('now') - julianday(t.last_completed_at)) / 7.0, 2)
    END as neglect_multiplier   -- STALE: retired weeks^2 curve; UNCAPPED either way (spec 5.2)
FROM tasks t
WHERE t.status = 'active';

CREATE VIEW tasks_due_soon AS
SELECT
    t.*,
    (julianday(t.next_due_at) - julianday('now')) as days_until_due
FROM tasks t
WHERE t.status = 'active'
    AND t.next_due_at IS NOT NULL
    AND t.next_due_at <= datetime('now', '+7 days')
ORDER BY t.next_due_at ASC;

CREATE VIEW recent_session_performance AS
SELECT
    s.session_type,
    COUNT(*) as session_count,
    AVG(s.actual_duration) as avg_duration,
    AVG(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) as completion_rate,
    AVG(s.user_energy_start) as avg_energy_start,
    AVG(s.user_energy_end) as avg_energy_end,
    AVG(s.tasks_completed) as avg_tasks_completed,
    AVG(s.tasks_skipped) as avg_tasks_skipped
FROM sessions s
WHERE s.started_at >= datetime('now', '-30 days')
GROUP BY s.session_type;

CREATE VIEW coaching_priority_queue AS
SELECT
    cq.*,
    GROUP_CONCAT(ct.task_id) as related_task_ids,
    GROUP_CONCAT(cs.session_id) as related_session_ids,
    GROUP_CONCAT(ced.external_dependency_id) as related_external_dependency_ids
FROM coaching_queue cq
LEFT JOIN coaching_tasks ct ON cq.id = ct.coaching_id
LEFT JOIN coaching_sessions cs ON cq.id = cs.coaching_id
LEFT JOIN coaching_external_dependencies ced ON cq.id = ced.coaching_id
WHERE cq.status = 'pending'
GROUP BY cq.id
ORDER BY
    CASE cq.urgency WHEN 'immediate' THEN 0 WHEN 'next_open' THEN 1 ELSE 2 END,
    cq.created_at ASC;

-- INDEX ONLY (migration 002 comment, task 18 design report SS2 item 4): GROUP_CONCAT(condition_key
-- || condition_op || condition_value) is lossy (ambiguous if a condition_value contains an op
-- substring adjacent to its key) and applies no scope filter. Never parse `conditions` for
-- matching -- read skill_conditions via skillsRepository.listConditions() instead.
CREATE VIEW fireable_skills AS
SELECT s.*,
    GROUP_CONCAT(sc.condition_key || sc.condition_op || sc.condition_value) as conditions
FROM skills s
LEFT JOIN skill_conditions sc ON s.id = sc.skill_id
WHERE s.is_active = TRUE
GROUP BY s.id;
