# Task 58 — test-hygiene sweep (task 53 findings W8/W11/W12)

**Brief written by the coordinator, 2026-08-22.** Three small, unrelated items from task 53's audit.
Evidence is in `docs/eval/test_audit_task53_findings.md`; this brief does not restate it.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.**

## 1. W8 — `contextGroupKey`'s NUL escape is a documented claim with no test

`src/scoring/score.ts:121-124` makes an explicit behavioural claim in its comment — *"so a task tagged
literally `flexible` never merges into the no-tags group"* — and **nothing tests it**. The mutation
`return '\x00flexible';` → `return 'flexible';` survives the full suite.

Add one test: a task with `contextTags: ['flexible']` alongside a task with `contextTags: []` must get
**different** group keys. Low blast radius (a shuffle-grouping oddity), but it is a stated invariant
with zero coverage.

⚠ **Context worth knowing:** this sentinel is why `score.ts` was a *binary* file to git until 2026-08-01
— the raw `0x00` byte sat inside git's first-8KB binary sniff, so **every diff of the scoring
composition ever reviewed showed `Bin 8860 → 9177 bytes` instead of lines.** The value is byte-identical
today (a source escape rather than a raw byte) and it is a `Map` key — never persisted, never displayed
— so there was never a behavioural defect. **Do not "clean up" the sentinel**; just test the claim.

## 2. W11 — `blockKindsAgree` is a compile-time guard dressed as a runtime assertion

`src/execution/__tests__/timer.test.ts:22-24, 79-83`:

```ts
const blockKindsAgree: BlockKindsAgree = true;
it("keeps the planner's BlockKind and the stored EpisodeBlockKind identical", () => {
  expect(blockKindsAgree).toBe(true);
});
```

The runtime assertion is a tautology — a constant compared to the literal it was just set to. **The real
guard is the type annotation**: if the unions diverge, `BlockKindsAgree` resolves to `false` and the
assignment is a type error. But jest runs through **babel-jest** (`@react-native/jest-preset`, types
stripped, never checked), so **`npx jest` cannot detect the drift this test appears to guard.** Only
`npx tsc --noEmit` can.

🔴 **The guard genuinely exists — this is *misleading*, not *absent*.** Do **not** delete it. Rename the
test and add a comment making the enforcement mechanism explicit, so a green jest run is never read as
proof the two vocabularies agree. ⚠ Name the real risk in the comment: **a CI path that runs jest but
not `tsc` would silently lose this guard entirely.**

## 3. W12 — the last migration's version bump has no downstream guard

**This one is a note, not a code change.** The audit found the migration forward-sweep hazard is
*present in the assertions but not in the outcome*: each migration's version bump is guarded by the
**next** migration's legacy fixture, so the chain is complete by construction — verified across 002–007
(and now 008). **But the LAST migration in `MIGRATIONS` has no downstream fixture**, so its bump is
unguarded until a successor lands. Demonstrated: mutating 002's own version bump left 002's suite green;
it was caught only by `schemaDrift.test.ts` and by 003's legacy fixture.

**Today that means migration 008 (task 49, schema 2.9.0) is the unguarded one.** Record this where the
next migration author will actually see it — a comment in `src/db/migrations/index.ts` and/or the
migration-authoring convention — stating that whoever writes **009** both guards 008 and inherits the
same gap. **If a cheap direct guard for the newest migration's bump is obvious to you, propose it in the
report rather than building it** (it would change the sweep convention, which is a wider call).

## 4. Test-first
W8 is a new behavioural assertion: **write it, watch it fail against `return 'flexible';`, revert,
keep it** — quote the failure. W11 and W12 are a rename/comment and a documentation note respectively:
**carve-outs under `CLAUDE.md`, and you must state them explicitly in the report as carve-outs**, not
skip them silently.

## 5. Constraints
- No production behaviour change. W8 touches only a test; W11 touches a test's name/comment; W12 is a
  comment/convention note.
- Do not delete the `blockKindsAgree` construct or its type — the type *is* the guard.
- Do not alter `contextGroupKey`'s sentinel value.

## 6. Verify
Baseline **1026 tests / 88 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. ✅ The worktree
duplication was removed 2026-08-22 — raw `npx jest` is now the true number; no subtraction.

## 7. Deliverable
Changes (uncommitted) + `docs/eval/task58_findings_report.md`: the W8 mutation-failure output, the W11
wording you chose, where you recorded W12 and any guard you propose, and a section titled exactly
**"Deviations from human decisions"** (empty is valid — write it out explicitly), plus your stated
test-first carve-outs.

## 8. Read first
1. This brief. 2. `docs/eval/test_audit_task53_findings.md` **W8, W11, W12**.
3. `src/scoring/score.ts:110-130`, `src/execution/__tests__/timer.test.ts:1-90`,
`src/db/migrations/index.ts`. 4. `CLAUDE.md`.
