-- ADHD Task Management App - Schema migration 004 (v2.4 -> v2.5)
-- Reconciles algorithm_weights (spec §5.4's learned-weights table) with the composition R3
-- actually shipped in src/scoring/factors.ts. R3 moved to 31/23/23/23 and dropped context_fit
-- from the weighted sum entirely (context/tools became a hard pre-filter - see
-- src/scoring/filter.ts) months ago, but nothing ever migrated the table whose entire purpose is
-- persisting learned weights for that composition. It has been seeded at the retired
-- 25/20/20/15/20 with 'context_fit' still a legal factor_name since 001. Dormant only because
-- task 17 (the learning-loop consumer) doesn't exist yet.
--
-- THE HAZARD (same as 002/003): SQLite has no ALTER TABLE ... ALTER COLUMN, and removing
-- 'context_fit' from the factor_name CHECK is a constraint change, so algorithm_weights needs
-- the full table-rebuild procedure. PRAGMA foreign_keys is a no-op when set from inside an open
-- transaction (verified against this repo's SQLite build) - this migration runs via
-- runMigrations' `rebuildsTables: true` path (see index.ts), which issues
-- `PRAGMA foreign_keys = OFF` before the transaction and restores it to ON after commit. Do NOT
-- add PRAGMA foreign_keys lines here - they would silently no-op.
--
-- No view selects FROM algorithm_weights (checked against all five: active_tasks_with_neglect
-- itself is dropped below for an unrelated reason, tasks_due_soon, recent_session_performance,
-- coaching_priority_queue, fireable_skills), so there is no drop-view-before-drop-table step for
-- this table, unlike 002's two rebuilds. algorithm_weights also has no FOREIGN KEY of its own and
-- no child table references it, so the rebuild is uncomplicated by cascades either way.
--
-- algorithm_weights IS AUTOINCREMENT, and this migration DELETES the context_fit row - unlike
-- 002/003, where the rebuilt tables never lost a row, this one actually does. That makes the
-- sqlite_sequence save/restore below load-bearing, not defensive boilerplate: without it, the
-- rebuild's INSERT...SELECT only copies the four surviving rows, sqlite_sequence would reset to
-- MAX(id) of those four, and the next insert into this table would silently reuse context_fit's
-- old id (task 26's findings report, §3b, is the empirical proof this isn't hypothetical).
--
-- ASYMMETRY, recorded deliberately (brief §1): the context_fit row is deleted UNCONDITIONALLY,
-- regardless of its data_points_count - the factor no longer exists in the scoring model, so any
-- learned data about it has nowhere to go and carrying it forward would just be dead weight. The
-- four SURVIVING rows are reseeded to 31/23/23/23 ONLY where data_points_count = 0 (see the
-- UPDATE statements below) - today that's every row (task 17 hasn't shipped, so nothing has
-- learned anything yet), but the guard means a future run of this same migration file against a
-- device where the learning loop has already updated a weight leaves that row alone instead of
-- clobbering real learned data with a hardcoded reseed. Different reason for each half: one
-- factor is gone and its data has no home; the other four still exist and their stored weight
-- might no longer be the retired default.
--
-- DECISION - active_tasks_with_neglect is DROPPED in this migration, not just left stale.
-- Reasoning: the view computes the retired weeks^2 neglect curve via POWER(), a function that
-- does not exist on this app's on-device SQLite build (confirmed empirically, task 12 Phase B;
-- see docs/eval/task12_phaseB_findings_report.md §1) - so the view cannot even run, and hasn't
-- been able to since before task 10 landed. It also now reflects none of R1 (linear curve, task
-- 10), R8 (recurrence accrual gate, task 25), or task 28's three-way anchor merge (task 33) - all
-- three rulings live only in listActiveByNeglect (src/db/repositories/tasks.ts), which is the
-- sole authoritative implementation and always has been for real queries. A stale view that
-- cannot execute and states a superseded rule is a trap, not a reference: the next person reading
-- the schema for ground truth would find POWER((days)/7, 2) and reasonably conclude neglect is
-- quadratic - exactly the kind of misreading this project has been most careful to prevent.
-- Counter-argument, weighed and rejected: dropping is irreversible in this forward-only scheme,
-- and the view was harmless while unread. But "unread" is exactly the problem - nothing enforces
-- that it stays unread, and a view "kept for reference" needs to actually be correct reference,
-- which this one has not been since task 10. Dropping it means the neglect computation now lives
-- in exactly one place, with no second copy to drift.

-- =====================================================================
-- 1. algorithm_weights rebuild - drop 'context_fit', reseed the surviving four to 31/23/23/23
-- =====================================================================

CREATE TEMP TABLE _algorithm_weights_seq_save AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'algorithm_weights'), 0) AS seq;

CREATE TABLE algorithm_weights_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    factor_name TEXT NOT NULL UNIQUE CHECK (factor_name IN (
        'importance',
        'urgency',
        'energy_match',
        'historical_success'
    )),
    weight_percentage REAL NOT NULL CHECK (weight_percentage >= 0 AND weight_percentage <= 100),
    context_specific_weights TEXT CHECK (json_valid(context_specific_weights)),
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence_level REAL DEFAULT 0.0 CHECK (confidence_level >= 0.0 AND confidence_level <= 1.0),
    data_points_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- context_fit is excluded here unconditionally - this is the row deletion, not the reseed.
INSERT INTO algorithm_weights_new (
    id, factor_name, weight_percentage, context_specific_weights,
    last_updated, confidence_level, data_points_count, created_at
)
SELECT
    id, factor_name, weight_percentage, context_specific_weights,
    last_updated, confidence_level, data_points_count, created_at
FROM algorithm_weights
WHERE factor_name != 'context_fit';

DROP TABLE algorithm_weights;
ALTER TABLE algorithm_weights_new RENAME TO algorithm_weights;

DELETE FROM sqlite_sequence WHERE name = 'algorithm_weights';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'algorithm_weights',
        MAX((SELECT seq FROM _algorithm_weights_seq_save), (SELECT COALESCE(MAX(id), 0) FROM algorithm_weights));
DROP TABLE _algorithm_weights_seq_save;

-- Reseed to R3's 31/23/23/23 (src/scoring/factors.ts FACTOR_WEIGHTS) - ONLY where nothing has
-- been learned yet. A row with data_points_count > 0 has real learned data and is left untouched.
UPDATE algorithm_weights SET weight_percentage = 31.0, last_updated = CURRENT_TIMESTAMP
    WHERE factor_name = 'importance' AND data_points_count = 0;
UPDATE algorithm_weights SET weight_percentage = 23.0, last_updated = CURRENT_TIMESTAMP
    WHERE factor_name = 'urgency' AND data_points_count = 0;
UPDATE algorithm_weights SET weight_percentage = 23.0, last_updated = CURRENT_TIMESTAMP
    WHERE factor_name = 'energy_match' AND data_points_count = 0;
UPDATE algorithm_weights SET weight_percentage = 23.0, last_updated = CURRENT_TIMESTAMP
    WHERE factor_name = 'historical_success' AND data_points_count = 0;

-- =====================================================================
-- 2. active_tasks_with_neglect - dropped (see DECISION note above)
-- =====================================================================

DROP VIEW active_tasks_with_neglect;

-- =====================================================================
-- Verification + version bump
-- =====================================================================

-- Checked by the migration runner (index.ts): a non-empty result here aborts and rolls back the
-- whole migration rather than committing a broken foreign key.
PRAGMA foreign_key_check;

UPDATE schema_metadata SET value = '2.5.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_5_algorithm_weights_reconciliation', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
