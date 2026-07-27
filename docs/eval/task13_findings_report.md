# Task 13 Findings — Timer + episode lifecycle + crash recovery

**Status: Phase A complete; Phase B run on the S23 FE, with one item outstanding (overnight doze)
and one finding that hands a hard requirement to task 24.** The engine is confirmed on hardware —
including the thing the whole task exists for, a force-kill mid-episode — and the `P` is closed
except for the overnight case. Full suite + `tsc --noEmit` + `eslint .` clean, **531 → 636 tests**,
eslint back to the same pre-existing `react-native/no-inline-styles` warnings in `src/dev/`.

**The one finding that changes someone else's work:** a JS `setTimeout` does **not** fire while the
app is backgrounded or dozing — it is deferred until the app returns to the foreground. The engine
is unaffected (the timer is timestamp-based, so state was correct every time), but **task 24 cannot
implement the alarm-style focus with a JS timer.** Details in §9.4.

**Merged-branch precondition, checked first as instructed:** the tree was already green before I
touched it — 531 tests, `tsc` 0, eslint 0 errors. Tasks 11 and 34 do compose. No finding there.

**Commits (six, logically separate):**

| Commit | What |
|---|---|
| `9b5b687` | migration 005 — the three session-runtime tables (v2.5 → v2.6) + prior-suite sweep |
| `0ce7d68` | runtime repository, `tasks.recordSkipEpisode`, `interactions.linkTask`/`listTaskIdsBySession` |
| `7a00775` | `src/execution/` — constants, pure timer, episode service, tail executor |
| `5e505ae` | timer arithmetic suite (28 cases, pure, injected clock) |
| `b46acc0` | episode lifecycle + tail suites (50 cases, real SQLite) |
| `75af5d1` | `sessions.completed_at` gets a writer |
| *(Phase B)* | `src/dev/Task13DeviceScreen.tsx` — the on-device harness |

---

## 1. What landed

**`src/execution/`** — the runtime state machine between task 11's plan and task 24's screens. No
UI. Every entry point takes an injected `now` (epoch ms); nothing in the module reads a clock.

- **`constants.ts`** — every threshold the design and its amendment fix, named. The guardrail is
  three independent switches (`GUARDRAIL_SELF_CARE_NUDGE`, `GUARDRAIL_LONG_EXTEND_THRESHOLD`,
  `GUARDRAIL_LONG_EXTEND_COACHING`), shipped **on**, per the option-B ruling.
  `EXTEND_QUANTUM_MINUTES = 25` and `SHORT_EXTENSION_MINUTES = 5` are defined here — **they did not
  previously exist in code**, only in the design prose.
- **`timer.ts`** — pure arithmetic: `timerSnapshot`, both extension mutations, the guardrail
  predicates, `repeatedExtensionArm`, `pauseRatio`, `recoveryCreditMs`.
- **`episodeService.ts`** — open / pause / resume, the five-option prompt, the four outcomes, the
  skip path, the escape valve, relaunch recovery, session lapse, session close.
- **`tail.ts`** — executes a `TailDirective` against `replanRemainingFromRepositories`.

**Data layer:** migration 005 (§2), a `runtime` repository over its three tables, and three small
additions elsewhere — `tasks.recordSkipEpisode`, `interactions.linkTask`,
`interactions.listTaskIdsBySession`.

**Both timer faces.** `countdown` counts `plannedMinutes` down; `openBlock` counts up and its
boundary **raises the prompt rather than ending anything**. A hyperfocus stretch switches the face
to count-up on any task; **a `+5` never does** — that asymmetry is tested directly.

**The five options** are all implemented on the state side: `done` → `completeTask` (the fold is
consumed, never re-derived), `short_extension`, `keep_going`, `park` → `recordProgressEpisode`,
`easier` → an `easier` replan. Task 24 owns surface and microcopy.

---

## 2. The §2a decision: where live timer state persists

**Decision: a dedicated three-table set in migration 005 (v2.6.0)** — option A of the three the
brief offered, with the internal shape being mine.

The brief's framing was right but its inventory was not: it says `sessions` "has `planned_duration`,
`started_at`, `completed_at` and nothing else," when it actually has fourteen columns including
`actual_duration`, both energy fields, all three task counters, `escape_valve_used`, `extended` and
`model_tier`. **The load-bearing claim survives the correction**: none of them holds the open
episode's task id, its start, the current block end, the mutated session end, or a pause ledger.

### Why not the alternatives

- **Columns on `sessions`** — mixes live runtime state into a historical record, and `sessions` is
  a CHECK-bearing table whose widening would mean a rebuild. Worse, it makes "is an episode open?"
  a nullable-column interpretation instead of a row that exists or doesn't, which is exactly the
  ambiguity crash recovery cannot afford.
- **`learning_state`** — not used, per the brief. It is task 19's watermark/tunable store, and an
  untyped key/value blob is the wrong home for state whose correctness is the whole task.

### The three tables, and why three rather than one

Each has a genuinely different lifetime, and collapsing them would have broken a rule:

| Table | Lifetime | Why it can't merge |
|---|---|---|
| `session_runtime` | the session | Holds the movable planned end and the session start. |
| `active_episode` | one episode | **Singleton by `CHECK (id = 1)`.** One task is served at a time, so this is a constraint rather than a convention — and it makes "a row survived the launch" *itself* the crash signal, with nothing inferred from a status column. |
| `session_task_extension` | (session, task) | The `repeated_extension` trigger's grain is the task within the session. A task parked and resumed in one session ends one episode and opens another **while the `+5` ledger must keep accumulating** — so it cannot live on the episode. Tested. |

### Two shape decisions inside that

**Epoch milliseconds, not `DATETIME`** — a deliberate deviation from the schema's house style,
confined to these three tables and documented at length in the migration header. These columns are
machine state for wall-clock arithmetic that no SQL date function reads; `CURRENT_TIMESTAMP` is
second-granular while the 60-second gate wants sub-second fidelity; and storing the same unit the
injected clock computes in removes a parse/format step, and a class of TZ bugs, from the one path
that must be right. Where a value *is* an ordinary reportable timestamp — `sessions.completed_at` —
it is written in `CURRENT_TIMESTAMP`'s own format instead.

**The pause ledger is three columns, not a segment table.** `paused_at_ms` (non-null ⇒ paused right
now), `paused_ms` (closed total), `pause_count`. That serves both consumers — §1.4's credit and
§8.2's >20% rule — and survives a kill taken mid-pause. Per-pause rows were considered and cut:
nothing reads them. **Consciously left open** (§7).

**No rebuild.** Three `CREATE TABLE`s, no CHECK widening, no view touches, no AUTOINCREMENT — so 005
deliberately does *not* set `rebuildsTables` and needs no `foreign_keys` dance or `sqlite_sequence`
save/restore. The migration says so explicitly, so the omission doesn't read as a missed step.

### ⚠ The migration number is in contention

**005 / schema 2.6.0 is claimed by this task.** Task 36 may also want 005. **Whoever merges second
renumbers to 006 / 2.7.0 and re-runs the prior-suite sweep.** Said here, in the migration header,
and in the commit message.

**Prior-suite sweep done**, as the brief warned: `runMigrations` walks forward, so 002's, 003's and
004's "latest version" assertions were always assertions about the *newest* migration. Five
assertions across four files moved to `2.6.0`, plus 004's fresh-install test, whose name I changed
from "lands at 2.5.0" to "applies 004" — the old name encoded the trap.

---

## 3. §2b: no period logic leaked in

**Confirmed.** Nothing in `src/execution/` reads or writes `task_recurrence` except through
`completeTask`'s existing dispatch. No `next_due_at` advancement, no `reset_date` rollover, no
missed-quota importance boost. There is a SCOPE LINE comment at the top of `episodeService.ts`
saying so, and `grep` over the module for `next_due_at` / `reset_date` / `current_period_progress`
returns nothing.

**One thing I deliberately did not fix:** `src/services/taskCompletion.ts`'s header still says the
period machinery "belong[s] to the recurrence/timer engine (task 13)". That is now stale — it is
task 36's. I left it rather than correct it, because task 36 will certainly rewrite that header and
a two-line edit there would be a pointless merge conflict on a file it owns. **Task 36 should fix
the pointer when it lands.**

---

## 4. The 13/24 boundary on the `sessions` row

Stated explicitly, because the brief flagged that both tasks could claim it or both skip it.

- **Task 24 CREATES the row.** It owns the check-in data — session type, planned duration, energy
  start — and nothing in task 13 can supply it. It then calls `startSessionRuntime`.
- **Task 13 owns every write after that**: the three episode counters (`tasks_completed`,
  `tasks_skipped`, `tasks_progressed`), the `extended` flag, `escape_valve_used`, and the terminal
  close (`status`, `actual_duration`, `completed_at`) via `closeSession`.

The split is not arbitrary: every post-creation write depends on runtime state that only task 13
holds, and splitting them would put two owners on one row. This is consistent with task 11's report
§5 ("writing the session row … [is] the owning task's work"), which was about session *creation*.

**A schema note task 24 needs:** `sessions.status` has only `'completed' | 'abandoned'` — there is
no in-progress value. So a running session must be born with a terminal status. **Create it as
`'abandoned'`**: that way a crash leaves the truthful value behind and `closeSession` overwrites it
on a clean end. The tests are written that way.

---

## 5. Decisions the design left to me

**1. §1.1 and §1.4 read as contradicting each other; they compose.** §1.1 says relaunch resumes the
timer ("resume if time remains"); §1.4 says relaunch closes the open episode as `abandoned`. Taken
either way alone, one of them is wrong. My reading: the **episode record** closes as `abandoned`
(so nothing is lost and no skip is written), and the app then opens to the right screen for the
**task**, which is a fresh episode against the *same* block if time remains. `recoverOpenEpisode`
returns that routing as a directive with three cases — `resume_block`, `block_expired`,
`session_over` — all tested. No double-count: the closed episode credits `[start, min(now,
blockEnd)]`, the new one starts at `now`.

**2. The recovery credit is bounded by the block end.** §1.4 says "credit elapsed − known pause
time" and calls it "generous but bounded". It is only bounded for a crash-and-immediate-relaunch: a
relaunch three days later would credit three days of "work" into `accumulated_minutes` and poison
the single `actual_duration_history` entry the fold exists to protect — failure mode #2 of the
design's own table. I read the bound as §1.4 composed with §1.1's timer semantics rather than as an
addition: the block end is when the stretch was scheduled to stop and raise the prompt, so the app
cannot have been working past it. Tested (40 minutes dead on a 25-minute block credits 25).

**3. Pausing moves the block end.** Otherwise an interruption eats the block. This is also the
reason spec §8.2 wants a persist "after pause" specifically: the end-time *is* the timer, so a
changed end-time must be durable before the next crash. Nothing is written per tick.

**4. Neither extension takes `now`.** An extension moves the stored end relative to itself, so the
time spent reading the prompt is never swallowed by the extension.

**5. The guardrail is expressed against `hyperfocusQuanta`, never the block end.** `+5` also moves
the block end, so a threshold phrased as "current stretch > 2× original block" would have caught a
chain of `+5` presses — a direct violation of "the guardrail never touches the `+5` path". Two
tests pin this: ten `+5` presses reach a 75-minute stretch on a 25-minute block with no nudge, no
`long_extend`, and nothing queued mid-flow.

**6. The `+5` moves the session end only when the block end actually passes it** — and even then
does **not** set `sessions.extended`. This is my operational reading of "absorb it into the 25%
overrun buffer where there's slack; only move the session end if there isn't". The alternative
(passing the remaining tail minutes in so the service could compute slack precisely) would have
made the timer service a session walker, which is task 24's job.

**7. The escape valve closes the current episode by the same 60-second rule as everything else** —
past the gate it is a park, inside the first minute a skip. Escaping never invents a third
disposition. Both branches tested.

**8. Episode close removes the runtime row *before* the outcome writes.** A crash in that window
loses something either way, and the two losses are not equal: closing last would let recovery credit
the same minutes twice and re-mark a completed task `in_progress` (silent corruption); closing first
can only lose one episode's bookkeeping in a millisecond window, which the user resolves by doing it
again. A transaction would beat both, but the repositories are built over the connection rather than
a transaction handle, so routing them through one is a restructuring this task didn't warrant.
**Named as residual risk in §7.**

**9. Coaching kinds for the two spec'd conversations the amendment didn't name.** Following the
house pattern constraint #12 set (`repeated_extension`, `long_extend` are `trigger_data.kind` on the
existing `pattern_detected` type — no migration): the >20%-pause rule uses
`{kind: 'high_pause_ratio'}` and the session lapse uses `{kind: 'session_lapsed'}`, both
`next_start`. I deliberately did **not** use `session_ended_early` for the lapse — the user did not
end the session early, it ran out while they were deciding, and mislabelling it would put a false
"ended early" in front of the coach.

**10. The abandoned episode writes `interaction_type='task_progress'` with
`completion_status='abandoned'`.** The design fixes the status but not the type. `task_progress` is
right because recovery does to the task exactly what a park does (credit + `in_progress`).
**Flag for task 19:** its friction-incident definition keys on `completion_status ∈ {skipped,
ended_early, abandoned}`, so a crash currently counts as a friction incident. That predates this
task, but §1.3's "a crash must never read as user failure" suggests it shouldn't — **task 19's call,
raised here so it is not decided by accident.**

**11. Minutes round to nearest** (`minutesFromMs`), one rule for every consumer, so a task worked in
five sittings cannot drift against its own history.

---

## 6. How the two extension paths and `repeated_extension` tested

**78 new cases** — 28 pure (`timer.test.ts`), 45 lifecycle against real SQLite
(`episodeService.test.ts`), 5 tail (`tail.test.ts`).

The tests that exist to pin *rulings* rather than behavior:

- **`+5` is uncapped.** Ten chained presses → 75 minutes, no cap, no promotion to hyperfocus, no
  coaching queued at press time, no face change. Two tests, pure and integrated.
- **The guardrail cannot reach `+5`.** Self-care nudge and `long_extend` both silent after six `+5`
  presses; the nudge fires on quanta 2 and 4, not 1 or 3.
- **`long_extend` at 3×, not at 2×.** Exactly 2× the original block is silent ("beyond 2×"); the
  next quantum queues one row at `next_start`, and further quanta do not re-queue.
- **`sessions.extended` is hyperfocus-only.** A `+5` that pushes the block past the session end
  moves the session end and still leaves the flag false.
- **`repeated_extension` fires at close, never at press**, one row per task per session — including
  the hard case: the same task parked after three presses and resumed for three more in the same
  session enqueues **one** row while the ledger reaches six presses.
- **Both arms and both exclusions**: count arm at 3 presses; percentage arm at 50% of the estimate;
  the 10-minute floor keeps a single press on a 10-minute task quiet; floor-typed tasks and blown
  estimates use the **count arm only**, via task 11's own `treatedAsOpenEnded` predicate so the two
  can never disagree about what "already an open block" means.
- **A park is never a skip**: three parks in one session write no `skip_count`, no `skip_reasons`,
  no `success_rate` change, leave `tasks_skipped` at 0 and enqueue **nothing at all**.
- **Park refuses inside 60 seconds** rather than downgrading, and closes nothing when it refuses.
- **Recovery**: credits elapsed − pauses, writes no skip artifact of any kind, leaves the task
  `active` and `in_progress`, bounds at the block end, routes all three ways, is a no-op on a clean
  launch, and cannot run twice on one episode. Every clean close path clears the crash signal.

The 60-second gate and the pause ratio are tested at their exact boundaries (59 999 ms vs 60 000 ms;
exactly 20% does not queue, since the spec says *more than* 20%).

---

## 7. Consciously left open

- **Overnight doze is the one Phase B item not run.** §9 covers a *forced* deep-idle pass
  (`dumpsys deviceidle force-idle`, device confirmed `mState=IDLE`), which is the standard proxy
  and came through clean. A real overnight with a session left open is still unrun, and the
  §9.4 alarm finding makes it the case most likely to behave differently.
- **The close-ordering window (§5.8).** A crash between `closeEpisode()` and the outcome write loses
  that episode's bookkeeping. The fix is a real transaction spanning both, which needs the
  repositories to accept a transaction handle — a data-layer change, not a task 13 change. Named so
  it is a decision rather than an accident.
- **No per-pause segment rows.** The ledger keeps totals and a count, not a history of individual
  pauses. Nothing reads segments today; if a future analysis wants them, they are not reconstructible
  from what is stored.
- **`completion_count` and `success_rate` still have no writer anywhere in the codebase.**
  `TaskWriteInput` omits both, `completeTask` doesn't touch them, and `historicalSuccessFactor`
  consequently scores every task off a permanent `n = 0`. I added the `skip_count` writer because the
  3-skip rule and constraint #11 are meaningless without one, and stopped there rather than quietly
  changing scoring behavior across the app. **This wants an owner** — task 17 is the natural home.
- **The energy check-in seam is unwired.** Spec §6.2's "between tasks: quick rating, energy check"
  belongs to task 24's flow; `interactions.user_energy_level_start/end` are left null by the episode
  rows. Anything writing them must project through `scales.ts` (constraint #6) — no raw 1–5 from a
  user-facing control.
- **`checkSessionLapse` is polled, not pushed.** It is a pure predicate over the stored session end,
  and task 24 decides when to ask. It deduplicates, so polling is safe.
- **The schema snapshot is now behind.** `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql`
  does not describe 2.6.0. That is the spec fold-in's job (task 35 / 27), not something to patch here
  — and it moves again if 005 gets renumbered.
- **Inherited and still open:** the task-32 device pass on task 33's grammar change.

---

## 8. For task 24

The service is meant to be rendered, not reimplemented. The shape:

```
startSessionRuntime  → after creating the sessions row (born 'abandoned')
recoverOpenEpisode   → at launch, ALWAYS, before anything else
startEpisode         → takes an AgendaTaskItem straight from the plan
currentTimer         → { face, remainingMs, workedMs, paused, boundaryReached, parkAvailable }
endOfBlockPrompt     → the five options + the self-care line, or null
pause/resumeEpisode  → explicit pause only; BACKGROUNDING IS NOT A PAUSE
applyShortExtension / applyHyperfocusExtension
completeEpisode / parkEpisode / skipEpisode / escapeToEasier  → each returns a TailDirective
runTailDirective     → carries a 'regenerate' out to the planner
checkSessionLapse / closeSession
```

Three things not to get wrong: **backgrounding must not call `pauseEpisode`** (it is normal, not
abandonment — only an explicit user pause stops the timer); **`parkEpisode` throws inside 60
seconds**, so read `parkAvailable` and offer skip instead; and the **expiry alarm** is an injected
`EpisodeExpiryScheduler` — this module decides *when*, task 24 supplies the platform call, **and
per §9.4 that call cannot be a JS timer.**

---

## 9. Phase B — on the S23 FE

Run 2026-07-27 against a debug build on the real device (`SM-S711U`, `adb` over USB). Driven
through `src/dev/Task13DeviceScreen.tsx`, with every claim below **re-checked by pulling
`databases/todoai.db` off the device and querying it directly** — the on-screen log alone would
only prove what the app believed, not what it wrote.

### 9.1 The data layer, first time on hardware

Migration 005 applies cleanly on op-sqlite: `schema version = 2.6.0`,
`last_migration = v2_6_session_runtime`, all three runtime tables present. Nothing in the
§2 shape decisions turned out to be desktop-only — the `CHECK (id = 1)` singleton, the epoch-ms
`INTEGER` columns and the `ON CONFLICT` upserts all behave as they do under better-sqlite3.

### 9.2 The force-kill, which is the whole point

`adb shell am force-stop com.todoai` mid-episode, then relaunch. Confirmed by DB query, not by log:

| Checked | Result |
|---|---|
| Crash signal survives the process | new PID, `active_episode` row found and reported at launch |
| Episode closes as abandoned | `interaction_type='task_progress'`, `completion_status='abandoned'`, with the recovery note |
| Time credited | `accumulated_minutes = 2`, `work_state = 'in_progress'`, `last_worked_at` stamped |
| **No skip written** | **`skip_count = 0`, `skip_reasons = NULL`** |
| **No coaching queued** | **zero `coaching_queue` rows linked to the session** (the three in the DB are task 12's `{"probe":true}` rows from 2026-07-16) |
| Task not abandoned by inference | `status = 'active'` |
| Nothing folded | `actual_duration_history = NULL` — correct, it wasn't completed |

**The credit bound held on device.** The episode was killed ~50 s into a 2-minute block and
recovered ~7.5 minutes later; it credited **2 minutes, not 7** — `{"creditedMinutes":2,
"directive":{"kind":"block_expired"}}`. Both the `resume_block` and `block_expired` directives were
observed across runs.

**The timer really does keep running while the app is dead.** Mid-run readout after a kill and
relaunch: `countdown rem 00:06 · worked 01:53`, with the process absent for five of those seconds.
Nothing ticks; remaining is arithmetic against the stored end-time, exactly as spec §8.2 requires.

### 9.3 The rest of the checklist

- **Backgrounding is not abandonment.** `KEYCODE_HOME`, 70 s away, return: same PID, no boot, no
  recovery, and the timer correct on return (`worked 01:45`) — the time away counted as worked,
  because backgrounding is not a pause.
- **Extend across the session boundary survives a kill.** One `Keep going` → `sessionEndMoved:true`,
  `sessionExtended:true`. Force-kill and relaunch: `blockEndAtMs` and `session_runtime.
  plannedEndAtMs` both still at start+27 min, `sessions.extended = 1`, `hyperfocusQuanta = 1`, and
  the `long_extend` row still queued at `next_start`.
- **`+5` behaved as ruled.** Three presses: session end moved, **`sessionExtended:false`**, nothing
  queued at press time; `repeated_extension` queued only at task close. The zero-work guard also
  showed up live — an 11-second episode completed with `episodeMinutes: 0` and wrote **no**
  `actual_duration_history` entry.
- **Session lapse** fires once (`lapsed:true` + `session_lapsed`) and dedupes on the second poll
  (`lapsed:true, coaching:[]`).
- **Forced deep doze** (`dumpsys deviceidle force-idle`, confirmed `mState=IDLE`) left the episode
  row, the session runtime and the prompt state intact.
- All three coaching kinds reached the queue as `pattern_detected` at `next_start`:
  `long_extend`, `session_lapsed`, `repeated_extension`. No migration was needed for any of them,
  as constraint #12 says.

### 9.4 ⚠ The finding: a JS timer is not an alarm

**Task 24 must not implement the expiry alarm with `setTimeout`.**

Twice, deliberately: with the app backgrounded, and again under forced deep doze. Both times the
alarm was scheduled correctly for the block end and **did not fire at that instant** — it fired on
return to the foreground, 38 s and 45 s late respectively. Android suspends the JS thread; a
pending timer just waits for the app to come back.

What this does *and does not* mean:

- **The engine is unaffected, and this is exactly why the design is timestamp-based.** In both
  runs the state on return was correct: `boundaryReached` true, the five-option prompt available,
  worked minutes right. Nothing depends on the alarm having fired.
- **The user-facing requirement is not met by the harness's mechanism.** Spec §6.2's "the app
  takes focus like an alarm" needs a real platform primitive — `AlarmManager`, a scheduled
  notification (notifee), or a foreground service — scheduled at `blockEndAtMs`. The
  `EpisodeExpiryScheduler` seam is already the right shape for it; only the implementation behind
  it changes, and it is task 24's to supply.

This is precisely the class of thing Phase A could not have found, and it is the reason the phase
split exists.

### 9.5 Two notes on the harness itself

- **Layout reflow silently swallows `adb input tap`.** Variable-length text above a button (the
  timer line gaining a `BOUNDARY` segment; the crash banner appearing) moved the targets and two
  taps landed on the wrong control — one of them parking an episode that was meant to be recovered,
  which cost a re-run. The screen is now **controls-first**, with every changing readout below the
  buttons, so coordinates are stable for a whole session. Worth copying for future device passes.
- **Test rows are left on the device** (`tasks` 13–18, session `t13-device-session`). The runtime
  tables were wiped clean afterwards — verified `0/0/0` — so no phantom crash signal survives, and
  `screen_off_timeout`, `stayon` and the battery/doze overrides were all restored.
