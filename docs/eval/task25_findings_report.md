# Task 25 Findings — Post-review scoring follow-ups (R6, U1, R7, R8)

**Status: complete.** R6, U1, R7, R8 each landed as its own commit on
`opus/batch-a-headless`, full suite + `tsc --noEmit` + `eslint` clean (455 tests, no
regressions). This report is the paper trail the brief §6 asks for: what landed, the R7 hold
mechanism and why, what the rulings didn't cover that I had to decide, and what I consciously left
open.

**Commits:**
- `596b885` — R6 smoothing
- `e86d4cf` — U1 dependency pre-filter
- `9213031` — R7 parent lifecycle
- `aaecccf` — R8 accrual gate

**Did 25's brief and 28's design disagree?** No — checked the three seams the user flagged (the
`listActiveByNeglect` anchor, `historicalSuccessFactor`, the R7 hold). Task 28 §5 states the merged
anchor is a three-way max folding in `last_worked_at`; 25's R8 uses the two-way
`COALESCE(last_completed_at, created_at)`. That is sequencing, not conflict — 33 makes the one-line
merge (see the task 33 report). §28's "scoring is untouched" and R6's formula change are orthogonal
(parks don't enter `n`). Nothing required stopping to ask.

---

## 1. What landed

### R6 — smoothed historical-success cliff (`src/scoring/factors.ts`)
Replaced the hard `n≤0 → 0.5, else raw` branch with `(rate·n + 0.5·k)/(n + k)`, `k = 2`. The
old cold-start branch falls out of the same expression (`n=0 → 0.5`), so it is gone, not kept
alongside. `HISTORICAL_SUCCESS_PRIOR_K` / `_MEAN` are named constants so task 17 swaps the prior's
*source*, not the formula. First skip → 0.33, first completion → 0.67, converging to the raw rate.
The `score.test.ts` "all factors maxed" fixture was bumped to 400 completions so shrinkage is
negligible where it asserts the composition (that test isn't about cold start).

### U1 — dependency-blocked pre-filter (`src/scoring/filter.ts`, `dependencies.ts`, `score.ts`)
`filterDependencyBlocked(items, unresolvedBlockers, pendingBreakdownComplete)` — pure, same
partition-and-retain contract as `filterBySessionCapability`. Rejects carry the blocking task ids
**and** the R7c hold flag. `dependencies.listUnresolvedBlockersForActiveTasks()` produces the
blocker map (active task → its not-yet-completed `depends_on` ids). Both rankers' doc comments now
state the pool must be pre-filtered by both filters; `rankWithContextNovelty`'s says so as
load-bearing.

### R7 — parent lifecycle after breakdown (`breakdown.ts`, `breakdownLifecycle.ts`, `dispatch.ts`)
- **R7a:** `persistBreakdown` links `parent depends_on` every subtask (ordered or not).
- **R7b:** `fireBreakdownCompleteIfParentUnblocked()` enqueues an immediate `breakdown_complete`
  when a completed task was the parent's last unresolved blocker. No auto-completion.
- **R7c:** hold via the U1 filter (below), fed by `pendingBreakdownCompleteTaskIds()`.
- **Eliminate edge:** `eliminate_task` now removes edges pointing at the eliminated task.

### R8 — neglect accrual gate (`src/db/repositories/tasks.ts`)
`neglectAccrualGapDays(recurrence)` + a `LEFT JOIN task_recurrence` in `listActiveByNeglect`;
`weeksNeglected = max(0, (now − anchor)/7 − gap/7)`. Start condition, not a cap — growth after
`accrualStart` is unbounded.

---

## 2. The R7 hold mechanism I chose, and why

**Chosen: the U1 filter excludes tasks with a pending `breakdown_complete` coaching row** (the
brief's recommended option), not R4's sentinel/new task state.

- No new task state means no new pool-query surface to keep in sync — the exact class of bug
  constraint #5 exists to prevent (a missed `status IN (...)` edit silently hiding a task). The hold
  rides the existing `filterDependencyBlocked` boundary that already runs before every ranker.
- The signal is derived, not stored: `pendingBreakdownCompleteTaskIds(coaching)` reads the
  coaching priority queue and collects `breakdown_complete` rows' related task ids. When the
  conversation resolves (row leaves `pending`), the hold releases automatically — nothing to unset.
- It composes cleanly with R7a: a held parent is *also* dependency-blocked until its last subtask
  completes, so for most of the chain's life both signals point the same way; the hold only matters
  in the window between "last subtask done → parent unblocked" and "user confirms."

**The seam this leaves (stated plainly):** the hold is only *enforced* once task 11 wires
`filterDependencyBlocked`'s third argument at the selection boundary. Task 25 builds the capability
(filter param + `pendingBreakdownCompleteTaskIds` + tests) but does not build the selection boundary
(that's task 11, and the brief scopes it out). Until task 11 lands, the immediate firing keeps the
window short but not zero — exactly the residual risk the brief's R7c already names. The task-11
brief's selection-boundary checklist covers the wiring.

---

## 3. Things the rulings didn't cover that I had to decide

1. **`scheduled`-type gap derivation.** R8's formula is `period / (1 + quota)`, but the domain
   `scheduled` type carries *neither* a `period` nor a `quota` field — only `scheduledDays:
   Weekday[]`. The brief's table gives only the single-day weekly case (quota 1 → 3.5 d).
   **Decision:** weekday schedules are inherently a weekly cycle, so `period = 7`; and
   `occurrencesPerWeek = max(1, scheduledDays.length)` is the quota. Single-day weekly →
   `7/(1+1) = 3.5 d`, matching the example exactly; multi-day (Mon+Thu) → `7/3 ≈ 2.33 d`, which
   surfaces *sooner*. This is both more faithful to "half the distance between occurrences" than a
   hardcoded quota-1 and the **safe direction** for a fail-safe (a shorter gap never hides a task
   longer). Recorded here rather than guessed silently; revisit if a real multi-day schedule proves
   it wrong.
2. **The "annual scheduled → 182.5 d" table row is not constructible** in the current domain (there
   is no annual period; `scheduled` is weekday-only, and `quota`/`scheduled_quota` top out at
   `month`). It is illustrative of the formula, not a representable state — so R8's tests verify the
   weekly-scheduled (3.5 d), quota-3×/week (1.75 d), quota-15/week (0.44 d), and a monthly-quota
   (10 d) cases instead. If annual recurrence is ever added, the same formula applies with
   `period_days = 365`.
3. **R7 immediate-vs-immediate precedence** ("recalibration wins"). Realized by the existing
   `coaching_priority_queue` view (both are `immediate`, ordered oldest-first, and a 3-skip
   recalibration is always enqueued *before* the completion that fires `breakdown_complete`), plus a
   recorded `precededByRecalibration` flag on the fire result so the drainer (task 12) can honor it
   explicitly. I did not build a new ordering mechanism — the view already expresses it. Caveat:
   SQLite `CURRENT_TIMESTAMP` is second-granularity, so two rows in the same second tie on
   `created_at` and the view's secondary order is unspecified; the flag exists precisely so the
   drainer never has to rely on tie-breaking. The test backdates the recalibration a second to
   assert the ordering deterministically.
4. **Nested-breakdown stacking.** "Queue the second rather than firing two immediates" is
   implemented by downgrading a new `breakdown_complete` to `next_start` urgency when another
   `breakdown_complete` is already pending. Firing is also idempotent per parent (no duplicate row).
5. **`eliminate_task` edge removal is general, not subtask-specific.** It removes *every* edge where
   the eliminated task is the `depends_on` target (its dependents), which covers the subtask case
   the brief names and is correct for any eliminate (a task others waited on will never complete, so
   its blockees should unblock). Documented that a `deleted` blocker still counts as unresolved in
   the U1 read — the edge removal is what prevents the "blocked forever" case, not a status special
   case.
6. **R7 resolution semantics are wired at the coaching/UI seam, not built here.** There is no
   "confirm done" action in the coaching resolution union — the check-off is a UI action (task 24)
   that calls `completeTask(parentId)`, which already picks the correct primitive by recurrence type
   (constraint #7). "Not actually done" is the existing `add_missing_task` action. Completing the
   parent re-runs the R7 hook on it, chaining a nested grandparent's confirmation. I documented this
   in `breakdownLifecycle.ts` rather than inventing a completion path.

---

## 4. Consciously left open

- **The R7 hold enforcement seam** (§2 above) — capability built, wiring is task 11.
- **`add_missing_task` dispatch is still unexercised on-device.** R7 makes it load-bearing (the
  natural "no, not done" resolution), so it is now on the personal-ship path — flag for task 32's
  device sweep, as the brief instructs.
- **Multi-day `scheduled` gap** (§3.1) — a reasoned decision, not a ruled one; revisit with real
  multi-day schedules.
- **R7 precedence under same-second ties** (§3.3) — the `precededByRecalibration` flag is the
  durable hook; the drainer (task 12/11) should read it rather than depend on view tie-breaking.
- **Spec is not touched here.** Implied v2.3 fold-ins for task 27, noted as I went: §5.1 smoothed
  historical success (R6), §5.2 the clock rule (R8, "start condition, not cap"), §5.3/§8.1 the
  two-pre-filter selection boundary (U1), §4.1/§4.2 the parent lifecycle + §7.2 the
  `breakdown_complete` trigger with recalibration-wins precedence (R7).

**Process note:** the `.claude/settings.json` allowlist entry (one `adb logcat` wildcard from the
`/fewer-permission-prompts` run at session start) was bundled into the R6 commit incidentally — it
is config, not scoring code, and harmless there.
