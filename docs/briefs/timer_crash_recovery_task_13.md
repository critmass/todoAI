# Task 13 — Timer + episode lifecycle + crash recovery (§8.2)

**Owner:** Opus. **Branch:** `opus/batch-a-headless` (Phase A), device batch for Phase B.
**Carries `P`.** Crash, background, process-kill, and doze behavior are only observable on the S23 FE. Phase A is a full headless build with an injected clock; Phase B is the device pass that closes it. **Task 13 is not done until Phase B runs.**

**Blocked by: nothing.** Task 11 landed (`src/planning/`), task 33 landed (migration 003 + the park primitive + the completion fold). This is the first item on the personal-ship critical path (`13 → 24`), and everything from here needs Jason and the phone.

**Before you start, confirm the merged branch is green.** 11 and 34 landed in parallel and each verified against its own tree (531 tests vs 495). Run `npx jest && npx tsc --noEmit && npx eslint .` on the merged branch first. If it isn't green, that is a finding, not a blocker to work around silently.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` — §3 module map, §4 constraints (**#5 uncapped neglect**, **#7 completion primitives**, and the "a park is not a skip" rule).
2. `docs/design/multisession_task28_design.md` — **§1.2 vocabulary, §1.3 legal transitions, §1.4 crash recovery, §3.1 timer semantics, §4 extend.** This is the design you are implementing; do not redesign it. **Read its extend amendment too:** `docs/design/multisession_task28_design_amendment_extend.md`.
3. `docs/eval/task33_findings_report.md` — **§4 is your itemized bill**, written by the task that deliberately left this work to you.
4. `docs/eval/task11_findings_report.md` — §1 (block kind), §3 (`plannedMinutes`, session-end mutability), §4.2/§4.7 (block geometry, escape-valve semantics), §5 (what 11 left open for you).
5. `src/planning/agenda.ts` and `src/planning/service.ts` — the contracts you consume, in full. They are short; read them, don't infer them.
6. `src/services/taskCompletion.ts` — **read the SCOPE LINE comment at the top.** The period machinery it hands off is **task 36's**, not yours (see §2b) — but read the comment so you know the boundary you must not cross.
7. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` — §8.2, §6.2, §5.3.5. Spec v2.3, not v2.2.

---

## 1. What this builds

The **timer engine and the episode lifecycle** — the runtime state machine that sits between task 11's plan and task 24's screens. Task 24 renders; you own the state, the clock arithmetic, and the durable record. **Build no UI.** Expose a service API clean enough that task 24 is a rendering layer over it.

An **episode** is one serving of one task inside a session. It opens when the user starts a task and closes with exactly one outcome: `completed`, `progress` (parked), `skipped`, or `abandoned`. That vocabulary is already fixed by the task 28 design §1.2 — respect the distinctions exactly.

### 1.1 Timestamp-based timers (spec §8.2)

Store the **end-time**, compute remaining from wall clock, never trust a tick counter. Persist timer state at **task start and after pause only** — not per tick. On relaunch the timer has kept running against the stored end-time, and the app opens to the correct screen (resume if time remains; end-of-block prompt if it expired while the app was dead).

Two faces, driven by task 11's `AgendaTaskItem.blockKind`:
- **`countdown`** — counts down `plannedMinutes`.
- **`openBlock`** — counts **up**; `plannedMinutes` is the block's gross boundary, and reaching it raises the end-of-block prompt rather than ending anything.

An **extend stretch counts up on any task**, regardless of `blockKind` (design §3.1). Extend is a runtime affordance you own, not a planned kind.

### 1.2 The five-option end-of-block prompt (state side)

When a block boundary is reached: **Done · +5 minutes · Keep going · Pause for later · Something easier** → `completeTask` / short extension / hyperfocus extension / park / escape-valve replan. You own the state transitions and persistence for all five; task 24 owns the surface and the microcopy.

**Extend is two affordances, not one — this amends task 28 design §4.1** (see `docs/design/multisession_task28_design_amendment_extend.md`, Jason's ruling of 2026-07-20). "Almost done" and "in flow" are different intents and get different mechanics; §1.4 below is authoritative over the design's single-button §4.1.

- **Done** → `completeTask(deps, taskId, { episodeMinutes })`. The fold is already built — pass the episode minutes and let it work. Do not reimplement the fold or touch `actual_duration_history` yourself.
- **+5 minutes** / **Keep going** → the two extension paths (§1.4).
- **Pause for later** → `tasks.recordProgressEpisode(id, minutes)` + a `task_progress` interaction row + `sessions.tasks_progressed`. **Gated by the 60-second rule** (design §1.3): the park option is not offered until the episode timer has run 60 seconds; a bail inside the first minute is a skip and carries skip semantics. **That is the entire detector.** Do not add a minimum-minutes rule, a "was this real progress" heuristic, or any threshold above it — the check is dumb, the conversation is smart.
- **Something easier** → `replanRemainingFromRepositories` with the escape-valve options; the session continues, completed work is not re-planned.

### 1.3 Crash / relaunch recovery (design §1.4) — the part that must be right

On relaunch with an open episode (stored start + pause ledger, no recorded outcome):

1. Close the episode as **`abandoned`** (`completion_status='abandoned'`).
2. Credit **elapsed − known pause time** to `accumulated_minutes`; set `work_state='in_progress'`.
3. **Write no skip.** No `skip_count`, no `task_skipped` coaching row, no contribution to the 3-skip recalibration counter.

A crash must never read as user failure, and **the app never abandons a *task* by inference** — only episodes and sessions are abandoned by inference; a task's in-progress work is written off only by an explicit user disposition through coaching. The session may independently be `abandoned`; session status and task `work_state` are orthogonal.

### 1.4 The two extension paths (amends design §4.1)

Both are timestamp-style mutations of the stored block end-time. They differ in everything else.

#### `+5 minutes` — "I'm almost done"

- Moves the current block end **+5 minutes**. Flat 5, on every block size — it's a "just let me finish" gesture, not a proportional one. **Ruled; do not make it a percentage.**
- **The timer face does not change.** A countdown stays a countdown.
- **The tail shifts, it does not regenerate.** Five minutes doesn't invalidate an energy ramp. Absorb it into the 25% overrun buffer where there's slack; only move the session end if there isn't.
- **Does not set `sessions.extended`** — that flag means the session ran long on hyperfocus.
- **No cap, no nudge, no promotion to hyperfocus, ever.** Press it ten times if that's what the task needs. **Ruled explicitly, and the reasoning binds:** not knowing how much longer something will take is the executive-function symptom this app exists to absorb, not a behavior to correct. A cap here would turn the button into an accusation. Any future "are you sure?" on this path is a bug against this ruling.
- **Repeated use queues a conversation instead** (below). That is the entire response, and it happens later, never mid-flow.

#### `Keep going` — hyperfocus

Unchanged from design §4.1–4.2 except that it is now the *only* path the guardrail governs:

1. Block end moves **+`EXTEND_QUANTUM_MINUTES` (25)**; chaining is allowed.
2. Crossing the session's planned end **moves the session end** and sets `sessions.extended = TRUE`.
3. The timer face switches to **count-up** for the stretch.
4. When the stretch ends, the tail is **regenerated**, never shifted — `replanRemaining`, extend as its third caller. Zero minutes remaining → straight to summary.
5. A stretch >= 50 minutes triggers task 11's **break-first rule** on regeneration (`LONG_STRETCH_BREAK_FIRST_MINUTES`). Call it; don't reimplement it.

#### The guardrail — RULED: option B, hyperfocus only

Build the design's three switches and ship them **on**:
- A one-line self-care check on the prompt every **second consecutive** hyperfocus quantum (~50 min). One tap still continues. Never blocking.
- A stretch beyond **2× the original block** additionally queues `pattern_detected` with `trigger_data: {kind:'long_extend'}`, urgency `next_start` — the *next* session opens with a conversation, not this one.
- Keep them as three independent flags so the cadence stays tunable without a redesign.

**The guardrail never touches the `+5` path.** Nudging someone who is finishing a task is precisely the wrong moment, and the split exists so that can't happen.

#### Repeated `+5` → a coaching conversation at task close

Fires when, **within one session on one task**, either arm trips — whichever comes first:

- **Count arm:** the 3rd `+5` press.
- **Percentage arm:** cumulative `+5` minutes >= **50% of `estimated_duration`**, subject to a **>=10 cumulative minutes** floor so a 10-minute task doesn't trip on a single press (a near-miss is not a pattern).
- **Floor-typed tasks (`duration_type='floor'`) and blown estimates already treated as open blocks use the count arm only** — a floor has no ceiling to be past, and running long there is definitionally not an estimation error.

Mechanics:
- **Enqueue at task close, not at press.** The conversation wants the real total ("that was 25 minutes, not 10 — should we call it 25 going forward?"), which doesn't exist until the task ends.
- **One row per task per session**, not one per press. Deduplicate.
- **`pattern_detected`, `trigger_data: {kind:'repeated_extension'}`, urgency `next_start`.** That trigger type already exists — **no migration, no CHECK rebuild** for this. Include the press count, cumulative extension, and the original estimate in `trigger_data`.
- Resolution is the existing **`modify_task(duration)`** tool. This is the human path to a better estimate; task 17's learning loop is the automatic one. They agree rather than compete.
- **This is not a skip, not a failure, and not a nudge.** Same framing rule as everywhere else: the system misjudged, not the user.

### 1.5 Pause, backgrounding, session lapse

- Track total pause time per episode. **>20% paused queues coaching** (spec §8.2).
- Backgrounding is **normal, not abandonment** — music and phone-based work are expected. Only a relaunch with an open, un-outcomed episode triggers §1.3 recovery.
- When a task timer expires, the app takes focus like an alarm (you own the state and the scheduling hook; task 24 owns presentation).
- If the **session** timer lapses while waiting on a prompt, return to dashboard and queue coaching.

---

## 2. Two scope boundaries — one decision, one already ruled

### 2a. Where does live timer state persist? *(decision + likely migration 005)*

There is **no home for it today.** `sessions` has `planned_duration`, `started_at`, `completed_at` and nothing else; `interactions` records an episode only once it has *closed*. Nothing durably holds: the open episode's task id, its start timestamp, the current block end-time, the mutated session end-time, or the pause ledger. All of §1.1 and §1.3 depend on that state surviving a process kill.

Options, with a recommendation:
- **A dedicated table (recommended)** — a small `active_episode` / `session_runtime` table holding the open episode and the pause ledger, cleared on close. Explicit, queryable, and the pause ledger gets a real home instead of a JSON blob.
- **Columns on `sessions`** — cheaper, but it mixes live runtime state into a historical record and re-opens a CHECK-bearing table.
- **`learning_state` key/value** — do **not** use this. It is task 19's watermark/tunable store; overloading it with runtime state couples two unrelated subsystems.

**If this becomes migration 005, the migration discipline is mandatory** (task 26 §2–§3 rebuild procedure; view-drop ordering; `sqlite_sequence` save/restore), **and so is the prior-suite sweep**: `runMigrations` walks forward, so 002/003/004's "latest version" and "full object list" assertions become assertions about 005 the moment you register it. Task 34's report §4 documents this exact trap. Expect to touch other migrations' test files; that is correct, not scope creep.

### 2b. The time-driven recurrence engine — RULED OUT of task 13 (it is task 36)

`src/services/taskCompletion.ts`'s header appears to assign task 13 the **period machinery**: advancing `next_due_at` to the next scheduled occurrence, rolling `reset_date` at a period boundary, and applying the **missed-quota importance boost** (spec §4.2). Completion deliberately does none of it — those fire when a *period boundary passes*, not when a user completes something.

**Jason ruled this into its own task (36) on 2026-07-20.** It is headless; task 13 is device-gated; splitting keeps the critical path lean. **Do not build any period logic here.** If you touch `taskCompletion.ts` or the recurrence repo for timer reasons, do not add `next_due_at` advancement, `reset_date` rollover, or the quota boost — that is 36's surface, and 36 owns the tests for it.

**Coordination hazard (also in the task 36 brief):** 13 and 36 are *not* fully file-disjoint, and **both may want a migration 005.** If you add one for §2a, say so loudly in your report and in the commit; whoever merges second renumbers. Do not assume you are the only migration in flight.

---

## 3. Contracts you consume (read them, don't infer them)

| You need | It already exists as | Do not |
|---|---|---|
| The agenda and its item vocabulary | `SessionPlan`, `AgendaItem`, `blockKind`, `plannedMinutes`, `deepFocus`, `resumeClaim` (`src/planning/agenda.ts`) | Build a plan-preview surface. The plan is hidden (spec §2.2/§6.2). |
| Tail regeneration | `replanRemainingFromRepositories(...)` (`src/planning/service.ts`) | Shift or shrink an agenda in place. |
| Parking a task | `tasks.recordProgressEpisode(id, minutes)` | Write `work_state`/`accumulated_minutes`/`last_worked_at` by hand. |
| Completing a task | `completeTask(deps, id, { episodeMinutes })` | Re-derive the fold, or pick a completion primitive yourself (constraint #7). |
| The neglect clock | `listActiveByNeglect` owns R8's gate **and** task 28's three-way anchor | **Re-derive R8's clock rule.** It is merged and tested; consume it. |
| Session rows | `sessions` repo (`create`/`update`) | Assume timer fields exist on it — see §2a. |
| Energy check-ins | `scales.ts` | Surface or persist a raw internal 1–5 (constraint #6). |

Note also: **task 24 owns the `sessions` row write** per task 11's report §5. Coordinate the boundary explicitly in your report so 13 and 24 don't both claim it or both skip it.

---

## 4. Constraints that bite here

- **A park is never a skip.** No `skip_count`, no coaching enqueue, no contribution to the 3-skip recalibration. Separate columns, separate code paths — that separation is the whole design.
- **The app never abandons a task by inference.** Episodes and sessions, yes; tasks, only by explicit disposition.
- **Never cap neglect** (#5). You are not touching the curve, but a "pause the clock while parked" convenience would be a saturation bug. A parked task accrues from `last_worked_at` and must resurface.
- **Don't re-derive R8** — `listActiveByNeglect` owns it after task 25 and 33.
- **60 seconds is the only park gate.** No heuristics above it.
- **Constraint #7** — if any path here triggers a completion, it goes through `completeTask`, which picks the primitive.
- **Two-level scales** (#6) — energy check-ins project through `scales.ts`.

---

## 5. Phase split

**Phase A (headless, do all of it first).** The full state machine with an **injected clock** — every timestamp path testable without a device: block expiry, session lapse, extend chaining, the 60-second gate, the >20% pause rule, and §1.3 recovery simulated by writing an open-episode row and running the relaunch path. Tests must cover recovery arithmetic (elapsed − pauses) directly.

**Phase B (device — this is what closes the `P`).** On the S23 FE, and nothing here substitutes for it:
- Background the app mid-task, return after minutes. Timer correct? No spurious recovery?
- **Force-kill** mid-episode, relaunch: abandoned episode, time credited, **no skip written**, correct screen.
- Let a task timer expire while the app is backgrounded; confirm the alarm-style focus and the correct post-expiry screen.
- Let the session timer lapse while a prompt is open.
- Extend across a session boundary; confirm `sessions.extended` and the moved end-time survive a kill.
- Doze / battery-optimization behavior overnight if a session is left open.

Batch Phase B with task 32's residue sweep if the timing works — it is the same setup cost.

---

## 6. Definition of done

- Timer engine + episode lifecycle implemented; commits logical and separate.
- Full suite + `tsc --noEmit` + `eslint .` clean. If a migration landed, prior migrations' suites swept (§2a).
- Phase B run on the S23 FE, with results in the report. **No Phase B, no done.**
- Findings report at `docs/eval/task13_findings_report.md` covering: what landed; the §2a persistence decision and its reasoning; confirmation that no period/recurrence logic leaked in from §2b (that's task 36); the 13/24 boundary on the `sessions` row write; how the two extension paths and the `repeated_extension` trigger tested; and **anything you consciously left open, stated plainly.**

That last habit is not ceremony. Task 25 naming its open residual is why task 11 closed the R7 hold instead of shipping a parent that could be served before its check-off.
