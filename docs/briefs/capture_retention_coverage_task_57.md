# Task 57 — test coverage for `src/capture/retention.ts` (task 53 W10)

**Brief written by the coordinator, 2026-08-22.** From task 53's audit finding W10. Small, headless,
no device. This is an **absent** test rather than a confirming one — the module has **no test file at
all**, and the mutation pass surfaced it in the same sweep.

## 0. Role
Build subagent. You author tests and verify with `npx jest` / `npx tsc --noEmit` / `npx eslint .`.
**Do not `git commit`** — leave the tree for coordinator review.

## 1. The gap

`src/capture/__tests__/` contains `availableBytes`, `forceKill`, `mutationCapture`, `record` and
`sha256` — **no `retention`**. Task 53 ran two mutations against `retention.ts` and **both survived the
full 973-test suite**:

1. 🔴 `for (const day of days.slice(0, Math.max(0, days.length - 1)))` → `for (const day of days)`
   — i.e. **rotation deletes the newest day**, against the module's own explicit rule: *"never the
   newest, which is what you are debugging."* The comment states the invariant; nothing enforces it.
2. `CAPTURE_WARN_BYTES` 80% → 20% of the ceiling — the warning threshold can be moved freely.

**Why it matters beyond coverage:** the 512 MB ceiling is the bound **task 14 reasons about** when it
treats `capture/` as reclaimable space (`retention.ts:32-35` says so), and 41/43 fill the
`reclaimSpace` hook against it. Rotation silently eating the newest day would destroy exactly the
records you are debugging with, in a module whose whole design rationale is "keep everything."

## 2. What to build

A new `src/capture/__tests__/retention.test.ts` over a **fake `CaptureWriter`** covering:

- **Rotate oldest-first.** Days are deleted in order from the oldest.
- 🔴 **Never the newest day.** With every day over the ceiling, the newest day directory survives.
  *This is mutation 1 — write it so it fails against `for (const day of days)`.*
- **Stops as soon as it is back under the ceiling** — the loop breaks rather than deleting everything
  (`bytesOnDisk` is re-read from `sizeOnDisk()` after each delete; a fake that doesn't shrink would
  hide this, so make yours shrink).
- **Under the ceiling → no rotation at all.**
- 🔴 **The warn threshold, pinned with a LITERAL.** `warn` is true at/over 80% of the ceiling and false
  below. Assert against the real number as well as the symbol — task 53's W5 showed that asserting a
  constant only against itself pins nothing, and the in-repo remedy (`factors.test.ts:45-48`,
  `src/execution/constants.ts`) is to add one literal-valued `expect` alongside. *This is mutation 2.*
- **A throwing `sizeOnDisk()`/`deleteDay()` must not propagate.** The `try/catch` is deliberate —
  *"A failed size check must not be able to stop anything"* — and the `lifecycle.capture` health
  record must still be emitted afterwards.
- **`pendingCeilingWarning()` / `dismissCeilingWarning()`**: set when warned, cleared on dismiss.
- **No writer installed → `checkCeilingAndReportHealth()` returns `null`** and does nothing.

## 3. Two hazards specific to this module

- ⚠ **`pendingWarning` is module-level mutable state** (`retention.ts:51`). It leaks between tests
  unless each one resets it (`dismissCeilingWarning()` in a `beforeEach`, or module re-import). A
  test that passes only because a previous test left the flag set is exactly the class task 53 exists
  to stop — and would be an embarrassing thing for *this* task to ship.
- **`captureWriter()`/`captureHealth()`/`record()` come from `./record`.** Look at how
  `record.test.ts` and `mutationCapture.test.ts` install a test writer and follow that pattern rather
  than inventing a new seam. **Do not change `record.ts` or `retention.ts`** — if the module is
  genuinely untestable without a seam change, stop and report that as a finding rather than
  refactoring production code to suit a test.

## 4. Constraints
- **Tests only.** No production change (see above). No schema, no migration.
- Capture's **removability** property (orientation §5) must survive: your test lives under
  `src/capture/__tests__/`, so deleting `src/capture/` still removes everything cleanly.
- Don't assert on the *absence* of a warning as evidence of anything — the module's header is
  emphatic that non-firing proves nothing. Test the mechanism, not the projection.

## 5. Test-first (`CLAUDE.md`)
The two mutations are named in §2 — apply each to `retention.ts`, watch your new test go **red**,
revert, keep the test. **Quote the failure output in your report.** A test that stays green against
`for (const day of days)` has not closed W10. Revert every mutation immediately after the check that
used it; `git status` must show only your new test file at the end.

## 6. Verify
Baseline: **998 tests / 86 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. In an isolated git
worktree `npx jest` reports the true number directly (the stale `.claude/worktrees/` duplicate is
untracked and won't be in your checkout); if you see ~1792/154 you are in the main tree — subtract the
fixed 794/68.

## 7. Deliverable
`src/capture/__tests__/retention.test.ts` (uncommitted) and a short
`docs/eval/task57_findings_report.md`: what you covered, the two mutation-failure outputs, how you
faked the writer, real jest/tsc/eslint numbers, and a section titled exactly **"Deviations from human
decisions"** (empty is valid — write it out explicitly).

## 8. Read first
1. This brief. 2. `src/capture/retention.ts` in full — the header explains why the warning is a
black-swan net and not a workflow prompt, which constrains what is worth asserting.
3. `docs/eval/test_audit_task53_findings.md` **W10** (and **W5** for the literal-pinning lesson).
4. `src/capture/__tests__/record.test.ts` + `mutationCapture.test.ts` — the existing fake/seam pattern.
5. `CLAUDE.md`.
