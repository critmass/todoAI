// AUTO-GENERATED from 005_session_runtime.sql - do not hand-edit by hand without also updating
// the .sql source; migrations/__tests__/schemaDrift.test.ts asserts these stay byte-identical.
export const MIGRATION_005_SQL = `-- ADHD Task Management App - Schema migration 005 (v2.5 -> v2.6)
-- Task 13 (timer + episode lifecycle + crash recovery): spec §8.2's timestamp-based timers and
-- task 28 design §1.4's relaunch recovery both require state that survives a process kill, and
-- as of v2.5 there is NO HOME FOR IT. \`sessions\` holds planned_duration / started_at /
-- completed_at and nothing else; \`interactions\` records an episode only once it has CLOSED.
-- Nothing durably holds the OPEN episode's task id, its start timestamp, the current block
-- end-time, the mutated session end-time, or the pause ledger - and every one of those is load
-- bearing for "the timer kept running while the app was dead".
--
-- DECISION (task 13 brief §2a): a dedicated runtime table set, NOT columns on \`sessions\` and NOT
-- the learning_state key/value store.
--   - Columns on \`sessions\` would mix live runtime state into a historical record, re-open a
--     CHECK-bearing table for a rebuild, and leave the pause ledger homeless anyway.
--   - learning_state is task 19's watermark/tunable store; overloading it would couple two
--     unrelated subsystems behind an untyped key/value blob.
--   - A dedicated set is explicit and queryable, has the right lifetime (rows are DELETEd at
--     close, so "is there an open episode?" is \`SELECT ... FROM active_episode\` rather than a
--     nullable-column interpretation), and gives the pause ledger real columns.
--
-- EPOCH MILLISECONDS, not DATETIME - a deliberate deviation from the schema's house style,
-- confined to these three tables. Every other timestamp in this schema is a human/reportable
-- DATETIME read by SQLite date functions; these are machine state for wall-clock ARITHMETIC and
-- no SQL date function reads them. Two reasons that matter: (1) CURRENT_TIMESTAMP is
-- second-granular, and the 60-second park gate plus the remaining-time computation want
-- sub-second fidelity; (2) the timer's clock is INJECTED (\`now: number\`, epoch ms) throughout
-- src/execution/ so every timestamp path is testable headless, and storing the same unit the
-- engine computes in removes a parse/format step - and with it a class of TZ/format bugs - from
-- the crash-recovery path, which is the one path that must be right.
--
-- NO REBUILD. Three CREATE TABLEs, no CHECK widening, no view touches, no AUTOINCREMENT (see the
-- singleton note below), so this migration does NOT set \`rebuildsTables\` in index.ts and needs
-- no sqlite_sequence save/restore or drop-view-first step. It runs inside the ordinary
-- transaction path with foreign_keys enforcement left ON.
--
-- COORDINATION HAZARD (recorded per the task 13 and task 36 briefs): task 36 (recurrence period
-- engine) is in flight and may also want a migration 005. This one claims 005 / v2.6.0. Whoever
-- merges second renumbers to 006 / v2.7.0 and sweeps the prior suites' "latest version"
-- assertions again.

-- =====================================================================
-- 1. session_runtime - the movable session end (task 28 design §4.1.2)
-- =====================================================================
-- One row per session that is currently running. The planner deliberately never assumes a fixed
-- session end (src/planning/agenda.ts: "The session's planned END is movable"); a hyperfocus
-- extend that crosses it moves it, and that mutation has to outlive a process kill. Task 24 owns
-- the \`sessions\` row itself; this row is the session's live runtime and is DELETEd when the
-- session closes.

CREATE TABLE session_runtime (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    planned_end_at_ms INTEGER NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- 2. active_episode - the open episode, or no row at all
-- =====================================================================
-- SINGLETON by construction (\`CHECK (id = 1)\`): exactly one episode can be open app-wide, because
-- exactly one task is being served at a time (spec §6.2). Making that a constraint rather than a
-- convention means "the open episode" is a row that exists or doesn't - the precise condition
-- task 28 design §1.4 recovers from ("stored episode start + pause ledger exist, no recorded
-- outcome"). The row is DELETEd by every close path, so a row surviving into the next launch IS
-- the crash signal; nothing has to be inferred from a status column.
--
-- THE PAUSE LEDGER lives here as (paused_at_ms, paused_ms, pause_count) rather than a JSON blob
-- or a segment table. \`paused_at_ms\` non-null means the timer is paused right now and records
-- when; \`paused_ms\` is the closed-pause total. That is everything both consumers need - §1.4's
-- \`elapsed - known pause time\` credit and §8.2's >20%-paused coaching - and it survives a kill
-- taken mid-pause (the open pause is bounded by the block end on recovery). Per-segment rows were
-- considered and cut: nothing reads them today, and the cut is recorded in the findings report.
--
-- block_end_at_ms is MUTATED in place by both extension paths (task 28 amendment: +5 flat, or a
-- 25-minute hyperfocus quantum) and by resuming from a pause (a pause pushes the end out so the
-- interruption does not eat the block). \`planned_minutes\` keeps the ORIGINAL block size so the
-- guardrail's "beyond 2x the original block" test has a fixed reference after the mutations.
--
-- hyperfocus_quanta counts ONLY "Keep going" presses. The +5 path is deliberately not counted
-- here and cannot contribute to either guardrail arm - the split is what makes guardrail option B
-- safe to ship (task 28 amendment §4: "The guardrail never touches +5").

CREATE TABLE active_episode (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    block_kind TEXT NOT NULL CHECK (block_kind IN ('countdown', 'openBlock')),
    planned_minutes INTEGER NOT NULL CHECK (planned_minutes >= 0),
    started_at_ms INTEGER NOT NULL,
    block_end_at_ms INTEGER NOT NULL,
    paused_at_ms INTEGER,
    paused_ms INTEGER NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
    pause_count INTEGER NOT NULL DEFAULT 0 CHECK (pause_count >= 0),
    hyperfocus_quanta INTEGER NOT NULL DEFAULT 0 CHECK (hyperfocus_quanta >= 0),
    long_extend_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (long_extend_enqueued IN (0, 1))
);

-- =====================================================================
-- 3. session_task_extension - the +5 ledger, per session per task
-- =====================================================================
-- The \`repeated_extension\` coaching trigger (task 28 amendment §3) fires "within one session on
-- one task", enqueues AT TASK CLOSE (the conversation wants the real total, which doesn't exist
-- until then), and writes ONE ROW PER TASK PER SESSION. None of that fits on active_episode: a
-- task can be parked and resumed inside the same session, which ends one episode and opens
-- another while the +5 ledger must keep accumulating. So the ledger is keyed at exactly the
-- trigger's own grain, (session_id, task_id), and outlives the episodes it spans.
--
-- coaching_enqueued is the deduplication flag. Checking the coaching queue instead would be wrong
-- twice over: a resolved row would no longer be found (re-enqueueing a second time in the same
-- session), and the check would couple this ledger to queue drain timing.
--
-- Rows are DELETEd with the rest of the session's runtime when the session closes.

CREATE TABLE session_task_extension (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    presses INTEGER NOT NULL DEFAULT 0 CHECK (presses >= 0),
    minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
    coaching_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (coaching_enqueued IN (0, 1)),
    PRIMARY KEY (session_id, task_id)
);

-- =====================================================================
-- Verification + version bump
-- =====================================================================

-- Checked by the migration runner (index.ts): a non-empty result here aborts and rolls back the
-- whole migration rather than committing a broken foreign key.
PRAGMA foreign_key_check;

UPDATE schema_metadata SET value = '2.6.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_6_session_runtime', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
`;
