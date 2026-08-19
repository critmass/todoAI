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
