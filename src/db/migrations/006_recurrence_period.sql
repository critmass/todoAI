-- ADHD Task Management App - Schema migration 006 (v2.6 -> v2.7)
-- Task 36 (recurrence period engine): the TIME-DRIVEN half of spec §4.2 - advancing next_due_at to
-- the next scheduled occurrence, rolling current_period_progress/reset_date at a period boundary,
-- and the missed-quota importance boost - has never existed. `completeTask` does the
-- completion-driven half and says so at the top of src/services/taskCompletion.ts; nothing did the
-- other half, so `reset_date` has had NO WRITER ANYWHERE since 001 and quota periods never rolled.
-- This migration gives that engine the one column it cannot derive, and makes the one invariant
-- the schema only ever stated in a comment structural.
--
-- 1. task_recurrence.last_period_shortfall - how many occurrences the IMMEDIATELY PRECEDING period
--    ended short by (quota - progress at the moment the period rolled), 0 when the quota was met.
--    THE BOOST ITSELF IS NOT STORED. Spec §4.2's missed-quota importance boost is DERIVED at
--    scoring time from this fact, exactly as urgency is derived from next_due_at (§4.1) - see the
--    task 36 findings report §3b. Writing a boost into tasks.importance would corrupt the user's
--    own 1-10 projection (constraint #6) and collide with the 1-99 subtask band under each hundred.
--    What is stored here is the FACT ("last week you missed two of three"), not the policy.
--    It is a single period's shortfall and is REPLACED, never summed: a user returning after three
--    missed weeks owes one period's worth, not three (spec §4.2, "missed occurrences reset - no
--    guilt stacking"). Capped at the quota by the writer for the same reason.
--
-- 2. reset_date IS NULL for 'unscheduled' and 'count' becomes a CHECK. 001 wrote that rule as a
--    trailing comment on the column and nothing enforced it. Both types have no period, no
--    schedule and no reset (§4.2), and conflating them with the period types is exactly the
--    invisible corruption orientation constraint #7 exists to prevent. Until now no code wrote
--    reset_date at all, so the rule cost nothing to state loosely; this task ships the first writer
--    of that column, which makes it the moment to make it enforceable rather than aspirational.
--    The copy below NULLs any stale value on those two types so an upgrade cannot fail on data
--    that predates the constraint.
--
-- WHAT reset_date MEANS, now that it has a writer: the LOCAL CALENDAR DATE ('YYYY-MM-DD') on which
-- the current period ENDS - an exclusive boundary. The sweep rolls when today >= reset_date, and
-- the period that just closed is [reset_date - one period, reset_date). Date, not datetime, and
-- local, not UTC: period boundaries are device-local midnights, and a calendar date is immune to
-- the 23/25-hour days a DST transition produces (task 36 report §3d). next_due_at already carries
-- the same 'YYYY-MM-DD' calendar-date shape everywhere it is written (src/llm/due/dueSpec.ts,
-- src/app/tasks/taskDraft.ts), so this is the established format for a due/boundary date, not a
-- new one.
--
-- NO BACKFILL of reset_date here. Existing period-bearing rows keep NULL and the engine seeds them
-- on its first sweep (`advanceRecurrence` treats a null reset_date as "period starts today"), which
-- keeps period seeding in ONE code path that is already idempotent and already tested, instead of
-- a second one written in SQL that runs once and can never be re-run.
--
-- THE HAZARD (same as 002/003/004): SQLite has no ALTER TABLE ... ALTER COLUMN, so adding the
-- reset_date CHECK requires the full table-rebuild procedure. The new column alone would have been
-- a plain ADD COLUMN; it rides the rebuild because the rebuild has to happen anyway.
--
-- PRAGMA foreign_keys is a no-op when set from inside an open transaction (verified against this
-- repo's SQLite build). This migration runs via runMigrations' `rebuildsTables: true` path (see
-- index.ts), which issues `PRAGMA foreign_keys = OFF` before the transaction and restores it to ON
-- after commit. Do NOT add PRAGMA foreign_keys lines here - they would silently no-op.
--
-- Rebuild specifics for task_recurrence:
--   - No VIEW selects FROM task_recurrence (checked against all four surviving views:
--     tasks_due_soon, recent_session_performance, coaching_priority_queue, fireable_skills - the
--     fifth, active_tasks_with_neglect, was dropped by 004), so there is no drop-view-first step.
--     The migration test asserts the view list is intact afterward.
--   - task_recurrence is AUTOINCREMENT, so sqlite_sequence is saved and restored around the
--     rebuild; every id is preserved via INSERT ... SELECT.
--   - NOTHING references task_recurrence with a foreign key (it is a leaf), so the DROP + RENAME
--     cannot orphan a child row. Its own FK to tasks(id) ON DELETE CASCADE is recreated below.
--   - idx_task_recurrence_type is recreated after the rebuild.
--   - PRAGMA foreign_key_check is asserted empty by the runner (a non-empty result rolls back).

-- =====================================================================
-- task_recurrence rebuild - adds last_period_shortfall, enforces the
-- "no reset_date on unscheduled/count" rule
-- =====================================================================

CREATE TEMP TABLE _task_recurrence_seq_save AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'task_recurrence'), 0) AS seq;

CREATE TABLE task_recurrence_new (
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
    reset_date DATETIME, -- 'YYYY-MM-DD' local calendar date the CURRENT period ends (exclusive); NULL for 'unscheduled' and 'count'
    last_period_shortfall INTEGER NOT NULL DEFAULT 0 CHECK (last_period_shortfall >= 0), -- task 36: quota - progress at the last roll; the boost is derived from it, never stored
    is_currently_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CHECK ( (recurrence_type = 'count') = (target_count IS NOT NULL) ), -- target_count iff type is 'count'
    CHECK ( recurrence_type NOT IN ('unscheduled', 'count') OR reset_date IS NULL ) -- neither has a period (§4.2)
);

INSERT INTO task_recurrence_new (
    id, task_id, recurrence_type, recurrence_pattern, target_count, current_period_progress,
    reset_date, last_period_shortfall, is_currently_active, created_at
)
SELECT
    id, task_id, recurrence_type, recurrence_pattern, target_count, current_period_progress,
    -- Sanitizing, not asserting: a pre-006 row could only have a non-null reset_date here if it
    -- were hand-written, but failing an upgrade on the user's own database is the worse outcome.
    CASE WHEN recurrence_type IN ('unscheduled', 'count') THEN NULL ELSE reset_date END,
    0, is_currently_active, created_at
FROM task_recurrence;

DROP TABLE task_recurrence;
ALTER TABLE task_recurrence_new RENAME TO task_recurrence;

DELETE FROM sqlite_sequence WHERE name = 'task_recurrence';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'task_recurrence',
        MAX((SELECT seq FROM _task_recurrence_seq_save), (SELECT COALESCE(MAX(id), 0) FROM task_recurrence));
DROP TABLE _task_recurrence_seq_save;

CREATE INDEX idx_task_recurrence_type ON task_recurrence(recurrence_type);

-- =====================================================================
-- Verification + version bump
-- =====================================================================

-- Checked by the migration runner (index.ts): a non-empty result here aborts and rolls back the
-- whole migration rather than committing a broken foreign key.
PRAGMA foreign_key_check;

UPDATE schema_metadata SET value = '2.7.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_7_recurrence_period', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
