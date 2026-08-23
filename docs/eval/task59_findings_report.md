# Task 59 — findings report: the realm-fragile error assertion

**Build subagent, 2026-08-23, isolated worktree `.claude/worktrees/agent-a85c4bb59f5a35490`.
Uncommitted, per the brief.** Diagnosis was not re-derived; it is
`docs/eval/housekeeping_2026-08-22_report.md` Part B.

**Verdict.** Reproduced deterministically first, then fixed at the boundary (`wrapDatabase`), then
proved the fix does not weaken the assertion. `consistency.test.ts` is **byte-for-byte unchanged** —
it still asserts exactly what it asserted before, and still goes red when the cycle is not rejected.
Migration 008, the trigger and all product code are untouched.

---

## 1. Reproduction — watched fail before anything was changed

Order-forcing sequencer, supplied on the command line only (nothing in the repo touched), written to
the scratchpad as `seqLast.js`:

```js
const Sequencer = require('.../node_modules/@jest/test-sequencer').default;
class ConsistencyLastSequencer extends Sequencer {
  sort(tests) {                       // consistency.test.ts last, everything else alphabetical
    const copy = Array.from(tests);
    copy.sort((a, b) => {
      const al = /consistency\.test\.ts$/.test(a.path) ? 1 : 0;
      const bl = /consistency\.test\.ts$/.test(b.path) ? 1 : 0;
      return al !== bl ? al - bl : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return copy;
  }
  shard(tests) { return tests; }
}
module.exports = ConsistencyLastSequencer;
```

```
npx jest src/services/backup --runInBand --no-cache --testSequencer=<scratchpad>/seqLast.js
```

**Failed on the first attempt**, exactly as Part B predicted:

```
PASS src/services/backup/__tests__/backup.test.ts
PASS src/services/backup/__tests__/ladder.test.ts (20.097 s)
PASS src/services/backup/__tests__/restore.test.ts
PASS src/services/backup/__tests__/salvage.test.ts (5.142 s)
PASS src/services/backup/__tests__/sessionGate.test.ts
FAIL src/services/backup/__tests__/consistency.test.ts
  ● validateConsistency › the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)

    expect(received).rejects.toThrow(expected)
    Expected pattern: /Circular dependency detected/
    Received function did not throw

    > 91 |     ).rejects.toThrow(/Circular dependency detected/);

Test Suites: 1 failed, 5 passed, 6 total
Tests:       1 failed, 59 passed, 60 total
```

---

## 2. Which fix, and why

**Taken: the better one — normalise driver errors into a real `Error` of the current realm at the
test-connection boundary (`src/db/testUtils/sqliteTestConnection.ts`).**
**Not taken: the narrow one.** `consistency.test.ts` was not edited at all.

Reasoning:

- The narrow fix repairs one assertion and leaves the trap armed. The next person who writes
  `await expect(db.execute(...)).rejects.toThrow(...)` against a driver error re-opens the identical
  bug, and it will again present as a mysterious order-dependent flake — the most expensive failure
  mode this repo has paid for twice now (task 53, then Part B's 24-run campaign).
- The boundary fix also removes the need for anyone to *know* about the realm quirk. Assertions can
  stay written the obvious way.
- The stated risk of the boundary fix — shared infrastructure, broad blast radius — is real and was
  answered by measurement, not by assertion: the full suite is green in four different orderings
  (§5), including 89 suites in **one process** with `consistency.test.ts` genuinely last.
- The normaliser is deliberately conservative in the direction that matters: an error that is
  **already a real `Error` of this realm passes through by identity**, so every existing
  `instanceof CircularDependencyError` / `toBeInstanceOf(NoSpaceError)` style assertion is untouched.
  Only unrecognisable objects are rebuilt, and `message`, `name`, `code` and the driver `stack` are
  all carried over — `isDiskFullError`'s `.code` check (`src/services/backup/errors.ts:47`) keeps
  working unchanged.

### Files changed (all test-only; no production file was modified)

| File | Change |
|---|---|
| `src/db/testUtils/sqliteTestConnection.ts` | New exported `normaliseDriverError` + internal `isOwnRealmError` / `callDriver`; every call into better-sqlite3 (`prepare`/`all`/`run`, and `exec` for BEGIN/COMMIT/ROLLBACK, and `close`) now goes through `callDriver`. |
| `src/db/testUtils/fileDbOperations.ts` | One line: the raw driver error captured when `new Database(file)` fails (`openError`) is normalised too — the only other place test infra hands a raw better-sqlite3 error to a test. |
| `src/db/testUtils/foreignRealmError.ts` *(new)* | Test helper: builds the cross-realm `SqliteError` shape deterministically with `vm.runInNewContext('Error')`. |
| `src/db/testUtils/__tests__/sqliteTestConnection.test.ts` *(new)* | The regression suite for the normalisation (6 tests). |
| `src/db/repositories/__tests__/dependencies.test.ts` | +1 test pinning the production reasoning at `dependencies.ts:52` (§6). |

One deliberate non-normalisation, commented in place: the error thrown by the **caller's own
callback** inside `transaction(fn)` is rethrown as-is. Normalisation belongs at the driver boundary,
not on app errors, and there is a test for that (`does not touch an error thrown by the caller
inside transaction()`).

---

## 3. Test-first — the new behaviour was watched fail first

The original symptom is order-dependent, so a naive unit test of it would pass vacuously when run
alone. `foreignRealmError.ts` removes that: it manufactures a genuine second realm with
`vm.runInNewContext('Error')` and builds an object with better-sqlite3's exact `SqliteError` shape
(non-enumerable `message`/`name` descriptors, a `code`, and a prototype chain ending at the *foreign*
`Error.prototype`). The condition is then deterministic regardless of file position.

**Before the fix** — `npx jest src/db/testUtils/__tests__/sqliteTestConnection.test.ts --no-cache`:

```
● wrapDatabase — driver error normalisation (task 59) › execute() rejects with a real Error, ...
    expect(received).rejects.toThrow(expected)
    Expected pattern: /Circular dependency detected/
    Received function did not throw

● ... › preserves name, code and the driver stack while normalising
    expect(received).toBeInstanceOf(expected)
    Expected constructor: Error
    Received constructor: Error          ← the cross-realm signature, in as many words

● ... › normalises driver errors raised by transaction control statements too
    Received function did not throw

Tests:       3 failed, 3 passed, 6 total
```

The three that pass before the fix are the guards: the precondition test (`RAW instanceof Error` is
`false`, `[object Object]`, but `String(RAW)` is still `"SqliteError: Circular dependency detected"`)
and the two pass-through tests. They are supposed to pass in both states — they are what would catch
the fix over-reaching.

**After the fix**: `Tests: 6 passed, 6 total`.

**Tests that guard each change** (as CLAUDE.md requires them named):

- `wrapDatabase` normalisation → `src/db/testUtils/__tests__/sqliteTestConnection.test.ts` (all 6),
  plus the original `consistency.test.ts` cycle assertion under consistency-last ordering.
- `fileDbOperations` `openError` normalisation → covered indirectly by the existing ladder/restore
  corruption suites (green in all orderings); **no new dedicated test** — stated here rather than
  left silent. It is one line reusing an already-tested function, and the raw-vs-normalised
  distinction is unobservable to the existing assertions, which match on message and `code`.
- `dependencies.ts:52` reasoning → `dependencies.test.ts` → *"still maps the trigger ABORT to
  CircularDependencyError"* (§6; mutation-proved).

---

## 4. Proof the fix does not weaken the test

The brief's requirement: the assertion must still go red if the cycle is genuinely **not** rejected.
`src/db/migrations/008_transitive_cycle_guard.ts` was temporarily reverted to migration 001's
length-two `WHEN EXISTS` form and the same consistency-last command re-run:

```
FAIL src/services/backup/__tests__/consistency.test.ts
  ● validateConsistency › the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)

    expect(received).rejects.toThrow()

    Received promise resolved instead of rejected
    Resolved to value: {"insertId": 3, "rows": [], "rowsAffected": 1}

    > 89 |     await expect(

Test Suites: 1 failed, 5 passed, 6 total
Tests:       1 failed, 59 passed, 60 total
```

Note the message is *different* from the flake's — "**promise resolved instead of rejected**", with
the inserted row's `insertId: 3` printed. That is the assertion catching a real regression rather
than mistaking a thrown error for a non-throw. The mutation was reverted immediately;
`git status --porcelain` confirms `008_transitive_cycle_guard.ts` is unmodified, and the full suite
(which includes `schemaDrift.test.ts`'s byte-identical `.sql`/`.ts` check) is green.

---

## 5. Verification

Consistency-last runs, all on the **final** code state unless noted:

| Run | Command | Result |
|---|---|---|
| Pre-fix reproduction | `src/services/backup`, in-band, consistency last | **1 failed / 60** |
| 6 × post-fix (before the `fileDbOperations` line) | same | **6 / 6 pass**, 60/60 each |
| 5 × post-fix (final state) | same | **5 / 5 pass**, 60/60 each |
| Full suite, **one process**, consistency last of 89 suites | `npx jest --runInBand --testSequencer=…seqLast.js` | **1033 / 1033 pass** |
| Full suite, parallel, consistency last, ×2 | `npx jest --testSequencer=…seqLast.js` | **1033 / 1033 pass** each |
| Full suite, **reverse-alphabetical**, one process | `npx jest --runInBand --testSequencer=…seqReverse.js` | **1033 / 1033 pass** |
| Full suite, normal ordering | `npx jest` | **1033 / 1033 pass, 89 / 89 suites** |

- `npx tsc --noEmit` — **clean** (exit 0).
- `npx eslint .` — **0 errors, 56 warnings** (exit 0), identical to baseline.
- `npx jest` — **1033 tests / 89 suites**, all green. Baseline was 1026 / 88; the delta is exactly
  the 6 new normalisation tests + 1 new `dependencies` test, and 1 new suite. No subtraction (the
  worktree duplication was removed on 2026-08-22, and this worktree's own `rootDir` scopes the run
  to itself).
- **One transient failure, recorded for honesty and not glossed:** an early full run reported
  `1 failed, 88 passed` where `006_recurrencePeriod.test.ts` died inside
  `write-file-atomic → ScriptTransformer.writeCacheFile` — a Jest transform-cache write collision on
  Windows, not an assertion. The immediately following identical run was 1033/1033 green, and it
  never recurred across the seven subsequent full runs.

---

## 6. The production check — `src/db/repositories/dependencies.ts:52`

```ts
const message = err instanceof Error ? err.message : String(err);
if (/Circular dependency detected/i.test(message)) { throw new CircularDependencyError(...); }
```

**Finding: the brief's reasoning holds, it is now pinned by a test, and it does not need hardening.**

### What I established by measurement, in this worktree

1. better-sqlite3 (`^12.11.1`) really is the hand-rolled shape — read directly from
   `node_modules/better-sqlite3/lib/sqlite-error.js`: a plain `function SqliteError`, patched with
   `Object.setPrototypeOf(SqliteError.prototype, Error.prototype)`, `name` defined on the prototype,
   `this.code = code`.
2. For an error with that shape whose chain ends in a **foreign** realm's `Error.prototype`:
   `err instanceof Error` is `false`, `Object.prototype.toString.call(err)` is `[object Object]`, and
   `String(err)` is **`"SqliteError: Circular dependency detected"`** — asserted in
   `sqliteTestConnection.test.ts`. The fallback survives because `Error.prototype.toString` is
   inherited through the (foreign) chain and reads `this.name` / `this.message` generically.
3. Driving the real repository with such an error still raises the typed error: new test
   *"dependenciesRepository.add — a driver error unrecognisable as an Error (task 59) › still maps
   the trigger ABORT to CircularDependencyError"*.
4. That test is a genuine detector, not decoration: mutating line 52 to
   `err instanceof Error ? err.message : ''` makes it fail —

   ```
   ● … › still maps the trigger ABORT to CircularDependencyError
       expect(received).rejects.toThrow(expected)
       Expected constructor: CircularDependencyError
       Received function did not throw
   ```

   The mutation was reverted; `dependencies.ts` is unmodified in the final diff.

### What I am inferring, not establishing

- **The production driver is op-sqlite, not better-sqlite3, and I did not run it.** Whether
  `@op-engineering/op-sqlite` throws a real `Error` or a look-alike is unverified here; this task is
  headless with no device phase.
- **I infer the realm quirk cannot arise in the app at all**, because the mechanism needs two
  JS realms sharing one process-cached native addon. The app is a single Hermes realm with one
  loaded copy of op-sqlite and no module-registry reset; there is no second `Error.prototype` for a
  chain to terminate at. The flip is, on this reasoning, a Jest-only artefact.
- So line 52 is correct **twice over** in production: `instanceof` is true in a single realm, and the
  `String(err)` fallback carries the message even if it were not.

### Recommendation

**Leave it as it is.** It is now correct *by test* as well as by fallback. If a future task wants it
correct by design rather than by fallback, the minimal edit is to stop asking about `Error`-ness at
all — `String((err as { message?: unknown })?.message ?? err)` — but that is a cosmetic change to
working code and I did **not** make it, since the brief forbids changing production behaviour
without flagging a deviation and there is nothing here worth deviating for.

**Found in passing, unchanged:** `src/services/backup/errors.ts:51` (`isDiskFullError`) carries the
same `err instanceof Error ? err.message : String(err ?? '')` shape. It is safer still — it checks
`.code === 'SQLITE_FULL'` first and only falls back to the message — and the same `String(err)`
reasoning applies. Reported, not touched.

---

## 7. Residual risk (smaller than the narrow fix would have left, but not zero)

Because the boundary fix was taken, `.rejects.toThrow()` against a driver error is now safe for
**everything routed through `wrapDatabase` / `createTestConnection` / `fileDbOperations`** — which is
every suite that uses the test connection. What remains reachable:

1. **`conn.raw`.** `createTestConnection` exposes the bare better-sqlite3 handle, and several suites
   use it (e.g. `dependencies.test.ts` `conn.raw.prepare(...).run(...)`). An error thrown from `raw`
   bypasses the normaliser. In practice these calls are **synchronous**, and the synchronous
   `expect(() => …).toThrow()` form never consults `isError` — which is exactly why
   `008_transitiveCycleGuard.test.ts` has never flaked. The trap only springs on the **promise** form
   against a **raw** driver error.
2. **Any future test that constructs its own better-sqlite3 `Database` directly** rather than going
   through the test utils.
3. This is test infrastructure only. Nothing here changes what ships to the device.

If either residual ever matters, the containment is already exported: `normaliseDriverError` can be
applied at the new site.

---

## Deviations from human decisions

**One, small, and it is an extension rather than a contradiction.** The brief scoped the "better
fix" to `wrapDatabase`. I also normalised the single raw-driver-error escape in
`src/db/testUtils/fileDbOperations.ts` (`openError`, from a `new Database(file)` that fails) — one
line reusing the same exported function, in the same test-only file cluster, because leaving it
would have made the report's "no raw driver error escapes the boundary" claim untrue. It changes no
production code and no assertion outcome; the full suite is green in four orderings with it in place.

Nothing else. Migration 008, the trigger, `consistency.test.ts` and all production code are exactly
as they were; the two temporary mutations (§4, §6) were reverted and confirmed reverted by
`git status`. Nothing was committed.
