-- ADHD Task Management App - Schema migration 002 (v2.2 -> v2.3)
-- Six gaps flagged by the task 18 skill-layer design (docs/eval/task18_design_report.md §2):
--   1. learning_state (key, value): watermarks + tunables for the distiller (genuine addition).
--   2. skills.is_active default flips TRUE -> FALSE (born-inactive defense-in-depth; existing
--      rows keep their actual stored value, only the default for future inserts changes).
--   3. skill_evidence.source: optional nullable provenance ('distiller' | 'outcome').
--   4. coaching_queue.trigger_type CHECK gains 'buried_task' (R4) and 'breakdown_complete' (R7).
--      coaching_queue.urgency CHECK already covers 'immediate'/'next_start'/'next_open' - verified,
--      not changed.
--   5. learning_data JSON convention note ("v":1) - documented in src/types/domain.ts next to the
--      Interaction type; not a schema change, so nothing to do here.
--   6. fireable_skills gets a comment (below) documenting that it is an index only - its
--      GROUP_CONCAT'd conditions are lossy and must never be parsed for matching; read
--      skillsRepository.listConditions() instead.
--
-- THE HAZARD: SQLite has no ALTER TABLE ... ALTER COLUMN. Changing a CHECK constraint or a
-- column DEFAULT (items 2 and 4) requires the full table-rebuild procedure: create the
-- corrected table under a temp name, copy every row, drop the old table, rename the temp table
-- into place, then recreate whatever the DROP TABLE took down with it.
--
-- PRAGMA foreign_keys is a no-op when set from *inside* an open transaction (verified against
-- this repo's SQLite build) - it can only be toggled with no transaction pending. This migration
-- is applied via runMigrations' `rebuildsTables: true` path (see index.ts), which issues
-- `PRAGMA foreign_keys = OFF` before opening the transaction that runs the statements below, and
-- restores it to ON after commit. Do NOT add PRAGMA foreign_keys lines to this file - they would
-- silently no-op inside the transaction and misrepresent what actually disables enforcement.
--
-- Two things the design report's hazard section didn't call out, discovered empirically while
-- building this migration (see docs/eval/task26_findings_report.md for the full writeup):
--   - DROP TABLE on a table a VIEW still selects FROM is flatly rejected by this SQLite build
--     ("no such table" raised from inside the view), not silently tolerated - so the dependent
--     view must be dropped *before* DROP TABLE, not just recreated after.
--   - Rebuilding an AUTOINCREMENT table resets its sqlite_sequence high-water mark to the
--     current copied MAX(id), silently breaking the "never reuse a rowid" guarantee for any
--     table that has ever had a row deleted. Both rebuilds below save and restore it explicitly.

-- =====================================================================
-- 1. learning_state - new table (watermarks + tunables; task 19 is the consumer)
-- =====================================================================

CREATE TABLE learning_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- 2. skill_evidence.source - simple ADD COLUMN, no rebuild needed (new column, not an
--    alteration of an existing one, so SQLite allows the CHECK here directly).
-- =====================================================================

ALTER TABLE skill_evidence ADD COLUMN source TEXT CHECK (source IN ('distiller', 'outcome'));

-- =====================================================================
-- 3. skills rebuild - is_active DEFAULT TRUE -> FALSE
-- =====================================================================

-- fireable_skills selects FROM skills, so it must be dropped before skills itself is dropped
-- (see hazard note above) and recreated once the rebuild is done.
DROP VIEW fireable_skills;

-- Save skills' AUTOINCREMENT high-water mark; the rebuild below resets sqlite_sequence to
-- whatever MAX(id) the copied rows produce, which understates history if any skill was ever
-- deleted (none are today - skills.ts has no delete - but this keeps the guarantee honest
-- regardless of that).
CREATE TEMP TABLE _skills_seq_save AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'skills'), 0) AS seq;

CREATE TABLE skills_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instruction TEXT NOT NULL,
    scope TEXT CHECK (scope IN ('coaching', 'planning', 'both')) DEFAULT 'both',
    schema_version TEXT,
    confidence REAL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    is_active BOOLEAN DEFAULT FALSE, -- was DEFAULT TRUE; born-inactive defense-in-depth (task 18 §2.1)
    times_fired INTEGER DEFAULT 0,
    times_corroborated INTEGER DEFAULT 0,
    times_contradicted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_fired_at DATETIME
);

INSERT INTO skills_new (
    id, instruction, scope, schema_version, confidence, is_active,
    times_fired, times_corroborated, times_contradicted, created_at, last_updated, last_fired_at
)
SELECT
    id, instruction, scope, schema_version, confidence, is_active,
    times_fired, times_corroborated, times_contradicted, created_at, last_updated, last_fired_at
FROM skills;

DROP TABLE skills;
ALTER TABLE skills_new RENAME TO skills;

DELETE FROM sqlite_sequence WHERE name = 'skills';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'skills', MAX((SELECT seq FROM _skills_seq_save), (SELECT COALESCE(MAX(id), 0) FROM skills));
DROP TABLE _skills_seq_save;

CREATE INDEX idx_skills_active ON skills(is_active, scope);

-- fireable_skills is an ACTIVE-SKILL INDEX ONLY. GROUP_CONCAT(condition_key || condition_op ||
-- condition_value) is lossy (ambiguous if a condition_value contains an op substring adjacent
-- to its key) and applies no scope filter. Never parse the `conditions` column for matching -
-- read skill_conditions via skillsRepository.listConditions() instead (task 18 design report,
-- docs/eval/task18_design_report.md §2 item 4).
CREATE VIEW fireable_skills AS
SELECT s.*,
    GROUP_CONCAT(sc.condition_key || sc.condition_op || sc.condition_value) as conditions
FROM skills s
LEFT JOIN skill_conditions sc ON s.id = sc.skill_id
WHERE s.is_active = TRUE
GROUP BY s.id;

-- =====================================================================
-- 4. coaching_queue rebuild - trigger_type CHECK gains buried_task, breakdown_complete
-- =====================================================================

-- coaching_priority_queue selects FROM coaching_queue - drop before dropping the table.
DROP VIEW coaching_priority_queue;

CREATE TEMP TABLE _coaching_queue_seq_save AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'coaching_queue'), 0) AS seq;

CREATE TABLE coaching_queue_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'task_skipped',
        'session_recalibration',
        'app_reorientation',
        'session_ended_early',
        'task_ended_early',
        'repeated_failures',
        'pattern_detected',
        'buried_task',        -- R4: buried out-of-context/tool task trigger
        'breakdown_complete'  -- R7: parent-confirmation trigger, fires with urgency='immediate'
    )),
    urgency TEXT CHECK (urgency IN ('immediate', 'next_start', 'next_open')) DEFAULT 'next_start',
    trigger_data TEXT CHECK (json_valid(trigger_data)),
    status TEXT CHECK (status IN ('pending', 'resolved')) DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO coaching_queue_new (id, trigger_type, urgency, trigger_data, status, created_at)
SELECT id, trigger_type, urgency, trigger_data, status, created_at
FROM coaching_queue;

DROP TABLE coaching_queue;
ALTER TABLE coaching_queue_new RENAME TO coaching_queue;

DELETE FROM sqlite_sequence WHERE name = 'coaching_queue';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'coaching_queue',
        MAX((SELECT seq FROM _coaching_queue_seq_save), (SELECT COALESCE(MAX(id), 0) FROM coaching_queue));
DROP TABLE _coaching_queue_seq_save;

CREATE INDEX idx_coaching_queue_status ON coaching_queue(status);
CREATE INDEX idx_coaching_queue_urgency ON coaching_queue(urgency);

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

-- =====================================================================
-- Verification + version bump
-- =====================================================================

-- Checked by the migration runner (index.ts): a non-empty result here aborts and rolls back
-- the whole migration rather than committing a broken foreign key.
PRAGMA foreign_key_check;

UPDATE schema_metadata SET value = '2.3.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_3_skill_layer_schema', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
