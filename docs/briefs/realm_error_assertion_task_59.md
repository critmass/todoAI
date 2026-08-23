# Task 59 — fix the realm-fragile error assertion (the reproduced flake)

**Brief written by the coordinator, 2026-08-22.** The diagnosis is **already done** — see
`docs/eval/housekeeping_2026-08-22_report.md` **Part B**. Read it; do not re-derive it. Your job is the
fix, done test-first, plus one production check.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.**

## 1. What is broken (summary — the report has the evidence)

The failing test is always the same one: `src/services/backup/__tests__/consistency.test.ts` →
*"the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)"*, at roughly
lines 89–91:

```ts
await expect(
  db.execute('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', [3, 1]),
).rejects.toThrow(/Circular dependency detected/);
```

**It is ORDER-dependent, not load-dependent.** Measured: consistency-first **6/6 pass**, consistency-last
**6/6 fail**; 0/10 failures under CPU load, and failing runs were *faster* than passing ones.

**Mechanism:** `better-sqlite3`'s `SqliteError` is a hand-rolled pseudo-Error
(`Object.setPrototypeOf(SqliteError.prototype, Error.prototype)`) with **no `[[ErrorData]]` slot**, and
`database.js:59` hands it to the **native addon, which Node caches per PROCESS, not per Jest realm**. So
`err instanceof Error` is true when the suite runs early and **false** when it runs later; Jest's
`isError()` then falls through to a cross-realm `instanceof` and reports *"Received function did not
throw."* In **both** cases the insert genuinely throws `SQLITE_CONSTRAINT_TRIGGER` with the right
message.

🔴 **Migration 008 and the product code are CORRECT. Do not "fix" the trigger or the migration.** The
sibling `008_transitiveCycleGuard.test.ts` never flakes because it uses the synchronous
`expect(() => …).toThrow()` form, which never consults `isError`.

## 2. Test-first — and here it means *reproduce first*

🔴 **Before changing anything, reproduce the failure deterministically**, by running the suite with
`consistency.test.ts` scheduled **last** (the housekeeping report describes the command-line sequencer
approach). You must see it fail. **A fix you cannot first watch fail is not verified** — that is the
whole lesson of task 53, and this task is a direct descendant of it.

Then fix, then prove it: the same consistency-last ordering must now pass, **repeatedly** (≥5 runs),
plus a normal full-suite run.

## 3. The fix — two options, you choose and justify

- **Narrow:** assert the rejection *value* rather than `Error`-ness at `consistency.test.ts:89-91`
  (e.g. `.rejects.toMatchObject({ message: /Circular dependency detected/ })`, or catch and assert on
  the message directly). Minimal blast radius; fixes this one site only.
- **Better:** normalise driver errors into a **real `Error` of the current realm** in `wrapDatabase`
  (`src/db/testUtils/sqliteTestConnection.ts`), so every suite using the test connection is immune.
  Wider benefit, but it is **shared test infrastructure used by many suites** — a mistake there is a
  broad breakage, so if you take it, run the whole suite in several orderings.

**Recommend one, state the tradeoff, and say plainly whether you also applied the other.** If you take
the narrow fix, note in the report that the class of bug remains reachable by any future
`.rejects.toThrow()` against a driver error — that is a real residual and should be written down, not
left implicit.

## 4. One production check — report, do not necessarily change

`src/db/repositories/dependencies.ts:52` uses the **same** `err instanceof Error` pattern in production:

```ts
const message = err instanceof Error ? err.message : String(err);
if (/Circular dependency detected/i.test(message)) { throw new CircularDependencyError(...); }
```

It is safe today because the `String(err)` fallback still yields a string containing the message — so
`CircularDependencyError` is still raised either way. **Confirm that reasoning holds** (write a test if
it is cheap), and report whether it deserves hardening. Note the production driver is **op-sqlite**,
not better-sqlite3, so the realm quirk may not even arise there — say which you established and which
you are inferring. **Do not change production behaviour without flagging it as a deviation.**

## 5. Constraints
- No schema, no migration, no change to migration 008 or the trigger.
- Don't weaken the assertion into something that would pass if the trigger stopped firing. The test
  must still fail if the cycle is *not* rejected — **prove that** by re-running it against the task-49
  mutation (`return tasksRecovered;`-style: temporarily revert the trigger to the length-2 form, or
  point the insert at a DB without 008) and watching it go red.

## 6. Verify
Baseline **1026 tests / 88 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. ✅ **The worktree
duplication is gone as of 2026-08-22** — raw `npx jest` now reports the true number; no subtraction.

## 7. Deliverable
The fix (uncommitted) + `docs/eval/task59_findings_report.md`: the reproduction command and its output,
which fix you chose and why, the ≥5 consistency-last passes, the proof the test still fails when the
cycle is *not* rejected, your finding on `dependencies.ts:52`, and a section titled exactly
**"Deviations from human decisions"** (empty is valid — write it out).

## 8. Read first
1. This brief. 2. `docs/eval/housekeeping_2026-08-22_report.md` **Part B** (the full diagnosis).
3. `src/services/backup/__tests__/consistency.test.ts`, `src/db/testUtils/sqliteTestConnection.ts`,
`src/db/repositories/dependencies.ts`. 4. `CLAUDE.md`.
