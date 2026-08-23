-- ADHD Task Management App - Schema migration 008 (v2.8 -> v2.9)
-- Task 49: widen `prevent_circular_dependencies` from a two-node check to a real reachability
-- check. Found in passing by task 14 Phase A and pinned by a test that deliberately asserted the
-- bug (src/services/backup/__tests__/consistency.test.ts).
--
-- THE DEFECT. Migration 001's trigger tested exactly one shape in its WHEN clause: an existing row
-- that is the direct reverse of the row being inserted. It caught A->B / B->A and nothing longer,
-- so A->B->C->A inserted cleanly with foreign keys and triggers fully on.
--
-- WHY THAT IS MORE THAN TIDINESS. U1's dependency-blocked pre-filter (task 25, mandatory) holds
-- blocked tasks out of the ranked pool. A cycle of three or more therefore makes EVERY task in it
-- permanently unselectable in every session - each one waits on a predecessor that is itself
-- waiting - while uncapped neglect (constraint #5) keeps raising scores that can never surface.
-- The tasks become invisible and stay invisible, and nothing in the app reports it. Before this
-- migration, `validateConsistency` (src/services/backup/consistency.ts) was the only code in the
-- tree that could see a cycle of length three or more, and only when something called it.
--
-- THE MECHANISM. The WHEN clause now walks the existing depends_on graph forward from
-- NEW.depends_on_task_id with a recursive CTE and aborts if that walk can reach NEW.task_id -
-- i.e. if the new edge would close a path back to its own source. Two properties matter:
--
--   1. THE WALK IS SEEDED WITH NEW.depends_on_task_id ITSELF, so `reachable` contains the 0-hop
--      node. That is what makes a self-dependency (task N depends on task N) abort too, with no
--      separate NEW.task_id = NEW.depends_on_task_id clause - the seed already equals NEW.task_id
--      in that case. Verified, not assumed.
--   2. UNION, NOT UNION ALL. The dedupe is load-bearing, not a style choice: a database that
--      already contains a cycle (rows written before this migration, or recovered by a salvage
--      with enforcement off) would send a UNION ALL walk round that loop forever. UNION makes the
--      walk terminate on any graph, cyclic or not.
--
-- COST, AND WHY NO NEW INDEX IS NEEDED. The walk's inner step is `td.task_id = r.node`, and
-- task_dependencies already carries UNIQUE(task_id, depends_on_task_id) from migration 001 -
-- whose implicit index leads on task_id AND contains depends_on_task_id, so each hop is a covering
-- index seek, not a scan. Measured against this repo's better-sqlite3 build: building a 2000-node
-- chain (1999 guarded inserts, each walking the whole tail built so far) takes ~13 ms total, and
-- the single worst-case insert - the edge that would close a 2000-hop chain, forcing the walk to
-- traverse every node before deciding - takes ~1 ms. A personal task graph is orders of magnitude
-- smaller than that.
--
-- WHAT IT DELIBERATELY DOES NOT REJECT: a DIAMOND. A->B, A->C, B->D, C->D is perfectly legal -
-- two independent paths converging on one prerequisite - and a naive "is the target already
-- transitively entangled with the source" check rejects it. The guard here only asks whether the
-- new edge closes a path back to its own SOURCE, which a diamond never does. Covered by
-- migrations/__tests__/008_transitiveCycleGuard.test.ts, the assertion that matters most here.
--
-- BOTH SQLITE BUILDS PARSE IT (this task ships headless, with no device phase to catch a
-- divergence, so it was checked empirically rather than assumed). A recursive CTE inside a
-- trigger's WHEN clause is accepted, and produces this exact accept/reject matrix, on:
-- better-sqlite3's 3.53.2 (the jest runner), op-sqlite's OWN bundled amalgamation at 3.51.3
-- (node_modules/@op-engineering/op-sqlite/cpp/sqlite3.c, the bytes that ship to the device -
-- compiled and driven directly for this check), Node's built-in node:sqlite at 3.51.2, and the
-- Android platform-tools CLI at 3.50.6. op-sqlite enables no SQLITE_OMIT_* flags for this
-- project, so nothing in its build removes CTE support.
--
-- NO TABLE REBUILD, AND THAT IS NOT A SHORTCUT. Constraint #12's DROP+RENAME discipline exists
-- because SQLite cannot ALTER a CHECK on an EXISTING COLUMN (migrations 002/004/006). A trigger
-- is not a column: DROP TRIGGER + CREATE TRIGGER replaces it outright, moves no data, and touches
-- no table definition. Rebuilding `task_dependencies` here would be pure risk for no benefit, so
-- `rebuildsTables` is left UNSET in index.ts - matching 003/005/007's discipline.
--
-- IT DOES NOT VALIDATE EXISTING ROWS. A BEFORE INSERT trigger fires on inserts, so a database
-- that already holds a cycle keeps it after this migration - which is why the migration cannot
-- fail on legacy data, and why `validateConsistency`'s cycle breaker still exists and still has
-- its own coverage. That function is the repair path for damage already on disk; this trigger is
-- the guard that stops new damage.
--
-- KNOWN GAP, RECORDED NOT CLOSED: this trigger is BEFORE INSERT only, exactly as migration 001's
-- was. An UPDATE that rewrites task_dependencies.task_id or depends_on_task_id can still create a
-- cycle with no trigger firing. Nothing in the app UPDATEs this table today (the dependencies
-- repository only INSERTs and DELETEs - src/db/repositories/dependencies.ts), so the hole is not
-- reachable through app code; adding a BEFORE UPDATE twin is a scope decision for a later task
-- (task 49 report, "BEFORE UPDATE").

DROP TRIGGER IF EXISTS prevent_circular_dependencies;

CREATE TRIGGER prevent_circular_dependencies
    BEFORE INSERT ON task_dependencies
    FOR EACH ROW
    WHEN EXISTS (
        WITH RECURSIVE reachable(node) AS (
            SELECT NEW.depends_on_task_id
            UNION
            SELECT td.depends_on_task_id
              FROM task_dependencies td
              JOIN reachable r ON td.task_id = r.node
        )
        SELECT 1 FROM reachable WHERE node = NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'Circular dependency detected');
    END;

-- =====================================================================
-- Verification + version bump
-- =====================================================================

UPDATE schema_metadata SET value = '2.9.0', updated_at = CURRENT_TIMESTAMP WHERE key = 'version';
UPDATE schema_metadata SET value = 'v2_9_transitive_cycle_guard', updated_at = CURRENT_TIMESTAMP WHERE key = 'last_migration';
