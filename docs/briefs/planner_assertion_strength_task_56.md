# Task 56 — planner assertion strength (task 53 findings W3/W4/W6/W7/W9)

**Brief written by the coordinator, 2026-08-22.** Five planner guards that **name a spec rule in their
title and do not measure it**. Every one was demonstrated by a surviving mutation against the full
suite — the exact mutations are in `docs/eval/test_audit_task53_findings.md`. Read that; this brief
does not restate the evidence.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.**

## 1. Scope — tests only

🔴 **This is an assertion-strengthening task. Do NOT change `src/planning/` production code.** Every
finding below is "the code is probably right, but nothing would notice if it weren't." If you believe a
finding reveals a genuine *behaviour* bug rather than a test gap, **stop and report it** — that becomes
its own task with its own ruling. Fixing planner behaviour under cover of a test task is exactly the
kind of unsanctioned change task 45 exists to audit.

## 2. The five, with their mutations

| # | Guard | Mutation that survives 973/973 |
|---|---|---|
| **W3** | *"allocates at most two major tasks…"* — enforced by **capacity, not the limit**: the fixture's third task is rejected by `isPlaceableInBlock`, so the rule the title names is unmeasured | `if (deepItems.length >= 2) break;` → `>= 3` |
| **W4** | the **25 % deep-focus overrun buffer can be deleted entirely** — the only discriminating assertion is a 40-min task that fits in both 45 and 60 work-minutes | `Math.floor(blockMinutes * (1 - DEEP_FOCUS_OVERRUN_BUFFER))` → `blockMinutes` |
| **W6** | the §5.3.2 **difficulty gradient is entirely unguarded** — nothing asserts within-group ordering direction, and nothing asserts the jitter is real | sort reversed (easy→hard becomes hard→easy); **and** `DIFFICULTY_JITTER = 1.5` → `0` |
| **W7** | the pre-deep-block break is **not counted against front-section capacity**, so the front section may overrun the session by 5 minutes unnoticed | `const preDeepBreak = … ? BREAK_MINUTES : 0;` → `0` |
| **W9** | the equal-energy group **tie-break is unguarded** — groups with equal mean energy fall back to insertion order rather than score order | drop `\|\| maxScore(b) - maxScore(a)` |

**Remediation shapes** are given per-finding in the audit report (re-size fixtures so only the *limit*
can stop placement; add a boundary case the buffer decides; a **seeded statistical** assertion for the
gradient). Follow them or better them, but say which.

## 3. W6 deserves a moment's thought

The gradient assertion must tolerate the jitter **by construction** rather than by luck — a
fixed-seed single-draw assertion that happens to pass is another vacuous test. The audit's suggestion is
a mean-position assertion over N seeded rolls (the low-energy task's mean index below the
high-energy one's), which is false under **both** the reversal and the zero-jitter mutation. ⚠ Also note
task 55 pinned `DIFFICULTY_JITTER`'s **value** with a literal but explicitly recorded that this is *not*
a substitute for W6's **behavioural** guard — so don't consider it covered.

## 4. Test-first — the mutations are the acceptance criteria
For each of the five: apply the named mutation, watch your new/strengthened assertion go **red**,
revert, keep it. **Quote each failure output in the report.** A strengthened test that stays green
against its own mutation has fixed nothing — that is the entire finding task 53 was chartered on, and
this task is its remediation. Revert every mutation immediately after the check that used it; the tree
must be clean of them at the end.

## 5. Constraints
- Tests only (§1). No production change, no schema, no migration.
- Don't delete or weaken existing assertions — **add** discriminating ones. Where a fixture must be
  re-sized to give the rule room to bite (W3, W4), keep the original intent of the test visible.
- Watch for knock-on: re-sizing a planner fixture can shift other assertions in the same suite. Fix
  them honestly rather than loosening them, and say what moved.

## 6. Verify
Baseline **1026 tests / 88 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. ✅ The worktree
duplication was removed 2026-08-22 — raw `npx jest` is now the true number; no subtraction.

## 7. Deliverable
Strengthened tests (uncommitted) + `docs/eval/task56_findings_report.md`: per finding — what you
asserted, the mutation-failure output, and anything you had to re-size and why; plus a section titled
exactly **"Deviations from human decisions"** (empty is valid — write it out).

## 8. Read first
1. This brief. 2. `docs/eval/test_audit_task53_findings.md` **W3, W4, W6, W7, W9** (and §3's note on the
in-repo literal-pinning remedy). 3. `src/planning/planner.ts` + `src/planning/__tests__/planner.test.ts`
+ `plannedMinutes.test.ts`. 4. Spec v2.4 §5.3 (the rules these tests name). 5. `CLAUDE.md`.
