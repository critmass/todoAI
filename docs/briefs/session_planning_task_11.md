# Task 11 — Session planning (§5.3)

**Owner:** Opus. **Branch:** `opus/batch-a-headless`. **Headless** — pure logic over the data layer and the scoring module; no device run required.

**Blocked by: nothing. Tasks 25 and 33 have both landed** — `filterDependencyBlocked` exists, and so does the whole task-28 headless contract. **This is the entire remaining headless stretch of the critical path** (`11 → 13 → 24`); everything after it needs Jason and the phone.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` — §3 module map, §4 constraints (especially **#5 uncapped neglect**, **#6 two-level scales**).
2. `docs/eval/task25_findings_report.md` — what R6/U1/R7/R8 actually became in code, and **§2, the R7 hold seam this task must close**.
3. `docs/eval/task33_findings_report.md` — **§4 is this task's added scope**, itemized.
4. `docs/design/multisession_task28_design.md` — the design 33 implemented; §5 for the anchor, §10 for the retrofit bill.
5. `docs/eval/task10_fable_review_report.md` — §1 forks 3 and 6, and **U5** (the unenforced seam). The review deferred several questions *to this task*; they're §2 below.
6. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` — **§5.3, §6.2, §2.2. Use v2.3, not v2.2**; v2.3 is the folded-in spec and describes the ruled target state.
7. `src/scoring/{factors,score,filter,dependencies}.ts` — the contracts you consume.

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

**a. Does planning make an LLM call?** *Still unruled — ask Jason before building, don't default.* Task 18's design specified `assemblePlanningPrompt` but flagged that **planning-scope skills have no consumer if planning is fully deterministic**. Recommendation on the record: build v1 **deterministic**, no LLM call — faster, testable, reproducible, and at ~5.2 tok/s a planning call costs real seconds before the user starts working. If that holds, say so explicitly in the report so task 19 isn't built against a phantom seam. **This is also the only thing that could give task 11 a `P`** — deterministic planning needs no device pass.

**b. Fork 3 — energy asymmetry stays out of scoring.** The review ruled the energy factor stays symmetric and pushed the "a high-energy session can afford easy tasks" argument *here*, because it's a session-**filling** question, not a scoring one. Handle it in the **difficulty gradient and energy ramp** — low-energy tasks are present in the ranked pool by design (energy is a weight, not a filter); use them to fill the ramp's front end. Do not reintroduce asymmetry into `energyMatchFactor`.

**c. Fork 6 — prove the shuffle.** Build the review's cheap test: a **seeded-rng positional-entropy check** over a realistic pool snapshot. Re-roll `rankWithContextNovelty` N times and measure the entropy of slots 1–3. **Alarm condition: slot-1 entropy ≈ 0 without a fail-safe-age outlier present.** That single number settles the "is the shuffle actually shuffling" question either way, and it's a permanent regression test.

**d. Very short sessions.** 5 minutes is a supported, first-class session (spec §8.2). If nothing fits the remaining time, offer to split a larger task rather than ending.

**e. Break overruns repopulate.** A long break doesn't fail the session — re-plan the agenda for the new remaining time, no guilt.

---

## 3. Task 28 — RESOLVED, and it changed this task's scope

**This section is superseded.** Task 28's design and task 33's implementation have both landed. Do **not** build against "today's model and leave a seam" — that instruction is void. Build against the contract task 33 shipped: `work_state`, `duration_type`, `accumulated_minutes`, `last_worked_at`, `recordProgressEpisode`, the `completeTask` fold, and the three-way neglect anchor all exist now.

**Read `docs/eval/task33_findings_report.md` §4 — it itemizes exactly what this task now owes:**
- Item sizing routes through **`plannedMinutes`**, not `estimated_duration` directly.
- Deep-focus allocation gains **step 0, the single-resume claim** — at most one in-progress task, chosen by most-recent `last_worked_at`, gets first claim on the deep-focus block. Quick sessions claim nothing; everything else flows through the untouched novelty pipeline.
- The agenda item type must carry **block kind (countdown vs open block) from day one** — this is the one that becomes a breaking change to task 24 if you skip it.
- **`replanRemaining`** gains a third caller (extend), alongside the escape valve and break overrun. Extend **regenerates** the tail; it never shifts it.
- The **break-first rule** after a stretch of ≥50 minutes.
- The **placement floor**: a floor-typed task is only placeable in a block ≥ its floor.

Not yours: the extend guardrail ruling (Jason owes it; it gates only task 24's surface).

## 3b. Two seams task 25 left specifically for you

1. **The R7 hold is capability-only until you wire it.** `filterDependencyBlocked` takes a third argument (`pendingBreakdownComplete`) and `pendingBreakdownCompleteTaskIds()` produces it — but nothing calls them together yet. **The selection boundary is where that wiring lives.** Without it, a parent whose subtasks just finished can be served as an ordinary task before the user confirms it's done. Task 25's report §2 names this as the residual risk it consciously left open for you.
2. **`precededByRecalibration`.** R7 records this flag on the fire result precisely so the drainer never has to depend on `created_at` tie-breaking at second granularity. If planning touches coaching drain ordering, read the flag rather than re-deriving precedence from timestamps.

## 3c. Superseded text (kept for provenance)

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
