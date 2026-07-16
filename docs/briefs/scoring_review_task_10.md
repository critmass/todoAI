# Fable Brief — Task 10: Review of task 9's scoring composition (todoAI)

**For:** a Fable review session. You are **reviewing, not implementing** — the deliverable is rulings and rationale, not a patch.
**Under review:** task 9, built headless in `opus/batch-a-headless` (commits `fb721a5`, `8903e74`, `0e381a8`). Code: `src/scoring/factors.ts`, `src/scoring/score.ts`, `src/services/taskCompletion.ts`, tests in `src/scoring/__tests__/`.
**Binding authority:** `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md` §5.1–§5.2 (scoring + the uncapped-neglect fail-safe), §4.1 (two-level scales, importance banding, derived urgency), §4.2 (recurrence + completion semantics). Where this brief and the spec differ, **the spec wins**.
**Also read first:** `docs/briefs/orientation_for_opus.md` (§3 module contracts, §4 the ten constraints — #5 uncapped neglect and #7 null≠unscheduled are the two live wires here).
**Why you:** the batch brief named this review specifically — *"the uncapped-neglect × importance-banding × derived-urgency × weights interaction is exactly the many-parts math that hides pathological orderings."* That prediction was correct. §3 below has three of them, with numbers.

---

## §0 — What task 9 built

Pure logic over the data layer. No LLM, no device; all of it runs under Jest.

| Piece | Where | What |
|---|---|---|
| Five factors | `factors.ts` | importance, derived urgency, energy match, context fit, historical success — each normalized to **[0,1]** |
| Weights | `factors.ts` | `FACTOR_WEIGHTS` = .25/.20/.20/.15/.20, summing to **exactly 1.0** (so `weightedSum` ∈ [0,1]) |
| Final score + ranking | `score.ts` | `scoreTask`, `scoreTasks` (strict), `rankWithContextNovelty` (weighted shuffle within context groups) |
| Completion policy | `services/taskCompletion.ts` | six-way dispatch by recurrence type |

**Already proven by tests — don't re-litigate these:** weights sum to 1.0; every factor is bounded [0,1]; the neglect multiplier is never capped; ranking ties break stably by ascending task id; the six-way completion dispatch routes each recurrence type to the right primitive (including `null` ≠ `unscheduled`).

**What is NOT proven:** everything in §3 and §4. That's your job.

## §1 — Decisions already made (Jason's calls — don't silently re-open)

1. **Neglect starts at 1, not 0.** Applied as `finalScore = weightedSum × (1 + neglectMultiplier)`. The `+1` is a **floor**, not a cap: without it a brand-new task (`weeksNeglected ≈ 0`) would score ~0 and never be selectable. Constraint #5 forbids an **upper** bound; a floor is not a cap. *You may argue the curve's shape (§3.1) — but "just cap it" is off the table.*
2. **Completion dispatch covers all six recurrence types now** (not just one-off/unscheduled). Period **rollover** (advancing `next_due_at`, `reset_date`, missed-quota boost) is time-driven and deferred to task 13; completion only closes, or records progress + resets the neglect clock.
3. `neglectMultiplier` is consumed as-is from `tasks.listActiveByNeglect()` (uncapped `weeksNeglected²`, computed in TS because Android SQLite has no `POWER()`).

## §2 — The composition, as math

```
base  = .25·importance + .20·urgency + .20·energyMatch + .15·contextFit + .20·historicalSuccess   ∈ [0,1]
final = base × (1 + neglectMultiplier)          where neglectMultiplier = weeksNeglected², uncapped
weeksNeglected = (now − COALESCE(last_completed_at, created_at)) / 7
```

The asymmetry that drives every finding below: **`base` is bounded [0,1]; the neglect term is unbounded.** Base can separate two tasks by at most ~10×. Neglect separates them without limit.

## §3 — Three candidate pathologies, with worked numbers

These are **reproduced against the real code**, not hand-derived. They are candidates for your ruling, not established bugs — in each case the spec is genuinely ambiguous about intent.

### 3.1 Neglect stops being a fail-safe and becomes the algorithm at ~2 weeks

Take a best-case task (importance 800, due today, energy matched, context available, no history → cold-start prior) against a worst-case one (importance 200, no due date, energy mismatched, **context unavailable**, skipped twice → success 0):

| Task | base | at 0 wks | at 10 wks |
|---|---|---|---|
| Fresh, perfect match | **0.850** | 0.850 | — |
| Stale, bad on every factor | **0.165** | 0.165 | **16.665** |

- **Crossover: 2.04 weeks.** After ~2 weeks the worst task on every single factor outranks the best task on every single factor.
- At 10 weeks it wins by **19.6×**.

§5.2 says neglect guarantees a task *"eventually"* surfaces "to force a decision" — a **fail-safe**. A knee at 2 weeks makes it the **primary ranking driver**, since in a real backlog most tasks are weeks old: ranking degenerates toward "oldest first," with the five factors as a rounding error. **The ruling I need:** is a quadratic on a *weekly* scale the intended aggression? If not, the shape is the lever (a slower divisor, a later knee, or engaging neglect only past a threshold) — the floor and the absence of a cap both stay.

### 3.2 `ordered` subtasks rank in reverse order

`subtaskImportance` (task 5, `src/llm/breakdown/mapper.ts`) gives ordered siblings ascending offsets by generation index: index 0 → **701**, index 1 → **702**, index 2 → **703**. Scoring ranks by **descending** score. With all else equal, `scoreTasks` returns:

```
id3(imp703) > id2(imp702) > id1(imp701)      # the LAST subtask first
```

So for a breakdown where `ordered: true` means "these must be done in sequence," the composition surfaces the **final** step first. Spec §4.1 says the 1–99 band "orders subtasks within a parent's band … when ordering matters" but **never fixes the read direction** — so either the mapper's offsets are inverted, or scoring should read the band ascending, or (most likely, and worth your view) **importance is the wrong mechanism for sequence entirely** and ordering should be expressed as real `task_dependencies` — which the data layer already enforces, and which `add_dependency` already exposes. Note `ordered: false` correctly gives every sibling the same value (701), per spec.

This one spans task 5 and task 9, which is why neither caught it alone.

### 3.3 A task the user physically cannot do can top the ranking

`contextFit` is a **soft weight (15%)**, not a filter. A task requiring `office`, in a `home` session, 5 weeks neglected (multiplier 25), against a doable, important (900), due-tomorrow task:

```
id9 (office task, contextFit=0) = 11.44   >   id10 (home, imp 900, due tomorrow) = 0.86     # 13×
```

Scoring alone would serve a task that is impossible right now. This may be fine **if** session planning (task 11) hard-filters by context before scoring — but that assumption is currently written down nowhere, and §8.1 treats context mismatch as a coaching/deferral case, not a ranking case. **Ruling needed:** is context a filter or a weight? If a filter, where does it live — and does the same argument apply to `tool_requirements`?

### 3.4 (Lower confidence) The neglect clock starts at creation, not at "actionable"

`weeksNeglected` counts from `created_at` when `last_completed_at` is null — regardless of whether the task was ever *due*. A task created a year ago and deliberately dated to next month carries multiplier `1 + 52²` = **2705** while it is not yet actionable, dominating everything. Arguably correct ("you've had it a year"), arguably wrong (it isn't due). Worth a ruling because it's cheap to fix now and load-bearing later.

## §4 — The open forks (the `REVIEW(task10)` markers in the code)

Each is a reasoned starting choice, not a measured one. Grep `REVIEW(task10)`.

| # | Fork | Chosen | The other side |
|---|---|---|---|
| 1 | **Urgency horizon** = 14 days, linear ramp; overdue saturates at 1 | reasoned, unmeasured | a different horizon, or a non-linear ramp; note overdue-by-1-day and overdue-by-6-months are identical |
| 2 | **Base sensitivity** (`urgency_level` 1–5) contributes a floor capped at **0.15** | honors §4.1's "optional base sensitivity" conservatively | drop `urgency_level` from v1 entirely (it defaults to 3 → a 0.075 floor on *every* deadline-less task) |
| 3 | **Energy match is symmetric** — `1 − \|session − task\|/4` | spend the energy you have on matching work | asymmetric: a high-energy session can always "afford" a low-energy task, so only *under*-capacity should be penalized |
| 4 | **Context fit = fraction** of the task's tags available | partial credit | any-overlap (binary), or a hard filter (see §3.3) |
| 5 | **Cold-start prior = 0.5** for a task with zero attempts | a task with no history isn't a task that "always fails" | §5.4's real hierarchical shrinkage (task 17) — is 0.5 the right stand-in until then? |
| 6 | **Novelty shuffle** samples proportional to raw `finalScore` | simple | because `finalScore` is unbounded, the shuffle's strength is an *uncontrolled* function of the neglect spread: it degenerates to deterministic when one task dominates. A softmax over normalized scores, or rank-proportional sampling, would be tunable. Also: `rankWithContextNovelty` orders groups by their **max** score, so one hugely-neglected task drags its whole group — including that group's weak tasks — ahead of a better-matched group |

## §5 — Out of scope (don't design these here)

- **Session planning** (task 11): deep-focus allocation, the 25% overrun buffer, progressive energy ramp, the escape valve (§5.3).
- **Numeric learning** (task 17): tuning the weights themselves (§5.4). Scoring reads `FACTOR_WEIGHTS` as data; the seeded values are §5.1's defaults.
- **Period rollover** (task 13): `next_due_at` advancement, `reset_date`, missed-quota importance boost.
- **Re-opening §1's decisions** as decisions. Their *consequences* (§3.1) are fair game.

## §6 — What a good review returns

1. A **ruling on each of §3.1–§3.4** — pathology or intended? If pathology, the mechanism to change (curve shape / band direction / filter-vs-weight), not the code.
2. A **call on each §4 fork**, or an explicit "leave it, measure it later, here's the measurement that would settle it."
3. Anything the composition does that **none of us have thought to look at** — that's the actual reason this review exists.
4. Where a ruling changes the spec's intent rather than just the implementation, **say so explicitly** so §5.1–§5.2 get updated rather than quietly diverging from the code.

Task 9 is otherwise **done**: built, unit-tested, lint/typecheck clean. It's the one task in batch A that closes without a device. This review is the last gate on it.
