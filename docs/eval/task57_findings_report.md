# Task 57 — findings: test coverage for `src/capture/retention.ts`

**Build subagent, 2026-08-23.** From task 53's audit finding W10
(`docs/eval/test_audit_task53_findings.md`). Brief: `docs/briefs/capture_retention_coverage_task_57.md`.

**Outcome: `retention.ts` now has a test file — it had none — and both W10 mutations are proven
detectors.** One new file, `src/capture/__tests__/retention.test.ts` (10 tests), no production
change.

---

## 1. What was missing

`src/capture/__tests__/` had `availableBytes`, `forceKill`, `mutationCapture`, `record`, `sha256` —
no `retention`. Task 53 ran two mutations against `checkCeilingAndReportHealth()` and both survived
the full 973-test suite:

1. `for (const day of days.slice(0, Math.max(0, days.length - 1)))` → `for (const day of days)` —
   rotation deletes the newest day, against the module's own explicit rule (`retention.ts:47`):
   "never the newest, which is what you are debugging."
2. `CAPTURE_WARN_BYTES` computed at 80% of the ceiling → 20%.

## 2. What the new suite covers

`src/capture/__tests__/retention.test.ts`, ten tests in five `describe` blocks:

- **Rotate oldest-first, stop once back under the ceiling.** Four days at ~⅓ of the ceiling each
  (178,956,971 B); deleting the oldest two lands at 357,913,942 B, under the 536,870,912 B ceiling,
  and the loop stops there rather than continuing.
- 🔴 **Never the newest day, even when the ceiling stays exceeded.** Four days each individually
  over the ceiling (`CAPTURE_CEILING_BYTES + 1000`), so rotating the oldest three never gets back
  under it. The newest day still survives and `bytesOnDisk` is still asserted `>` the ceiling
  afterward — this is what makes the assertion discriminate the real loop (bounded by
  `days.length - 1`) from the mutant (bounded by nothing).
- **No rotation at all when already under the ceiling.**
- 🔴 **The warn threshold, pinned with a literal.** `expect(CAPTURE_WARN_BYTES).toBe(429496729)` —
  512 MiB × 0.8, floored — plus a boundary test at the literal byte counts 429496728 (warn false)
  and 429496729 (warn true), per task 53's W5 lesson that a constant compared only to itself pins
  nothing.
- **The try/catch does not propagate**, in two shapes: `sizeOnDisk()` throwing before any rotation
  is attempted, and `deleteDay()` throwing mid-rotation after `sizeOnDisk()` already succeeded. Both
  assert the `lifecycle.capture` health record is still emitted (via the same fake writer's
  captured `append()` calls) with the correctly-measured `bytesOnDisk`.
- **`pendingCeilingWarning()` / `dismissCeilingWarning()`** — set to the returned state when a check
  warns, cleared on dismissal; and confirmed to stay `null` after a check that doesn't warn (state
  hygiene, not treated as evidence of anything per the module's own header).
- **No writer installed** → `checkCeilingAndReportHealth()` returns `null`, `pendingCeilingWarning()`
  stays `null`, and `captureHealth().droppedTotal` doesn't move (confirming `record()` — and
  therefore the writer-null no-op path inside it — is never reached at all on this branch, not just
  that it fails silently).

## 3. How the writer was faked

Followed the `record.test.ts` / `mutationCapture.test.ts` pattern: a plain object literal
implementing `CaptureWriter`, installed via `setCaptureWriter`. The one addition needed for
`retention.ts` specifically — those two existing fakes hardcode `sizeOnDisk: () => 0` and
`listDays: () => []`, which would hide every rotation behavior — is a real mutable `Map<string,
number>` of day → bytes that both `sizeOnDisk()` and `deleteDay()` read from, so deleting a day
actually shrinks what the next `sizeOnDisk()` call reports, exactly as the brief calls out
(`retention.ts` re-reads `sizeOnDisk()` after each delete). `append()` is captured into a `written[]`
array so the `lifecycle.capture` health record can be inspected. Throw-toggles
(`setThrowOnSizeOnDisk` / `setThrowOnDeleteDay`) let the try/catch tests turn a specific call into a
failure without needing a second writer implementation.

## 4. 🔴 The two mutation-failure outputs

Both applied to `src/capture/retention.ts`, checked with
`npx jest src/capture/__tests__/retention.test.ts`, then reverted immediately.

**Mutation 1** — `days.slice(0, Math.max(0, days.length - 1))` → `days`:

```
● rotation (design §6 rule 4, "never the newest, which is what you are debugging") › never deletes the newest day, even when the ceiling is still exceeded afterward

  expect(received).toEqual(expected) // deep equality

  - Expected  - 0
  + Received  + 1

    Array [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
  +   "2026-08-04",
    ]

    136 |     expect(fake.deletedDays).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);

Test Suites: 1 failed, 1 total
Tests:       1 failed, 9 passed, 10 total
```

The newest day (`2026-08-04`) was deleted under the mutant — exactly the violation the rule forbids.

**Mutation 2** — `CAPTURE_WARN_BYTES = Math.floor(CAPTURE_CEILING_BYTES * 0.8)` → `* 0.2`:

```
● the warn threshold (task 53 W5: pin with a literal, not just the symbol) › is 80% of the ceiling, and that is asserted against a literal

  expect(received).toBe(expected) // Object.is equality

  Expected: 429496729
  Received: 107374182

    160 |     expect(CAPTURE_WARN_BYTES).toBe(429496729);

● the warn threshold (task 53 W5: pin with a literal, not just the symbol) › warns at or above the threshold and not below it, checked against literal byte counts

  expect(received).toBe(expected) // Object.is equality

  Expected: false
  Received: true

    166 |     expect(checkCeilingAndReportHealth()?.warn).toBe(false);

Test Suites: 1 failed, 1 total
Tests:       2 failed, 8 passed, 10 total
```

Two tests go red: the literal pin itself, and the boundary-crossing test (429,496,728 bytes now
reads as over the mutant's lowered threshold). Both mutations reverted; `git diff` against
`retention.ts` is empty and `git status --porcelain` shows only the new test file.

## 5. Verification

Run in this worktree.

| check | result |
| --- | --- |
| `npx jest` | **87 suites passed / 1008 tests passed** — baseline 86/998, **+1 suite / +10 tests** |
| `npx tsc --noEmit` | clean, exit 0 (one intermediate error fixed — see §6) |
| `npx eslint .` | **0 errors, 56 warnings** — unchanged from baseline |

## 6. A TypeScript narrowing snag, not a production issue

An earlier draft of the two try/catch tests used
`expect(() => { state = checkCeilingAndReportHealth(); }).not.toThrow()`, assigning the outer
`state` variable from inside the closure passed to `expect`. `tsc` then reported `state` as type
`never` at the following `state?.bytesOnDisk` reads (TS does not re-widen a `let` variable's
narrowed type across a function-literal boundary the way it does for direct assignment in the same
scope). Replaced with a plain `try { state = checkCeilingAndReportHealth(); } catch { threw = true; }`
in the same lexical scope, which type-checks cleanly and asserts the identical thing (`threw` is
`false`). Test-only change; no effect on what's covered.

## Test-first compliance (`CLAUDE.md`)

This is an absent-test task (task 53 W10), not a bug fix, so there was no red state to reproduce
before writing anything — the module had zero coverage. The applicable discipline here is the
brief's own: write the test, then apply each of the two named mutations and watch it go red before
trusting it, which is what §4 above records for both. All ten tests were run green before either
mutation was applied, confirming they pass for the right reason against the real code, not just
against the absence of assertions.

## Deviations from human decisions

None. The brief's fake-writer approach, the module-level `pendingWarning` reset hazard, the literal
pinning requirement, and the "do not touch `record.ts` / `retention.ts`" constraint were all
followed as written; no seam change was needed.
