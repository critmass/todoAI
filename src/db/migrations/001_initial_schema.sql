-- ADHD Task Management App - SQLite Database Schema v2.2
-- Offline-first, local storage. Regenerated to match Specification v2.2.
--
-- Changes from v2.1:
--   1. tasks.duration_source ('user' | 'model_guess') added (spec 4.1) so the learning
--      loop can replace a model guess off the FIRST real completion (spec 5.4).
--   2. task_recurrence.recurrence_type discriminator added: five types
--      (scheduled_quota, quota, scheduled, unscheduled, count); plus target_count for 'count'.
--      current_period_progress doubles as the running counter for 'count' (reset_date NULL,
--      no period reset). NULL recurrence (no row) = true one-off (spec 4.2).
--   3. Neglect view stays UNCAPPED. 'unscheduled' completion updates last_completed_at
--      (resetting neglect) WITHOUT setting status='completed' (app logic; noted in view).
--   4. schema_metadata model/format strings corrected: 4B default; TQ1_0 (mainline) / Q2_0 (fork).
--   Carried forward from v2.1: parent_task_id, summary_schema_version, skill tables,
--      neglect excluded from summed algorithm_weights, importance 1-1000 / energy 1-5.

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

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    importance INTEGER CHECK (importance >= 1 AND importance <= 1000),
    urgency_level INTEGER DEFAULT 3 CHECK (urgency_level >= 1 AND urgency_level <= 5),
    next_due_at DATETIME,
    estimated_duration INTEGER NOT NULL, -- minutes; coach guesses if unspecified
    duration_source TEXT CHECK (duration_source IN ('user', 'model_guess')) DEFAULT 'model_guess',
    actual_duration_history TEXT CHECK (json_valid(actual_duration_history)), -- JSON array; cumulative for multi-session (spec 8.7)
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
    learning_data TEXT CHECK (json_valid(learning_data)),
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
    extended BOOLEAN DEFAULT FALSE, -- session ran past planned length via 'extend' (spec 8.7, proposed)
    model_tier TEXT CHECK (model_tier IN ('8B', '4B', '1.7B')), -- tier locked for this session (spec 3.1)
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- =====================================================================
-- Algorithm weights (numeric learning)
-- =====================================================================
-- neglect_factor intentionally NOT a member of this set (uncapped post-sum multiplier; spec 5.1-5.2).

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

CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instruction TEXT NOT NULL,
    scope TEXT CHECK (scope IN ('coaching', 'planning', 'both')) DEFAULT 'both',
    schema_version TEXT,
    confidence REAL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    is_active BOOLEAN DEFAULT TRUE,
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

CREATE TABLE skill_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    interaction_id INTEGER,
    evidence_type TEXT CHECK (evidence_type IN ('origin', 'corroboration', 'contradiction')) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE SET NULL
);

-- =====================================================================
-- Coaching queue (three trigger tiers; spec 7.2)
-- =====================================================================

CREATE TABLE coaching_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'task_skipped',
        'session_recalibration',
        'app_reorientation',
        'session_ended_early',
        'task_ended_early',
        'repeated_failures',
        'pattern_detected'
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
    ('version', '2.2.0'),
    ('created_at', datetime('now')),
    ('app_name', 'ADHD Task Management'),
    ('model_family', 'Ternary Bonsai (4B default/validated; 8B/1.7B contingent)'),
    ('model_format', 'TQ1_0 (mainline-compatible repack) / Q2_0 (native, PrismML fork)'),
    ('last_migration', 'v2_2_schema');

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
-- For 'unscheduled' tasks, completion updates last_completed_at (resetting neglect here)
-- while status stays 'active' -- so they keep flowing through this view (app logic).
-- This view is BYPASSED on-device (src/db/repositories/tasks.ts computes weeksNeglected in TS
-- instead; see that file's TaskWithNeglect doc comment for why). Kept honest anyway: task 10
-- (R1) replaced the neglect curve with a LINEAR one (1 + weeks, not weeks^2) -- the real
-- swappable seam is neglectCurve in src/scoring/score.ts, which this column's shape must
-- mirror if this view is ever revived. Linear no longer needs POWER() at all.
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
            (julianday('now') - julianday(t.created_at)) / 7.0
        ELSE
            (julianday('now') - julianday(t.last_completed_at)) / 7.0
    END as neglect_multiplier   -- UNCAPPED by design (spec 5.2); LINEAR (task 10, R1)
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

CREATE VIEW fireable_skills AS
SELECT s.*,
    GROUP_CONCAT(sc.condition_key || sc.condition_op || sc.condition_value) as conditions
FROM skills s
LEFT JOIN skill_conditions sc ON s.id = sc.skill_id
WHERE s.is_active = TRUE
GROUP BY s.id;
