# Task 24 Findings — Product UI implementation

**Status: Phase A complete. Phase B is NOT run, and this task is not done without it.**
The product surface exists, is wired to the real services, and the whole tree is green — full
suite **636 → 706 tests**, `tsc --noEmit` clean, `eslint .` **0 errors** (56 warnings, all the
pre-existing `react-native/no-inline-styles` ones in `src/dev/`). What Phase A structurally
cannot establish is the one thing this task owed constraint #13: that a real `AlarmManager` alarm
fires from background and doze on the S23 FE. **§9 is the device checklist Jason runs.**

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

## 9. Phase B — the device session Jason runs (closes the `P`)

Run on the S23 FE against a debug build. **Batch with task 32's residue sweep — same setup cost.**
Build first: the TurboModule is new, so this needs a real `npx react-native run-android`, not a
Metro reload.

**A. The alarm — the thing Phase A cannot establish (constraint #13).**
1. Start a session, start a block with a short estimate (2–3 min), then press HOME.
2. Confirm the alarm fires **at the block end, not on return**. Watch the clock.
3. Repeat under forced deep idle: `adb shell dumpsys deviceidle force-idle`, confirm `mState=IDLE`,
   then wait out the block. This is the case a JS timer failed twice (38 s and 45 s late).
4. Repeat with the screen locked, to see the full-screen intent actually take focus rather than
   only posting a heads-up.
5. Check `adb shell dumpsys alarm | grep todoai` shows one alarm, not a stack, after pressing `+5`
   and `Keep going` a few times.
6. **If `USE_FULL_SCREEN_INTENT` is not granted**, expect a heads-up with alarm sound instead —
   record which behaviour you got, because that determines whether Settings needs a second grant
   affordance.

**B. `recoverOpenEpisode` after a real force-kill.**
7. Mid-block: `adb shell am force-stop com.todoai`, relaunch. Expect the app to open **straight into
   the same block** with the original end-time — not a fresh block, not the dashboard.
8. Kill mid-block and relaunch **after the block would have ended**. Expect the recovery screen
   ("keep working / it's done / leave it for later"), and confirm by DB query that
   `skip_count = 0` and no `coaching_queue` row was written.
9. Take "leave it for later" and confirm **nothing new** was written — the credit from recovery is
   the only record.

**C. Backgrounding is not a pause.**
10. Mid-block, HOME for 60–90 s, return. Same PID, no recovery banner, `paused_at_ms` still NULL,
    `pause_count` still 0, and the time away **counted as worked**.
11. Then press pause explicitly, wait, resume — and confirm the block end moved out by the pause.

**D. The full loop end to end.**
12. Add a task through the chat (real extraction, real save — watch that the prose turn asks or
    recaps before the constrained call runs).
13. Start a session: energy → duration → context → tools check → block → each of the five options
    at least once across a couple of sessions, including a `+5` chain and a `Keep going` chain long
    enough to see the self-care nudge (two consecutive quanta).
14. Skip three tasks in one session and confirm the **immediate** `session_recalibration`
    conversation appears.
15. Reach a session summary with a `repeated_extension` queued and confirm the estimate note
    appears and routes into the coach.
16. Open the six-kind recurrence editor on the device and form a judgement on it — task 23's review
    named this as the one thing a prototype could not settle. The day chips are now two letters.

**E. Pull the database and check the writes, not the screen.**
`adb` the DB off the device and query it directly, as task 13's Phase B did — the on-screen log only
proves what the app believed, not what it wrote. Specifically: `sessions.status` transitions
`abandoned → completed`, both energy columns populated and in the 1/3/5 band, `tasks_progressed` vs
`tasks_skipped` on the right rows, `skip_count` untouched by every park, and one
`actual_duration_history` entry per completion.
