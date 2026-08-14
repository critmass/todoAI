# Task 44 — Personal-use QoL pass

**Owner:** **Sonnet** for the screens; all product questions are **ruled** (§0) — build to them, don't re-open them.
**Status:** ⬜ open. `P`. **Gates nothing** — quality-of-life for Jason's own alpha use.
**Sequencing:** batch onto **task 41's device session**. Kept a separate task so 41's diff stays reviewable and 41 never blocks on a product ruling it has nothing to do with.

---

## 0. Rulings — 2026-08-07, Jason

1. **A task blocked by other tasks gets both buttons disabled** — quick-start *and* self-complete.
2. **Self-completed tasks are excluded from completion-time calculations.**
3. **Quick-start runs the full check-in** and is otherwise a normal session that happens to be one task long.
4. **If any check-in condition would have filtered the quick-start task out — including missing tools — show a warning screen with a back-out button.**
5. **Logs must distinguish a quick-start session from a normal one.**

These are settled. §3 and §4 are the build instructions, not a discussion.

---

## 1. Model warm-up on coaching-screen open

Load the model when the coaching screen opens, not after the first prompt is sent.

`src/app/chat/modelHost.ts` already exposes `ensure()` and `phase(): 'idle' | 'loading' | 'checking_grammars' | 'ready' | 'failed'`, built so "a 3-second load is explained rather than felt." **The change is *when* `ensure()` is called** — on screen mount rather than first send.

**Constraint #3 is not at risk; it gets safer.** The startup guard compiles every grammar before any token is generated, so moving `ensure()` earlier moves the guard earlier. What must *not* change is loading at process launch — a timer-only session never needs the 4B (~3 s and real heat on this hardware). Screen-open is the right middle.

**Watch for:** mount-then-navigate-away leaving a load in flight. `ensure()` dedupes via `inFlight`; confirm the `'failed'` path doesn't throw into an unmounted screen.

---

## 2. The timer dial — deferred, and the record needs correcting

**Nothing regressed, and the code comment that says otherwise is wrong.** `WorkScreen.tsx` lines 1–5 claim the horizontal bar is *"explicitly acceptable — preferable, even — per the task brief."* **Task 24's brief says nothing about it** — no mention of conic-gradient, dial, arc, bar or circle. The comment cites an authorization that does not exist.

What actually happened: the dial lives in task 23's **HTML** prototype (`Main Screen.dc.html`), where `conic-gradient` is one free line of CSS. React Native has no equivalent. Task 24 shipped a bar and recorded it in its findings report §6, *"Deferred to the beta (designed) pass — deliberately, not forgotten"* — filed as a **deferral**, which reads as scheduling, when it was a **change to an approved design.** It was never surfaced for sign-off. See task 45.

**Deferred to the designed visual pass**, where the dependency question gets decided once for the whole visual layer rather than for one control:

| Path | Cost | Risk |
|---|---|---|
| `react-native-svg` | a new **native** dependency in bare RN 0.86 New Architecture | task 24 §9.6's `.cxx` codegen build trap already bit once (`README_build.md`) |
| hand-rolled arc from rotated `View`s | none | fiddly at boundaries, worse for count-**up** hyperfocus which has no fixed denominator |

**In this task, do one thing:** fix the false comment in `WorkScreen.tsx` so it cites the findings report and states plainly that the dial is deferred, not rejected.

---

## 3. Quick-start: launch a session for one specific task

A button on the task view that starts a session for that task.

**It is a normal session, one task long** (ruling 3). Full check-in — energy, context, duration. `sessions` gets its real `user_energy_start`; nothing is left null to save a tap.

**Blocked tasks: the button is disabled** (ruling 1). "Blocked" means:

- **Dependency-blocked** — an incomplete prerequisite. U1's pre-filter exists because ordered chains served out of order was a real defect (tasks 10/25); an enabled button here would walk around the one filter whose bypass causes real harm.
- **Held for R7 `breakdown_complete`** — a parent awaiting the user's check-off is blocked *by its own subtasks*. Same rule, same reason: R7 deliberately holds it out of the pool.

Disabled with a visible reason ("blocked by *X*"), not hidden — a missing button is a bug report, a disabled one with a reason is an explanation.

**The check-in warning screen** (ruling 4). Because check-in happens *after* the task is chosen, the ordinary capability pre-filter has no pool to act on. So run the same predicates against the answers, and **if any condition would have filtered this task out — wrong context, missing tools, insufficient energy, duration that doesn't fit — show a warning screen naming the specific condition, with a back-out button.** Proceed is allowed; the point is that it's informed, not accidental.

Reuse the real predicates from `src/planning/` rather than re-deriving them, or the warning drifts from the filter it's mirroring.

---

## 4. Self-complete: mark a task done that you finished away from the app

**Reuse `completeTask()` in `src/services/taskCompletion.ts`.** It already branches between `tasks.update({status:'completed'})` and `tasks.recordUnscheduledCompletion()` by recurrence type — constraint #7, opposite completion semantics — and runs task 33's cumulative fold and task 36's recurrence advance. **Do not hand-roll a second completion path.**

**Blocked tasks: disabled** (ruling 1). You cannot have finished something whose prerequisite is incomplete; an enabled button offers to record an impossibility.

**Excluded from completion-time calculations** (ruling 2). Concretely:

- Write the `interactions` row with **explicit null runtime fields** and a marker identifying it as self-completed. Do not invent a duration.
- It **counts** for completion and for the neglect clock — the task really is done, and `recordUnscheduledCompletion` resetting the clock is correct.
- It is **excluded from duration/estimation learning.** A completion with no episode carries no evidence about how long things take; pooling it would poison the estimate signal with a sample that has no duration.
- ⚠ **This makes the button a candidate *first* writer for `completion_count` / `success_rate`, which have no writer anywhere today** — `historicalSuccessFactor` scores every task off a permanent n=0, and **task 17 owns that writer** (task 13 report §7). Whatever this task writes, **record it in the findings report** so task 17 inherits the convention instead of re-deriving it.
- **Recurring tasks must still advance** through task 36's engine, or urgency goes stale — the exact bug 36 fixed.

---

## 5. Session origin in the record (ruling 5)

A quick-start session must be distinguishable from a normal one.

**In capture (task 41):** the `episode` and `lifecycle` streams carry a session-origin field — `planned` | `quickstart`. Cheap, and it's the diagnostic view.

⚠ **Recommended, and it's a schema change so it's Jason's call: mark it in `sessions` too.** The reasoning is the one Jason already applied to self-completion in ruling 2 — **the learning layer reads the database, not the capture logs.** A one-task quick-start session is a different population from a planned multi-task session: different length, different selection path, different completion profile. If task 17 pools them naively it learns from a mixed distribution and can't tell. Capture-only means 17 is structurally blind to the distinction.

If ruled in, it is a `sessions` column and **migration 007 / schema 2.8.0**, with the standing rule that every migration sweeps prior migrations' test suites.

---

## 6. Deliverables

1. §1, §3, §4 built to the §0 rulings; §2 limited to the comment correction.
2. Task-view contracts extended for both actions (`src/app/screens/contracts.ts` — `TaskListProps` currently carries only `onOpen` and `onAdd`). Screens stay presentational: no screen imports a repo, a service, `src/execution`, `src/planning`, or a clock.
3. The check-in warning screen, driven by the real planning predicates.
4. Tests for the new controller paths, headless against `better-sqlite3` in the existing style.
5. `docs/eval/task44_findings_report.md` — **must include a "Deviations from human decisions" section, even if empty** (see the standing rule in the coordinator handoff §4). Must record the self-completion learning convention for task 17, and the session-origin decision.

---

## 7. Done means

- All four items confirmed on the S23 FE, DB-verified — self-completion in particular checked against the pulled DB for the correct primitive, the correct recurrence advance, and the `interactions` row shape.
- Both buttons verifiably disabled on a dependency-blocked task and on an R7-held parent.
- The warning screen fires for each filter condition, including missing tools, and the back-out works.
- Quick-start and normal sessions are distinguishable in the logs.
- No second completion path exists. No screen gained a disallowed import.
