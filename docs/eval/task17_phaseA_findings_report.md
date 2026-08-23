# Task 17 Phase A — findings report

**Brief:** `docs/briefs/numeric_learning_task_17_phaseA.md` (a supplement to
`docs/briefs/numeric_learning_task_17.md`, which is not superseded). **Owner:** Opus 5, build
subagent, headless. **Date:** 2026-08-22. **Nothing is committed** — the tree is left for
coordinator review.

Phase A does three things: (a) builds the `completion_count`/`success_rate` writer that did not
exist anywhere, (b) pins the `skipCount` wiring task 53's audit found unguarded (W2), (c)
literal-pins the seven constants that were asserted against themselves (W5).

---

## 1. 🔴 The attempt definition — provisional, awaiting Jason's ruling

> **An attempt is a served-and-dispositioned encounter with a task: a completion or a skip.**
> Nothing else is an attempt. Formally, the writer maintains one invariant:
>
> ```
> success_rate = completion_count / (completion_count + skip_count)
> ```

Task 44 §3 deliberately declined to answer this and wrote up the sub-questions for task 17 to
inherit. This is my answer. It is **product intent**, it is **implemented**, and it is **provisional
until Jason rules** — it is recorded in code comments as provisional (`src/db/repositories/tasks.ts`
on `recordHistoricalCompletion`, `src/services/taskCompletion.ts` on `completeTask`) and it is
**not** folded into orientation §5 as settled.

### Why this definition

**1. It is the only definition that makes the scorer and the writer one definition instead of two.**
`src/scoring/score.ts:73–75` already passes `task.completionCount + task.skipCount` as the R6
evidence count `n`. That is an existing, shipped commitment to "attempts = completions + skips" —
half an answer, encoded in the reader. Any writer that disagreed would have made `success_rate` mean
one thing and `n` mean another, and the product of the two (`rate·n`, the numerator R6 actually
uses) would have been a quantity with no interpretation at all. Holding the invariant above makes
`rate·n` **exactly the completion count**, and R6 collapses to a form that can be read off:

```
historicalSuccessFactor(rate, n) = (rate·n + 0.5·k)/(n + k)  =  (C + 1)/(C + S + 2)   [k = 2]
```

which is the posterior mean of a Beta(1,1) prior over "did this task get done when it came up" —
Laplace's rule of succession. R6's shape is untouched (the brief forbids re-deriving it); it simply
now has a coherent meaning. Phase B changing the prior's *source* changes the `+1` and `+2`, nothing
else.

**2. It matches what the user actually did.** A skip is the user being offered the task and saying
no. That is a real, informative negative — it is the whole reason `skip_count` exists and why §7.2
runs a coaching conversation on the third one. Not counting it would throw away the only negative
evidence the app collects.

**3. It keeps the two things the codebase already treats as *not* dispositions out.** A park and a
crash-recovered abandonment are, structurally, not decisions about the task (see §2).

### The alternatives I considered and rejected — for Jason

| Alternative | What it would mean | Why not |
|---|---|---|
| **A. Attempt = completion only** (`success_rate` ≡ 1.0 whenever `completion_count > 0`) | Skips are pure noise | The column becomes a constant. It cannot rank anything, and it discards the app's only negative signal. Also contradicts `score.ts` outright. |
| **B. Attempt = every episode opened** (park and abandonment in the denominator) | A park is a partial failure | Directly violates constraint #11 ("a park is never a skip") and the crash-is-not-user-failure principle. It would also punish exactly the ADHD behaviour the app is built to support — starting something, working 20 real minutes, and parking it. A task worked in five sittings would read as an 80 % failure. |
| **C. Attempt = skip only** (i.e. keep `completion_count` unwritten) | Status quo | This is the live bug. See §4: it is not merely inert — it is *one-sided*, because `skip_count` has had a writer since task 13 and `completion_count` never did. |
| **D. Self-completion excluded from `success_rate` but counted in `completion_count`** | "Doing it away from the app isn't evidence about the app's ranking" | This is the one genuinely arguable alternative, and it is the sub-question task 44 flagged. I rejected it because it **breaks the invariant**: `rate·n` would stop equalling the completion count, and the two columns would need a third (an `attempt_count`) to stay coherent — a schema change Phase A is not permitted to make and, I think, should not want. See §3 for the substantive argument. |
| **E. Time-decay / recency weighting** (recent attempts count more) | A task you used to skip but now finish converges faster | Real and probably right eventually, but it is a *learning-loop* design (§5.4), needs a stored decay state, and belongs to Phase B. Phase A deliberately ships the unweighted count so Phase B has a defined baseline to improve on. |

**What I would want Jason to look hardest at:** D (self-completion), and B's boundary — specifically
whether a task the user parks *repeatedly and never finishes* should eventually register as
something. Under this definition it registers as nothing at all; the neglect multiplier is what
resurfaces it. I think that is correct (the parked work is real work), but it is the case where "not
an attempt" is doing the most work.

---

## 2. How the writer treats each disposition

| What happened | `completion_count` | `skip_count` | `success_rate` | Where |
|---|---|---|---|---|
| **Normal completion** (episode `Done`) | +1 | — | recomputed | `completeTask` → `tasks.recordHistoricalCompletion` |
| **Skip** (episode `Skip`, incl. the escape valve inside the 60-second gate) | — | +1 | recomputed | `tasks.recordSkipEpisode` |
| **Park** (episode `Pause for later`, incl. the escape valve past the gate) | — | — | **untouched** | `tasks.recordProgressEpisode` — reaches neither column |
| **Crash-recovered `abandoned` episode** | — | — | **untouched** | `recoverOpenEpisode` → `recordProgressEpisode` only |
| **Self-completion** (task 44's "I did it away from the app") | +1 | — | recomputed | `selfCompleteTask` → `completeTask` → same primitive |

### The normal completion

`completeTask` calls `tasks.recordHistoricalCompletion(taskId)` once, at the single choke point,
**before** recurrence dispatch — the same position as task 28's duration fold, for the same reason:
it must be identical across all six recurrence branches, and it must fire exactly once. Placing it
before dispatch also means the `task` `completeTask` returns is already the post-write row, so no
caller reads stale counters.

A **`count`-recurrence task counts each increment.** Three increments of a 3-count task are three
completions; the third, which also closes the task, is not double-counted. Pinned by test.

### The skip

`recordSkipEpisode` already incremented `skip_count`; it now also recomputes `success_rate` in the
**same SQL statement**. That matters: SQLite evaluates every right-hand side against the pre-UPDATE
row, so the increment and the recompute cannot be observed disagreeing. Both primitives are written
this way for the same reason — it is a structural guarantee against task 44 §3's rejected state (a
`completion_count` that moves while `success_rate` stays fictional at 0.0). There is no window, not
even within a transaction, in which one column has moved and the other has not.

### The crash-recovered `abandoned` episode

**Confirmed: it does not drag the rate down, and it cannot.** `recoverOpenEpisode`
(`src/execution/episodeService.ts`) closes the episode as `abandoned`, credits the elapsed-minus-
paused minutes via `tasks.recordProgressEpisode`, and returns. It never calls `completeTask` and
never calls `recordSkipEpisode`, so it has no path to either column — the same structural argument
constraint #11 already rests on, not a policy check a refactor could drop. This matches the original
brief §3a and constraint #11's spirit exactly. Pinned by a test that gives the task a real 0.5 rate
*first*, then crashes it, and asserts the rate is unchanged (an assertion against a fresh task's 0.0
default would have passed vacuously).

**Divergence flag for task 19, per the brief:** task 19 owns the parallel *friction-incident*
definition for the skill layer. This report takes no position on whether a recovered crash is a
friction incident for skills — only that it is **not** a failed attempt for scoring. If 19 decides a
crash *is* friction, that is not a contradiction of this, and neither definition should be derived
from the other.

### The self-completion

**It counts as a full completion — numerator and denominator both.** Task 44 established that it
"should almost certainly count toward `completion_count`" and left the `success_rate` half open.
My reasoning for closing it this way:

- The task **is done**. Ruling §0.2 says so. A definition of "success" under which finishing
  something does not count as success would need a much stronger justification than "the app didn't
  watch."
- The invariant (§1) leaves no coherent middle. Counting it in the numerator but not the denominator
  pushes `success_rate` above `C/(C+S)` and can exceed 1.0, violating migration 001's CHECK.
  Counting it in the denominator but not the numerator would score *doing the task* as a failure.
  Excluding it from both requires a third stored count, i.e. a schema change Phase A cannot make.
- Task 44's `notes='self_completed'` marker keeps doing the job it was actually built for, and the
  split is now cleaner than before: it excludes these rows from **duration-weighted** aggregates,
  which genuinely have nothing to measure (`session_id`, `duration_minutes`,
  `user_energy_level_start/end` are all explicit `null`). It is not, and should not be, a marker
  for "half a completion."
- The bias this could introduce — self-completions inflating a task's apparent success — is
  bounded and, I think, benign: a task the user reliably finishes away from the app *is* a task they
  reliably finish. Phase B has the marker available if a duration-weighted or origin-weighted loop
  wants to treat them differently.

**This is the single sub-decision I would most expect Jason to want to overturn**, which is why it
is stated here rather than absorbed.

---

## 3. Where the writer fires — verified against the real call graph

`completeTask` is the **sole** completion path in production. Verified, not assumed:

- `grep -rn "status: 'completed'"` over `src/` (excluding tests): the only production writes are
  the two inside `completeTask` itself (`src/services/taskCompletion.ts:158, 177`). Every other hit
  is a `sessions` row (`closeSession`), a comment, or `src/dev/Task12DeviceScreen.tsx` (a dev
  spike, outside the ship path).
- Its two callers are `completeEpisode` (`src/execution/episodeService.ts:673`) and
  `selfCompleteTask` (`src/services/taskCompletion.ts:209`).
- **The R7 breakdown check-off is not yet wired.** `src/services/breakdownLifecycle.ts`'s header
  documents "Confirmed done → complete the PARENT via `completeTask`", but that module only
  *enqueues* the trigger, and `src/services/coaching/dispatch.ts` states explicitly that **no**
  coaching resolution completes a task. So the check-off is a documented future caller, not a
  present one. When it is wired, it routes through `completeTask` and gets counted for free — which
  is the reason for choosing the choke point rather than instrumenting `completeEpisode`.
- `src/services/recurrence/advance.ts` (task 36's sweep) advances periods and never completes, so a
  period rollover is correctly not an attempt.

Two `Pick<TasksRepository, …>` dependency slices had to widen to carry the new primitive through:
`EpisodeServiceDeps.tasks` and `TaskLibraryDeps.tasks`. Neither module calls it — they only hand
`deps` to `completeTask` — and both are commented to say so, so the widening is not read later as
permission for the episode or library layer to touch these columns directly.

**Capture.** `recordHistoricalCompletion` is enumerated in `withMutationCapture`
(`src/capture/streams/mutationCapture.ts`). Without a wrapper the `...tasks` spread would have
passed it through uncaptured, and the `mutation` stream would have shown a task's skips but never
its completions — an asymmetry in exactly the pair of columns this task makes load-bearing.

**No migration, and none needed.** Every row predating this writer has `completion_count = 0` (there
was no writer) and `success_rate` at its `0.0` default. Since `0/(0 + S) = 0`, **every existing row
already satisfies the invariant**, including rows with nonzero `skip_count`. Jason's alpha database
becomes consistent the moment the code lands, with no backfill. A test pins this
(`a pre-writer row (skips recorded, completion_count 0) is already on the invariant`). Nothing in
`algorithm_weights` was touched — that is Phase B's.

---

## 4. What the writer changes in real scoring

The gap was worse than "the signal is inert." It was **one-sided**: `skip_count` has had a writer
since task 13, `completion_count` never did. So negative evidence reached the scorer and positive
evidence did not.

Fixed inputs for both examples: importance 500 → factor 0.5; no due date, `urgency_level` 3 →
urgency 0.075; energy 3 vs a `med` check-in → energyMatch 1.0; weights 31/23/23/23.

**Example A — "Tidy the garage": completed twice, skipped eight times.**

| | `completion_count` | `success_rate` | `n` | historicalSuccess | baseScore |
|---|---|---|---|---|---|
| **Before** | 0 (never written) | 0.0 | 8 | `(0·8+1)/(8+2)` = **0.100** | 0.42525 |
| **After** | 2 | 0.2 | 10 | `(0.2·10+1)/(10+2)` = **0.250** | 0.45975 |

A task with a genuine 20 % success rate was being scored as a 0 % one. **+0.0345 on the base score,
+8.1 %**; at 2 weeks neglected the final score moves 1.27575 → 1.37925.

**Example B — a task completed 20 times, never skipped.** This is the severe case.

| | `completion_count` | `success_rate` | `n` | historicalSuccess | baseScore |
|---|---|---|---|---|---|
| **Before** | 0 | 0.0 | 0 | `n = 0` → **0.500** (the cold-start prior) | 0.51725 |
| **After** | 20 | 1.0 | 20 | `(20+1)/(20+2)` = **0.9545** | 0.62180 |

Before Phase A, a task the user has finished twenty times scored **identically to one they had never
touched** — 0.5, the prior, because `n` was 0 for both. That is +0.1045 on the base score
(**+20.2 %**), and it is 45 % of the entire 0.23 weight, on every ranking the app produces.

Net effect: the 23 % historical-success weight now contributes real, two-sided information for the
first time, and R6's smoothing — built in task 25, never fed — starts running on actual data.

---

## 5. Test-first, and the mutation evidence

Per `CLAUDE.md`, every behavioural change here got its failing test first.

**(a) The writer.** Written strictly test-first: **18 tests were red across three suites** before a
line of the implementation existed (7 in `tasks.test.ts` failing with
`TypeError: repo.recordHistoricalCompletion is not a function`, 6 in `taskCompletion.test.ts`, 5 in
`episodeService.test.ts`), plus 1 more in `mutationCapture.test.ts` written and failed before the
capture wrapper. Four post-implementation mutations then confirmed each guard is a real detector:

| Mutation on the implementation | Result |
|---|---|
| Delete the `recordHistoricalCompletion(taskId)` call from `completeTask` | **11 tests red** across 2 suites |
| `recordSkipEpisode` stops recomputing `success_rate` (task 44's rejected half-write) | **9 tests red** across 4 suites |
| Drop the `CAST(… AS REAL)` (SQLite integer division: `1/4` = 0) | **3 tests red** |
| Count a skip in the numerator too (i.e. "attempt = anything served") | **10 tests red** across 4 suites |

Every mutation was reverted immediately; `git status` was verified after the sweep.

**(b) W2 — the `skipCount` wiring.** One test in `score.test.ts`, written first, then mutated with
the exact change the audit named (`task.completionCount + task.skipCount` → `task.completionCount`).
Verbatim output:

```
FAIL src/scoring/__tests__/score.test.ts
  ● scoreTask › counts skips as evidence too — n is completionCount + skipCount, not
    completions alone (task 55 / W2)

    expect(received).toBeCloseTo(expected, precision)

    Expected: 0.25
    Received: 0.35

    Expected precision:    10
    Expected difference: < 0.00000000005
    Received difference:   0.09999999999999998

      87 |
      88 |     // n = 10, the full attempt count.
    > 89 |     expect(scored.factors.historicalSuccess).toBeCloseTo(historicalSuccessFactor(0.2, 10), 10);
         |                                              ^
      90 |     // Literal pin of the same value, so the assertion cannot move with the formula:
      91 |     // (0.2·10 + 0.5·2)/(10 + 2) = 3/12 = 0.25.
      92 |     expect(scored.factors.historicalSuccess).toBeCloseTo(0.25, 10);

      at Object.toBeCloseTo (src/scoring/__tests__/score.test.ts:89:46)

Test Suites: 1 failed, 3 passed, 4 total
Tests:       1 failed, 57 passed, 58 total
```

Mutation reverted; `git diff --stat src/scoring/score.ts` empty afterwards. This is now the only
fixture in `src/scoring` or `src/planning` with a nonzero `skipCount`, which is precisely why the
audit could delete the wiring and stay at 973/973.

**(c) W5 — the seven constants.** Each got one extra **literal** assertion alongside (never
replacing) the existing symbolic one, copying `factors.test.ts:45–48` and `src/execution/constants.ts`
as the brief instructed. **7/7 mutations caught:**

| Constant | Mutation | Test that turned red |
|---|---|---|
| `URGENCY_HORIZON_DAYS` | 14 → 30 | `urgencyFactor › the urgency horizon is 14 days (literal pin, task 55 / W5)` |
| `BASE_SENSITIVITY_CEILING` | 0.15 → 0.4 | `falls to the base-sensitivity floor beyond the horizon` **+** `uses only the base floor when there is no due date` (2 red) |
| `MISSED_QUOTA_BOOST_MAX` | 0.25 → 0.30 | `missedQuotaBoost › scales with how much of last period was missed` |
| `DEEP_FOCUS_MAJOR_MIN_MINUTES` | 25 → 20 | `the major-task threshold is 25 planned minutes: 24 cannot anchor a deep-focus block` |
| `BREAK_MINUTES` | 5 → 7 | `a ≥50-minute preceding stretch places a break FIRST in the regenerated agenda` |
| `EASIER_MAX_ITEM_MINUTES` | 25 → 60 | `escape valve (easier): only short items, no open blocks, no deep-focus block` |
| `DIFFICULTY_JITTER` | 1.5 → 0 | `tunable planning constants (literal pins, task 55 / W5) › pins the difficulty-gradient jitter amplitude at ±1.5` |

Six of the seven are pinned *behaviourally* with literals (the horizon straddled at 7 and 14 literal
days; the major-task threshold straddled at 24 and 25 literal minutes). `DIFFICULTY_JITTER` is the
exception and is pinned by value only — there is no existing behavioural assertion to hang a literal
on, because the §5.3.2 gradient is entirely unguarded, and that is **W6**, a separate finding with a
separate remedy (a seeded statistical test) that Phase A does not own. The test says so in a comment
so it is not mistaken for W6 being done.

### The test that guards each change

| Change | Guarding test | File |
|---|---|---|
| Writer exists, invariant holds, real division, CHECK bounds, legacy rows | `historical-success counters (task 17 Phase A)` — 8 tests | `src/db/repositories/__tests__/tasks.test.ts` |
| Fires once per completion at the choke point, every recurrence branch | `historical-success counters (task 17 Phase A)` — 4 tests | `src/services/__tests__/taskCompletion.test.ts` |
| Self-completion counts fully; not double-counted | `selfCompleteTask … historical-success treatment` — 2 tests | `src/services/__tests__/taskCompletion.test.ts` |
| Done / Skip / Park / crash-`abandoned` treatment, mixed history | `historical-success counters per disposition (task 17 Phase A)` — 5 tests | `src/execution/__tests__/episodeService.test.ts` |
| Both halves of the pair reach the `mutation` stream | `captures the historical-success counters, both halves of the pair` | `src/capture/__tests__/mutationCapture.test.ts` |
| (b) W2 — `skipCount` reaches R6's `n` | `counts skips as evidence too …` | `src/scoring/__tests__/score.test.ts` |
| (c) W5 — the seven constants | see the table above | `factors.test.ts`, `planner.test.ts` |

**A note on vacuity, since task 53 is why this task exists.** Two of my first-draft tests passed
vacuously and were rewritten before implementation: asserting `success_rate === 0` after a skip on a
fresh task tells you nothing, because the column already defaults to `0.0`. Both now start from a
real completion so the recompute is the only way to pass, and both are commented to say why. The
`recordSkipEpisode` repository test additionally ends with a skip *after* a completion — the
discriminating case, since everything else in it would also pass if only the completion writer
recomputed.

---

## 6. Verification (real numbers, worktree excluded)

Run as `npx jest --testPathIgnorePatterns worktrees`:

| | Baseline | After Phase A |
|---|---|---|
| **Tests** | 974 | **998** (+24) |
| **Suites** | 86 | **86** (no new suite) |
| `npx tsc --noEmit` | clean | **clean** |
| `npx eslint .` | 0 errors / 56 warnings | **0 errors / 56 warnings** (unchanged) |

The +24: `tasks.test.ts` +8, `taskCompletion.test.ts` +6, `episodeService.test.ts` +5,
`planner.test.ts` +2, `score.test.ts` +1, `factors.test.ts` +1, `mutationCapture.test.ts` +1. (Three
of the W5 literal pins live inside existing tests, so they add assertions rather than test count.)

Twelve files changed, ~652 insertions / 14 deletions, **uncommitted**. Production code:
`src/db/repositories/tasks.ts`, `src/services/taskCompletion.ts`,
`src/capture/streams/mutationCapture.ts`, `src/execution/episodeService.ts` (type slice only),
`src/app/tasks/taskLibraryController.ts` (type slice only).

---

## 7. Deviations from human decisions

**Three.** All are Phase A making a call the briefs explicitly assigned to it or left open; none
overrides a settled decision, and none touches a constraint, a ship gate, or orientation §5.

1. **The attempt definition, including the self-completion sub-question (§1, §2).** The brief marks
   this as PRODUCT-INTENT and provisional. Task 44 §3 declined it; I have implemented
   *attempt = completion or skip*, with a self-completion counting as a full completion in both
   numerator and denominator. The alternatives and the reasoning are in §1's table. **This is
   Jason's to ratify or overturn**, and it is recorded as provisional in the code comments, not as
   settled doctrine.

2. **`recordSkipEpisode` now writes a second column.** Task 13 wrote that primitive with an explicit
   comment saying `success_rate` is *not* recomputed there because "no writer for it exists yet
   anywhere in the codebase — flagged, not silently invented." I have changed that behaviour. It is
   a deviation from a prior deliberate choice, but the choice was explicitly conditional on the
   writer not existing, and task 17 is the task orientation §9 assigns that writer to. The comment
   is rewritten to say what is now true and why, rather than deleted. Naming it here because a
   reviewer skimming the diff should see it flagged rather than discover it.

3. **`withMutationCapture` gained an entry, and two `Pick<TasksRepository, …>` slices widened.**
   The capture wrapper is task 41/42's module and the brief did not ask me to touch it. I did,
   because the alternative was a `mutation` stream that records a task's skips and not its
   completions — an asymmetry created by this change, in the exact columns this change makes
   load-bearing, that would silently misinform whoever reads that stream later. It is one
   enumerated method following the existing `recordSkipEpisode` pattern exactly, with a test. The
   two dependency-slice widenings are mechanical type consequences (`tsc` demanded them); neither
   module calls the new primitive and both carry a comment saying so.

**Not deviations, recorded for completeness:** no migration and no schema change (§3 shows none is
needed); `algorithm_weights` untouched; `neglectCurve`, the neglect multiplier and R8's clock
untouched (constraint #5); `scales.ts` untouched (constraint #6); R6's formula untouched — only its
inputs became real.

---

## 8. What Phase B inherits

- **A defined, tested baseline for `success_rate`.** Phase B's §5.4 loops can now assume the column
  means something. The `data_points_count = 0` reseed guard in migration 004 is still untouched and
  still exists for Phase B's sake.
- **The exact seam for the learned prior.** R6's `(C + 1)/(C + S + 2)` decomposition (§1) shows
  precisely where `HISTORICAL_SUCCESS_PRIOR_MEAN` (0.5) and `HISTORICAL_SUCCESS_PRIOR_K` (2) enter.
  Phase B replaces the prior's *source* — a learned global/parent rate under hierarchical shrinkage
  — by changing those two numbers per cell. The formula and the writer stay.
- **A marker that now has exactly one job.** `interactions.notes = 'self_completed'` +
  `session_id IS NULL` is the join for excluding self-completions from **duration-weighted**
  aggregates. It is deliberately *not* a success-rate modifier. If Jason overturns §2's ruling, this
  marker is where the alternative would attach — and it would then need a third stored count, i.e. a
  migration.
- **Three open threads, none of them Phase A's:**
  - **W6** — the §5.3.2 difficulty gradient is still unguarded (direction *and* jitter). `DIFFICULTY_JITTER`'s
    value is now pinned; its *behaviour* is not, and the value-pin is explicitly not a substitute.
  - **Task 19 / friction incidents** — the crash-is-not-a-failed-attempt ruling here is scoping
    *scoring only*; 19's friction definition is independent and should not be derived from it.
  - **The R7 breakdown check-off** is a documented future caller of `completeTask` that is not
    wired yet (§3). When it lands it is counted automatically — no change needed here — but it is
    worth a test at that time.
- **Task 50's energy charter is untouched and still Phase B's**: `docs/design/energy_definition_task50.md`
  §4–§5 routes the idiosyncratic half of `energy` to §5.4's learned `average_energy_cost`. Phase A
  did not go near internal bands 2/4, and nothing in extraction can reach them through this work.
