# Device session — findings report (2026-08-19, S23 FE)

**What this is.** The authoritative evidence record for the first on-device run of merged `main`
(`c1c02d4` → tested through the session). Until today, the merged tree had **never** been built or
run on the S23 FE — tasks 41, 44, 14, 48 and the migration/recurrence chain were all *believed, not
confirmed*. This report consolidates what was confirmed, what remains believed, and the defects
found, so the evidence lives in one place rather than scattered across board rows and commits.

**Device:** Samsung SM-S711U (S23 FE), Android 16, debug build via Metro. **Raw artifacts** (three
DB snapshots, the capture corpus, screenshots) are in the private archive **outside the repo**:
`todoAI_private_archive/device_session_2026-08-19/` — see its `README.md`.

⚠ **Process note (see §Deviations).** This session was driven partly by the coordinator directly
(build, `adb`, DB pulls) and partly by device subagents. Going forward that is not the model — the
coordinator delegates execution to subagents and verifies their reports. This report is a
coordination record of what was observed, written by the coordinator.

---

## 1. Pre-flight

- **Pre-migration DB preserved.** Pulled the installed build's DB (schema **2.6.0**, 13 sessions, 30
  tasks) via `run-as` before first launch of the merged build migrated it. This is the irreplaceable
  fallback and is archived.
- **Build + the `.cxx` codegen trap.** `rm -rf android/app/.cxx` then `./gradlew installDebug` →
  **BUILD SUCCESSFUL**, installed. The trap (task 24 §9.6) is **avoided**:
  `-DREACT_NATIVE_APP_MODULE_PROVIDER=TodoAiAppSpecs_ModuleProvider` is present in the generated
  `build.ninja`, and — confirmed at runtime, not just in the build file — the second TurboModule
  `NativeCaptureLog` **resolves** (capture wrote; a null module would have degraded to a no-op).

## 2. Migrations 006 + 007, and the recurrence engine — CONFIRMED

The device was at **2.6.0**, so first launch applied **both 006 (recurrence) and 007
(session_origin)** — *both* first-ever on device — against real data (7 active tasks, 3 recurring).

- **Both migrations applied**, DB reached **2.8.0**, no error. This exercises the task-26 fix (apply
  >1 migration in one launch) on hardware for the first time.
- 🔴 **Task 36's recurrence engine ran on device for the first time.** The `advanceRecurrence` sweep
  at app-open, against the 3 real recurring tasks: **`unscheduled` skipped** (task 12, correct),
  both `scheduled` advanced to the current period, **`last_period_shortfall` = 0**, and the **neglect
  anchors (`last_completed_at`/`created_at`) provably untouched** (constraint #5). This is the engine
  that carried the live urgency-scoring fix, working on real data.
- **007:** `sessions.origin` present; all 13 pre-existing rows **NULL** (not backfilled), exactly as
  ruled. The `ADD COLUMN … CHECK` path (task 44 deviation 2) works on real op-sqlite.

## 3. Capture (task 41) — CONFIRMED writing losslessly

A real chat extraction produced the full **twelve-stream** tree in **external** app-private storage
(deviation 2.2's root confirmed):

- **Envelope contract intact:** `{"v":1,"seq":43,"run":"…","stream":"conversation","type":"turn",
  "sessionId":null,…}` — the ratified global `v`, process-global `seq`, per-process `run`, correct
  null `sessionId` for dashboard input.
- 🔴 **The raw model completion is preserved.** `modeltext` holds the verbatim pre-parse output
  (`{"title":"path to IRS appointment","description":null,"estimated_duration_minutes":15,…`) — the
  exact data migration 001 used to discard ("raw transcript never stored"). This is the entire reason
  task 41 exists, now corpus gold on device.
- `modelio` carries metadata (`grammarId`, `grammarSha8`, `todayISO`, D10 `rung`, timings) and points
  to the raw text by `textRef` — the egress-class split intact.
- **`mutation` emitted 24 records for one chat-created task**, reproducing the design's ~20-per-task
  prediction on real hardware (a size fact task 31's loader must expect).

## 4. Force-kill acceptance test (task 41 §14.2) — PASS

The test the whole capture design was built around. Drove a quick-start session to a live episode
(Charlie, taskId 23), `adb shell am force-stop com.todoai` mid-episode, relaunched.

| Assertion | Result |
|---|---|
| Pre-kill run seq contiguous | ✅ seq 15..59, **zero gaps** |
| Post-kill run has its own boot | ✅ fresh `boot` at seq=1 |
| Post-kill run seq contiguous | ✅ seq 1..10, **zero gaps, zero dups** |
| No events lost around the crash | ✅ **zero `dropped` markers** |
| Recovery derives the SAME episodeId | ✅ `s-1787124234092-3067#23@1787124256922` **identical** across the kill |
| Every line parses | ✅ (one "bad line" the analysis flagged was the pull tool's own stderr for a non-existent `crisis` file — no crisis gate ran — not a torn record) |

This simultaneously **re-confirms task 13's `recoverOpenEpisode`** on the merged build.

## 5. Thermal sampling (task 41's seam, moved from task 19) — CONFIRMED

The `runtime` stream carries `{"type":"sample","thermalStatus":0,"batteryLevel":0.79,
"charging":false}`. `PowerManager.getCurrentThermalStatus()` returns cleanly (0 = NONE, cool) and the
battery read matches the on-screen 79% — despite an unrelated `ThermalManagerService` HAL warning in
the system log (different API path). Fills `TernaryBonsaiProvider`'s sampler, empty since task 6.

## 6. The flows (task 44 + others)

- **Grammar-compile gate (37/48) — CONFIRMED.** A chat extraction returned a real title through the
  tightened grammars; the startup guard compiled all grammars (including 48's novel `min:0`
  alternation) without falling back to prompt-JSON.
- **Quick-start runs the full check-in — CONFIRMED** (ruling 0.3). Energy → duration → context, then
  serves the one task.
- **Resume slot (task 33) — CONFIRMED.** In-progress tasks show "Picking this back up".
- **Self-complete (item 4) — CONFIRMED correct.** Task 27 → `completed`; `interactions` row
  `{type:task_completion, session_id:null, energy:null, duration:null, notes:'self_completed'}` — the
  exact ruled convention; and 🔴 **`completion_count`/`success_rate` stayed 0** — the deliberate
  no-writer convention that **task 17 inherits**, holding on device.
- **Coaching-queue drain at session start — CONFIRMED.** A `session_lapsed` coaching (urgency
  `next_start`) queued by the force-killed session correctly intercepted the next quick-start.
- 🔴 **Coaching-resolution dispatch (task 12) — CONFIRMED, closes a residue item.** Engaging the Coach
  screen, the model replied coherently in **~15 s (warm)** and `coaching_queue` id 16 went to
  `resolved`. This flow was unexercised on the merged build.
- 🔴 **Mismatch-warning screen (item d) — CONFIRMED.** Quick-started task 31 (`path to IRS
  appointment`, needs IRS/appointment/government) with a `home` context. The **"Before you start"**
  screen named **both** conditions: *"wrong context — this session doesn't have IRS, appointment,
  government"* and *"doesn't fit in the time planned (10 min)"* (15-min task in a 10-min block), with
  **Start anyway / Back out** and informed-consent copy. Reuses the real `src/planning` predicates
  (named the exact missing contexts).

## 7. Junk-purge dry run (task 44 item 5) — done, surfaced a scope gap

`scripts/purge-junk-tags.js --db <pulled DB>` (dry-run default): **0 leading-separator junk found.**
The target class (`:mixing`/`:episode`) has **zero instances** in the real data. The one junk tag
present is **`use_breath_pause`** — the snake_case/phrasing class deliberately scoped **out** (the
tracked signal pinned to 20/40). **So the purge cleans a class that isn't there, and the visible
clutter is the class it won't touch.** Removing `use_breath_pause` needs a manual, human-judgment
step, not the automated purge. **`--apply` was NOT run.** (Owed to Jason.)

## 8. Still believed / blocked — NOT confirmed this session

- 🔴 **Task 14 Phase B is blocked on WIRING, not on a device go-ahead.** Verified: the backup ladder
  (`createBackup`/`VACUUM INTO`/`salvage`/no-space) is invoked by **nothing** in `src/app/` or
  `src/execution/` (only a comment in `capture/nativeWriter.ts` references the module). So VACUUM-INTO
  on device, the no-space error identity, corruption/restore and salvage **have no code path to
  reach them** until task 14's §13 session-gate wiring is built. `src/app` is now settled, so that
  wiring is unblocked.
- **StatFs two-volume has no UI/consumer** — same wiring gap. `availableBytesFor` is exposed but
  invoked by nothing, so the two-volume comparison (`ANDROID_EXTERNAL_FILES_PATH` vs
  `ANDROID_DATABASE_PATH`) can't run on device yet.
- **`fsync` app-open-time on/off** — needs a rebuild toggling the `record.ts` constant; not done.
- **Blocked-button disabling (item a)** — no dependency-blocked task exists in the data, so it is
  unverified for lack of a subject, not for failure.

## 9. Defect leads found (verify before acting)

- 🔴 **"Wrap this up" button on the Coach screen appears non-functional.** A device subagent tapped
  it 3× (verified via `uiautomator` that taps landed in the clickable bounds) with no visible change.
  The coaching still resolved (via the model's resolution dispatch), so the button may be a dead/
  unimplemented affordance or a silent no-op. **Needs a focused check.** Screenshots
  `devsweep2/13_wrapup.png`..`17_wrapup5.png` in the archive.
- **StatFs / backup unwired** — see §8; strictly a gap, but it means two shipped-looking capabilities
  are unreachable.

## 10. Numbers

- 🔴 **First cold extraction: `latencyMs: 83334` (~83 s)** — includes the 1 GiB model load. A real UX
  fact for the designed pass; warm coaching replies were ~15 s. The app-open `fsync` on/off number is
  still owed (needs a rebuild).

## Deviations from human decisions

**One, and it is a process deviation by the coordinator, not a task-decision deviation.**

The coordinator executed hands-on work this session — ran `gradlew`, drove the device via `adb
input`, ran `jest`/`tsc`/`eslint` directly, pulled and analysed DBs, edited `scripts/gen-task-table.js`.
Some was explicitly requested at the time ("can you drive the gradle build?"; "you can make screen
touches"). **Jason ruled 2026-08-19 that going forward this is not the model:** the coordinator never
changes code and never runs tests/builds/device directly — those are subagent tasks — and the
coordinator's job is to review reports and code and to interface between Jason and the subagents. That
rule is now recorded in the coordinator handoff §1 and in coordinator memory. This report is itself a
coordination record (maintaining the canonical evidence base), which remains in-role.

**No task-decision deviation was found in the code tested.** Every confirmed behaviour matched a ruled
decision (self-complete conventions, the warning screen, the no-writer convention, the recurrence
skip rules). The device subagent's one flagged "anomaly" (quick-start showing "Echo") was a **mis-tap**
— Echo has empty context, so no warning is correct for it; the coordinator re-ran on the right task and
the warning fired correctly.

## Where the evidence lives

Repo: this report. Archive (outside repo): `todoAI_private_archive/device_session_2026-08-19/` — the
2.6.0 pre-migration DB, the 2.8.0 post-migration DB, the after-flows DB, the full capture corpus (incl.
`modeltext` raw completions), and all screenshots. The board rows for 36, 41, 44, 14, 13 point here.

---

## Appendix — the coordinator's device-subagent spawn prompts (added for completeness)

*Added by the coordinator 2026-08-19. The two device-verification subagents this session ran on inline prompts with no brief file — this appendix records them verbatim so the audit trail is complete, per the rule ruled that day. Their findings are already folded into the body of this report.*

### D1 — device UI verification sweep (self-complete, quick-start warning, blocked buttons)

> You are a device-verification agent for the todoAI project. You drive the app on a physically-connected Samsung S23 FE via `adb` and report what you observe. You do NOT edit code or the canonical docs — you drive, pull, and report. The coordinator verifies your pulled artifacts. The device is a SINGLE SERIAL RESOURCE — you are the only agent touching it; screenshot before each tap, act, screenshot after; never run destructive commands.
>
> **Current state (do not re-derive):** device authorized; debug build of merged `main` installed and running; Metro running on the host with `adb reverse tcp:8081 tcp:8081` set — do NOT stop Metro or the app breaks. The app is at some screen post-crash-recovery (a force-kill test just ran) — relaunch clean first (`adb shell monkey -p com.todoai -c android.intent.category.LAUNCHER 1`), confirm the "Focus" dashboard. Schema 2.8.0. The task list has Charlie/Delta/Echo (each "One-time · 2 min · In progress") and "Call the dentist for 10 minutes tomorrow" (1 min), plus others below the fold.
>
> **Coordinates:** screenshots come back 1080×2340, displayed scaled to 923-wide (multiply by ~1.17). `adb shell input tap X Y` takes ORIGINAL 1080-wide coordinates. Verify every tap with a follow-up screenshot. `adb exec-out screencap -p > path.png` then Read it.
>
> **TEST A — Self-complete:** Review task list → pick a task NOT one of Charlie/Delta/Echo (use "Call the dentist…") → tap "Mark done" → screenshot the result → report what you observe (the coordinator pulls the DB to verify the interactions row).
>
> **TEST B — The quick-start warning screen:** tap "Quick start" on a task → go through the check-in (energy Medium, duration "About 10 minutes", context) → on the context screen deliberately pick a context that does NOT match the task, then Start → watch for a warning screen naming a filter condition with "Start anyway"/"Back out"; screenshot if it appears; if it doesn't, report that too. If you reach a warning, tap "Back out".
>
> **TEST C — Blocked-button states:** scroll the full task list (swipe up), look for any task whose "Quick start"/"Mark done" appear disabled/greyed with a visible reason; screenshot any you find; if none, say so plainly (a finding, not a failure).
>
> **After:** return to the dashboard, leave the app there. Do NOT pull or analyse capture logs or the DB — that's the coordinator's step. Report per test: what you tapped, what you saw (with screenshot paths under `…/scratchpad/devsweep/`), any anomaly. Separate confident from uncertain. End with any task names + states you touched so the coordinator can pull the exact rows.
>
> **Hard limits:** never run `am force-stop`, disk-filling, DB writes/`PRAGMA`, `pm uninstall`/`clear`, file deletion, or `adb reverse --remove`; never stop Metro or kill the app; do not navigate into Jason's other apps/settings/data — if you land on the Android home screen, relaunch todoai and touch nothing else; if anything is destructive-looking or ambiguous, stop and report.

### D2 — coaching drain + mismatch-warning test

> You are a device-verification agent for the todoAI project. You drive the installed app on a physically-connected Samsung S23 FE via `adb` and report what you observe. You do NOT edit code or docs. The coordinator verifies against a DB pull afterward. The device is a SINGLE SERIAL RESOURCE — you are the only agent touching it.
>
> **Setup (do not re-derive):** `adb devices` shows `device`; debug build of merged `main` installed; Metro running with `adb reverse tcp:8081 tcp:8081` set — do NOT stop Metro. Screenshot via `adb exec-out screencap -p`; taps use ORIGINAL 1080-wide coordinates (displayed ×1.17); verify every tap. Save screenshots under `…/scratchpad/devsweep2/`. The dashboard is "Focus" (Start work / Review task list / Add task / Metrics / Settings).
>
> **Context:** there is a pending `session_lapsed` coaching in the queue, so tapping "Quick start" currently routes to a Coach screen instead of the check-in — correct behavior (the app drains coaching at session start). Your first job is to drain it; then the warning-screen test becomes reachable.
>
> **TEST D — Drain the pending coaching (confirms coaching-resolution on device):** relaunch clean, confirm dashboard. Review task list → Quick start on any task → land on the Coach screen. Tap the chat input, type a short reply (`adb shell input text "I%sgot%sdistracted%sbut%sready%snow"` — `%s` = space), screenshot to confirm, tap send. The on-device model runs — wait up to ~90 seconds (cold load); poll by screenshotting every ~15s until the coach responds or the screen changes. Read and quote the coach's response; report where the flow lands.
>
> **TEST E — The mismatch warning screen (only after D drains the queue):** back to dashboard → Review task list → find "path to IRS appointment" (tags IRS/appointment/government; scroll if needed) → tap its Quick start. If you land on Coach again, the queue wasn't fully drained — note it and STOP. Otherwise the check-in: energy Medium, duration "About 10 minutes", context tap only "home" (a context this task does NOT have), then Start. Watch for a warning screen naming the mismatch, with "Start anyway"/"Back out"; screenshot it. If the warning appears → tap "Back out" (do not start a session). If it goes straight to an episode with no warning → screenshot and tap the top-left back arrow to exit. Report which happened.
>
> **Report:** per test (D, E): Observed (what happened + screenshot paths) and any anomaly; quote the coach's text in D; separate confident from uncertain; list any tasks/state you touched; leave the app on the dashboard, clean.
>
> **Hard limits:** never `am force-stop`, disk-filling, DB writes/`PRAGMA`, `pm uninstall`/`clear`, file deletion, or `adb reverse --remove`; never stop Metro or kill the app; do not leave the todoai app into Jason's other apps/settings/data; if stuck, ambiguous, or destructive-looking, STOP and report.

*(Note: a third SendMessage to resume the first device agent for these follow-ups could not be delivered — its transcript had been cleaned up — so a fresh subagent was spawned with the D2 prompt above. The failed-resume message carried the same content as D2.)*
