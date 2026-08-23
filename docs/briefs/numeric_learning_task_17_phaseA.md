# Task 17 Phase A — make the historical-success signal real (+ task 55)

**Brief written by the coordinator, 2026-08-22.** A **supplement** to the existing work order
`docs/briefs/numeric_learning_task_17.md` — read that one too; it is not superseded and must not be
edited. This brief **phases** task 17 and folds in **task 55** (task 53's scoring findings W2 + W5),
because they are the same question from two directions.

> **Do not back-edit** `numeric_learning_task_17.md`, `docs/eval/task44_findings_report.md`, or
> `docs/eval/test_audit_task53_findings.md`. They are point-in-time records. Write a **new** report.

## 0. Role and boundary

Build subagent. You author code + tests and verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. Headless — no device. **Do not `git commit`**; leave the tree for coordinator review.

## 1. Why this is phased (scope control, deliberate)

Task 17 as originally briefed is six learning loops + hierarchical shrinkage + regression protection
+ rollback + the missing writer. That is too much for one pass to do *well*, and this is the tier
where a shallow job is worse than none — a silently-degrading learned state is invisible until
rankings just feel wrong.

- **Phase A (this brief):** make the historical-success signal **real and guarded**. The writer that
  does not exist, plus the two scoring-assertion gaps task 53 demonstrated. Self-contained, closes a
  live scoring gap, and settles the definitions Phase B builds on.
- **Phase B (queued, not yours):** the six §5.4 loops, shrinkage, regression protection, rollback.

## 2. What Phase A builds

### (a) The `completion_count` / `success_rate` writer — the live gap

🔴 **No writer exists anywhere** (task 13 report §7). `historicalSuccessFactor` scores **every task**
off a permanent `n=0`, so R6's smoothing runs on empty across the whole app — a 23% weight
contributing nothing real. Task 17 owns this writer; orientation §9 says so.

**The core design question, which task 44 deliberately left to you:** *what counts as an attempt?*
Task 44's report §3 spells out the sub-questions — does a skip count against it? an abandoned
episode? a self-completion with no episode at all? — and explicitly declines to answer them, because
they are "exactly the kind of real design question orientation §9 assigns to task 17."

🔴 **The code already encodes half an answer, and task 53 found it unguarded.**
`src/scoring/score.ts:73-75` passes `task.completionCount + task.skipCount` as `attemptCount`. So
*the scorer's* definition is **attempts = completions + skips**. Your writer must be consistent with
that, or one of the two must change deliberately and be surfaced. Do not let them silently disagree.

**Three inherited constraints — honour them, they are already reasoned:**

1. 🔴 **Never write `completion_count` alone.** Task 44 §3 considered and **rejected** it: a
   `completion_count` that increments while `success_rate` stays frozen at `0.0` is **worse** than
   both-untouched, because `n` starts looking non-zero to any code using it as a proxy for "has this
   been observed" while the rate stays fictional.
2. **Self-completion** (task 44's `notes='self_completed'`, `session_id IS NULL`) *"should almost
   certainly count toward `completion_count`"* — the task really is done. Whether it counts toward
   `success_rate`'s numerator, denominator, both, or neither is **the open question you must answer
   and surface.** The `notes` marker is what lets duration-weighted aggregates exclude these rows
   without a new column.
3. **A crash is not user failure** (constraint #11's spirit; original brief §3a). A recovered crash
   writes `completion_status='abandoned'`; it should **not** drag down a task's success rate. Confirm
   your writer treats it that way, and note that task 19 owns the parallel friction-incident
   definition — flag any divergence rather than deciding for 19.

🔴 **Whatever you decide about "attempt" is PRODUCT-INTENT and is provisional until Jason rules it.**
Implement your recommendation, and put it in the report's Deviations section with the reasoning and
the alternatives — do not fold it into orientation §5 as settled.

### (b) Task 55 / W2 — pin the `skipCount` wiring

Task 53 demonstrated that dropping `+ task.skipCount` from the `attemptCount` argument passes
**973/973**, because **no fixture in `src/scoring` or `src/planning` sets `skipCount` nonzero**
(coordinator-verified by grep). Consequence: a task skipped twenty times reads as *no evidence* and
stays pinned at the 0.5 prior instead of converging to its real low success rate.

One test in `score.test.ts` with e.g. `completionCount: 2, skipCount: 8` asserting the factor equals
`historicalSuccessFactor(rate, 10)` and **not** `historicalSuccessFactor(rate, 2)`. **Test-first:
watch it fail against that mutation before you keep it.**

### (c) Task 55 / W5 — literal-pin the seven unpinned constants

`URGENCY_HORIZON_DAYS`, `BASE_SENSITIVITY_CEILING`, `MISSED_QUOTA_BOOST_MAX`,
`DEEP_FOCUS_MAJOR_MIN_MINUTES`, `BREAK_MINUTES`, `EASIER_MAX_ITEM_MINUTES`, `DIFFICULTY_JITTER`. Each
can currently be changed freely with the suite green, because the tests assert against the constant
itself or compute the fixture *from* it — both sides move together.

🔴 **The remedy already exists in this repo twice — copy it, do not invent one.**
`factors.test.ts:45-48` asserts `importanceFactor(null)` against **both**
`DEFAULT_IMPORTANCE_INTERNAL / 1000` **and** the literal `0.5` (that mutation was **caught**), and
`src/execution/constants.ts` is pinned with literals throughout (**4/4 caught**). **One extra literal
`expect` per constant** — not a rewrite, and do not remove the existing symbolic assertions.

## 3. Corrections to the original brief (it predates these — do not follow it here)

| Original brief says | Current truth |
|---|---|
| Branch `opus/batch-a-headless` | **Merged long ago. Work on `main`.** |
| Spec **v2.3** §5.4 | **v2.4** is current (`ADHD_Task_Management_App_Specification_v2.4.md`). |
| §3b: "the thermal sampler is a stub, assigned to task 19" | **Resolved.** Jason moved *sampling* to task 41; it is **built and device-confirmed** (2026-08-19 — the `runtime` stream carries `thermalStatus`/`batteryLevel`). Task 19 keeps thermal **policy**. Phase B consumes 41's sampler; §3b is **not an open question any more**. |
| §4: "learned energy adjustments live in the internal 2/4 band" | **Now load-bearing, not incidental.** Task 50 (2026-08-22) defined `energy` as **activation cost** and deliberately **excluded** the idiosyncratic half from extraction, routing it to *"the organ built for it — §5.4's learned `average_energy_cost`, which drives internal 2 and 4."* **Task 17 IS that organ.** Read `docs/design/energy_definition_task50.md` §4–§5; it is Phase B's charter for the energy loop, and nothing may let extraction reach 2/4. |

## 4. Constraints

- **No migration, no schema change** in Phase A. `algorithm_weights` is currently read by **nothing**
  in production (verified) — Phase B is its first consumer; leave it alone here.
- **Constraint #5** — do not touch the neglect multiplier, `neglectCurve`, or R8's clock.
- **Constraint #6** — always project through `scales.ts`; never surface a raw internal energy value.
- **Do not re-derive R6.** The formula `(rate*n + 0.5*k)/(n + k)`, k=2 stays; Phase B changes the
  prior's *source*, not the shape.
- **Migration 004's `data_points_count = 0` reseed guard exists for task 17's sake** — a learned
  weight must never be silently overwritten by a reseed. (Phase B's concern; know it.)

## 5. Test-first (`CLAUDE.md`) — non-negotiable here

Every behavioural change gets its failing test first, proven to fail for the right reason. For (b)
and (c) the mutations are **named above** — run them, watch red, revert, keep the test. Task 53 exists
because tests that never failed were trusted; a Phase-A "fix" that stays green against its own
mutation has fixed nothing. **Name in your report the test that guards each change.**

## 6. Verify

Baseline: **974 tests / 86 suites** real, `tsc` clean, `eslint` 0 errors / 56 warnings. Raw
`npx jest` reports ~1768/154 — the stale worktree adds a fixed **794/68**. Quote the real number (or
run with `--testPathIgnorePatterns worktrees`), never the raw one.

## 7. Deliverable

Code + tests (uncommitted) and `docs/eval/task17_phaseA_findings_report.md` containing:

- The **attempt definition** you chose, its reasoning, and the alternatives — as a **provisional**
  recommendation for Jason.
- How the writer treats: a normal completion, a skip, a crash-recovered `abandoned` episode, and a
  self-completion; where it fires (`completeTask` in `src/services/taskCompletion.ts` is the natural
  choke point — confirm against the real call graph) and why.
- What the writer changes in **real scoring** — before/after on a worked example.
- The mutation-failure output for (b), and the constants covered in (c).
- Real jest/tsc/eslint numbers.
- A section titled exactly **"Deviations from human decisions"** — empty is valid and must be
  written out explicitly.
- What Phase B inherits.

## 8. Read first

1. This brief, then `docs/briefs/numeric_learning_task_17.md` (the original work order).
2. `docs/eval/task44_findings_report.md` **§3** — the convention analysis written *for you to inherit*.
3. `docs/eval/test_audit_task53_findings.md` **W2 + W5** — the exact mutations.
4. `src/scoring/score.ts:73-75`, `src/scoring/factors.ts` (`historicalSuccessFactor`, the constants),
   `src/services/taskCompletion.ts`, `src/db/repositories/tasks.ts`.
5. `CLAUDE.md`; orientation §4 (constraints) and §9 (the handoffs pinned to task 17).
