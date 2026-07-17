# Task 10 R1/R2/R3 Implementation Report — landing Fable's rulings on the scoring composition

**Question:** `docs/briefs/scoring_review_task_10.md` recorded three resolved rulings (R1 neglect
curve, R2 subtask ordering, R3 context/tool filter) as product-intent decisions, not yet code.
This is the implementation pass: land all three, keep constraint #5 (uncapped neglect) and the
two-level scales intact, and leave R4 (the coaching trigger) untouched.

**Verdict: GREEN.** All three rulings are implemented, tested, and committed as three separate
commits on `opus/batch-a-headless`. 407 tests passing across 47 suites, `tsc --noEmit` clean,
`eslint .` clean (0 errors — only pre-existing warnings in unrelated `src/dev/` screens). Headless
throughout — pure logic over the data layer, no device run required for this pass.

**Date:** 2026-07-17. **Branch:** `opus/batch-a-headless`. **Commits:** `ac5da48` (R1), `7083a87`
(R3), `2397568` (R2).

**Read first:** [`docs/briefs/scoring_review_task_10.md`](../briefs/scoring_review_task_10.md)
(the rulings under implementation) and
[`docs/briefs/orientation_for_opus.md`](../briefs/orientation_for_opus.md) §4 (constraint #5
uncapped neglect, constraint #6 two-level scales).

---

## 1. R1 — Neglect curve

`neglectMultiplier` → `neglectCurve(weeks)`, seeded `1 + weeks`, replacing `weeks²`. Still
uncapped by design.

- [`src/scoring/score.ts`](../../src/scoring/score.ts): `neglectCurve` is now the sole,
  documented "swappable seam" — `scoreTask` routes `item.weeksNeglected` through it directly,
  rather than trusting a pre-computed multiplier from the repository layer.
- [`src/db/repositories/tasks.ts`](../../src/db/repositories/tasks.ts): `listActiveByNeglect`
  drops `** 2`.
- The migration SQL (`001_initial_schema.sql`) and its `.ts` mirror (`001_initial_schema.ts`,
  which the schema-drift test asserts stays byte-identical) both updated — the
  `active_tasks_with_neglect` view is bypassed on-device (no `POWER()`) but its comment now
  matches the real linear curve instead of describing the retired squared one.
- Tests: squared-value assertions replaced with linear ones; a new test asserts `neglectCurve` is
  linear and unbounded at three orders of magnitude.

## 2. R3 — Context/tool hard filter, reweight to 31/23/23/23

`contextFit` left `FACTOR_WEIGHTS`; the freed 15% redistributes evenly across the remaining four.

- [`src/scoring/factors.ts`](../../src/scoring/factors.ts): `contextFitFactor` deleted (not
  deprecated — nothing else could legitimately call it once context became a filter, not a
  weight); `FactorBreakdown` and `weightedSum` drop the field.
- [`src/scoring/filter.ts`](../../src/scoring/filter.ts) (new): `filterBySessionCapability`
  partitions a neglect-annotated pool into `eligible` vs. `rejected` by exact tag match, requiring
  **all** of a task's `context_tags` and `tool_requirements` to be satisfied — not just any
  overlap. Rejects carry `missingContexts`/`missingTools` and are **retained**, not discarded, so
  the future R4 trigger has something to read.
- `SessionCheckIn` gained a `tools` field (didn't exist before — the session check-in only
  modeled energy + contexts) since the spec's "tools checklist" (§6.2) needed a session-side
  home.
- Tests: an impossible task no longer ranks once filtered before scoring; rejects are retained
  and queryable; weights sum to 1.0 at the new values.

## 3. R2 — Subtask ordering via real dependencies + transitive fan-out

The hard one, per the brief's own label. Three separate pieces:

**a. The DAG guard (a real, confirmed gap).** `src/db/repositories/dependencies.ts` had a comment
flagging that the `prevent_circular_dependencies` DB trigger only catches a *direct* two-node
cycle (A↔B), not a longer chain (A→B→C→A) — "flagged for awareness, not fixed." Since transitive
fan-out counting assumes an acyclic graph, this was load-bearing, not cosmetic. `add()` now walks
the existing `depends_on` graph via BFS before every insert and rejects any cycle length with the
same typed `CircularDependencyError` the trigger already used. The trigger stays as a backstop.

**b. The fan-out offset.** [`mapper.ts`](../../src/llm/breakdown/mapper.ts)'s
`subtaskImportance` took a generation index before, so an `ordered: true` breakdown's *last* step
scored highest (descending-by-score ranking surfaced it first — backwards). It now takes
transitive fan-out (descendants unlocked); `sequentialUnlocks` builds the "unlocks" adjacency for
today's straight-chain breakdown structure, and `transitiveFanOut` walks it generically so the
mechanism keeps working if breakdown structure ever branches. First subtask in a chain now scores
highest, fixing the ordering bug directly.

**c. The persistence step, which didn't exist as code anywhere.** `mapper.ts` is deliberately
pure (no repository calls), and the only place `break_down_task` was handled
(`services/coaching/dispatch.ts`) is an intentional staged stub (D8) — it never creates subtasks.
So "persist real task_dependencies chaining the subtasks in sequence" had no home to land in.
Added [`src/services/breakdown.ts`](../../src/services/breakdown.ts): `persistBreakdown` creates
each subtask via `tasks.create`, then — for `ordered: true` — chains them through the now-guarded
`dependencies.add`, one edge per `sequentialUnlocks` pair.

Tests: an ordered breakdown creates a real dependency chain (verified against real SQLite);
scoring an ordered breakdown's writes surfaces the high-leverage unblocker first (mapper→scoring
integration test); a multi-hop cycle is rejected, as is a self-dependency; unordered siblings
still share one importance value.

## 4. Issues that came up

1. **The DAG guard was a real, not hypothetical, gap.** R2 explicitly asked to confirm this
   before trusting fan-out counts. It was confirmed missing (§3a above) and fixed — this wasn't a
   defensive add, `transitiveFanOut` would have been unsound without it the moment a coaching
   `add_dependency` action created a longer cycle.

2. **Self-inflicted, caught by tests.** While updating the migration's mirrored `.ts` copy
   (`001_initial_schema.ts`, a template-literal string), a comment referencing `` `neglectCurve` ``
   in backticks prematurely closed the enclosing template literal and broke the Babel parse. The
   `schemaDrift` suite failed immediately; fixed by dropping the backticks from the comment.

3. **A scope line drawn, not an oversight.** The brief's R2 rationale mentions "dependency
   filtering keeps a blocked high-fan-out task from jumping its own prerequisites" — implying a
   task-9-level filter for tasks with unmet dependencies, parallel to R3's context/tool filter.
   The explicit R2 instructions for this pass didn't require it, and its natural home (session
   planning, task 11) is marked "later." **Left unimplemented.** Without it, a blocked subtask
   could theoretically still outrank its own prerequisite if neglect pushed its score high enough
   — worth a conscious decision before task 11 starts, not a silent gap.

4. **No prior art for "mapper output → persisted task."** The same gap exists for
   `extractionToTaskWrite` (task 5) — nothing in the codebase yet turns a pure mapper's
   `TaskWriteInput` into a `tasks.create()` call. `persistBreakdown` was built from scratch,
   following `services/taskCompletion.ts`'s dependency-injection convention (a `deps` object of
   picked repository methods). Reasonable given R2 explicitly required persistence, but it's new
   architectural surface, not just a wiring fix, and the same pattern will likely need repeating
   for extraction.

## 5. Out of scope, by design

- **R4** (the coaching trigger for buried out-of-context/tool tasks) — separate ruling, not
  touched.
- **R5** (neglect clock start: creation vs. actionable) — recorded as a minor open item in the
  brief, not a ruling requiring code.
- **Session planning** (task 11) — the actual selection-boundary caller that will invoke
  `filterBySessionCapability` before `scoreTasks`/`rankWithContextNovelty` doesn't exist yet.
- Fable's re-scoped review (§6 of the brief) — this pass implements the rulings the review is
  supposed to run *against*; the review itself is still pending.

## 6. One-line call

**GREEN.** R1, R2, and R3 are implemented, match the brief's rulings, keep neglect uncapped and
scales two-level, and pass the full suite + type-check + lint with no regressions. One real data-
layer gap (multi-hop cycle detection) was found and closed as part of R2's own "must" checkpoint.
One deliberate scope line (dependency-based selection filtering) is flagged above for a human
decision, not silently resolved either way.
