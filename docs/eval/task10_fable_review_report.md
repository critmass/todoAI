# Task 10 — Fable Review Report: the revised scoring composition

**Scope:** the re-scoped §6 of `docs/briefs/scoring_review_task_10.md` — rulings on the remaining
§4 forks (1, 2, 3, 5, 6) plus the unknowns pass, run against the **revised** composition (linear
`neglectCurve`, context/tool hard pre-filter, 31/23/23/23 weights, transitive-fan-out subtask
ordering) as landed by `docs/eval/task10_R1R2R3_implementation_report.md`. R1–R5 are settled and
were not re-opened. Reviewing, not implementing — no code was changed in this pass.

**Date:** 2026-07-18. **Branch:** `opus/batch-a-headless`.
**Code reviewed:** `src/scoring/{factors,score,filter}.ts`, `src/llm/breakdown/mapper.ts`,
`src/services/breakdown.ts`, `src/db/repositories/{tasks,dependencies}.ts`.

**Verdict in one line:** the revised composition is sound and strictly gentler than the original
(worst-vs-best crossover moved ~2 wks → ~9.4 wks); leave forks 1, 2, 3, 6 as built; smooth the
fork-5 cold-start cliff; and one real recombination pathology exists — **the novelty shuffle
destroys R2's ordered-subtask sequence unless the dependency-blocked filter (the gap the
implementation report consciously left open) is built. Ruling: that filter is mandatory, as the
second half of R2, before task 11 ships.**

---

## 1. Fork rulings (§4 forks 1, 2, 3, 5, 6)

### Fork 1 — Urgency horizon 14 d, linear ramp, overdue saturates at 1 → **LEAVE**

**Intended, and the saturation is correct by composition, not despite it.** "How overdue" is not
urgency's job in this design — it's neglect's. An overdue task that stays untouched keeps an
aging neglect clock, so overdue-by-6-months *does* outrank overdue-by-1-day at the final-score
level (equal base × older multiplier). Making urgency itself grow past 1 would double-count time
with the neglect term. The one caveat: this coupling assumes period rollover (task 13) eventually
advances `next_due_at`; until then a completed `scheduled` task can pin at urgency 1 — a known
task-13 deferral, not a fork-1 defect.

Worth recording: R1 made this fork *matter more*, not less. Under `weeks²`, neglect swamped the
whole base by ~2 weeks, so the horizon was nearly irrelevant; under linear, urgency's 0.23 spread
stays meaningful for weeks. The current shape is live and fine.

**Measurement that would settle the horizon value:** log lead time at completion for due-dated
tasks. If completions on tasks that had ≥2 weeks of lead cluster at/after their due dates (i.e.
the ramp lifts them too late), widen the horizon or make the ramp convex. Until that data exists,
14 d linear is a fine seed.

### Fork 2 — Base-sensitivity floor capped at 0.15 → **LEAVE**

**Intended; the default-3 floor is noise by arithmetic.** After the reweight, the default
`urgency_level` 3 contributes 0.075 × 0.23 ≈ **0.017** of base — it cannot reorder anything
except deadline-less tasks against each other, which is exactly the "base sensitivity" §4.1
describes. A deliberate level-5 vs level-1 spread is 0.0345 of base: perceptible, never
dominant. Conservative, as intended.

The real cost of `urgency_level` was never in scoring — it's extraction-schema surface (one more
grammar slot, one more thing the 4B can get wrong). **Measurement:** after ~a month of real
usage, the fraction of tasks with a non-default `urgency_level`. If it's ~0, drop the field from
the *extraction* schema (a spec §4.1 touch); the scoring code can stay — it is inert at default.

### Fork 3 — Symmetric energy match → **LEAVE symmetric; the asymmetric instinct belongs to task 11**

**Intended.** The two directions are not symmetric in consequence, and the fork only changes one
of them. Low-energy session / high-energy task: both variants penalize — correct, and the
ADHD-critical direction. High-energy session / low-energy task: symmetry zeroes it, which
*protects scarce high-energy windows from being frittered on easy tasks* — the right default for
this product. The "high energy can afford anything" argument is really a session-*filling*
argument, and filling is session planning's job: §5.3's difficulty gradient and progressive
energy ramp need low-energy tasks *present in the ranked pool* (they are — it's a weight, not a
filter), not *boosted in scoring*. Baking asymmetry into the factor would pre-empt task 11's
arrangement logic with a cruder version of it.

**Measurement:** the neglect-age distribution of low-energy tasks vs. the rest. If the
low-energy backlog systematically ages until the fail-safe rescues it (i.e. the user's actual
check-ins are mostly "high" and easy tasks only ever surface via neglect), revisit with
undercapacity-only distance: `max(0, taskEnergy − sessionEnergy) / 4`.

### Fork 5 — Cold-start prior 0.5 → **KEEP the prior, FIX the cliff (small code change)**

The 0.5 value is right; the pathology is the **discontinuity at n = 0 → 1**. The prior vanishes
entirely on the first observation: one skip → factor 0 (−0.115 of base on a 23% weight), one
completion → 1.0. A brand-new task skipped once on a bad day takes the maximum-possible history
penalty off a single data point. It's *mild* — one week of neglect (+1× base) out-earns the
penalty, and §7.2's single-skip coaching is the real response to a skip — but it's a cliff where
the design everywhere else is a slope, and the fix is one line:

```
historicalSuccessFactor(rate, n) = (rate·n + 0.5·k) / (n + k),   k ≈ 2
```

This is the exact degenerate form of §5.4's hierarchical shrinkage — task 17 later replaces the
prior's *source* (fixed 0.5 → learned global/parent prior), not the formula — so it's not
throwaway work. The current hard branch (`n ≤ 0 → 0.5`) becomes the k→this-blend's own n=0 case.
**Implied spec touch:** a §5.1 note that historical success is smoothed, not raw.

If Jason prefers to leave it: the settling measurement is time-to-next-serve for tasks whose
first interaction was a skip, vs. tasks with a first completion — if the skip-first cohort's
median re-serve latency is dominated by neglect recovery rather than factor competition, the
cliff is doing visible harm.

### Fork 6 — Novelty shuffle ∝ raw finalScore; groups ordered by max → **LEAVE (re-judged under linear); but see finding U1**

**The unbounded-score-drives-shuffle-strength concern no longer bites.** Under `weeks²`, a
10-week task vs. a 1-week peer sampled ~50:1 (multipliers 101 vs 2) — effectively deterministic.
Under linear it's ~5.5:1 (11 vs 2), and the ratio grows only linearly with age spread. Residual
determinism at the very top when one task is hugely neglected is the §5.2 fail-safe *working* —
a task that has climbed for months **should** deterministically surface to force its decision —
not a shuffle failure. Softmax/rank-proportional sampling would add a tunable no one will tune;
raw-score sampling is now proportionate. Leave.

**The group-by-max concern is dissolved by R3, not just softened.** Pre-R3, "one neglected task
drags its whole group forward" could drag forward a group of *unavailable-context* tasks.
Post-filter, every group in the ranked pool is a context the session actually has — so a
champion pulling its siblings forward is **context-switch economy** (you're in that context for
the champion anyway; §5.3.2's grouping exists precisely to batch this way). The "weak tasks ride
along" behavior is the feature, in its intended form. Leave.

**Measurement (cheap, headless):** a seeded-rng positional-entropy test over a realistic pool
snapshot — re-roll `rankWithContextNovelty` N times, measure entropy of slots 1–3. Alarm
threshold: slot-1 entropy ≈ 0 *without* a fail-safe-age outlier present. That single number is
the tunability argument settled either way.

---

## 2. Unknowns pass — what the R1+R2+R3 recombination does that no single ruling shows

### U1 — **The novelty shuffle destroys R2's ordered-subtask sequence. The dependency-blocked filter is not optional.** *(the finding of this review)*

Ordered siblings from one breakdown share `created_at` (equal neglect clocks) and inherit the
parent's `context_tags` (same shuffle group). Two consequences compose badly:

- **Strict ranking is sequence-safe by an invariant worth recording:** equal clocks mean the
  neglect multiplier is a common factor across the chain, so relative order reduces to base
  score, where the fan-out offset decides — and it keeps deciding as the chain ages, because the
  clocks age together. `scoreTasks` never inverts a chain.
- **The shuffle is not.** The fan-out offset separates adjacent steps by ≤ 99/1000 × 0.31 ≈
  0.2–0.4% of finalScore. `weightedShuffle` samples proportionally, so within their shared
  context group the steps of an ordered chain are served in **near-uniform random order**. R2's
  validity claim — "descending-by-score is a valid execution order" — is true of the strict
  ranker and false of the novelty ranker, and task 11 (which the spec points at weighted-shuffle,
  §5.3.2) is the caller most likely to use the novelty ranker.

The implementation report (§4, item 3) consciously left the dependency-blocked selection filter
unbuilt as "task 11 territory, worth a conscious decision." **This is that decision: the filter
is the load-bearing second half of R2, not an optional companion.** With blocked tasks removed
before ranking, only the currently-unblocked step of a chain is in the pool — the shuffle cannot
misorder what isn't there, and the ≈0.2% offset margin stops mattering entirely. Without it, no
amount of offset tuning fixes the shuffle (any bounded offset is noise to a proportional
sampler).

**Shape:** a second hard pre-filter beside `filterBySessionCapability` at the selection boundary
— same partition-and-retain contract (`eligible` / `rejected` with the blocking task ids), since
spec §8.1 already names "dependency issues" as a no-available-tasks coaching cause and R4's scan
wants rejects. Task 11 must not ship without it; until it exists, only `scoreTasks` is
sequence-safe and `rankWithContextNovelty` must not serve pools containing dependency chains.

### U2 — The broken-down parent competes with its own subtasks

`persistBreakdown` creates the subtasks and the chain, and leaves the **parent** untouched:
still `active`, still in `listActiveByNeglect`, at importance exactly `parent` vs. its subtasks'
`parent + offset`, with identical context/energy. So the parent ranks immediately *below* its
own steps and continues to be served as a doable task while its pieces are also in the pool —
double-representation of the same work, and selecting the parent is always the wrong grain.

**Recommended fix reuses R2's own machinery:** in `persistBreakdown`, also add
`parent depends_on each subtask` edges. The U1 filter then hides the parent until every step
completes, at which point it surfaces as the natural "wrap up / verify / close" moment (or gets
auto-completed — a task-12 policy call, either way the mechanism is right). No new concept, no
snooze state — the same move R4's sentinel design already made. Note `parent_task_id` is a
column, not a dependency edge, so no cycle is created. **Implied spec touch:** §4.1/§4.2 say
nothing about a parent's lifecycle after breakdown — the spec should state it (currently the
gap is invisible in the spec and real in the pool).

### U3 — Hard filter × neglect accrual: the context-return "ambush" is intended — verify magnitude only

A task filtered out for w weeks re-enters its first eligible session at ×(1 + w). Under
`weeks²` this recombination would have been explosive (the filter *manufactures* long absences);
under linear it's proportionate, and the experience — "you're finally at the office; the
longest-neglected office work tops the list" — is arguably exactly right. R4 catches the
pathological tail (6-month-buried, due-soon). No change. **Measurement:** log the max
neglect multiplier entering each session's eligible pool; if re-entry spikes routinely outrank
due-today tasks, that's R1-seam data (curve shape), not a filter defect.

### U4 — The revised composition is strictly gentler; crossover now ~9.4 weeks

Recomputing the brief's §3.1 exemplar under 31/23/23/23 + filter: best-case base
= 0.31·0.8 + 0.23·1 + 0.23·1 + 0.23·0.5 = **0.823**; worst *eligible* base (importance 200, no
due date → default floor, energy fully mismatched, success 0) = **0.079**. Linear crossover:
0.823 = 0.079 × (1 + w) → **w ≈ 9.4 weeks** (was 2.0 pre-R1; ~4.1 under R1 with the old
weights). And the brief's original worst-case can no longer compete at all — "context
unavailable" now means filtered, not scored. The factor signal governs for ~2 months before the
fail-safe takes over. Intended and healthy; no action.

### U5 — (Low severity) The filter→rank seam is two calls with no enforcement

`scoreTasks`/`rankWithContextNovelty` accept plain `TaskWithNeglect[]`; nothing stops a future
caller ranking an unfiltered pool — which is exactly the U1/U3 class of bug reintroduced
silently. Not worth a type-system fix now; **make it a task-11 review-checklist item** (the
selection boundary must call capability filter + dependency filter before either ranker), and
the rankers' doc comments should say "pool must be pre-filtered" once the U1 filter exists.

### U6 — R5 advisory (invited by the brief): gate the neglect clock on the urgency horizon — and note task 13 will make this worse, not better

Linear softened the far-future-dated case (~2700× → ~53×) but ×53 still buries everything the
moment a year-old, due-next-year task is otherwise eligible — while it has a *scheduled* decision
point and needs no fail-safe. And a sharper version arrives with task 13: once rollover advances
`next_due_at`, an **annual** `scheduled` task completed today starts re-accruing from
`last_completed_at` and enters its next due window carrying ×53 every year, by construction.

**Cheap rule that fixes both without touching constraint #5:** don't accrue neglect while
`next_due_at − now > URGENCY_HORIZON_DAYS` — effective clock start
= `max(COALESCE(last_completed_at, created_at), next_due_at − horizon)`. Monotone, one
expression in `listActiveByNeglect`, and it leaves every no-due-date task (the fail-safe's real
constituency — `unscheduled`, one-offs without deadlines) exactly as is. Growth for actionable
tasks stays unbounded; this is a *start* condition, not a cap. Fine to defer on today's data
(only deliberately far-future-dated tasks hit it), **but it should land with or before task 13**,
where it stops being an edge case. **Implied spec touch:** §5.2's clock definition.

---

## 3. Implied spec changes (deliverable 3 — so the spec doesn't quietly diverge)

The spec **already diverges** from the landed code on two points — R1/R3 were ruled and
implemented but §5 was never updated:

1. **§5.1 weights table** — still 25/20/20/15/20 with a Context-fit row. Should read
   importance 31 / urgency 23 / energy 23 / historical 23, with context/tools moved to a stated
   **hard pre-filter at the selection boundary** (and the note that the filter retains rejects
   for R4/§8.1).
2. **§5.2 curve** — still `(days_neglected / 7)^2`. Should read the linear seed `1 + weeks`
   with the swappable-seam note (√weeks, weeks/N as one-line alternatives), uncapped as before.

New from this review:

3. **§5.1** — historical success is a smoothed rate (fork 5), not raw completion/(completion+skip)
   at low n.
4. **§5.2** — the clock-start rule if U6 is adopted (accrual gated on the urgency horizon);
   at latest, decide alongside task 13.
5. **§5.3 / §8.1** — the selection boundary runs **two** hard pre-filters before ranking:
   session capability (context/tools, R3) and dependency-blocked (U1); both retain rejects;
   "dependency issues" in §8.1 now has a concrete mechanism.
6. **§4.1/§4.2** — parent-task lifecycle after breakdown (U2): parent depends on its subtasks,
   surfaces (or auto-completes) when the chain finishes.
7. **§7.2** — R4's fourth coaching trigger (buried out-of-context/tool tasks) still needs its
   table row; the spec shows three triggers. (R4 is ruled; this is bookkeeping, noted here only
   because §7.2 was in this review's spec-change scope.)

---

## 4. One-line call

**GREEN with one mandatory follow-up:** rulings — leave forks 1, 2, 3, 6 as built (fork 6's
degeneracy concern is defanged by linear neglect and its group concern dissolved by R3); smooth
fork 5's n=1 cliff with the shrinkage blend; **build the dependency-blocked pre-filter as the
second half of R2 before task 11** (U1 — the novelty shuffle otherwise serves ordered chains in
random order); link parents to their subtasks at breakdown (U2); adopt the horizon-gated neglect
clock with or before task 13 (U6). Spec §5.1/§5.2 need updating for R1/R3 *today* — they
currently describe the retired composition.
