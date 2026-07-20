// AUTO-GENERATED from 003_multisession_work.sql - do not hand-edit by hand without also updating
// the .sql source; migrations/__tests__/schemaDrift.test.ts asserts these stay byte-identical.
export const MIGRATION_003_SQL = `-- ADHD Task Management App - Schema migration 003 (v2.3 -> v2.4)
-- Task 33 / task 28 design (docs/design/multisession_task28_design.md §7): multi-session work &
-- hyperfocus extension. Adds the state a work episode needs to be PARKED ("I'll be back") instead
-- of collapsing into a skip, the cumulative-time column the completion fold writes through, the
-- open-ended duration mode ('floor'), and the neglect re-anchor input (last_worked_at):
--   1. tasks.duration_type       - 'estimate' | 'floor' (open-ended work; estimated_duration holds
--                                  the floor value). Timer counts up for 'floor'; §3.1.
--   2. tasks.work_state          - 'none' | 'in_progress'. Orthogonal to status; a parked task
--                                  stays status='active' so every pool query works unchanged. §1.1.
--   3. tasks.accumulated_minutes - minutes worked toward the current completion; folds to ONE
--                                  actual_duration_history entry at completion. §2.
--   4. tasks.last_worked_at      - re-anchors the neglect clock (working a task is attention);
--                                  joins listActiveByNeglect's anchor as a third max input. §5.
--   5. sessions.tasks_progressed - parked tasks count here, not in tasks_completed/tasks_skipped.
--   6. interactions              - interaction_type gains 'task_progress', completion_status gains
--                                  'progress' (the park episode's row). §1.1.
--
-- THE HAZARD (same as 002): SQLite has no ALTER TABLE ... ALTER COLUMN, so widening the two
-- interactions CHECK constraints (item 6) requires the full table-rebuild procedure. Items 1-5 are
-- plain ADD COLUMNs - SQLite allows CHECK and NOT NULL DEFAULT on ADD COLUMN directly (verified on
-- this build via migration 002's skill_evidence.source add and this migration's tests), so no
-- rebuild for them.
--
-- PRAGMA foreign_keys is a no-op when set from inside an open transaction (verified against this
-- repo's SQLite build). This migration runs via runMigrations' \`rebuildsTables: true\` path (see
-- index.ts), which issues \`PRAGMA foreign_keys = OFF\` before the transaction and restores it to ON
-- after commit. Do NOT add PRAGMA foreign_keys lines here - they would silently no-op.
--
-- Rebuild specifics for interactions (inheriting 002's verified findings):
--   - No VIEW selects FROM interactions (checked against all five: active_tasks_with_neglect,
--     tasks_due_soon, recent_session_performance, coaching_priority_queue, fireable_skills), so
--     there is no drop-view-first step here - unlike 002's two rebuilds. Asserted by the migration
--     test, which confirms the view list is intact afterward.
--   - interactions is AUTOINCREMENT and is referenced by three child FKs (skill_evidence,
--     interaction_tasks, interaction_external_dependencies). The rebuild preserves every id via
--     INSERT ... SELECT and restores sqlite_sequence, so those FKs (resolved by table name) stay
--     valid and no rowid is ever reused.
--   - idx_interactions_timestamp / _type / _session are recreated after the rebuild.
--   - PRAGMA foreign_key_check is asserted empty by the runner (a non-empty result rolls back).

-- =====================================================================
-- 1-4. tasks - four ADD COLUMNs (no rebuild)
-- =====================================================================

ALTER TABLE tasks ADD COLUMN duration_type TEXT NOT NULL DEFAULT 'estimate'
    CHECK (duration_type IN ('estimate', 'floor'));          -- §3.1; estimated_duration holds the floor value
ALTER TABLE tasks ADD COLUMN work_state TEXT NOT NULL DEFAULT 'none'
    CHECK (work_state IN ('none', 'in_progress'));           -- §1; orthogonal to status
ALTER TABLE tasks ADD COLUMN accumulated_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (accumulated_minutes >= 0);                        -- §2; folds to ONE history entry at completion
ALTER TABLE tasks ADD COLUMN last_worked_at DATETIME;        -- §5; nullable; neglect re-anchor

-- =====================================================================
-- 5. sessions - one ADD COLUMN
-- =====================================================================

ALTER TABLE sessions ADD COLUMN tasks_progressed INTEGER NOT NULL DEFAULT 0;

-- =====================================================================
-- 6. interactions rebuild - interaction_type gains 'task_progress',
--    completion_status gains 'progress'
-- =====================================================================

CREATE TEMP TABLE _interactions_seq_save AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'interactions'), 0) AS seq;

CREATE TABLE interactions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    interaction_type TEXT NOT NULL CHECK (interaction_type IN (
        'work_session',
        'coaching_conversation',
        'task_input',
        'energy_checkin',
        'pattern_recognition',
        'task_completion',
        'task_skip',
        'task_progress'  -- task 28 §1.1: the park episode's interaction row
    )),
    session_id TEXT,
    user_energy_level_start INTEGER CHECK (user_energy_level_start >= 1 AND user_energy_level_start <= 5),
    user_energy_level_end INTEGER CHECK (user_energy_level_end >= 1 AND user_energy_level_end <= 5),
    conclusions TEXT CHECK (json_valid(conclusions)),
    learning_data TEXT CHECK (json_valid(learning_data)),
    conversation_summary TEXT, -- AI-generated, grammar-constrained; raw transcript never stored
    summary_schema_version TEXT,
    duration_minutes INTEGER,
    completion_status TEXT CHECK (completion_status IN ('completed', 'skipped', 'ended_early', 'abandoned', 'progress')),
    context_used TEXT CHECK (json_valid(context_used)),
    user_feedback_rating INTEGER CHECK (user_feedback_rating >= 1 AND user_feedback_rating <= 5),
    notes TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

INSERT INTO interactions_new (
    id, timestamp, interaction_type, session_id, user_energy_level_start, user_energy_level_end,
    conclusions, learning_data, conversation_summary, summary_schema_version, duration_minutes,
    completion_status, context_used, user_feedback_rating, notes
)
SELECT
    id, timestamp, interaction_type, session_id, user_energy_level_start, user_energy_level_end,
    conclusions, learning_data, conversation_summary, summary_schema_version, duration_minutes,
    completion_status, context_used, user_feedback_rating, notes
FROM interactions;

DROP TABLE interactions;
ALTER TABLE interactions_new RENAME TO interactions;

DELETE FROM sqlite_sequence WHERE name = 'interactions';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'interactions',
        MAX((SELECT seq FROM _interactions_seq_save), (SELECT COALESCE(MAX(id), 0) FROM interactions));
DROP TABLE _interactions_seq_save;

CREATE INDEX idx_interactions_timestamp ON interactions(timestamp);
CREATE INDEX idx_interactions_type ON interactions(interaction_type);
CREATE INDEX idx_interactions_session ON interactions(session_id);

-- =====================================================================
-- Verification + version bump
-- =====================================================================

-- Checked by the migration runner (index.ts): a non-empty result here aborts and rolls back the
-- whole migration rather than committing a broken foreign key.
PRAGMA foreign_key_check;

UPDATE schema_metadata SET value = '2.4.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_4_multisession_work', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
`;
