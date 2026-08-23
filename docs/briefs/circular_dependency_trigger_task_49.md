# Task 49 — widen `prevent_circular_dependencies` to real cycles

**Brief written by the coordinator, 2026-08-22.** Found in passing by task 14 Phase A and **pinned by
a test that deliberately asserts the bug**. Headless, no device.

## 0. Role
Build subagent. You author code + tests and verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`** — leave the tree for coordinator review.

## 1. The defect

Migration 001's trigger (`001_initial_schema.sql:381-391`) only catches a cycle of **length two** —
its `WHEN` clause tests for a single row that is the direct reverse of the one being inserted:

```sql
CREATE TRIGGER prevent_circular_dependencies
    BEFORE INSERT ON task_dependencies
    FOR EACH ROW
    WHEN EXISTS (
        SELECT 1 FROM task_dependencies td
        WHERE td.task_id = NEW.depends_on_task_id
        AND td.depends_on_task_id = NEW.task_id
    )
    BEGIN SELECT RAISE(ABORT, 'Circular dependency detected'); END;
```

**`A→B→C→A` inserts cleanly today**, with foreign keys and triggers fully on.

**Why this is more than tidiness.** U1's dependency-blocked pre-filter (task 25, mandatory) holds
blocked tasks out of the ranked pool — so a 3+ cycle means **every task in it is permanently filtered
from every session**, while uncapped neglect (constraint #5) keeps raising scores that never surface.
The tasks become invisible and stay invisible. `validateConsistency` (task 14) is currently the only
thing in the tree that can see a cycle of length ≥3, and only when something calls it.

## 2. What to build

A migration (**008**, schema **2.9.0** — 007 is task 44's; do not contend) that replaces the trigger
with one detecting a **path** from `NEW.depends_on_task_id` back to `NEW.task_id`, i.e. transitive
closure rather than the direct pair.

**The likely mechanism** is a `WITH RECURSIVE` walk inside the `WHEN EXISTS (...)` subquery. ⚠ **Verify
empirically that this build's SQLite accepts a CTE in a trigger's `WHEN` clause** — do not assume it.
op-sqlite compiles its own bundled amalgamation at **SQLite 3.51.3** (`cpp/sqlite3.c`, wired at
`android/CMakeLists.txt:79`), so the version does not vary by device, and the headless suite runs
`better-sqlite3` — **check both agree**, because a trigger that parses in one and not the other is a
device-only failure and this task has no `P` to catch it.

**If a recursive `WHEN` clause does not work**, do not force it. Bring back the alternatives with a
recommendation rather than picking silently: a trigger body that runs the check and `RAISE`s, or an
app-layer guard in the dependencies repository (weaker — the DB stops being self-defending), or
keeping the cheap pair check in the trigger and making `validateConsistency` the real defense with a
defined call site. **Say which and why in the report.**

## 3. 🔴 Two traps

**(a) Do NOT do the table-rebuild dance.** The board row says *"a CHECK/trigger change → constraint
#12's full-rebuild discipline"* — **that over-broadens constraint #12 and is wrong for a trigger.**
Constraint #12 is about *altering a CHECK on an existing column*, which SQLite cannot do without
DROP+RENAME. **A trigger is `DROP TRIGGER` + `CREATE TRIGGER`** — no table rebuild, no data movement.
*(This is the same over-broadening that produced task 44's deviation 2, which Jason ratified and which
prompted the handoff's constraint-#12 clarification. Don't repeat it.)*

**(b) You MUST still sweep prior migrations' test suites.** `runMigrations` walks the whole list
forward, so earlier suites' "latest version" and "full object list" assertions silently become
assertions about **yours**. This has surfaced live through migrations 002–006 as a failure in a file
you didn't touch, reading like unrelated breakage. Expect to update the version assertions and the
trigger/object lists. Note also `schemaDrift.test.ts` — the `.sql` ↔ `.ts` mirror guard; keep them in sync.

## 4. The test that pins the bug — update it deliberately, don't delete it

`src/services/backup/__tests__/consistency.test.ts` **asserts the current bug on purpose**, in two places:

- **`:20`** *"finds a cycle of length three, which the schema trigger does NOT catch"* — this tests the
  pure `findBackEdge` function. **Still valid; leave the assertion.** Its *title* now needs adjusting
  since the trigger will catch it.
- **`:74`** *"breaks a three-task dependency cycle the schema trigger lets through"* — this **inserts a
  3-cycle at the DB level and relies on the insert succeeding.** After your fix that insert will
  `ABORT`. 🔴 **Rewrite it to assert the trigger now REJECTS the cycle**, and keep a path that still
  exercises `validateConsistency`'s repair on **pre-existing** cycle data (rows that predate the
  migration, or inserted with the trigger temporarily disabled) — because that is exactly the case
  `validateConsistency` still exists for and it must not lose coverage.

## 5. Surface, don't decide

**The trigger is `BEFORE INSERT` only.** An `UPDATE` to `task_dependencies` can create a cycle with no
trigger firing at all — before your change and after it. Whether to add a `BEFORE UPDATE` trigger is a
scope question: note it in your report with a recommendation, and only build it if it is genuinely
free alongside the insert one. **Don't silently expand scope, and don't silently leave a hole you saw.**

## 6. Constraints
- Constraint #5 (uncapped neglect), #7 (`null` ≠ `unscheduled`), #12 as clarified in §3a.
- No app-behaviour change beyond the guard; `src/planning`'s U1 filter is untouched.
- Migration **008**, schema **2.9.0**. Both the `.sql` and its `.ts` sibling, registered in
  `src/db/migrations/index.ts`, following 005/006/007's shape exactly.

## 7. Test-first (`CLAUDE.md`) — non-negotiable
Write the failing test first: a 3-cycle insert that **should** be rejected, red before the migration
exists, green after. Then a 4-cycle. Then confirm the length-2 case still aborts (no regression) and
that a legitimate **diamond** (`A→B`, `A→C`, `B→D`, `C→D` — not a cycle) still inserts cleanly. That
last one is the one a naive transitive check breaks, so it is the assertion that matters most. **Name
each guarding test in your report.**

## 8. Verify
Baseline: **998 tests / 86 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. If you are running
in an isolated git worktree, `npx jest` reports the true number directly — the stale
`.claude/worktrees/` duplicate is untracked and will not be in your checkout. If you see ~1792/154 you
are in the main tree; subtract the fixed 794/68.

## 9. Deliverable
Migration + tests (uncommitted) and `docs/eval/task49_findings_report.md`: the mechanism you used and
the evidence it parses in **both** SQLite builds, the diamond case, how you rewrote the pinned tests,
the `BEFORE UPDATE` recommendation, the prior-suite sweep you performed, real jest/tsc/eslint numbers,
and a section titled exactly **"Deviations from human decisions"** (empty is valid — write it out).

## 10. Read first
1. This brief. 2. `src/db/migrations/001_initial_schema.sql:381-391` (the trigger) and `007_session_origin.*`
(the newest migration's shape). 3. `src/services/backup/__tests__/consistency.test.ts` +
`src/services/backup/consistency.ts` (`findBackEdge`, `validateConsistency`).
4. `docs/eval/task26_findings_report.md` (the migration-runner fix and the rebuild discipline).
5. `CLAUDE.md`; orientation §4.
