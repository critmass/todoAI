# Task 54 — guard the recovery ladder's salvage-rejection policy (task 53 W1)

**Brief written by the coordinator, 2026-08-22.** Numbered from task 53's top audit finding
(`docs/eval/test_audit_task53_findings.md` W1). 🔴 **This is a data-loss path, and it is live** — task
14's §13 wiring (committed `ad73281`, 2026-08-21) means `runRecoveryLadder` now runs at **every app
launch**. When the test was written the ladder was dormant code; it is not any more.

## Role
Build subagent. You author code + tests and verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. No device work. **Do not `git commit`** — leave the tree for coordinator review.

## The defect (demonstrated, not suspected)

`src/services/backup/ladder.ts:69-72`:

```ts
function defaultAcceptSalvage(report: SalvageReport): boolean {
  const tasksRecovered = report.recovered.some((entry) => entry.table === 'tasks');
  return tasksRecovered && report.taskRowsRecovered > 0;
}
```

Task 53 demonstrated that **the second conjunct is asserted by nothing** — this mutation passes the
full suite **973/973**:

```
return tasksRecovered && report.taskRowsRecovered > 0;   →   return tasksRecovered;
```

Three tests in `src/services/backup/__tests__/ladder.test.ts` look like they cover it. None do:

- **`:68`** "salvages a corrupt working database and promotes the rebuild" — reaches the default
  policy but only on the **accepting** branch (400 tasks seeded, so `taskRowsRecovered > 0`).
- **`:97`** "falls through to restore when the salvage recovers nothing worth keeping" — 🔴 **the
  title names the policy but the fixture never reaches it.** It corrupts the file **`'header'`**, and
  its own comment says *"A file with no readable header is not a database at all — nothing to
  salvage"* — so `salvageDatabase` **throws** and control leaves via the `catch` at `ladder.ts:152`.
  `accept()` is never called. This test exercises the exception path.
- **`:123`** "honours an injected salvage policy that rejects a lossy rebuild" — injects
  `acceptSalvage: () => false`, testing that the **seam** is honoured, not that the **default** is right.

**Why it matters.** The accepting branch calls `promoteToWorking(...)` — which **overwrites the user's
working database** — then returns `status: 'salvaged'`, so **step 3 (restore-from-backup) never
runs**. A wrong policy silently replaces a recoverable database with an **empty** one while a good
backup sits unused on disk. `ladder.ts`'s own header names exactly this class: *"A ladder that wiped a
device because it ran out of automatic options would be the single worst bug this task could ship."*

## What to build

### 1. The missing test (this is the deliverable)

🔴 **Test-first, and the ordering is the whole point of this task** (`CLAUDE.md`). Write the test,
then **apply the mutation above and watch it fail**, then revert the mutation and confirm it passes.
**A test that still passes against `return tasksRecovered;` has fixed nothing** — that is precisely the
failure task 53 exists to stop. Report the observed failure message.

**The discriminating case** is a salvage that *succeeds* but recovers the `tasks` table with **zero
rows** — `tasksRecovered === true` **and** `taskRowsRecovered === 0`. That is the only shape that
separates the real policy from the mutant. A fixture that throws (header corruption) does not reach
the policy at all, which is the trap `:97` already fell into.

**Suggested fixture** (verify it empirically — the corruption behaviour is measured, not assumed):
seed the working DB with N tasks → `createBackup(...)` so a good backup exists → `DELETE FROM tasks`
in the working DB → close it → `corruptDatabaseFile(path, 'lastPage')` → run the ladder. Expect
`status === 'restored'`, and the restored `tasks` count === N (the rows came from the backup, not the
empty salvage).

⚠ **Confirm the fixture actually lands where you think.** Before asserting, check that the run reaches
`accept()` with `taskRowsRecovered === 0` — not the `catch`. `'lastPage'` is the documented
partial-damage mode (`fileDbOperations.ts`: *"the database still describes itself and most of it
reads, but integrity_check fails"*); `'header'`/`'page'`/`'truncate'` are the other modes if
`'lastPage'` on a near-empty file doesn't produce the shape you need. If no fixture can produce
`tasksRecovered && taskRowsRecovered === 0` against this schema, **stop and report that** — it would
mean the second conjunct is unreachable in practice, which is a finding, not a failure.

**Helpers available** (`src/db/testUtils/backupFixture.ts`, `fileDbOperations.ts`): `createFixture`,
`seedWorking(fixture, count)`, `countRows`, `WORKING`, `corruptDatabaseFile(target, mode)`,
`fixture.ops.pathFor(...)`. Match the existing suite's style.

### 2. Fix the misleading test title at `:97`

Its title claims policy coverage it does not provide, and a future reader will trust it exactly as
task 53's audit initially might have. Rename it to what it actually tests — the unreadable-file /
salvage-throws path (e.g. *"falls through to restore when the file cannot be salvaged at all"*) — and
keep its comment. **Change no assertion**; this is a naming fix.

## Constraints
- **Do not change `defaultAcceptSalvage`'s behaviour.** This task adds the missing guard around the
  policy as written. If you believe the policy itself is wrong (e.g. it should also weigh the backup's
  age against the salvage's completeness — `ladder.ts:15-21` puts exactly that question to Jason and
  deliberately leaves it open), that is a **product decision: surface it, do not make it.**
- No schema, migration, or production-logic change. Tests + one test title.
- Don't touch the other Phase-A backup internals.

## Verify
Baseline: **973 tests / 86 suites** real, `tsc` clean, `eslint` 0 errors / 56 warnings. ⚠ Raw
`npx jest` reports ~1767/154 — a stale worktree (`.claude/worktrees/…`) adds a fixed **794/68**.
Quote the real number, never the raw.

## Deliverable
The new test + the title fix, uncommitted, plus a short report at
`docs/eval/task54_findings_report.md`: the fixture as built and why it reaches the policy, 🔴 **the
observed failure output when run against `return tasksRecovered;`** (the proof it is a real
detector), the real jest/tsc/eslint numbers, and a **"Deviations from human decisions"** section
(empty is valid — write it out explicitly).

## Read first
1. This brief. 2. `docs/eval/test_audit_task53_findings.md` §W1. 3. `src/services/backup/ladder.ts`
(esp. the header and `:69-72`, `:119-152`). 4. `src/services/backup/__tests__/ladder.test.ts`.
5. `src/services/backup/salvage.ts` (`SalvageReport`). 6. `CLAUDE.md` (the test-first bar).
