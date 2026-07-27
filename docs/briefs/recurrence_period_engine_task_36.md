# Task 36 — Recurrence period engine (time-driven half of §4.2)

**Owner:** Opus. **Branch:** `opus/batch-a-headless`. **Headless** — pure logic over the data layer with an injected clock. No device pass, no `P`.
**Split from task 13 by Jason's ruling (2026-07-20)** so the critical path stays lean: task 13 is device-gated, this is not, and this can run while Jason is away from the phone.
**Runs in parallel with task 13 — but they are NOT fully file-disjoint** (§5). Read that section before starting.

**Read first:**
1. `src/services/taskCompletion.ts` — **the SCOPE LINE comment at the top is this task's charter.** It names precisely what completion deliberately does not do, and hands it here.
2. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §4.2 — the five recurrence types and their completion semantics. (If task 35's fold-in has landed, use the newer spec.)
3. `src/db/repositories/recurrence.ts` and `tasks.ts` — **read the actual primitives from source.** This brief names them from memory of an earlier read; do not trust its summaries over the code. Task 27's brief used the same instruction and caught a real conflict.
4. `docs/eval/task25_findings_report.md` — R8's accrual gate `anchor + period/(1+quota)`, which consumes the period data you are about to start maintaining.
5. `docs/briefs/orientation_for_opus.md` §4 — constraints, especially **#5 (neglect never saturates)** and **#7 (`null`/one-off ≠ `unscheduled`)**.

---

## 1. Why this exists — a live bug, not a nice-to-have

`completeTask` does the completion-driven work (close, or reset the neglect clock). It deliberately does **not** do the time-driven work: advancing `next_due_at` to the next occurrence, rolling `reset_date` and `current_period_progress` at a period boundary, or applying the missed-quota importance boost. Those fire when *a period boundary passes*, not when a user completes something — different clock, different trigger.

Nothing does them today. Consequences right now:

- **Completing a `scheduled` task leaves `next_due_at` where it was**, so it reads as perpetually due-or-overdue.
- **Derived urgency is therefore wrong for every recurring task** — and urgency is 23% of the score.
- **Quota periods never roll**, so `current_period_progress` accumulates across periods instead of resetting.
- **The missed-quota importance boost (spec §4.2) has never existed.**

This is the last major piece of §4.2 that was specified and never built.

## 2. Scope

1. **`next_due_at` advancement** for `scheduled` and `scheduled_quota`, computed from `recurrence_pattern`'s scheduled days.
2. **Period rollover** for `quota`, `scheduled_quota`, and period-bearing `scheduled`: reset `current_period_progress`, advance `reset_date`.
3. **Missed-quota importance boost** — when a period ends with the quota unmet, remaining occurrences in the *new* period surface harder (§3b for the mechanism, which is a decision).
4. **Catch-up after absence.** The app is offline-first with no background scheduler; a user returning after two weeks must land in a correct state. **Missed occurrences reset — no guilt stacking** (spec §4.2). Never fabricate a backlog of missed occurrences.

### Explicitly not yours

- **Completion-driven work** — `completeTask` owns it. Do not move logic across that line in either direction.
- **The neglect clock.** `listActiveByNeglect` owns R8's gate and task 28's three-way anchor. **Consume, never re-derive** (constraint #5 — and a "pause accrual while between occurrences" convenience would be a saturation bug).
- **`which:"next"` weekday semantics (task 22).** From a Thursday, the 4B read "next Monday" as 11 days out. That is a *resolution-at-extraction* bug and stays task 22's. You will be doing adjacent date arithmetic — **do not fix it here, and do not contradict it.** If your work makes 22 easier or harder, say so in the report.
- **`unscheduled` and `count`.** Neither has a period, a `reset_date`, or a schedule. **Never give them one to make the code uniform** — the schema enforces `reset_date IS NULL` for them, and constraint #7 exists because conflating these corrupts tasks invisibly.

## 3. Decisions to make and record

**a. Where does the sweep run, and is it idempotent?** There is no background scheduler and no daemon. Recommendation: a single idempotent `advanceRecurrence(now)` sweep called at **app open and session start**, safe to run twice in the same second and safe to run after any gap. Idempotency is the whole design constraint — write the test that calls it three times in a row and asserts one advancement.

**b. Is the missed-quota boost stored or derived?** **Recommendation: derived at scoring time, like urgency — do not mutate `tasks.importance`.** Writing a boost into stored importance corrupts the user's own 1–10 projection (constraint #6) and collides with the 1–99 subtask band under each hundred (a parent at 700 with subtasks at 701–799 has no room for a silent bump). Urgency is already precedent: spec §4.1 says it is derived, not stored static. If you disagree, argue it in the report rather than quietly storing it.

**c. Catch-up semantics after a long absence.** A user gone 3 weeks on a "3×/week" task: reset to the current period, quota unmet in the missed periods, **no accumulated debt**. Confirm this matches the 5-day re-orientation flow (spec §6.1/§8.5), which dispositions stale tasks conversationally — your sweep must not have already made that conversation confusing.

**d. Timezone and DST.** Period and day boundaries are real dates. Recommendation: device-local midnight, and **write down what happens across a DST transition** rather than discovering it in March. A test with a DST-crossing clock is cheap now.

**e. Interaction with R8's gap.** The accrual gate offsets by `period/(1+quota)` from the anchor. Once periods actually roll, that gate is reading live data for the first time. Check the composition and report what you find — this is the first time these two pieces have ever run together.

## 4. Constraints that bite here

- **Constraint #7** — `null` (no recurrence row, one-off) vs `unscheduled` have opposite semantics. Your sweep must skip both, plus `count`.
- **Constraint #5** — nothing here may cap, pause, or saturate neglect accrual.
- **Constraint #6** — no raw internal 1–1000 importance or 1–5 energy crosses a user-facing boundary; project through `scales.ts`.
- **No guilt stacking.** Missed occurrences reset. That is a product rule, not an implementation convenience.

## 5. Parallel-track hazard (read before starting)

Task 13 is likely running at the same time and is **not** fully file-disjoint from this one:

- Task 13 may add **migration 005** for timer state. If you also need a migration, **coordinate the number** — two migration 005s is a merge conflict that corrupts the runner's forward walk.
- Both tasks touch the completion/episode neighbourhood. You own `src/services/recurrence*` (or equivalent); **task 13 owns the episode lifecycle and must not gain period logic.**
- If either task adds a migration, **both must sweep prior migrations' test suites** (task 34 §4: `runMigrations` walks forward, so earlier suites' "latest version" and "full object list" assertions become assertions about the new one).

State in your report which files you touched, so the merge is auditable.

## 6. Definition of done

- Engine implemented; commits logical and separate.
- Full suite + `tsc --noEmit` + `eslint .` clean; prior migration suites swept if a migration landed.
- Tests with an **injected clock** covering: advancement for each scheduled type, period rollover, the idempotency triple-call, long-absence catch-up, a DST crossing, and explicit negative tests that `unscheduled`, `count`, and one-offs are untouched.
- Findings report at `docs/eval/task36_findings_report.md`: what landed, the (a)–(e) decisions and reasoning, the R8 composition finding, anything task 22 now inherits, and **anything you consciously left open, stated plainly.**
