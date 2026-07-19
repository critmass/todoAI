# Task 25 — Post-review scoring follow-ups (R6–R8 + U1)

**Owner:** Opus. **Branch:** continue on `opus/batch-a-headless`. **Headless** — no device run required.

**Why this exists.** `docs/eval/task10_fable_review_report.md` closed the Fable review of the scoring
composition GREEN, with one mandatory follow-up and two recommendations. Jason has since ruled on
all three. This brief is those rulings plus the mandatory item, as one work order.

**Read first:**
1. `docs/eval/task10_fable_review_report.md` — the review (U1, U2, U6, fork 5).
2. `docs/eval/task10_R1R2R3_implementation_report.md` — what R1/R2/R3 actually landed, especially
   §4.3 (the scope line this brief closes).
3. `docs/briefs/orientation_for_opus.md` §4 — constraints, especially **#5 (uncapped neglect)**,
   **#6 (two-level scales)**, **#7 (`null`/one-off ≠ `unscheduled`)**.
4. `docs/briefs/scoring_review_task_10.md` — R1–R5, for context on how these rulings are numbered.

**New rulings recorded here (continuing the R-series):**
- **R6** — historical-success smoothing (fork 5).
- **R7** — parent-task lifecycle after breakdown (U2).
- **R8** — neglect accrual gate for recurring tasks (U6, as re-ruled).

---

## 1. R6 — Smooth the historical-success cold-start cliff

**Ruling: adopt the review's fix as written.**

`historicalSuccessFactor` currently hard-branches: `n ≤ 0 → 0.5`, else the raw rate. The prior
vanishes on the first observation, so one skip → 0.0 and one completion → 1.0, i.e. ±0.115 of base
score decided by a single event on the 23% weight.

Replace with:

```
historicalSuccessFactor(rate, n) = (rate·n + 0.5·k) / (n + k),   k = 2
```

The `n = 0` case falls out of the same expression (→ 0.5), so the branch disappears rather than
being kept alongside. First skip lands at 0.33, first completion at 0.67, converging to the raw
rate as evidence accumulates.

This is the degenerate form of spec §5.4's hierarchical shrinkage — **task 17 later replaces the
prior's *source* (fixed 0.5 → learned global/parent prior), not the formula.** Leave `k` a named
constant so 17 can reach it.

**Tests:** n=0 → 0.5; single skip → 0.33; single completion → 0.67; convergence toward the raw rate
at large n; and the existing factor-weight-sum assertions still hold.

---

## 2. U1 — The dependency-blocked pre-filter (the mandatory item)

**This is the load-bearing second half of R2, and it blocks task 11.**

The problem, from the review: ordered siblings from one breakdown share `created_at` (equal neglect
clocks) and inherit the parent's `context_tags` (same shuffle group). The fan-out offset separates
adjacent steps by ≈0.2–0.4% of `finalScore`, which is **noise to a proportional sampler** — so
`weightedShuffle` serves an ordered chain in near-random order. R2's validity claim ("descending by
score is a valid execution order") is true of `scoreTasks` and **false of
`rankWithContextNovelty`**. No amount of offset tuning fixes this; the fix is to keep blocked tasks
out of the pool entirely.

**Shape:** a second hard pre-filter beside `filterBySessionCapability` at the selection boundary,
following the **same partition-and-retain contract** — return `eligible` / `rejected`, with rejects
carrying the **blocking task ids**. Rejects are retained, not discarded: spec §8.1 already names
"dependency issues" as a no-available-tasks coaching cause, and R4's scan wants them.

**Also required (U5, cheap here):** the rankers' doc comments must state that the pool is expected
pre-filtered, and the task-11 brief gets a review-checklist item that the selection boundary calls
**both** filters before either ranker. Not worth a type-system fix; do not build one.

**Tests:** a blocked subtask never appears in `eligible`; the unblocked head of a chain does;
rejects carry correct blocker ids; a chain re-ranked N times under the novelty ranker never
inverts, because only one step is ever in the pool.

---

## 3. R7 — Parent-task lifecycle after breakdown (U2)

**Ruling: keep the parent. When the last subtask completes, immediately trigger a coaching
conversation for the user to confirm the parent is done.**

Today `persistBreakdown` leaves the parent `active`, in `listActiveByNeglect`, at importance just
below its own subtasks, with identical context/energy — so it competes with its own pieces and is
always the wrong grain to serve.

**Three parts:**

**a. Link parent to subtasks.** In `persistBreakdown`, add `parent depends_on <each subtask>` edges
via the now-guarded `dependencies.add`. `parent_task_id` is a column, not an edge, so this creates
no cycle. The U1 filter then hides the parent for the whole life of the chain.

**b. Fire coaching on the last completion.** When the final subtask completes and the parent
unblocks, enqueue a **new coaching trigger — `breakdown_complete`** — with **`urgency:
'immediate'`**. Rationale for immediate over queued: the completion is a natural seam (the same
argument §7.2 makes for the skip), the user's knowledge of whether the work is actually done is
freshest right then, and it lands on a win rather than interrupting one. The conversation asks for
the check-off; it does **not** auto-complete the parent.

**c. Hold the parent out of the pool until that coaching resolves.** This is the part that is easy
to get wrong. The parent unblocks the instant the last subtask completes, so without a hold it
re-enters the ranked pool and can be served as an ordinary task before the confirmation ever
happens — the U2 bug returning through the side door. Immediate firing makes the window short, but
it does not remove it (session ends, app is backgrounded, crash before resolution). **Design
decision left to you, with a recommendation:** have the U1 filter also exclude tasks with a pending
`breakdown_complete` coaching row, rather than inventing a new task state. R4's sentinel is the
alternative; prefer the filter unless you find a reason not to, and record which you chose and why.

**Resolution semantics:**
- *Confirmed done* → complete the parent. **Use the correct completion primitive** (constraint #7):
  if the parent is `unscheduled` or recurring, `recordUnscheduledCompletion`, **not**
  `update(status:'completed')`.
- *Not actually done* → the natural resolution is **`add_missing_task`**, which re-blocks the parent
  via a new subtask and the chain continues. **Note:** `add_missing_task` dispatch is still
  **unexercised on-device** (task 12 §4). This ruling makes that residue item load-bearing rather
  than incidental — flag it for the next device session; it is now on the personal-ship path.

**Edges you must handle:**
- **Nested breakdown.** If the parent is itself a subtask of a grandparent, completing it may unblock
  the grandparent and fire a second `breakdown_complete` immediately. Chained confirmations must not
  stack into a pile-up; queue the second rather than firing two immediates at once.
- **Eliminated subtask.** `eliminate_task` on a subtask must remove its dependency edge, or the
  parent is blocked forever by a task that will never complete.
- **Immediate-vs-immediate precedence.** If a `breakdown_complete` and a 3-skip
  `session_recalibration` would both fire, the recalibration wins (the user is struggling; the
  celebration can wait one beat). Record the precedence explicitly.
- **Auto-completion is not in scope.** The check-off is the user's; do not add a "looks done, closing
  it" path.

---

## 4. R8 — Neglect accrual gate for recurring tasks (U6, re-ruled)

**Ruling: on recurring tasks, neglect does not begin accruing until half the distance between
occurrences has elapsed. For quota types the occurrence gap is `period / (1 + quota)`.**

Effective clock start:

```
accrualStart = anchor + gap(recurrence)
anchor       = COALESCE(last_completed_at, created_at)

gap(scheduled | scheduled_quota | quota) = period / (1 + quota)      // quota defaults to 1
gap(unscheduled | count | none)          = 0
```

Worked reference points (confirm these in tests):

| Recurrence | period | quota | gap | meaning |
|---|---|---|---|---|
| annual `scheduled` | 365 d | 1 | **182.5 d** | 6 months — matches the ruling as stated |
| weekly `scheduled` | 7 d | 1 | **3.5 d** | half a week |
| `quota` 3×/week | 7 d | 3 | **1.75 d** | evenly-spaced occurrences with end padding |
| `quota` 15/week | 7 d | 15 | **0.44 d** | ~10.5 h |

The `(1 + quota)` denominator is the ruling as given, and it collapses to exactly "half the period"
at quota = 1 — the halving is absorbed into the `+1`, so there is **no separate halve step**.

**What this is and is not.** It is a **start condition, not a cap.** Growth after `accrualStart` is
unbounded, nothing saturates, and **constraint #5 is untouched.** Do not let this become a ceiling
under any refactor.

**Explicitly not gated:**
- **`unscheduled`** — neglect *is* its entire resurfacing mechanism (spec §4.2); gating it would
  break the type.
- **`count`** — no period to halve.
- **One-offs (`null` recurrence)** — **ruled: accrue from creation, as today.** The far-future-dated
  one-off case the review raised is accepted as-is; do not add a horizon fallback for it.

**Where it lands:** `listActiveByNeglect`, which computes `weeksNeglected` in TypeScript already
(op-sqlite has no `POWER()` — do not move this into SQL). It needs recurrence data in that read; if
that means a join or a second read, take the simplest correct option and say which.

**Do not** let task 13 re-derive this. Once landed, 13's period rollover composes with it rather
than duplicating it.

**Tests:** each row of the table above; a task inside its gap has `weeksNeglected = 0` and therefore
multiplier 1.0; a task past its gap accrues from `accrualStart`, not from `anchor`; `unscheduled`
and `count` are unaffected; a one-off accrues from `created_at`; and the linear curve remains
unbounded at three orders of magnitude (the existing R1 test must still pass).

---

## 5. Out of scope

- **Task 11** (session planning) — this brief unblocks it; it does not start it.
- **Spec updates** — task 27 folds R1–R8 into spec v2.3. Note the implied touches as you go
  (§5.1 smoothing, §5.2 clock rule, §5.3/§8.1 two pre-filters, §4.1/§4.2 parent lifecycle,
  §7.2 the new trigger) but do not edit the spec here.
- **The `coaching_queue` CHECK constraint migration** for `breakdown_complete` — that is **task 26**,
  which already extends the same CHECK for R4's buried-task trigger. **Both triggers land in one
  migration.** Coordinate: this brief's code depends on that migration existing.
- **Task 17** numeric learning — R6 leaves it the seam; do not pre-build it.

## 6. Definition of done

- R6, U1, R7, R8 implemented, each as its own commit.
- Full suite + `tsc --noEmit` + `eslint .` clean, no regressions.
- A findings report at `docs/eval/task25_findings_report.md` covering: what landed, the R7 hold
  mechanism you chose and why, anything the rulings didn't cover that you had to decide, and any
  gap you consciously left open (state it, as the R1/R2/R3 report did — that habit is why U1 was
  caught).
