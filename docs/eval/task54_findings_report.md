# Task 54 — findings: guarding the recovery ladder's salvage-rejection policy

**Build subagent, 2026-08-22.** Numbered from task 53's top audit finding
(`docs/eval/test_audit_task53_findings.md` W1). Brief: `docs/briefs/ladder_salvage_guard_task_54.md`.

**Outcome: the missing guard now exists and is a proven detector.** One new test in
`src/services/backup/__tests__/ladder.test.ts`, one test title corrected, no production change.

---

## 1. What was missing

`defaultAcceptSalvage` (`src/services/backup/ladder.ts:69-72`) is the last thing standing between a
successful-but-empty salvage and `promoteToWorking(...)` overwriting the user's working database —
after which the ladder returns `status: 'salvaged'` and **step 3 (restore-from-backup) never runs**.
Task 53 demonstrated the second conjunct was asserted by nothing: mutating

```
return tasksRecovered && report.taskRowsRecovered > 0;   →   return tasksRecovered;
```

left the whole suite green. The three tests that looked like coverage were the accepting branch, the
injected-seam branch, and — misleadingly titled — the exception branch.

## 2. The fixture, and why it reaches the policy rather than the `catch`

The discriminating shape is a salvage that **succeeds** with `tasks` in `report.recovered` and
`taskRowsRecovered === 0`. Getting there was measured, not assumed.

**Measured first (a throwaway spike, since deleted).** Every file-only corruption tried against a
working database whose `tasks` table had been emptied **failed to produce the shape**:

| fixture | integrity | salvage | `accept()` reached? |
| --- | --- | --- | --- |
| seed N → `DELETE FROM tasks` → `'lastPage'` | **passes** (`healthy`) | not run | no |
| same → `'page'` | fails | throws `unable to open database` | no |
| same → `'truncate'` / `'header'` | fails | throws `malformed` / `not a database` | no |
| same → `VACUUM` → `'lastPage'` | fails | throws `unable to open database` | no |

The brief's suggested fixture (`DELETE FROM tasks` then `'lastPage'`) lands in row 1: after the
delete the tail of the file is freelist, and garbling a free page does not trip `integrity_check` —
the ladder stops at `healthy` and never reaches step 2 at all. Two variants **did** reach the policy
(padding a `tasks`-independent table so the last page is live data), but their story is "the user had
no tasks anyway", which is not the data-loss case.

**Shipped fixture** — the true data-loss shape, 400 real tasks that salvage cannot read:

1. `seedWorking(fixture, 400)` → `createBackup(...)`, so a complete backup of all 400 exists.
2. `corruptDatabaseFile(pathFor(WORKING), 'lastPage')` — genuine byte damage, so
   `PRAGMA integrity_check` really fails and the ladder really reaches step 2.
3. `fixture.ops.setQueryFault((sql) => /salvagesrc\."tasks"/.test(sql) && !/rowid AS rid/.test(sql))`
   — every read of the **source's** task rows fails the way an unreadable page does. The rowid scan
   is deliberately left working: that is what makes `copyTable` degrade to the row-at-a-time path,
   skip all 400 rows, and still report the table as **recovered** rather than **lost**. (This is the
   documented purpose of `setQueryFault` — "how a table that is present but CORRUPT is modelled",
   `fileDbOperations.ts` — and the same seam `salvage.test.ts:151,169` already uses.)
4. Run the ladder with **no** `acceptSalvage` injected, so the default policy is what decides.

**Verified empirically before asserting anything** (spike instrumentation, with `acceptSalvage` used
only as a probe that recorded the report and returned false):

```
acceptCalled: true,
tasksEntry:   {"table":"tasks","rowsCopied":0,"rowsSkipped":400,"degraded":true},
taskRowsRecovered: 0,
lost: [],
attempts: ["integrity_check:false: *** in database main *** Tree 8 page 97 cell 3: Offset 42405 …",
           "salvage:false:salvage rejected: 0 task row(s) recovered",
           "restore:true:restored todoai.backup.a.db (2026-08-17 09:00:01.000)"]
```

`accept()` **is** called (not the `catch`), with exactly `tasksRecovered === true &&
taskRowsRecovered === 0`. The fault is cleared immediately after the ladder returns, and the matcher
is scoped to the `salvagesrc.` alias so it cannot touch the restore or the assertions.

## 3. The new test asserts, in order

- the shape reached the policy: `tasks` ∈ `recovered`, `taskRowsRecovered === 0`;
- `status === 'restored'`, `attempts` = `integrity_check → salvage → restore`;
- the salvage attempt's detail starts `salvage rejected:` — **the branch discriminator**: the
  `catch` writes the SQLite error string into that field instead, which is exactly how the old `:97`
  test looked like coverage without being it;
- `workingDbReplaced === true`;
- the working database ends with **400** rows — they came from the backup, not the empty salvage.

## 4. 🔴 The mutation proof

Applied `return tasksRecovered && report.taskRowsRecovered > 0;` → `return tasksRecovered;` in
`src/services/backup/ladder.ts`, then `npx jest src/services/backup/__tests__/ladder.test.ts`:

```
  ● runRecoveryLadder › rejects a salvage that rebuilds the tasks table EMPTY and restores the backup instead

    expect(received).toBe(expected) // Object.is equality

    Expected: "restored"
    Received: "salvaged"

    > 158 |     expect(outcome.status).toBe('restored');

Test Suites: 1 failed, 1 total
Tests:       1 failed, 8 passed, 9 total
```

And with the intermediate assertions temporarily disabled, so the mutant runs all the way to the
consequence — this is the data loss itself, 400 rows replaced by an empty database while a complete
backup sat unused on disk:

```
    expect(received).toBe(expected) // Object.is equality

    Expected: 400
    Received: 0

    > 171 |     expect(await countRows(rebuilt, 'tasks')).toBe(400);
```

Mutation reverted; `ladder.ts` is byte-identical to `HEAD` (`git diff` touches only the test file).
Unmutated, the ladder suite is 9/9 green.

## 5. The title fix

`ladder.test.ts` — *"falls through to restore when the salvage recovers nothing worth keeping"* →
**"falls through to restore when the file cannot be salvaged at all"**. Its fixture corrupts the
`'header'`, so `salvageDatabase` throws and the policy is never consulted; the old title claimed
coverage that the new test actually provides. No assertion changed, comment kept.

## 6. Surfaced, not decided — two properties of the policy as written

Per the brief these are **product decisions for Jason**; nothing here acts on them, and
`defaultAcceptSalvage` is unchanged.

1. **A legitimately empty `tasks` table is indistinguishable from a lost one.** A user who has
   cleared their list and then hits corruption gets the *backup* restored, which resurrects tasks
   they deliberately deleted. The policy reads "zero tasks" as "salvage failed" — correct for the
   damage case, wrong for the empty case. Nothing available at that point tells the two apart
   (`taskRowsRecovered` is a count, not a provenance).
2. **`report.lost` is not weighed at all.** A salvage that recovers one task row but loses every
   other table is accepted, and the (possibly complete, possibly minutes-old) backup goes unused.
   This is the same open question `ladder.ts:15-21` already puts to Jason about salvage-versus-backup
   age; the task row count is currently the whole of the answer.

## 7. Verification

Run at the repo root with the mutation reverted.

| check | result |
| --- | --- |
| `npx jest` (raw) | **1768 passed / 154 suites** — includes the stale worktree |
| `npx jest` **real** (worktree excluded, measured not subtracted) | **974 passed / 86 suites** — baseline 973/86, **+1**, the new test |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint .` | **0 errors, 56 warnings** — unchanged from baseline |

The worktree's contribution was confirmed rather than assumed: re-running with
`--testPathIgnorePatterns` excluding `.claude\worktrees\` yields 974/86 directly, so the stale tree's
fixed 794/68 is intact.

## Test-first compliance (`CLAUDE.md`)

The ordering **was** the task and was followed literally: the test was written first, the audit's
mutation applied, the failure observed and recorded above (§4), the mutation reverted, and the test
confirmed green. No carve-out was used. The test guarding the change is
`src/services/backup/__tests__/ladder.test.ts` → *"rejects a salvage that rebuilds the tasks table
EMPTY and restores the backup instead"*. The measurement spike used to find the fixture was a
throwaway file and has been deleted.

## Deviations from human decisions

**One.** The brief's suggested fixture (seed N → backup → `DELETE FROM tasks` → close →
`corruptDatabaseFile(..., 'lastPage')`) was measured and **does not reach the policy** — after the
delete the corrupted tail page is freelist, `integrity_check` passes and the ladder returns
`healthy` at step 1 (§2, row 1). The brief explicitly anticipated this ("verify it empirically — the
corruption behaviour is measured, not assumed") and named the fallback modes; all four file-only
modes were tried and none produced the shape, so the shipped fixture adds the `setQueryFault` seam on
top of real `'lastPage'` damage. That is a change of fixture mechanism, not of the case under test —
and it produces the stronger scenario the brief was aiming at: 400 real tasks lost, rather than zero
tasks present. No constraint was crossed: `defaultAcceptSalvage` is unchanged, and nothing outside
the test file and this report was touched.
