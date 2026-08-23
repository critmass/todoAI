# Task 49 — findings: widening `prevent_circular_dependencies` to real cycles

**Build subagent, 2026-08-23.** Brief: `docs/briefs/circular_dependency_trigger_task_49.md`.
Headless, no device phase. Tree left uncommitted for coordinator review.

**Outcome: migration 008 (schema 2.9.0) ships, and the recursive-CTE mechanism is confirmed —
empirically, in op-sqlite's own bundled 3.51.3 amalgamation as well as the jest runner's 3.53.2.**
No fallback was needed, so the alternatives in brief §2 were not taken. The diamond case passes.
No table was rebuilt.

---

## 1. The mechanism

`008_transitive_cycle_guard.sql` is `DROP TRIGGER` + `CREATE TRIGGER`, nothing else besides the
version bump:

```sql
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
```

It walks the existing `depends_on` graph forward from the new edge's TARGET and aborts if that walk
can reach the new edge's SOURCE. Three properties are deliberate and were each checked rather than
assumed:

1. **The seed is `NEW.depends_on_task_id` itself**, so `reachable` contains the 0-hop node. That is
   what makes a self-dependency (`N → N`) abort with no separate `NEW.task_id =
   NEW.depends_on_task_id` clause — in that case the seed already equals `NEW.task_id`. I spiked
   both forms; the extra clause is redundant, so it is not in the shipped DDL.
2. **`UNION`, not `UNION ALL`.** Load-bearing, not style: a database that already holds a cycle
   (rows written before this migration, or carried over by a salvage) would send a `UNION ALL` walk
   round that loop forever. Verified directly — with a pre-seeded 3-cycle in the table, inserts
   still return in microseconds and reject/accept correctly.
3. **The abort message is unchanged** (`'Circular dependency detected'`), because
   `src/db/repositories/dependencies.ts:49` regex-matches it to raise `CircularDependencyError`.

**No new index is needed.** The walk's inner step is `td.task_id = r.node`, and migration 001's
`UNIQUE(task_id, depends_on_task_id)` gives an implicit index that leads on `task_id` *and* carries
`depends_on_task_id` — a covering seek per hop. Measured on better-sqlite3: building a 2000-node
chain (1999 guarded inserts, each walking the whole tail built so far) costs ~13 ms in total, and
the single worst case — the edge that would close a 2000-hop chain, forcing the walk to visit every
node before deciding — costs ~1 ms.

## 2. Two-SQLite evidence (brief §2's ⚠)

The concern was real enough to be worth doing properly, since there is no `P` phase to catch a
device-only parse failure. **The same DDL and the same 12-insert accept/reject matrix were run
against four independent SQLite builds, including op-sqlite's own bytes.**

| build | version | source | `CREATE TRIGGER` | matrix |
| --- | --- | --- | --- | --- |
| **op-sqlite's bundled amalgamation** | **3.51.3** | `node_modules/@op-engineering/op-sqlite/cpp/sqlite3.c` — the file `android/CMakeLists.txt:79` compiles | **OK** | identical |
| better-sqlite3 (the jest runner) | 3.53.2 | `node_modules/better-sqlite3` 12.11.1 | OK | identical |
| Node's built-in `node:sqlite` | 3.51.2 | Node 24.14.0 | OK | identical |
| Android platform-tools CLI | 3.50.6 | `%LOCALAPPDATA%\Android\Sdk\platform-tools\sqlite3.exe` | OK | identical |

The first row is the one that answers the brief's question directly, and it is not an inference from
neighbouring versions: op-sqlite's `cpp/sqlite3.c` was compiled here with MSVC into a DLL and driven
through the C API (`sqlite3_open` / `sqlite3_exec`), printing `sqlite3_libversion() = 3.51.3` before
running the matrix. (Windows App Control blocks running a freshly built `.exe`, so the amalgamation
was loaded as a library from Python's `ctypes` instead — signed interpreter, unsigned library, which
the policy permits. The 3.51.2 and 3.50.6 rows were kept anyway as a version bracket.)

The matrix in every build: `1→2` ok, `2→3` ok, **`3→1` REJECT** (3-cycle), **`2→1` REJECT**
(2-cycle), `3→4` ok, `4→5` ok, **`5→1` REJECT** (4-hop), **`1→1` REJECT** (self), then the diamond
`6→7`, `6→8`, `7→9`, **`8→9` ok** — 8 surviving edges, the same 8 everywhere.

**Compile flags checked too, not just the version.** op-sqlite defines no `SQLITE_OMIT_*` macros for
this project: its `defaultSqliteFlags` list is populated only under `performanceMode`, and this
repo's `package.json` carries no `op-sqlite` config block at all, so the list is empty
(`node_modules/@op-engineering/op-sqlite/android/build.gradle:137-146`). Nothing in the build
removes CTE or trigger support.

## 3. The diamond — the assertion that matters most

`A→B`, `A→C`, `B→D`, `C→D` inserts cleanly. This is what a naive transitive check breaks: it is two
independent paths converging on one shared prerequisite, and nothing about it is a cycle. The guard
only asks whether the new edge closes a path back to **its own source**, which a diamond never does.

Guarded by `closes a legitimate DIAMOND cleanly: A->B, A->C, B->D, C->D is not a cycle` in
`src/db/migrations/__tests__/008_transitiveCycleGuard.test.ts`, plus two neighbours that cover the
adjacent traps: `accepts a long acyclic chain and a second edge into the same tail` (a shared tail
and a shortcut down a node's own chain — both legal) and `rejects an edge that closes a cycle
through a shared node, not only along one chain` (the converse: convergence must not become a way to
smuggle a cycle past).

## 4. Test-first, and the test that guards each change

Written and run red first. **8 of the 15 new tests failed before the migration existed**, each for
its intended reason: the three cycle-rejection cases threw nothing, the self-dependency threw
nothing, the version was `2.8.0`, and the trigger DDL contained no `WITH RECURSIVE`. The other 7
passed on the pre-migration tree by design — they describe behaviour that must be *preserved*
(diamond, chain, the length-2 case, the exact abort string) or that *documents the bug*
(`the old trigger really did let a three-cycle through`).

`src/db/migrations/__tests__/008_transitiveCycleGuard.test.ts` (15 tests):

| change | guarding test |
| --- | --- |
| 3-cycle rejected (the headline) | `rejects a three-task cycle: A->B->C->A` |
| 4-cycle rejected | `rejects a four-task cycle: A->B->C->D->A` |
| length-2 still aborts (no regression) | `still rejects the direct two-task cycle migration 001 already caught` |
| self-edge rejected by the CTE seed | `rejects a self-dependency (the degenerate one-node cycle)` |
| **diamond still inserts** | `closes a legitimate DIAMOND cleanly: A->B, A->C, B->D, C->D is not a cycle` |
| long chains / shared tails still insert | `accepts a long acyclic chain and a second edge into the same tail` |
| convergence is not a smuggling route | `rejects an edge that closes a cycle through a shared node, not only along one chain` |
| abort string unchanged (repo error mapping) | `keeps the exact abort message the repository maps to CircularDependencyError` |
| version + name | `lands at 2.9.0 and records the migration name` |
| trigger replaced, not duplicated | `replaces the trigger rather than adding a second one` |
| the bug being fixed, on the pre-008 schema | `the old trigger really did let a three-cycle through - that is what 008 exists for` |
| legacy DB holding a cycle still migrates | `migrates a database that already contains a cycle without failing, leaving the rows for the consistency sweep` |
| **no table rebuild** | `preserves task_dependencies rows and their ids - no table rebuild, only DROP/CREATE TRIGGER` |
| idempotence | `is idempotent: running twice does not reapply 008 or throw` |
| FK enforcement restored | `keeps foreign_key_check empty and enforcement restored (no rebuild dance needed here)` |

Plus `MIGRATION_008_SQL is byte-identical to 008_transitive_cycle_guard.sql` in
`schemaDrift.test.ts` (the `.sql` ↔ `.ts` mirror; the `.ts` is machine-generated from the `.sql`,
never hand-edited), and one new salvage test — see §6.

## 5. The pinned tests in `consistency.test.ts` — how they were rewritten

Both places the brief flagged were handled as instructed, and **`validateConsistency`'s repair
coverage is not merely preserved, it is now exercised against the state it actually exists for.**

**`:20`, the pure `findBackEdge` case.** Assertion untouched. Title changed from *"finds a cycle of
length three, which the schema trigger does NOT catch"* to **`finds a cycle of length three`**, with
a comment saying why it survives: `findBackEdge` is the *repair* half, and the trigger cannot fix a
cycle already on disk.

**`:74`, the DB-level case.** Split into two, because the old test was carrying two claims and only
one of them is still true:

- **`the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)`** — the
  same three edges, now asserting that the third one aborts and never reaches the table.
- **`breaks a PRE-EXISTING three-task cycle — rows the trigger could not have stopped`** — keeps the
  original repair assertions verbatim (`cyclesBroken === 1`, two edges left, second sweep finds
  nothing), against a cycle seeded *around* the trigger.

Seeding that state needed a helper, since the trigger now refuses to create a cycle of any length.
`seedPreExistingCycle` (`src/db/testUtils/backupFixture.ts`) reads the trigger's own DDL out of
`sqlite_master`, drops it, inserts, and replays the DDL verbatim — **exactly the dance `salvage.ts`
already performs**, so the fixture reproduces a real code path rather than inventing one. Tests that
want damaged data now ask for it explicitly instead of relying on a hole in the schema. It is used
by `consistency.test.ts`, `ladder.test.ts`, and the new salvage test.

## 6. The prior-suite sweep (brief §3b)

`runMigrations` walks forward, so earlier suites' "latest version" assertions were assertions about
008 the moment it registered. **12 suites / 24 tests went red on the first full run after the
migration landed** — none of them files this task set out to touch. All swept:

**Version and migration-name assertions** (`'2.8.0'` → `'2.9.0'`, `'v2_8_session_origin'` →
`'v2_9_transitive_cycle_guard'`), plus the prose comments and test titles that name which migrations
"ride along":

- `src/db/migrations/__tests__/002_skillLayerSchema.test.ts` (×2, + "003-008 ride along")
- `src/db/migrations/__tests__/003_multisessionWork.test.ts` (×1, + "004-008 ride along")
- `src/db/migrations/__tests__/004_algorithmWeightsReconciliation.test.ts` (×2, + "005 through 008")
- `src/db/migrations/__tests__/005_sessionRuntime.test.ts` (×4 + last_migration, + "006-008")
- `src/db/migrations/__tests__/006_recurrencePeriod.test.ts` (×4 + last_migration, + title)
- `src/db/migrations/__tests__/007_sessionOrigin.test.ts` (×4 + last_migration, + title)
- `src/db/migrations/__tests__/index.test.ts` (×1 + comment)
- `src/services/backup/__tests__/backup.test.ts`, `restore.test.ts` (×4), `salvage.test.ts` (×2)

**Object lists needed no change.** The trigger is *replaced*, not added, so
`['prevent_circular_dependencies', 'update_tasks_timestamp']` in 002/004/005/006/`index.test.ts` is
still correct — and `008_transitiveCycleGuard.test.ts` asserts that explicitly rather than leaving it
implied.

**Two suites failed for a reason that was not the version**, and both were seeding a 3-cycle through
the very hole this task closes:

- `src/services/backup/__tests__/ladder.test.ts` — *"runs the periodic consistency sweep on a healthy
  database when asked"* inserted `1→2, 2→3, 3→1` directly. Rewritten to use `seedPreExistingCycle`.
- `src/services/backup/__tests__/consistency.test.ts` — the pinned test, §5.

**One new test added while sweeping**, because 008 makes an existing code path load-bearing in a way
it was not before: `salvage.test.ts` → **`carries a source that already contains a long cycle across,
then breaks it`**. Salvage drops triggers precisely so `INSERT … SELECT` cannot abort on damaged
data; with the widened trigger, *any* cycle in the source would now abort the whole
`task_dependencies` copy rather than just a reversed pair. **Proven to be a real detector, not
decoration:** mutating `salvage.ts` to leave `prevent_circular_dependencies` in place during the copy
makes it fail on exactly the intended assertion (`consistency.cyclesBroken` 1 → 0, because the bulk
copy aborts and the row-by-row fallback silently drops the cycle-closing edge — the exact data loss
the dance prevents). The mutation was reverted.

**Comments corrected where 008 falsified them** (documentation, no behaviour, so no test — stated
per `CLAUDE.md`'s carve-out): `src/services/backup/consistency.ts`'s ⚠ header block (it said the
trigger catches only 2-cycles and that "migration 007 is claimed by task 44"),
`src/db/repositories/dependencies.ts`'s header, and `src/services/backup/salvage.ts`'s
trigger-dropping rationale.

## 7. 🔴 No table rebuild (brief §3a)

`rebuildsTables` is left **unset** for 008 in `src/db/migrations/index.ts`, with the reason recorded
inline. Constraint #12's DROP+RENAME discipline exists because SQLite cannot `ALTER` a `CHECK` on an
**existing column** (migrations 002/004/006). A trigger is not a column: `DROP TRIGGER` +
`CREATE TRIGGER` replaces it outright, moves no data, and touches no table definition. Rebuilding
`task_dependencies` here would have been pure risk for no benefit. Asserted by `preserves
task_dependencies rows and their ids - no table rebuild, only DROP/CREATE TRIGGER`, which compares
the full row set (ids included) across the migration, and by the `foreign_key_check` /
`PRAGMA foreign_keys` test showing no FK dance was needed.

## 8. Surfaced, not decided: the `BEFORE UPDATE` hole

**The trigger is `BEFORE INSERT` only — before this change and after it.** An `UPDATE` that rewrites
`task_dependencies.task_id` or `depends_on_task_id` can create a cycle of any length with no trigger
firing at all.

**Recommendation: leave it, and record it — do not add a `BEFORE UPDATE` twin in this task.**
Reasoning, for whoever picks this up:

- **It is not reachable from app code today.** `grep` finds no `UPDATE` against
  `task_dependencies` anywhere in `src/`. The dependencies repository only `INSERT`s and `DELETE`s
  (`src/db/repositories/dependencies.ts`), and an edge is changed by removing and re-adding it —
  which routes through the guard.
- **It is not free.** A `BEFORE UPDATE` twin is not the same predicate: it must ignore the row being
  updated (otherwise a no-op `UPDATE` of an existing edge would see its own row and abort), which
  means a different, less obvious WHEN clause, and it needs its own diamond/self-edge/no-op matrix.
  That is a second thing to get right, not a copy-paste, and brief §5 was explicit about not
  silently expanding scope.
- **The consequence is bounded and already covered.** A cycle created that way is exactly the
  "pre-existing damage" case `validateConsistency` exists for, and §5's helper now gives it a
  fixture. The hole is written into `008_transitive_cycle_guard.sql`'s header and
  `consistency.ts`'s so it cannot be lost.

If the answer is "close it anyway", the natural shape is a second trigger with the same CTE plus
`WHERE td.id <> OLD.id` in the walk, and the same four-case matrix.

## 9. Verification

Run in the isolated worktree, so these are true counts (the stale `.claude/worktrees/` duplicate is
not in this checkout — baseline re-measured here first and it matched the brief exactly).

| | baseline | after |
| --- | --- | --- |
| `npx jest` | **998 tests / 86 suites**, all pass | **1016 tests / 87 suites, all pass** |
| `npx tsc --noEmit` | clean | **clean (exit 0)** |
| `npx eslint .` | 0 errors / 56 warnings | **0 errors / 56 warnings** |

+18 tests, +1 suite: 15 in the new `008_transitiveCycleGuard.test.ts`, 1 in `schemaDrift.test.ts`,
1 from splitting the pinned `consistency.test.ts` case in two, 1 new salvage test.

**Files touched.** New: `src/db/migrations/008_transitive_cycle_guard.sql`, its generated `.ts`
sibling, `src/db/migrations/__tests__/008_transitiveCycleGuard.test.ts`. Modified:
`src/db/migrations/index.ts`, `schemaDrift.test.ts`, the six prior migration suites,
`index.test.ts`, `src/db/testUtils/backupFixture.ts`, `src/db/repositories/dependencies.ts`
(comment), `src/services/backup/{consistency,salvage}.ts` (comments), and
`src/services/backup/__tests__/{consistency,ladder,salvage,backup,restore}.test.ts`.
**Nothing in `src/planning` was touched** — U1's filter is untouched, as required.

## 10. Deviations from human decisions

**None.**

The one thing worth flagging as an *addition* rather than a deviation: the brief scoped the work to
the migration plus the two pinned tests, and I also added one test to `salvage.test.ts` (§6) and a
shared `seedPreExistingCycle` fixture. Both fell out of the sweep the brief mandated — `ladder.test.ts`
was seeding a cycle the same way `consistency.test.ts` was, and the salvage drop-and-replay became
load-bearing for a wider class of source data the moment the trigger widened. Neither changes app
behaviour, and the salvage test was mutation-verified before being kept.
