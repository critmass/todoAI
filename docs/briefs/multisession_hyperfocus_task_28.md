# Task 28 — Multi-session work & hyperfocus extension (spec §8.7)

**Owner:** Fable. **Deliverable: a design document, not code** — `docs/design/multisession_task28_design.md`, plus a findings report. Opus implements afterward.

**Dependencies: none blocking.** Everything this needs already exists (the type system, the recurrence union, scoring, the coaching resolution actions). **Its significance is what it *blocks*: 11, 13, 17, and 24.** Each of those is built against the assumption that a task is either done or not done, and every one of them would need retrofitting if this lands after. **Sequence it before task 11 or accept the retrofit.**

**Read first:**
1. Spec v2.2 **§8.7** — the open item, including its provenance (the "Finish mokRadio project" test: a 10-step chain where each subtask was "at least an hour" as a *floor*).
2. Spec §4.1 (`estimated_duration`, `duration_source`, `actual_duration_history`), §4.2 (the five recurrence types), §5.3 (session planning), §6.2 (the task screen and escape valve), §8.2 (timers, pausing).
3. `docs/briefs/orientation_for_opus.md` §4 — the ten constraints. **#5 (uncapped neglect) and #7 (`null` ≠ `unscheduled`) both bite here.**
4. `docs/briefs/postreview_scoring_task_25.md` — R7 (parent lifecycle) and R8 (neglect accrual gate); both interact with in-progress state.
5. `docs/briefs/session_planning_task_11.md` §3 — the seam task 11 is being told to leave for you.

---

## 1. The problem

For work in the "long/uncertain" zone — roughly ≥1 hr, where precise estimation stops being meaningful for ADHD — the app needs two capabilities its model doesn't support:

- **Work across multiple sessions.** A task can be worked, **paused, and resumed later** without reading as incomplete or as a failure. `actual_duration_history` must accumulate **cumulative time toward a single completion**, not log several separate short tasks.
- **Extend mid-session.** When it's going well, continue past the planned length — an **"extend"** affordance, the inverse of the escape valve.

The app today has two task outcomes: completed, or not. This work needs a third, and the third one changes things in more places than it first appears.

## 2. What the design must settle

**a. The in-progress state.** Where does it live — a `tasks.status` value, a separate work-session record, or something else? What distinguishes *paused* from *skipped* from *abandoned*? The app currently collapses all three, and that collapse is the bug: **pausing a task the user intends to resume must never count as a skip**, or it feeds the single-skip coaching trigger and, three times over, the immediate session recalibration (§7.2). Getting this wrong means the app coaches the user for making progress.

**b. Cumulative duration.** How `actual_duration_history` accumulates across sessions toward one completion, what `average_actual_duration` means for a task worked in five sittings, and how this interacts with `duration_source` and the §5.4 learning loop that replaces a model guess off the first real completion. If "first real completion" now takes three weeks, what does the learner do in the meantime?

**c. Open-ended duration mode.** `estimated_duration` is `NOT NULL` and the timer is core to the execution screen — so open-ended work can't simply have no estimate. The mokRadio case is the shape: "at least an hour" is a **floor, not a ceiling**, and today the app reads it as a ceiling and treats an overrun as an estimation error. Design how a floor-typed estimate coexists with a mandatory duration and a dominant timer.

**d. The extend affordance.** Task-level, session-level, or both? What happens to the rest of the planned agenda when the user extends — does it shift, shrink, or get discarded? Does the session timer extend with it? And does extend need a limit, which is question (f).

**e. Re-entry into planning.** A partially-done open-ended task re-entering the pool. Does remaining-time get re-estimated? Does it get a resume boost, and how does that interact with the neglect clock (does an in-progress task accrue neglect at all?), with R7's parent-hold mechanism, and with `count`-type tasks where each increment is its own completion?

## 3. Three tensions worth naming rather than resolving quietly

**Resume-continuity vs. novelty.** The app's core ADHD motivator is novelty — weighted shuffle, varied contexts, deliberate unpredictability (§2.3, §10.1). Multi-session work pulls the opposite way: to finish long work you have to *come back to the same thing*. These are in genuine tension and the design should say where it lands and why, not split the difference by accident.

**Hyperfocus extension vs. self-care.** §5.3.4 places breaks and self-care nudges deliberately, and §10.3 is "coaching over forcing." An unbounded extend is the app helping the user work past the point where it's good for them — which is a real ADHD failure mode, not a feature. **Does extend need a guardrail, and is that a nudge or a limit?** This is a product-values call: surface it for Jason with a recommendation rather than deciding it silently.

**The fail-safe and open-ended work.** An `unscheduled` task resurfaces *purely* through neglect (§4.2), and constraint #5 forbids capping that. If an in-progress task's neglect clock is paused or reset while it sits half-done, check carefully that nothing can hide indefinitely. R8 established that a *start condition* is legitimate and a *ceiling* is not — stay on the right side of that line and say explicitly which one you're using.

## 4. Constraints

- **Never cap neglect** (#5). Shape and clock-start are tunable; saturation is the violation.
- **`null`/one-off ≠ `unscheduled`** (#7) — opposite completion semantics, different repo primitives. Any new completion path must respect both.
- **Two-level scales** (#6) — nothing internal reaches the user.
- **Local-only** — no cloud, no new external dependency.
- **Don't over-engineer the detection.** The check is dumb, the conversation is smart. If the design needs to know whether a user is in hyperfocus or has abandoned something, prefer asking in the coaching dialogue over building a detector.

## 5. Definition of done

A design doc concrete enough that Opus can implement without further design input — the bar task 18's design met. Specifically:

- The state model, stated precisely (what states exist, what transitions are legal, what each means for scoring, planning, coaching, and learning).
- The data-model changes, at column level, so the migration is mechanical.
- The extend semantics, including what happens to the agenda.
- Answers to §2(a)–(e) and a stated position on §3's three tensions, with the hyperfocus-guardrail question escalated to Jason rather than decided.
- **Every place task 11, 13, 17, and 24 would have to change**, listed explicitly — this is the retrofit bill, and Jason needs it to decide sequencing.
- A findings report at `docs/eval/task28_design_report.md`, including anything you deliberately left open and why.
