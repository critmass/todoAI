# Task 17 — Numeric learning loops (§5.4)

**Owner:** Opus. **Branch:** `opus/batch-a-headless`. **Headless** — pure logic over the data layer, injected clock. No `P`.
**Not on the personal-ship path** (personal ship is met). This is the first half of Phase-2 learning; it makes the app improve with use.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` §3 (`algorithm_weights`, `energy_patterns`, `context_effectiveness` repos), §4 (constraints #5 uncapped neglect, #6 scales).
2. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §5.4 — the six loops and the single-user provisions.
3. `docs/eval/task25_findings_report.md` — R6's smoothed historical success `(rate·n + 0.5k)/(n+k)`, k=2. **This task replaces R6's fixed 0.5 prior with a *learned* one — same formula, learned source.**
4. `src/scoring/` — where the weights are consumed; `src/db/migrations/004_*` — the `data_points_count = 0` reseed guard exists **for this task's sake**.

---

## 1. What this builds

The six §5.4 numeric-learning loops, made real for a **single-user** data regime: factor-weight adjustment, time-estimation learning, energy-pattern recognition, context-effectiveness learning, break/self-care optimization, and the learning-parameters loop. These tune *which* tasks get chosen and *how long/what energy* they're predicted to need — the numeric complement to task 19's behavioral skill layer.

**The two provisions that make it work for one user (not a population):**
- **Hierarchical shrinkage / cold-start.** A per-cell estimate (e.g. *phone × afternoon × low-energy*) rarely reaches the 10–15-point bar for a solo user. Start every cell from a global prior; specialize only once a cell has its own data; fall back to the parent level otherwise (afternoon before afternoon×phone×low). Useful day one, refined over time.
- **Conservative, protected adaptation.** ≥10–15 points before adjusting a *specialized* weight; small increments (5–10%); track weekly/monthly cycles; **regression protection** — monitor completion rates and **roll back** any adaptation that degrades them.

## 2. The three writers this task owns (two are live gaps today)

1. **`algorithm_weights` adjustment** — the factor-weight loop. Migration 004 reseeded the four surviving factors to 31/23/23/23 **only where `data_points_count = 0`**; this task is the first writer that moves them off the seed. Respect the guard's intent: a learned weight is never silently overwritten by a reseed.

2. **⚠ `completion_count` / `success_rate` — NO WRITER EXISTS (task 13 handoff, report §7).** `historicalSuccessFactor` currently scores every task off a permanent n=0, so R6's smoothing is running on empty for the whole app. **This task is the natural owner of that writer.** Decide where it fires (on `completeTask` / on skip) and wire it. This is a live scoring bug, not just a learning nicety — until it's written, the 20% historical-success weight contributes nothing real.

3. **Time-estimation learning + `duration_source`.** A `duration_source='model_guess'` estimate has zero real observations; replace it off the *first* actual completion rather than waiting for the specialized-weight bar (spec §5.4). A `'user'` estimate is trusted more but still refined. **New signal from task 24:** `repeated_extension` coaching rows (a task that needed `+5` three times or ≥50% over) mark tasks whose estimate is systematically wrong — a clean, high-value input to this loop.

## 3. Decisions to make and record

**a. The crash-as-friction question (task 13 handoff → was pinned to task 19, but this loop touches it too).** A recovered crash writes `completion_status='abandoned'`. Does that count as a failed completion in `success_rate`? Per constraint #11's spirit, **a crash is not user failure** — so it should *not* drag down a task's success rate. Confirm this is how the `completion_count`/`success_rate` writer treats it, and coordinate with task 19 (which owns the friction-incident definition for skills).

**b. Where does the thermal sampler fit?** §5.4's loops run "opportunistically in idle, cool windows." The thermal sampler is a stub, assigned to task 19. If this task runs before 19, its heavy consolidation should be gated on *some* signal even if crude (cold-to-warm tok/s drift as the proxy, per orientation §8). Don't build a heat-blind background loop.

**c. Rollback granularity.** Regression protection must roll back *an adaptation*, not the whole learned state. Decide the unit (per-cell? per-loop?) and keep an audit trail (`task_updates` with `update_source='algorithm_learning'` already exists for this).

## 4. Constraints that bite here

- **#5 uncapped neglect** — this task tunes summed weights; it must not touch the neglect multiplier or its clock. `neglectCurve` is out of scope.
- **#6 two-level scales** — learned energy adjustments live in the internal 2/4 band (behavioral discounting); never surface a raw internal value.
- **Regression protection is not optional.** The spec calls it out because an over-eager solo-user loop will happily learn from a bad week. A degrading completion rate rolls the change back.
- **Don't re-derive R6/R8.** R6's formula stays; you change its prior's *source*. R8's neglect gate is `listActiveByNeglect`'s, untouched.

## 5. Definition of done

- The six loops implemented with shrinkage + regression protection + rollback; commits logically separate.
- **The `completion_count`/`success_rate` writer exists and fires** — the live gap closed, with the crash-as-abandoned decision recorded.
- Model-guessed durations replaced off first completion; `repeated_extension` wired as an estimate signal.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- Tests with an injected clock: a cell specializing only after its bar, parent fallback before then, a rollback triggered by a degrading metric, and the success-rate writer treating a crash correctly.
- Findings report at `docs/eval/task17_findings_report.md`: the (a)–(c) decisions, what the success-rate writer changed in real scoring, and anything left open.

*Model note: mostly ordinary Opus. The **regression-protection + rollback interaction** is the one piece where the stronger reasoner earns its keep (many pieces interacting; a silently-degrading learned state is invisible until rankings feel wrong) — Opus 5 if available, per the handoff §8.*
