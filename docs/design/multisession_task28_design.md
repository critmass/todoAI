# Task 28 Design — Multi-session work & hyperfocus extension (spec §8.7)

**Status:** design deliverable, ready for Opus to implement without further design input.
**Authority:** spec §8.7 (the open item), §4.1/§4.2 (duration fields, recurrence), §5.3 (planning), §6.2 (execution screen), §8.2 (timers/pausing), task 28 brief (`docs/briefs/multisession_hyperfocus_task_28.md`), orientation constraints #5 and #7.
**Builds on (does not redesign):** the completion-primitive policy (`src/services/taskCompletion.ts`), the two-filter selection boundary (R3 + U1, task 25), the R7 parent lifecycle, the R8 accrual gate, `listActiveByNeglect`'s TypeScript-side neglect computation, the coaching trigger/urgency machinery (`src/services/coaching/triggers.ts`).
**Escalated, not decided here:** whether "extend" gets a guardrail, and of what kind — §6.4 presents the options with a recommendation; Jason rules.

---

## 0. TL;DR — the shape of the design

The app gains a **third episode outcome**: alongside *done* and *skipped*, a work episode can end in **progress** ("park it — I'll be back"). Parking is structurally incapable of reading as a skip: it writes no `skip_count`, enqueues no coaching, and does not count toward the 3-skip recalibration, because it flows through entirely different code paths and columns. State lives on the task as a new **`work_state` axis orthogonal to `status`** — a parked task stays `status='active'`, so every existing pool query, filter, and ranker works unchanged. Time accumulates in `tasks.accumulated_minutes` and folds into **exactly one** `actual_duration_history` entry at completion, so a task worked in five sittings is one learning observation, not five short tasks. Open-ended work gets **`duration_type='floor'`** ("at least an hour"): `estimated_duration` stays `NOT NULL` (it holds the floor), the timer counts **up** instead of down, and an overrun is definitionally not an estimation error. **Extend** is one affordance on the execution screen: it grows the current work stretch by a 25-minute quantum, moves the session end with it if needed, and when the stretch finally ends the agenda tail is **regenerated** for the remaining time — the same primitive the escape valve and break-overrun already use. The neglect clock **re-anchors to `last_worked_at`**: working a task is attention, so the clock restarts, then grows without bound — a clock start, not a cap, on the R8-legitimate side of the line. Scoring is untouched: no new factor, no multiplier, no change to the task-10 GREEN composition. Continuity is planning's job, and it gets exactly one lever: **at most one in-progress task per session gets first claim on the deep-focus block**; the rest of the agenda stays novelty-shuffled.

The three failure modes the brief names, and where each is killed:

| Failure mode | Killed by |
|---|---|
| Pausing reads as a skip → app coaches the user for making progress | Park is a separate outcome with separate columns and no coaching enqueue (§1.3, §1.5) |
| Cumulative time logs as several short tasks → learning corrupted | Single fold point in `completeTask`: one history entry per completion, all recurrence types (§2) |
| In-progress state hides a task from the neglect fail-safe | Clock re-anchors on work but never pauses or saturates; a parked task accrues from the park moment and *must* resurface (§5) |

---

## 1. The state model

### 1.1 Two orthogonal axes on the task, plus a per-episode outcome

**Axis 1 — `tasks.status`** (unchanged): `active | completed | archived | deleted`. Membership in the pool. A task being worked across sessions is **`active` the whole time** — this is the load-bearing choice. The alternative (a new `'in_progress'` status value) was rejected because every pool read in the codebase is `WHERE status = 'active'` (`listActive`, `listActiveByNeglect`, the views); a new status value would force `status IN (...)` edits across all of them and create a class of bugs where one query is missed and in-progress tasks silently vanish from the pool — which is exactly the hiding failure constraint #5 exists to prevent.

**Axis 2 — `tasks.work_state`** (new): `none | in_progress`. Whether there is an open, partially-worked stretch toward the *current* completion. Only meaningful while `status='active'`; the completion fold and every closing disposition reset it to `'none'`.

**Per-episode outcome** — each serving of a task in a session is an **episode**, recorded as an interaction row, ending in exactly one of:

| Outcome | Meaning | Interaction written |
|---|---|---|
| `completed` | The user checked it off | `interaction_type='task_completion'`, `completion_status='completed'` (existing) |
| **`progress`** (new) | The user parked it: worked it, stopping here, intends to resume | `interaction_type='task_progress'`, `completion_status='progress'` (both new enum values) |
| `skipped` | The user declined it — "not this, not now" | `interaction_type='task_skip'`, `completion_status='skipped'` (existing) |
| `abandoned` | The episode ended without a user decision (crash, walked away) | open episode closed on relaunch as `completion_status='abandoned'` (existing value, new recovery rule — §1.4) |

### 1.2 Vocabulary, precisely — paused vs. parked vs. skipped vs. abandoned

The app currently collapses these; here is the full separation:

- **Paused** — the §8.2 in-episode timer pause (interruption, bathroom, phone call). Transient, within one episode, no task state change, already spec'd (>20% paused queues coaching — unchanged, and parked time is *not* paused time; a parked task has no running episode).
- **Parked** (`work_state='in_progress'`) — the episode ended with the `progress` outcome. The user made progress and stopped on purpose. **Never a skip, never a failure.**
- **Skipped** — the user was served the task and declined without working it. The existing coaching signal, unchanged.
- **Abandoned** — an *episode* or *session* ends without a user decision. **Tasks are never abandoned by inference.** The only way a task's in-progress stretch is written off is an explicit user disposition through coaching (`eliminate_task`, or a `modify_task` that resets it). The app infers abandonment of episodes and sessions only.

### 1.3 Legal transitions

```
work_state 'none'
  │  park (progress outcome, episode ≥ 1 min elapsed)         [recordProgressEpisode]
  ▼
work_state 'in_progress'   ── accumulated_minutes > 0, last_worked_at set
  │
  ├─ resume + park again        → stays 'in_progress' (accumulated grows)   [recordProgressEpisode]
  ├─ resume + complete          → 'none'; fold accumulated+episode into ONE
  │                               actual_duration_history entry             [completeTask, §2]
  ├─ resume + skip              → stays 'in_progress'; normal skip semantics
  │                               (skip_count+1, task_skipped coaching row);
  │                               accumulated time RETAINED                 [skip service, task 11/13]
  ├─ episode abandoned (crash)  → stays 'in_progress'; elapsed-minus-pauses
  │                               credited to accumulated (§1.4)            [relaunch recovery, task 13]
  ├─ coaching eliminate_task    → task archived; accumulated discarded
  │                               (logged in the interaction, not history)  [dispatch, unchanged + reset]
  ├─ coaching defer_task        → stays 'in_progress'; deferred work resumes
  │                               with its time intact                      [dispatch, unchanged]
  └─ coaching break_down_task   → stays 'in_progress' on the PARENT; parent is
                                  dep-blocked by its subtasks (R7/U1) and its
                                  accumulated time folds when the parent is
                                  confirmed done (§6.1)
```

**The one dumb check** (per the brief's "the check is dumb, the conversation is smart"): the Park affordance is not offered until the episode timer has run **60 seconds**. You cannot have made progress on work you didn't start; a bail inside the first minute is a skip and should carry skip semantics. That is the entire detector. There is no threshold above it, no "was this real progress" heuristic, and no minimum-minutes rule: past 60 seconds, park is park because the user says so. A user who parks everything to dodge skip coaching is making an honest choice the app respects (coaching over forcing) — and loses nothing structurally, because the neglect clock keeps the task resurfacing (§5).

### 1.4 Crash / relaunch recovery (composes with §8.2's timestamp timers)

On relaunch with an open episode (stored episode start + pause ledger exist, no recorded outcome): close the episode as `abandoned`, credit `elapsed − known pause time` to `accumulated_minutes`, set `work_state='in_progress'`, and write **no skip**. Rationale: a crash must never read as user failure (§8.2 already rules backgrounding "normal, not abandonment"); crediting the elapsed time is the generous-but-bounded choice (the pause ledger caps the overcount, and one noisy episode is diluted inside a cumulative total that only becomes a learning observation at completion). The session itself may still be `abandoned` — session status and task work_state are independent.

### 1.5 What each state means, subsystem by subsystem

| Subsystem | `work_state='in_progress'` means |
|---|---|
| **Scoring** | **Nothing. Deliberately.** No new factor, no multiplier, no change to `historicalSuccessFactor` (parks are neither completions nor skips — `n` unchanged, `success_rate` unchanged). The task-10-reviewed composition stays byte-identical. The *only* scoring-adjacent effect is the neglect anchor (§5), which lives in `listActiveByNeglect`, not in `src/scoring/`. |
| **Planning** | Eligible in the pool as normal, plus first claim on the deep-focus block (§3). Remaining-time arithmetic per §3.2. |
| **Coaching** | Park enqueues **nothing**. Not `task_skipped`, not counted by the 3-skip recalibration counter (which counts skip outcomes, and park is not one), no new trigger type (considered and cut — §9). Skips *of* an in-progress task coach normally. |
| **Learning (§5.4 / task 17)** | Invisible until completion. The fold produces the single duration observation; no partial updates mid-flight (§2.3). |
| **Sessions** | Parked tasks count in a new `sessions.tasks_progressed`, not in `tasks_completed` or `tasks_skipped`. |
| **Skill layer (task 19)** | `progress` is **not** a friction incident (the §4.2 incident definition already excludes it by enum), and for Channel-B attribution a park counts as a *successful* attempt — flag in §8. |

---

## 2. Cumulative duration — the fold

### 2.1 The invariant

> **`actual_duration_history` receives exactly one entry per completion event, equal to the total minutes worked toward that completion, for every recurrence type.**

Mechanism: minutes accrue in `tasks.accumulated_minutes` via `recordProgressEpisode` (and crash credit). At completion, `completeTask` computes `total = accumulated_minutes + finalEpisodeMinutes`, appends `total` to `actual_duration_history`, recomputes `average_actual_duration` as the mean of the history array, and resets `accumulated_minutes = 0`, `work_state = 'none'` — **before** dispatching to the recurrence-typed completion primitive. One choke point; the fold is identical across all six recurrence branches, so constraint #7 is untouched (the fold is orthogonal to *which primitive* closes or keeps the task).

`completeTask`'s signature gains the episode time:

```typescript
completeTask(deps, taskId, opts?: { episodeMinutes?: number })
// episodeMinutes: minutes worked in the episode that ended in this completion.
// Omitted (coaching check-offs, R7 breakdown_complete confirmations): 0 — only accumulated folds.
```

The fold writes go through `tasks.update()` (existing primitive); no new completion primitive is needed. Per-episode granularity is not lost: each episode is an interaction row with `duration_minutes`, so future learning that wants sitting-level data (energy cost per sitting, time-of-day effects) reads interactions, while duration estimation reads the folded history.

### 2.2 What `average_actual_duration` now means

The mean **total work time per completion**. For a one-off: the one number. For `unscheduled`/`scheduled`/`quota` types: the mean across occurrences, each occurrence's multi-sitting time already summed. For `count`: each increment is its own completion (spec §4.2), so each increment folds its own total — a single 30-minute review that happened to span two sittings folds as one ~30-minute entry, which is exactly what "how long does one review take" should mean. This is the number time-estimation learning wants, and it required no redefinition — only the fold discipline above.

### 2.3 The learner in the meantime ("first real completion now takes three weeks")

Position: **the §5.4 model-guess replacement rule waits for the fold.** No partial observation is written and no estimate is mutated mid-flight. Three reasons: partial times are censored data (you know the task took *at least* N minutes — updating an average with a floor observation biases it low); task 17 owns numeric mutation and does not exist yet; and the practical need — "the plan shouldn't keep believing a 60-minute estimate after 3 hours of work" — is handled *in planning arithmetic, not in stored data*, by the overrun rule in §3.2. One seam is left for task 17, named here so it isn't invented twice: `accumulated_minutes ≥ estimated_duration` on an estimate-typed task is an early oh-the-guess-was-low signal 17 may consume; v1 does nothing with it.

---

## 3. Open-ended duration mode, and planning arithmetic

### 3.1 `duration_type = 'estimate' | 'floor'`

New column, default `'estimate'`. For `'floor'`, `estimated_duration` (still `NOT NULL`, still minutes) holds the **floor value**: "at least an hour" → `estimated_duration = 60, duration_type = 'floor'`. The mokRadio case stops being a modeling lie: the 60 is a floor the app *uses as a floor* — a minimum block size for placement — and there is no ceiling to overrun, so nothing about running long is an error.

- **Orthogonal to `duration_source`.** A floor can be user-stated ("at least an hour", `'user'`) or coach-guessed for obviously open-ended work (`'model_guess'`).
- **Who sets it:** the user at extraction (§7 adds one enum field to `task_extraction.v1`), or coaching `modify_task`. Never inferred from magnitude — a user-estimated 90-minute task is still an estimate. (The skill layer's `long_uncertain` bucket keys on `duration_type='floor' OR estimatedDuration ≥ 60` — §8.)
- **Timer semantics** (contract for tasks 13/24): estimate-typed tasks count **down** from remaining (§3.2) as today. Floor-typed tasks count **up** — elapsed this episode, with the *block* end (a session-planning quantity, not a task property) as the boundary that raises the end-of-block prompt (§4.1). An extend stretch on any task also counts up.

### 3.2 `plannedMinutes` — the one function task 11 sizes agenda items with

```
plannedMinutes(task, blockWorkMinutes):
  floor-type:                              → fills its block: min(blockWorkMinutes, ∞) = blockWorkMinutes,
                                             but only placeable in a block ≥ estimated_duration (the floor
                                             is a MINIMUM block size — never place "at least an hour" work
                                             into a 20-minute slot; offer-to-split is the fallback)
  estimate-type, work_state='none':        → estimated_duration
  estimate-type, in_progress,
    accumulated < estimated_duration:      → remaining = estimated_duration − accumulated_minutes
  estimate-type, in_progress,
    accumulated ≥ estimated_duration:      → treat as floor-type for placement (the task has PROVEN
                                             open-ended; it fills a block, no stored field mutates)
```

The last row is the §2.3 practical fix: a blown estimate converts the task's *planning treatment* to open-ended, without touching stored data — the eventual completion writes the true total and estimation learning corrects from truth.

`blockWorkMinutes` already accounts for §5.3.1's 25% overrun buffer (a 60-minute slot plans ~45 of work); this design adds no second buffer.

### 3.3 Re-entry into planning — the resume rule (§2e of the brief)

**At most one in-progress task per session gets first claim on the deep-focus block.** Concretely, as a step 0 before §5.3.1's normal deep-focus allocation:

1. Candidates: `eligible` pool members (both hard filters already applied) with `work_state='in_progress'` that are *placeable* per §3.2 (for floor-types and blown estimates: block ≥ floor).
2. Pick the one with the **most recent `last_worked_at`**. Rationale for recency over score: resumption value is continuity value, and continuity decays with time away (the context-reload cost ADHD pays is the whole reason to resume the freshest thread); meanwhile the *old* parked tasks are already championed by their growing neglect multiplier through the normal shuffle — recency and neglect cover opposite ends without a tunable.
3. Place it in the deep-focus block. The rest of the agenda — including any other in-progress tasks — flows through the untouched novelty pipeline (`filterBySessionCapability → filterDependencyBlocked → rankWithContextNovelty`), where in-progress tasks compete like anyone else.
4. Sessions with no deep-focus block (Quick, short Moderate): **no resume claim.** You don't re-enter a three-hour project in a ten-minute session; if an in-progress task surfaces through the ordinary shuffle and fits per §3.2, fine, but nothing forces it.

This is the entire continuity mechanism. It is planning-level by design: putting a resume boost into scoring would reopen the task-10-reviewed composition and distort the shuffle's proportional sampling for every task, to serve a need that is really about *session structure* (long work belongs in the deep block) — the same reasoning that kept fork 3's energy asymmetry out of scoring and pushed it into arrangement.

---

## 4. Extend

### 4.1 The affordance — one control, task-triggered, session-extending

There is **one** extend affordance, not a task-level and a session-level one. It lives on the execution screen (§6.2 already reserves the spot) and becomes salient at the **end-of-block prompt** — when the current task's planned block (countdown reaching zero, or a floor task's block boundary) is reached:

> **Done · Keep going · Pause for later · Something easier**

(complete / extend / park / escape valve — the four ways a block can end; plain skip remains available before meaningful work has begun, per §1.3.)

**"Keep going"** extends the current work stretch by `EXTEND_QUANTUM_MINUTES = 25` (named tunable; pomodoro-scale, ≈2 prompts/hour — chosen so hyperfocus is interrupted rarely, but not never, pending §4.3). Pressing it repeatedly chains quanta. Mechanics:

1. The current block's end moves +25 min (timestamp-based, §8.2 style: mutate the stored end-time).
2. If the new block end crosses the session's planned end, the session end moves with it and `sessions.extended = TRUE` (column already exists). The session timer extends — the user is declaring they have the time; the app does not argue (pending the §4.3 guardrail ruling on *how* it may gently push back).
3. The timer face switches to count-up for the extended stretch if it wasn't already.

### 4.2 What happens to the rest of the agenda: regenerated, not shifted

When the extended stretch finally ends (any outcome), the remaining agenda is **thrown away and re-planned** for whatever session time remains — the same `replanRemaining(session, remainingMinutes)` primitive the escape valve (§5.3.5) and break-overrun repopulation (§8.2) already require of task 11; extend is its third caller. If no time remains, the session goes straight to summary.

Position, not a hedge: regenerate beats shift and beats shrink-in-place. A shifted tail is stale — it was arranged for an energy ramp and context grouping that a 75-minute hyperfocus stretch has invalidated (energy is different now, and the plan is hidden from the user anyway, so there is no "but I saw the list" cost — spec §2.2/§6.2). Tasks that fall out of the regenerated tail were never promised to the user, remain in the pool, and carry no guilt — identical to the break-overrun rule. Regeneration includes a fresh between-task energy check when the stretch was long (≥50 min), and the regenerated agenda places a **break first** after such a stretch (§5.3.4 self-care placement) — this break-first rule holds regardless of how §4.3 is decided; it is planning hygiene, not a guardrail.

### 4.3 The guardrail question — **escalated to Jason, with a recommendation**

§5.3.4 places breaks deliberately; §10.3 is coaching over forcing. An unbounded, frictionless extend is the app helping the user blow past self-care into the real ADHD failure mode of hyperfocus (skipped meals, 2 a.m., wrecked next day). Whether extend gets a limit is a **product-values call about what kind of app this is**, so it is presented, not decided:

- **Option A — unlimited, quiet.** Extend never resists. Maximal user sovereignty; the app is a tool, not a guardian. Risk: the app becomes complicit in the crash-after-hyperfocus cycle it exists to soften.
- **Option B — nudge cadence, never a wall (recommended).** Every **second** consecutive extend (~50 min of extension), the prompt carries a one-line self-care check ("You've been at this a while — water, stand, stretch? Still going?") — still exactly one tap to continue, never blocking. A stretch that exceeds **2× the original block** additionally queues a `next_start` coaching row (`session_ended_early`-style gentle follow-up, existing trigger types suffice: use `pattern_detected` with `trigger_data:{kind:'long_extend'}`) so the *next* session opens with a conversation, not a mid-flow interruption. This is "coaching over forcing" applied literally: the nudge is in the flow, the coaching is at the seam, nothing ever stops the user.
- **Option C — soft cap.** After N extends the button greys out for the session; work continues untimed but unplanned. Rejected-by-recommendation: it's a wall wearing a cardigan — the first time a user hits it mid-flow, the app has become the parent §10.3 promises not to be.

**Recommendation: B.** It is the only option that takes both §5.3.4 and §10.3 seriously rather than sacrificing one to the other. Implementation note so the ruling is cheap to apply either way: the nudge cadence, the 2× threshold, and the coaching enqueue are three independent switches; A is all three off, B is all three on, and anything between is a config choice, not a redesign.

---

## 5. The neglect clock and the fail-safe (tension 3)

**Rule: working a task re-anchors its neglect clock.** `listActiveByNeglect`'s anchor becomes the latest attention event:

```sql
-- anchor: latest of created_at, last_completed_at, last_worked_at (SQLite's scalar max(),
-- a core function — NOT the POWER()-class math extension; safe on op-sqlite)
(julianday('now') - MAX(
    julianday(created_at),
    julianday(COALESCE(last_completed_at, created_at)),
    julianday(COALESCE(last_worked_at,    created_at))
)) / 7.0  AS weeks_neglected
```

Stated in R8's terms, explicitly: **this is a clock start, not a ceiling.** A work episode is genuine attention — the fail-safe's job is to guarantee every task eventually forces a *decision*, and an hour of work on the task is a stronger decision than the coaching conversation that would also have reset the clock (§5.2 "resets on completion, or on a coaching intervention"). After `last_worked_at`, growth is linear and unbounded; nothing pauses while parked, nothing saturates, ever. The hiding check the brief demands: can an in-progress task hide indefinitely? Only by being *worked* repeatedly — and each re-anchor requires the task to have been served and worked, which is a surfacing loop, not hiding. A task parked once and never resumed accrues neglect from the park moment exactly as an untouched task accrues from creation, and climbs until it forces its decision. Constraint #5 intact; on the R8-legitimate side of the line.

Composition with R8 (task 25): the accrual gate offsets from *its* anchor (`COALESCE(last_completed_at, created_at)`). When both land, the combined rule is `accrualStart = anchor′ + gap(recurrence)` with `anchor′` the three-way max above. Whichever task lands second makes this one-line merge in `listActiveByNeglect`; flagged in both directions (§10, task 25 coordination note).

---

## 6. Interactions with the R-series and recurrence types

### 6.1 R7 — breakdown and the parent's accumulated time

A parked task that later gets broken down (coaching `break_down_task`) keeps its `work_state` and `accumulated_minutes` **on the parent**. The parent is immediately dep-blocked by its subtasks (R7a edges + U1 filter), so it can't be served; its clock re-anchors only if it is worked again — which it can't be while blocked, so it accrues neglect normally and the fail-safe chain (subtasks surface → complete → `breakdown_complete` → confirmation) is the resolution path. When the R7 confirmation completes the parent, `completeTask` folds the parent's own direct minutes as its history entry (`episodeMinutes` omitted → 0); subtasks folded their own. Nothing double-counts. The `breakdown_complete` conversation's "not actually done" branch (`add_missing_task`) re-blocks the parent with its time still intact.

Hold interaction: an in-progress parent pending `breakdown_complete` is already held out of the pool by the R7 hold; `work_state` adds nothing and conflicts with nothing.

### 6.2 R8 — recurring tasks worked but not completed

`last_worked_at` re-anchors neglect for recurring tasks too (attention is attention); the R8 gap then offsets from that anchor per §5. Occurrence machinery (`next_due_at` advancement, period rollover, quota progress) is completion-driven and timer-driven (task 13) and reads none of the new columns — working a weekly task without completing it does not advance its schedule, only its neglect anchor. Correct on both sides: the task stops screaming (you attended to it) but the occurrence stays due (you didn't do it).

### 6.3 `count`-type tasks

Uniform under the fold (§2.2): `work_state`/`accumulated_minutes` describe the stretch toward the *next increment*; each increment's completion folds its own total and resets both. A parked half-review then resumes toward the same increment. No special case anywhere — the six-way `completeTask` dispatch is untouched except for the shared fold.

### 6.4 One-off vs `unscheduled` (constraint #7)

The fold happens before primitive dispatch and is identical for both; `recordUnscheduledCompletion` still owns the neglect-reset-stay-active semantics, `update(status:'completed')` still owns closing. No new completion path exists — park is not a completion and touches neither primitive.

---

## 7. Data-model changes (migration 003, mechanical)

```sql
-- 003_multisession_work.sql
-- tasks: four ADD COLUMNs (no rebuild; ADD COLUMN supports CHECK + NOT NULL DEFAULT — task 26 verified)
ALTER TABLE tasks ADD COLUMN duration_type TEXT NOT NULL DEFAULT 'estimate'
    CHECK (duration_type IN ('estimate','floor'));          -- §3.1; estimated_duration holds the floor value
ALTER TABLE tasks ADD COLUMN work_state TEXT NOT NULL DEFAULT 'none'
    CHECK (work_state IN ('none','in_progress'));           -- §1; orthogonal to status
ALTER TABLE tasks ADD COLUMN accumulated_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (accumulated_minutes >= 0);                       -- §2; folds to ONE history entry at completion
ALTER TABLE tasks ADD COLUMN last_worked_at DATETIME;       -- §5; nullable; neglect re-anchor

-- sessions: one ADD COLUMN (sessions.extended already exists in v2.2)
ALTER TABLE sessions ADD COLUMN tasks_progressed INTEGER NOT NULL DEFAULT 0;

-- interactions: REBUILD (two CHECK constraints gain a value each — SQLite can't ALTER a CHECK)
--   interaction_type   CHECK gains 'task_progress'
--   completion_status  CHECK gains 'progress'
```

**Rebuild hazards, inherited from task 26's findings (follow them, they're verified on this build):**
`interactions` is `AUTOINCREMENT` → capture and restore `sqlite_sequence` around the rebuild; no view in schema v2.2 reads `interactions` (verified against the five views: `active_tasks_with_neglect`, `tasks_due_soon`, `recent_session_performance`, `coaching_priority_queue`, `fireable_skills` — none references it), but the migration must still assert the view list is intact afterward, since 002 rebuilt tables *with* dependent views and the drop-view-first discipline is now the house pattern; recreate `idx_interactions_timestamp` / `_type` / `_session` after the rebuild; the `rebuildsTables` flag on `applyMigration` handles the FK pragma dance; `PRAGMA foreign_key_check` asserted empty.

**`active_tasks_with_neglect` view:** already bypassed by `listActiveByNeglect` (POWER() gap) and not consumed by code; leave it as-is in 003 and let task 27's spec/schema fold-in refresh its definition. The real anchor change lands in `listActiveByNeglect`'s SQL (§5).

**TypeScript surface (kept honest with the schema, the 002 discipline):** `TaskRow`/`Task`/`TaskWriteInput` + mappers gain `duration_type`/`durationType`, `work_state`/`workState`, `accumulated_minutes`/`accumulatedMinutes`, `last_worked_at`/`lastWorkedAt`; `SessionRow`/`Session` gain `tasks_progressed`/`tasksProgressed`; `InteractionType` gains `'task_progress'`; `CompletionStatus` gains `'progress'`; new `DurationType` and `WorkState` string-literal unions in `db.ts`.

## 7.1 Repository & service surface

```typescript
// tasks repository — one new primitive
/** Records a progress episode: accumulates minutes, stamps last_worked_at, marks in_progress.
 *  The PARK primitive — never writes skip_count, never touches success_rate. */
async function recordProgressEpisode(id: number, minutes: number): Promise<Task>
// UPDATE tasks SET accumulated_minutes = accumulated_minutes + ?,
//                  last_worked_at = CURRENT_TIMESTAMP, work_state = 'in_progress' WHERE id = ?

// taskCompletion service — the fold (§2.1), before recurrence dispatch, all branches
completeTask(deps, taskId, opts?: { episodeMinutes?: number })

// listActiveByNeglect — anchor SQL per §5 (three-way max); composes with R8 when both exist

// grammar/extraction (this task's implementation, NOT a retrofit):
// task_extraction.v1: root gains ,"duration_type": durationType ; durationType ::= "\"estimate\"" | "\"floor\""
//   (rule name has no underscore; the JSON key keeps its underscore — the standing Q1c discipline)
// zod validator + extractionToTaskWrite mapper pass it through; extraction guide (task 7 prompt)
// gains one line: phrases like "at least / a couple hours minimum / open-ended" → duration_type "floor".
// breakdown grammar (task_breakdown.v1 subtasks): NOT extended in v1 — subtasks default 'estimate';
// a floor-typed subtask is created via modify_task if ever needed. (Deliberate cut, §9.)
// Both grammar changes go through buildGrammarRegistry → startup guard, per constraint #3.
```

The park/skip/complete outcome dispatch at episode end is the execution-flow service (built by tasks 13/24 against this contract): `completed → completeTask(..., {episodeMinutes})`, `progress → recordProgressEpisode(id, episodeMinutes)`, `skipped →` the skip path (skip_count + `task_skipped` enqueue; unchanged semantics, untouched columns).

---

## 8. Cross-task flags (not retrofits — things other tasks must know)

- **Task 19 (skill layer):** `SituationSnapshot.taskType`'s `long_uncertain` derivation becomes concrete: `duration_type === 'floor' || estimatedDuration >= 60`. The friction-incident definition (design §4.2) keys on `completion_status ∈ {skipped, ended_early, abandoned}` — `'progress'` is correctly excluded *by default*; do not add it. Channel-B attribution: a coached task whose next attempt ends in `progress` counts as **corroboration** (progress is the win condition for long work), not neutral.
- **Task 25 (if it lands after this):** the R8 anchor merge in `listActiveByNeglect` (§5, one line). If 25 lands first (likely), this task's implementation performs the merge instead.
- **Task 27 (spec fold-in):** §8.7 closes; §4.1 gains the four columns + `duration_type` semantics; §6.2's Extend loses its "proposed" tag; §8.2 gains the episode-recovery rule (§1.4); §5.2 gains the `last_worked_at` re-anchor with the start-condition-not-cap statement; the §7.2 trigger table gains **no** row (park doesn't coach — worth stating in the spec explicitly so nobody adds one).
- **Task 32 (device sweep):** the extraction grammar change (§7.1) needs its Phase-B device pass like every grammar change.
- **Jason (ruling needed):** the §4.3 guardrail — A, B (recommended), or C.

---

## 9. Considered and cut (so they aren't re-litigated silently)

- **A `'stale in-progress'` coaching trigger** (parked > N days → conversation). Cut for v1: the re-anchored neglect clock already resurfaces parked tasks with unbounded pressure, at which point serving it *is* the confrontation, and a skip there coaches normally. A dedicated trigger adds a migration value and a detector for something the fail-safe already does. Revisit only with field evidence that parked tasks rot in practice (they mathematically cannot rot silently — see §5).
- **A resume-boost scoring factor.** Cut: reopens the reviewed composition; continuity is a session-structure concern (§3.3).
- **An `'in_progress'` `tasks.status` value.** Cut: silently-vanishing-from-pool failure class (§1.1).
- **Auto-conversion of large estimates to floors.** Cut: `duration_type` is declared, not inferred (§3.1); the §3.2 blown-estimate rule handles the practical case without mutating data.
- **A "was that real progress?" detector** beyond the 60-second gate. Cut per the brief: the check is dumb, the conversation is smart.
- **Floor-typed subtasks in the breakdown grammar.** Cut for v1 to keep the 4B's breakdown output unchanged; the mokRadio shape ("each subtask at least an hour") is served by breaking down into subtasks and marking floors via a follow-up `modify_task` — or more simply by the blown-estimate planning rule. Revisit when real breakdowns demand it. *(Left open deliberately — recorded in the findings report.)*
- **Partial-duration learning updates.** Cut (§2.3); seam named for task 17.

---

## 10. The retrofit bill — every place tasks 11, 13, 17, 24 change

This is the sequencing evidence. **Recommendation: land task 28's implementation (migration 003 + §7.1 surface) *before* task 11.** The bill below shows why: 11's changes are structural (planner core), while 13/17/24's are additive. Building 11 first means rebuilding its allocation step, its item-sizing function, and its agenda type — a genuine rework — versus 13/24 absorbing their items as ordinary requirements and 17 being untouched code (it doesn't exist yet either way).

### Task 11 — session planning (structural: 6 touches)
1. **Agenda item sizing** must call `plannedMinutes(task, blockWork)` (§3.2), not read `estimated_duration` raw — touches every fill/fit computation in the planner.
2. **Deep-focus allocation gains step 0**: the single-resume first-claim rule (§3.3) before normal major-task selection.
3. **Agenda item type** carries block kind — `countdown` (estimate remaining) vs `openBlock` (floor / blown-estimate / extend stretch) — so the execution screen knows which timer face to run. Absent this, the type is designed once and extended never; designed late, it's a breaking change to 24's consumption.
4. **`replanRemaining` gains a third caller** (extend, §4.2) and the break-first-after-long-stretch rule (≥50 min). The primitive itself is already required by escape valve + break overrun; only the callers and the break-first rule are new.
5. **Placement floor**: floor-typed tasks are only placeable in blocks ≥ their floor (§3.2); quick sessions therefore naturally exclude them — the existing "offer to split" fallback is the escape hatch and needs to know a floor task *can* be split (via breakdown), not shortened.
6. **Session-end mutability**: the planner's session record treats planned end as movable (extend, §4.1.2) — an interface assumption to bake in, not a computation.

*(The task-11 brief §3 already instructs Opus to leave this seam and build against today's model if 28 hasn't landed — items 1–3 are exactly the rework that clause would then trigger.)*

### Task 13 — timers & recurrence engine (additive: 5 touches)
1. **Count-up timer mode** for `openBlock` items and extend stretches (§3.1, §4.1); countdown for estimate remaining.
2. **Episode accounting**: the timer reports elapsed-episode-minutes to the outcome dispatch (`recordProgressEpisode` / `completeTask({episodeMinutes})`).
3. **Relaunch recovery rule** (§1.4): open episode → `abandoned` + credit, task `in_progress`, never a skip. (The §8.2 timestamp-timer recovery 13 was already building gains one branch.)
4. **Block/session end-time mutation** for extend (timestamp store update, §4.1).
5. **Pause-percentage coaching** (>20%, §8.2) computes over the *episode*, and parked time is not paused time (§1.2) — a definition to honor, not new machinery.

*(13's period-rollover work reads none of the new columns — §6.2 — and must not re-derive the neglect anchor, which stays owned by `listActiveByNeglect`, same rule as R8.)*

### Task 17 — numeric learning (definitional: 3 touches, zero code rework)
1. **Time-estimation loop** consumes folded per-completion totals (§2.2) — the observation definition, stated before 17 exists so it's never wrong.
2. **Floor tuning policy**: v1 never auto-lowers a user-stated floor; whether completions raise a floor (or a floor converts to an estimate after consistent totals) is 17's open policy — seam named §2.3/§3.1.
3. **Early-signal seam**: `accumulated ≥ estimate` as a pre-completion re-estimate input (§2.3) — optional, 17's call.

### Task 24 — product UI (additive: 5 touches)
1. **Execution screen**: the four-outcome end-of-block prompt (§4.1); Park hidden for the first 60 s (§1.3); Extend control per §6.2's reserved slot; count-up face for open blocks.
2. **Guardrail surface** per Jason's §4.3 ruling (nudge line in the extend prompt, if B).
3. **Between-task + park microcopy**: progress must *read* as a win — "Progress saved — 2 h 10 m in so far" — and a resumed task opens with its accumulated context ("picking up where you left off"; the existing optional "read notes" slot covers the rest).
4. **Session summary**: progressed tasks presented as progress (via `tasks_progressed`), never as incomplete/failed; extended sessions framed positively (`extended` flag).
5. **Add-task confirmation**: floor-typed durations echo as "at least N min" (extraction change itself is 28's scope, §7.1).

---

## 11. Test obligations (the contract, testable headless)

- **Park is never a skip:** a `progress` outcome mutates neither `skip_count` nor `success_rate`, enqueues no coaching row, and three parks in one session enqueue no `session_recalibration`.
- **The fold:** five episodes then completion → exactly one new `actual_duration_history` entry equal to the sum; `average_actual_duration` = mean of entries; `accumulated_minutes` back to 0; verified per recurrence branch (one-off closes, `unscheduled` stays active with clock reset, `count` folds per increment) — constraint #7 assertions unchanged and re-run.
- **Neglect re-anchor:** a task worked yesterday has `weeksNeglected ≈ 1/7` regardless of `created_at`; a task parked 10 weeks ago scores `weeksNeglected ≈ 10` and its multiplier exceeds any fresh task's (the fail-safe reaches parked tasks); the three-way max handles NULLs; the existing R1 unboundedness test still passes; composed with R8's gate when both exist.
- **plannedMinutes:** each §3.2 row, including the blown-estimate → floor conversion and the placement-floor rule.
- **Resume rule:** exactly one first-claim per session; most-recent `last_worked_at` wins; quick sessions claim nothing; the claimed task passed both hard filters first.
- **Extend:** block end +25; session end moves only when crossed; `extended` flips TRUE once; `replanRemaining` called on stretch end with the correct remaining time; zero remaining → summary.
- **Recovery:** open episode at relaunch → `abandoned` interaction, credited minutes, `in_progress`, no skip artifacts.
- **Migration 003:** fresh and populated-2.3.0 paths; `sqlite_sequence` preserved across the `interactions` rebuild (the 002 delete-then-migrate repro pattern); new enum values accepted, bogus still rejected; indexes recreated; `foreign_key_check` empty.
- **Grammar:** `task_extraction.v1` with `duration_type` passes the startup guard, the rule-name lint, and the schema-drift fixtures; existing fixtures extended with one "at least an hour" case.
