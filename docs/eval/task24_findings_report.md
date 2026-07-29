# Task 24 Findings — Product UI implementation

**Status: Phase A complete. Phase B PARTIALLY run on the S23 FE — the `P` items that gate
constraint #13 are closed; the rest of the loop is not yet exercised on device.**
The product surface exists, is wired to the real services, and the whole tree is green — full
suite **636 → 706 tests**, `tsc --noEmit` clean, `eslint .` **0 errors** (56 warnings, all the
pre-existing `react-native/no-inline-styles` ones in `src/dev/`).

**The headline: the alarm fires.** On the S23 FE (Android 16), backgrounded, the block-end alarm
fired **11 milliseconds** after the stored block end — against the **38–45 seconds** task 13
measured for a JS `setTimeout` under the same conditions. Constraint #13 is discharged. §9 has the
evidence; §10 is what has *not* run yet.

**Phase B also found two real bugs and one build trap**, none of which an emulator pass would have
surfaced (§9.5, §9.6).

**The app is now the app.** `App.tsx` renders `src/app/`; the `src/dev/` harnesses still exist and
are still reachable, but behind a small debug-only affordance rather than being the product.

**Commits (ten, logically separate):**

| Commit | What |
|---|---|
| `a761589` | design tokens, shared components, the session controller |
| `fd441d0` | the expiry alarm — TurboModule + `AlarmManager` + manifest (constraint #13) |
| `064d11c` | chat controller, model host, launch sequence |
| `4a2652d` | the task draft model and the screen props contracts |
| `a76f792` | task library controller + service wiring |
| `149ccb6` | session controller suite against real SQLite (22 cases) |
| `2d48d9b` | screens — dashboard, task list, editor, recurrence editor, chat, metrics, settings |
| `3e69799` | draft / library / launch / chat suites (48 cases) |
| `1f5bd4e` | app root, router, dev-harness demotion, green suite |
| `9aebc74` | two corrections from reviewing the screens |

---

## 1. What shipped

**`src/app/`** — the product surface, 35 files including its tests, in four layers that do not leak
into each other:

- **Controllers** (`session/`, `chat/`, `tasks/`) — all the behaviour. Each is a plain factory over
  injected repositories with a `getState`/`subscribe` store, so every one is testable headless
  against `better-sqlite3` without rendering anything. 70 of the new tests are here.
- **Screens** (`screens/`) — 16 screens plus the recurrence editor, all purely presentational,
  against a fixed props contract
  (`screens/contracts.ts`). No screen imports a repository, a service, `src/execution`,
  `src/planning`, or a clock. This is what lets the beta-gate designed pass replace the visual
  layer without touching a line of behaviour.
- **The shell** (`App.tsx`, `appServices.ts`, `launch.ts`) — the launch sequence, the router, and
  the single place the native SQLite entry point is touched.
- **The alarm** (`alarm/`, `src/specs/`, three Kotlin files) — §3.

The screens cover spec §6.2's whole loop: dashboard → check-in (energy → duration → context) →
hidden plan → tools check → the timer-dominant execution screen → the five-option prompt → break →
summary, plus the task list, the six-kind recurrence editor, the chat surface for both task input
and coaching, and minimal metrics and settings.

**What is rendered is what the engine said.** The five options come from `endOfBlockPrompt` and the
screen renders exactly the array it is handed — it never substitutes `park` for `skip`, never adds
an option, never re-derives the 60-second gate. The timer face, the worked minutes, the self-care
nudge and the park gate are all read off `currentTimer`/`endOfBlockPrompt`.

## 2. The 13/24 boundary on the `sessions` row, as built

Task 13's report §4 drew the line; this is where it actually fell.

- **Task 24 creates the row, exactly once**, in `sessionController.startSession`, with
  `sessionType`, `plannedDuration`, `userEnergyStart` and **`status: 'abandoned'`** — constraint
  #14, so a crash leaves the truthful value and `closeSession` overwrites it on a clean end. Pinned
  by test (`the sessions row is BORN abandoned`).
- **Task 13 owns every other write**: the three counters, `extended`, `escape_valve_used`, and the
  terminal close. Nothing in `src/app/` touches any of them.

**One deliberate extension of that line, stated so it is a decision and not a drift.** Task 24 also
writes **`sessions.user_energy_end`**, from the summary screen's energy check (spec §6.2's "energy
check" between/after tasks). The principle in task 13's §4 is that the check-in data is task 24's
because *nothing in task 13 can supply it* — and that is exactly true of the closing energy too: it
is a user-supplied value with no runtime derivation. So the rule as built is: **task 24 owns the two
user-supplied energy fields; task 13 owns everything derived from runtime state.** Both go through
`scales.ts` (`'low' → 1`, `'med' → 3`, `'high' → 5`); a raw user-facing value never reaches the
column. Tested both ways.

**Still null, and left so on purpose:** `interactions.user_energy_level_start/end` on the per-episode
rows. Task 13 writes those rows and leaves the energy null; asking for an energy rating at every
episode boundary is a tax the functional pass should not levy, and the session-level pair already
gives the learning loop a per-session signal. Beta-pass work if it is wanted.

## 3. The alarm primitive: `AlarmManager.setAlarmClock`

**Chosen: a first-party TurboModule over `AlarmManager.setAlarmClock`, delivering a
full-screen-intent notification.** Not `setTimeout` (constraint #13), and not notifee.

- `src/specs/NativeEpisodeAlarm.ts` — the codegen spec (`schedule`, `cancel`,
  `canScheduleExactAlarms`, `openExactAlarmSettings`), plus `codegenConfig` in `package.json`.
- `EpisodeAlarmModule.kt` — schedules at `blockEndAtMs`. One alarm at a time: a fixed request code
  with `FLAG_UPDATE_CURRENT`, so every re-schedule (resume, `+5`, `Keep going`) replaces rather
  than stacks, mirroring the engine's one-open-episode invariant.
- `EpisodeAlarmReceiver.kt` — posts a high-importance, `CATEGORY_ALARM` notification with
  `setFullScreenIntent`. That is Android's mechanism for spec §6.2's "the app takes focus like an
  alarm": locked or elsewhere, the system launches the activity; already in use, it surfaces as a
  heads-up, which is the correct, less rude behaviour in that case.
- `EpisodeAlarmPackage.kt` + one line in `MainApplication.kt` — autolinking only walks
  `node_modules`, so an app-owned module has to be listed.
- Manifest: `USE_EXACT_ALARM`, `SCHEDULE_EXACT_ALARM` (`maxSdkVersion=32`), `POST_NOTIFICATIONS`,
  `USE_FULL_SCREEN_INTENT`, `VIBRATE`, and the not-exported receiver.

**Why `setAlarmClock` over the alternatives.** It is the strongest primitive Android offers: exempt
from Doze *and* App Standby, exact, and surfaced by the OS as a user-visible alarm. `setExact...`
is weaker for no gain; a foreground service would keep the app alive at a battery and complexity
cost the functional pass does not need. **Why not notifee:** it would be a new native dependency
whose New-Architecture behaviour on RN 0.86 is one more unknown on a build that currently has none,
to wrap the same two OS calls this module makes directly.

**It degrades, never drops.** If exact alarms are refused (API 31/32 without the grant), the module
falls back to `setAndAllowWhileIdle` — batched to roughly a nine-minute window but still piercing
Doze — and Settings offers `openExactAlarmSettings`. If `POST_NOTIFICATIONS` is refused, the alarm
still fires and the app is still *correct* on return, because the timer is arithmetic against a
stored end-time; only the interruption is lost. If the native module is absent entirely (a stale
APK, or Jest), the JS side is a no-op: **a stale build loses the alarm, not the app.**

**There is no `setTimeout` on this path and there must never be one.** Both the spec file and the JS
scheduler say so at the top, because "add a JS timer as a backup" looks like belt-and-braces and is
in fact a regression against a measured finding.

## 4. Decisions this task had to make

**1. Ending a block EARLY offers three options, not five.** At a real boundary the engine supplies
the prompt. When the user taps "End this block" with time still on the clock, `endOfBlockPrompt`
correctly returns null, and the controller assembles the same shape **minus `+5` and `Keep going`**:
those two answer "the block ran out and I need more", which is not the question a stopping point
with time remaining is asking. The three dispositions are still the engine's calls and the 60-second
park gate is still read from the engine's own snapshot. Tested both ways.

**2. Tools are optimistic at planning time, confirmed per task.** Spec §6.2's order is plan first,
tools checklist second — but `checkIn.tools` feeds a *hard* pre-filter, so planning with an empty
tool set would drop every task that needs anything at all. The plan is therefore built against the
union of tools any active task requires, and the per-task check narrows it. "Not with me" runs
`replanRemaining` with the corrected set, falling back to §6.2's own `firstWorkableWithTools`.
**Missing tools is not a skip**: no episode has opened, so there is nothing to decline — the app
misjudged what the user has to hand, and says so.

**3. A recovered session re-asks context before replanning.** The plan is derived state and does not
survive the process. Energy comes back off the `sessions` row; contexts and tools are stored
nowhere, and guessing them would silently mis-filter the pool. So after the recovered task is dealt
with, the app asks one question — "you're back, where are you now?" — and replans the remainder.
After an unknown gap that is also just the better product behaviour.

**4. `block_expired` gets its own screen, not the engine prompt.** `recoverOpenEpisode` has already
closed the episode, so there is no episode for the five outcome calls to act on, and
`parkAvailable` would be false — meaning the engine prompt would offer **skip** for work the user
actually did. The recovery screen instead offers three honest choices: keep working (a fresh block),
it's done (a zero-length episode so the completion goes through the normal fold — the crash credit
is already in `accumulated_minutes`), or leave it for later (**write nothing at all**, because
recovery already parked it; a second disposition would double-record it). None of the three writes
a skip. Tested.

**5. The dashboard's "Add task" opens the chat; the task list's opens the editor.** Spec §6.3's path
is the conversation, and that is the dashboard's affordance. The manual editor stays reachable from
the list because it is the only way to add a task when the model has not loaded, and because
sometimes you know exactly what you want and should not wait three seconds to say it.

**6. The startup guard runs on first model use, not at process launch.** Constraint #3 says "at
startup, before any user session". Loading a 4B costs ~3 s and real heat, and a timer-only session
never needs the model at all. What the constraint protects — that no grammar is ever first-parsed
in front of a user, mid-flow — is preserved exactly: the guard runs inside an explicit "getting
ready" state, before the first token is ever generated, and a failure disables the grammar path
app-wide in favour of prompt-JSON + validation (tested).

**7. The one interval in the app is a display refresh.** `useTimerSnapshot` re-*reads* the engine's
stored end-time once a second so the digits change. It accumulates nothing; a tick that never fires
costs a stale digit that corrects itself on the next render. It is not, and must not become, the
alarm.

**8. The `+5` and `Keep going` paths are two controller methods, never one.** Constraint #12. `+5`
has no cap, no confirmation and no nag anywhere in the UI, and leaves a countdown a countdown; the
self-care nudge is rendered only from `prompt.selfCareNudge`, which reads `hyperfocusQuanta` and so
structurally cannot be reached by a chain of `+5` presses.

## 5. Three things this closed for free

Task 23's review §4 left three residual follow-ups. All three land in the real product, because in
each case the *engine* already had the behaviour and only the surface was missing:

1. **The guardrail-B self-care nudge** is `endOfBlockPrompt.selfCareNudge`, rendered as one calm
   line above the options, never blocking, hyperfocus-only.
2. **The repeated-`+5` conversation** is surfaced at the **session summary** — the controller
   collects the `repeated_extension` coaching the engine queues at task close and offers
   "'<task>' ran long a few times — want to revisit its estimate?", routing into the coach. The
   in-the-moment button stays untouched.
3. **The skip threshold is 3**, because it was always the engine's `skipsThisSession === 3`; the
   prototype's `2` was a prop default that no longer exists.

## 6. Deferred to the beta (designed) pass — deliberately, not forgotten

- **The designed visual pass.** `theme.ts` carries the prototype's tokens and the components use
  them, so the functional pass already speaks the right visual language — but motion, elevation,
  dark mode, the full type scale and per-screen polish are beta-gate work.
- **Metrics depth.** Two counts and the `recent_session_performance` view. No trends, no charts.
- **Settings breadth.** Alarm status + the exact-alarm grant, notification permission, model phase,
  schema version. No preferences, no export, no data controls.
- **The progress ring is a bar.** React Native has no conic-gradient without a new dependency; a
  horizontal bar under the timer is honest and robust where a hand-rolled arc would be fragile.
- **The break screen is minimal** — a countdown and "start the next task". Break overrun *does*
  replan (spec §8.2), but there is no break content.
- **Onboarding (spec §6.1's first-run branch)** does not exist. The app opens to a dashboard whose
  empty state is "Add task", which is a usable first run for one user who wrote it.

## 7. Consciously left open

- **Spec §6.1's 5-day re-orientation is not wired.** The `app_reorientation` trigger exists, its
  prompt exists, and `runLaunchSequence` already drains anything that enqueues it — the conversation
  is one writer away. What is missing is the writer's input: a durable **"last opened" watermark**.
  There is nowhere truthful to keep one today (`sessions.started_at` answers "when did you last
  *work*", which is a different question — someone can open the app daily and start no sessions for
  a week). Its natural home is **task 26's `learning_state (key, value)` table**, which does not
  exist yet. Pinned there rather than guessed at.
- **The prototype's "every N weeks" schedule interval is dropped.** The `scheduled` union member
  carries weekdays and nothing else, so the control would have discarded its own value. Adding a
  real interval is a schema change and belongs with **task 36**, which owns period semantics.
- **`sessions.model_tier` is never written.** A session that makes no model call has no tier to
  record, and writing `'4B'` unconditionally would be a fiction. Wants a decision about what the
  column means before something writes it.
- **`session_ended_early` is never enqueued.** Backing out of a session with time remaining is a
  first-class trigger type in the CHECK, but it is not one of spec §7.2's five rows, so this pass
  does not invent a sixth conversation. Flagged rather than silently added.
- **Ending a session mid-episode routes to the prompt rather than choosing for the user.** Backing
  out of the work screen with a block open raises the five-option prompt; the user must pick a
  disposition. The app never picks one by inference (constraint #11's spirit).
- **The task list's recurrence read is an N+1** — one `getByTaskId` per row. A personal list is tens
  of rows; the alternative is a bespoke join only this screen would use.
- **Coaching queued at session start does not chain into the session.** It opens the conversation
  and returns to the dashboard; the user taps "Start work" again. Chaining is a nicety, not a gate.
- **The `no-grammar` fallback duplicates the D10 ladder minus the grammar.** `runConstrained`
  requires grammar text and passing an empty string would hand llama.cpp an unparseable grammar
  rather than none at all. ~25 lines, labelled as the ladder's twin. If the fallback ever becomes
  load-bearing, the right fix is to make `ConstrainedCall.grammar` optional in task 6's own file.
- **`docs/` is now excluded from `eslint .`** — the task 23 prototype ships a DOM runtime
  (`docs/design/support.js`) that reported 17 errors about `document` and `customElements` under
  the RN config. Excluding it is what makes `eslint .` say something true about shipped code.

## 8. Handoffs

- **Task 26** — the `learning_state` table it adds is what unblocks §6.1's 5-day re-orientation
  (§7). One writer at app open and one read in `runLaunchSequence`.
- **Task 36** — if a real schedule interval is wanted in the recurrence editor, it is a schema
  change on the `scheduled` union member and belongs with the period engine.
- **Task 32** — this pass **wires** D1's recap→constrain flow in the real product (the prose turn
  runs the recap-or-clarify instruction, and the constrained extraction runs over the whole
  conversation including that turn). **Measuring** it is still task 32's residue item (c), and the
  product surface is now the natural place to measure it.
- **Task 21** — the crisis gate is active, app-side and gate-first on every chat turn, with zero
  model calls on a distress transcript (tested). Its coverage and `CRISIS_REFERRAL_TEXT` remain the
  hard beta gate; nothing here changes that.


## 9. Phase B — what ran on the S23 FE (2026-07-28/29)

Run against a debug build on the real device (`SM-S711U`, Android 16, `adb` over USB). Every claim
below was **re-checked by pulling `databases/todoai.db` off the device and querying it directly** —
the on-screen state only proves what the app believed, not what it wrote. Same discipline as task
13's Phase B, and it earned its keep again.

### 9.1 ⭐ The alarm fires — constraint #13 discharged

The thing Phase A structurally could not establish.

**Scheduled correctly.** With a 2-minute block open, `dumpsys alarm` showed exactly one entry:

```
RTC_WAKEUP #4: Alarm{... com.todoai}
  tag=*walarm*:com.todoai.BLOCK_ENDED
  type=RTC_WAKEUP  origWhen=2026-07-28 23:30:32.373  window=0
  exactAllowReason=policy_permission
  policyWhenElapsed: device_idle=--  battery_saver=--
  Alarm clock:
    triggerTime=2026-07-28 23:30:32.373
    showIntent=PendingIntent{... com.todoai startActivity}
Next wake from idle: Alarm{... com.todoai}
```

`window=0` is the whole point: **exact, not batched.** `exactAllowReason=policy_permission` is the
`USE_EXACT_ALARM` grant. And **`Next wake from idle: com.todoai`** is the OS stating it will bring
the device out of Doze for this alarm.

**Fired on time, from the background.** HOME pressed at 23:29:00, block end 23:30:32.373:

```
23:30:32.384  ActivityManager: Received BROADCAST intent ... act=com.todoai.BLOCK_ENDED
              cmp=com.todoai/.EpisodeAlarmReceiver
```

**11 milliseconds late.** Task 13 measured the same moment at **38 s and 45 s late** with a JS
`setTimeout`. That is the entire justification for constraint #13, now confirmed from both sides.

**The notification is the right shape.** `dumpsys notification`: `importance=4`, `category=alarm`,
`channel=todoai.block_end` with `mSound=content://settings/system/alarm_alert` and
`usage=USAGE_ALARM`, and **`fullscreenIntent=PendingIntent{... com.todoai startActivity}`** —
allowlisted by NotificationManagerService. The OS also showed the alarm-clock icon in the status bar
for the duration, which is `setAlarmClock` doing exactly what it says on the tin.

**All three permissions auto-granted on Android 16**, with no prompt to design around:
`USE_EXACT_ALARM: granted=true`, `USE_FULL_SCREEN_INTENT: granted=true`,
`POST_NOTIFICATIONS: granted=true`.

### 9.2 Backgrounding is not a pause

Mid-block, HOME for ~70 seconds, then read the row directly:

| Checked | Result |
|---|---|
| `paused_at_ms` | **NULL** |
| `paused_ms` / `pause_count` | **0 / 0** |
| `block_end_at_ms` | **unchanged** — the block was never extended by the time away |

The time away counted as worked, because backgrounding is normal, not abandonment.

### 9.3 `recoverOpenEpisode` after a real force-kill

`adb shell am force-stop com.todoai` mid-episode, then relaunch. The app opened **straight into the
recovery screen** — "You're back. 2 minutes on 'Alarm' are already saved — nothing was lost while
you were away." Confirmed by query, not by screen:

| Checked | Result |
|---|---|
| Crash signal cleared | `active_episode` = 0 rows |
| Episode closed as abandoned | `task_progress` / `completion_status='abandoned'` + the recovery note |
| **Credit bounded by the block end** | **2 minutes**, though the process was dead ~90 s *past* the block end |
| **No skip written** | **`skip_count = 0`, `skip_reasons = NULL`** |
| **No coaching queued** | **0 pending `coaching_queue` rows** |
| Task not abandoned by inference | `status='active'`, `work_state='in_progress'` |
| Nothing folded | `actual_duration_history = NULL` |

**"Leave it for later" wrote nothing at all** — interactions stayed at 4, credit stayed at 2,
`skip_count` stayed 0 — then routed to the "You're back, where are you now?" re-check-in, exactly
as §4.4 designed. Recovery had already parked it; a second disposition would have double-recorded.

### 9.4 The rest of what ran

- **Launch routing (spec §6.1).** With coaching queued, the app opened **into the coach chat, not
  the dashboard** — twice, on real leftover rows. `pendingAtAppOpen` picked the `immediate` row.
- **Session-start routing.** "Start work" with an `immediate` row queued opened the coach instead of
  the check-in — `pendingAtSessionStart`, the other urgency seam, also correct.
- **The `sessions` row is born `'abandoned'` on hardware**, with `user_energy_start = 3` for
  "Medium" (constraint #6 through `scales.ts`), `session_type='quick'`, `planned_duration=10`.
  `session_runtime` created; `active_episode` **absent until START is pressed** — so backing out of
  a task you never started still costs nothing.
- **The real planner ran**: for a 10-minute quick session it served the only task that fits and
  nothing else. The block opened with `block_end_at_ms − started_at_ms = 120000` exactly.
- **The timer face**: countdown, progress bar, `FOCUSING`, updating once a second off the stored
  end-time.
- **The editor round-tripped through SQLite**: create and update, `duration_source='user'`, energy
  via `scales.ts`, **no `task_recurrence` row for a one-off**, delete correctly disabled for a
  dependency-blocked task and enabled otherwise. Task-list summaries built from real rows.
- **Settings reported the alarm honestly in both states** — "isn't available in this build" while
  the module was unresolved, "set to fire exactly on time" after. That screen is what turned a
  silent failure into a five-second diagnosis.

### 9.5 ⚠ Two real bugs the device found (both fixed, commit `e6657a4`)

1. **Android's back gesture was unhandled, so it quit the app from every screen.** React Native
   wires nothing by default, and no emulator or unit pass would surface it because back is a
   *platform* gesture. Now mapped to each screen's own back action: the dashboard lets Android leave
   (it is the root), the prompt **consumes** the press because a disposition is required, and
   everything else navigates. Found the hard way — a `KEYCODE_BACK` meant to dismiss a keyboard
   exited the app instead.
2. **Backing out of an open block abandoned the session instead of asking.** The work screen's back
   was wired to `leaveSession`. It now raises the five-option prompt: the app never picks a
   disposition by inference (constraint #11's spirit). This also made the code match what §7 of this
   report already claimed, which is the more embarrassing half of the finding.

### 9.6 ⚠ The build trap: app-level codegen and a cached CMake configure

**Worth recording because it will bite anyone adding a second app-owned TurboModule.**

The first build compiled everything — the codegen'd `NativeEpisodeAlarmSpec.java`, the JNI
`TodoAiAppSpecs-generated.cpp`, the Kotlin module and package — and the Java side resolved fine
(`getModule("EpisodeAlarm") match=true` in logcat). But `TurboModuleRegistry.get()` returned
**null**, so every alarm call silently no-oped.

The cause: `DefaultTurboModuleManagerDelegate::javaModuleProvider` is a static function pointer that
**defaults to `nullptr`**, and RN's `OnLoad.cpp` only assigns the app's own provider when the compile
flag `-DREACT_NATIVE_APP_MODULE_PROVIDER` is set. `ReactNative-application.cmake` sets it
automatically — but only `if(EXISTS <build>/generated/source/codegen/jni/CMakeLists.txt)`, and on the
**first** build CMake configured *before* codegen had produced that file. The configure is then
cached in `android/app/.cxx/`, so every later build reused the flag-less configuration.

**Fix — no code change:** delete `android/app/.cxx` and rebuild. The flag then appears in
`build.ninja` (`-DREACT_NATIVE_APP_MODULE_PROVIDER=TodoAiAppSpecs_ModuleProvider`) and the module
resolves. **Recorded in `README_build.md` as a gotcha.**

The silver lining is that the failure mode was exactly the designed one: a build without the native
module lost the alarm and **not the app**, and Settings said so in plain words.

### 9.7 Housekeeping

The six stale `coaching_queue` rows left by task 12's and task 13's device sessions were marked
`resolved` (they intercepted every app open and every session start). The runtime tables were left
**0/0/0** afterwards, so no phantom crash signal survives, and no `com.todoai` alarm is pending.
Test rows on the device now include tasks 19 ("Alarm") and 20 ("Ping").


### 9.8 The five outcomes, on hardware

Fixture tasks were seeded straight into the database for these. Task *creation* through the editor
is already verified above (§9.4); what is under test here is the execution paths, and tapping six
tasks out through the soft keyboard would only re-prove something already proven.

| Outcome | What the database says |
|---|---|
| **Done** | `status='completed'`, **`actual_duration_history=[1]`** — one entry equal to the total minutes worked — `average_actual_duration=1`, `accumulated_minutes` reset to 0, `tasks_completed=1`, and a `task_completion` interaction. The fold, on device. The agenda then served the next task. |
| **Pause for later** (park) | `accumulated_minutes` kept, `work_state='in_progress'`, `status='active'`, `last_worked_at` stamped, **`tasks_progressed=1` with `tasks_skipped=0`**, and **zero coaching rows queued** — constraint #11 holding on device, in separate columns reached by separate code |
| **Not this one** (skip) | `skip_count` incremented on each declined task, `tasks_skipped=3`, one `task_skipped` row per skip at `next_start` |
| **+5 minutes** | block end moved **exactly +300 000 ms**, `hyperfocus_quanta` still **0**, face still `countdown`, ledger `presses=1 minutes=5 coaching_enqueued=0` — nothing queued at press time (constraint #12) |
| **Keep going** | see §9.10 |

**The three-option early prompt is real.** Ending a block before its boundary showed exactly
Done / Pause for later / Something easier — no `+5`, no `Keep going` — with "2 minutes worked this
block" above it. At a real boundary the same screen showed all five.

**Choosing an outcome cancels the alarm.** After the park, `dumpsys` showed **0 pending
`com.todoai` alarms**: `detachEpisode` → `scheduler.cancel()` reaching the platform.

### 9.9 The third skip stops the session (spec §7.2)

Three tasks declined in one session, and the app **stopped serving tasks and opened the coach** with
the recalibration opener. The database agrees: three `task_skipped` rows at `next_start`, one
**`session_recalibration` at `immediate`**, `tasks_skipped=3`, and the session closed.

This did not work before Phase B — see §9.11.

### 9.10 The session lapse and the chat, against the real 4B

**The lapse loop, end to end.** A session left open past its planned end produced
`pattern_detected` / `{"kind":"session_lapsed"}` at `next_start`, written at exactly the minute the
session's clock ran out — and the next "Start work" surfaced it as a coaching conversation instead
of a check-in. That is `checkSessionLapse` → `enqueueCoachingTrigger` → `pendingAtSessionStart`,
three separate pieces meeting correctly on hardware.

**The 4B answered through the product UI.** One user turn in that conversation took ~70 seconds
end to end — the model loading, the constraint-#3 startup guard compiling all four registered
grammars, and then ~60 tokens of prose — and came back supportive, on-scope, and ending in one
concrete next step, which is what the task-7 coaching prompt asks for. The chat surface, the model
host, the startup guard and the prompt layer are confirmed together.

**"Wrap this up" resolved the queue row with no model call**, because a `session_lapsed`
conversation has no candidate task to dispose of — the deliberate skip in §4's disposition path.

### 9.11 ⚠ Three more bugs the device found (all fixed)

On top of §9.5's two:

3. **Declining a task you never STARTED did nothing.** The work screen offers "Not this one" and
   the escape valve before the block begins, but every disposition call in the engine requires an
   open episode and throws without one. The error went into controller state that no session screen
   renders, so on a phone it was simply a button that did nothing. Fixed by opening a zero-length
   episode first, which keeps every semantic in task 13 rather than reimplementing the outcome in
   the UI — and lands on the right side of the 60-second gate for free, since a task never started
   has worked 0 ms and the engine correctly reads an escape from it as a skip.
4. **A coaching chat offered "Save this task".** `canSave` was set on any first user turn regardless
   of purpose. Tapping it would have run grammar-constrained task extraction over a transcript about
   why something was skipped — capturing a task nobody asked for out of the user's explanation of
   their own difficulty.
5. **`immediate` coaching did not interrupt.** The third skip queued `session_recalibration` and the
   controller walked on to the next agenda item — precisely the thing the trigger fires to prevent
   (§7.2: "stop serving tasks and talk about what they can take on RIGHT NOW"), and it would not
   have surfaced until the next session start. Now any `immediate` coaching closes the session and
   routes straight into the coach, keyed off `urgencyForTrigger` rather than the trigger's name so a
   future immediate trigger needs no second edit.

`guard()` also logs now. A disposition failing silently is indistinguishable on a device from a
button that does nothing; rendering controller errors on the session screens is beta work, but
getting them into `logcat` is not optional.
