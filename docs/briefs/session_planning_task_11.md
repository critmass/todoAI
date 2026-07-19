# Task 11 — Session planning (§5.3)

**Owner:** Opus. **Branch:** `opus/batch-a-headless`. **Headless** — pure logic over the data layer and the scoring module; no device run required.

**Blocked by:** task **25** (the U1 dependency-blocked pre-filter). Do not start the selection boundary until 25 has landed — without that filter the novelty ranker serves ordered subtask chains in random order, and any planning built on top inherits the bug.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` — §3 module map, §4 constraints (especially **#5 uncapped neglect**, **#6 two-level scales**).
2. `docs/eval/task10_fable_review_report.md` — §1 fork 3 and fork 6, and **U5** (the unenforced seam). This review deliberately deferred several questions *to this task*; they're listed in §3 below.
3. `docs/briefs/postreview_scoring_task_25.md` — the filters and rulings you're building on.
4. Spec v2.2 §5.3, §6.2, §2.2.
5. `src/scoring/{factors,score,filter}.ts` — the contracts you consume.

---

## 1. What this builds

A **deterministic planner** that turns a session request into an ordered agenda. Input: session length (Quick ≤10 min / Moderate ≤45 min / Deep Focus ≥60 min), the energy check-in (low/med/high), and available contexts + tools. Output: an ordered list of tasks with break slots, plus enough structure for the task-24 execution screen to walk it.

**The plan is hidden from the user** (spec §6, §2.2). They see one task at a time. Do not build a plan-preview screen or expose the agenda through the returned type in a way that invites one.

### The selection boundary — the part that must be right

Order of operations, non-negotiable:

```
listActiveByNeglect()
  → filterBySessionCapability()      // context/tools (R3)
  → filterDependencyBlocked()        // U1, from task 25
  → scoreTasks() or rankWithContextNovelty()
  → arrange into an agenda
```

Both filters run **before** either ranker. Both **retain their rejects** — carry them through to the caller, because spec §8.1's "no available tasks" coaching and R4's buried-task scan both read them. **U5:** this is currently a convention with nothing enforcing it. Add it to your own review checklist and state in the planner's doc comment that the rankers require a pre-filtered pool.

### Arrangement (spec §5.3)

1. **Deep-focus allocation** — when the session is long enough, reserve end-of-session time for 1–2 major tasks, with a **25% overrun buffer** (a 60-min slot plans ~45 min of work).
2. **Context-aware grouping** — group by context; within a group, weighted-shuffle toward a difficulty gradient (easier front, harder back, with real randomness — novelty is the point).
3. **Progressive arrangement** — order the context groups as an energy ramp toward the deep-focus block.
4. **Breaks / self-care** — natural breaks at context switches; **never inside a deep-focus block**. Quick sessions get none.
5. **Escape valve** — regenerate the *remaining* agenda with lower energy requirements, shorter estimates, and same-or-easier contexts. It does not end the session and does not re-plan completed work.

### Tools checklist (spec §6.2)

After planning, surface the required tools. If tools are missing: offer the first **non-deep-focus** task that works with what's present, and rebuild the rest of the agenda against available tools.

---

## 2. Decisions to make (and record in the findings report)

**a. Does planning make an LLM call?** *This is the one that needs Jason, not you — ask before building if he hasn't ruled.* Task 18's design specified `assemblePlanningPrompt` but flagged that **planning-scope skills have no consumer if planning is fully deterministic**. Recommendation: build v1 **deterministic**, no LLM call — it's faster, testable, reproducible, and at ~5.2 tok/s a planning call costs real seconds before the user starts working. If that holds, planning-scope skills fire only via recalibration/escape-valve coaching until a consumer exists; say so explicitly so task 19 isn't built against a phantom seam.

**b. Fork 3 — energy asymmetry stays out of scoring.** The review ruled the energy factor stays symmetric and pushed the "a high-energy session can afford easy tasks" argument *here*, because it's a session-**filling** question, not a scoring one. Handle it in the **difficulty gradient and energy ramp** — low-energy tasks are present in the ranked pool by design (energy is a weight, not a filter); use them to fill the ramp's front end. Do not reintroduce asymmetry into `energyMatchFactor`.

**c. Fork 6 — prove the shuffle.** Build the review's cheap test: a **seeded-rng positional-entropy check** over a realistic pool snapshot. Re-roll `rankWithContextNovelty` N times and measure the entropy of slots 1–3. **Alarm condition: slot-1 entropy ≈ 0 without a fail-safe-age outlier present.** That single number settles the "is the shuffle actually shuffling" question either way, and it's a permanent regression test.

**d. Very short sessions.** 5 minutes is a supported, first-class session (spec §8.2). If nothing fits the remaining time, offer to split a larger task rather than ending.

**e. Break overruns repopulate.** A long break doesn't fail the session — re-plan the agenda for the new remaining time, no guilt.

---

## 3. Known interaction with task 28 (flag, don't solve)

Spec §8.7 (multi-session work + hyperfocus "extend") is **unresolved design**, and it lands directly on this task: a partially-done open-ended task re-entering the plan, cumulative duration toward one completion, and the "extend" affordance as the escape valve's inverse. **Do not invent a design for it here.** Build against today's model (a task has an estimate and is completed or not), and **leave a clean seam** where an in-progress state would slot in — then say in the findings report exactly where a retrofit would have to touch. If task 28 lands first, this brief is superseded on that point.

---

## 4. Constraints that bite here

- **Never cap neglect** (#5). Shape and clock-start are tunable; saturation is the violation.
- **Two-level scales** (#6) — project through `scales.ts`; never surface an internal 1–1000 or 1–5 value.
- **Don't re-derive R8's clock rule.** `listActiveByNeglect` owns it after task 25. Consume, don't reimplement.
- **`null`/one-off ≠ `unscheduled`** (#7) — if planning triggers any completion, use the right primitive.
- Deep-focus blocks are uninterruptible by breaks.

## 5. Definition of done

- Planner implemented, commits logical and separate.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- The positional-entropy test committed as a regression test, with its measured baseline recorded.
- Findings report at `docs/eval/task11_findings_report.md`: what landed, the (a)–(e) decisions and their reasoning, the task-28 seam location, and **any gap you consciously left open** — state it plainly. That habit is why U1 was caught before it shipped.
