// AUTO-GENERATED from 007_session_origin.sql - do not hand-edit by hand without also updating
// the .sql source; migrations/__tests__/schemaDrift.test.ts asserts these stay byte-identical.
export const MIGRATION_007_SQL = `-- ADHD Task Management App - Schema migration 007 (v2.7 -> v2.8)
-- Task 44 (personal-use QoL pass): sessions.origin - RULED by Jason, 2026-08-07 (orientation §5,
-- task44 brief §5). A quick-start session (task 44 §3: launch a session for ONE specific task,
-- skipping the planner's selection boundary entirely) must be distinguishable from a normal one
-- IN THE DATABASE, not only in capture (task 41's \`episode\`/\`lifecycle\` streams already carry an
-- origin field - see src/capture/context.ts's SessionOrigin type, which has been waiting for this
-- migration since task 41 landed).
--
-- WHY THE DATABASE AND NOT ONLY CAPTURE (recorded so a future session does not read this as
-- redundant - see orientation.md §5 for the full reasoning, condensed here):
--   1. Capture is deletable by design (every stream independently removable, consent-gated at 42,
--      pruned by 43); \`sessions\` is permanent. A permanent consumer (task 17's learning loops)
--      must not depend on an ephemeral store.
--   2. Quick-start bypasses runSelectionBoundary entirely, so its outcome is a CONFOUNDER, not a
--      label - the ranker didn't choose, so pooling its outcome credits/blames the scorer for a
--      choice the user made. Capacity learning is contaminated the same way (a one-task session is
--      not evidence about how much fits in a session).
--   3. It cannot be backfilled - deferring the column until task 17 exists destroys the record for
--      every session in the gap.
--
-- SCOPE DISCIPLINE (task 44 brief §5): this migration RECORDS origin. It does not build exclusion
-- logic into the learning layer, and it does not reshape session_type to absorb the distinction -
-- how task 17 consumes the column is task 17's decision.
--
-- NULLABLE, NOT BACKFILLED. Every session row written before this migration gets NULL, and NULL
-- is MEANINGFUL here: "the distinction did not exist yet," never "unknown" or "planned" by
-- default. Guessing 'planned' for old rows would assert something no code ever recorded.
--
-- ONE WRITER. \`sessions.origin\` is written exactly once per session, in
-- src/app/session/sessionController.ts (constraint #14: task 24 owns session-row creation).
-- Two call sites exist there today (startSession / startQuickStartSession) because task 44 adds a
-- second CREATION PATH, not a second writer of this column on an existing row - nothing UPDATEs
-- origin after a session is born, exactly like \`session_type\`.
--
-- MIGRATION-DISCIPLINE NOTE (constraint #12's "any CHECK change needs the full table-rebuild
-- discipline"): this column carries a CHECK, and the instinct from 002/003(sessions' own ADD
-- COLUMN)/004/006 is therefore to reach for the rebuild dance. It is NOT needed here, and the
-- reason is structural rather than a shortcut: SQLite's ALTER TABLE ADD COLUMN supports a CHECK
-- constraint on the new column PROVIDED it references only that column and does not require
-- validating pre-existing rows against it (SQLite docs, ALTER TABLE - and empirically confirmed
-- against this repo's better-sqlite3 build before writing this migration: a self-referential
-- \`CHECK (origin IN (...))\` added via plain ADD COLUMN accepts valid values, rejects invalid ones,
-- and leaves every existing row's new column NULL without complaint). The rebuild dance in
-- 002/004/006 was necessary because each of those CHANGED a CHECK on an EXISTING column, which
-- SQLite genuinely cannot do without DROP+RENAME. Migration 003's \`sessions.tasks_progressed\` is
-- the closer precedent: a brand-new column via plain ADD COLUMN, no rebuild, and that column just
-- didn't happen to carry a CHECK. \`rebuildsTables\` is therefore left UNSET below, matching 003 and
-- 005's discipline, not 002/004/006's - see index.ts's registration for the same note.
--
-- NO FOREIGN_KEYS DANCE. Same reasoning as 005: nothing here is a rebuild, so
-- \`PRAGMA foreign_keys = OFF/ON\` around this migration would be pure noise.

ALTER TABLE sessions ADD COLUMN origin TEXT CHECK (origin IN ('planned', 'quickstart'));

-- =====================================================================
-- Verification + version bump
-- =====================================================================

UPDATE schema_metadata SET value = '2.8.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_8_session_origin', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
`;
