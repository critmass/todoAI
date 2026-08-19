# Device session runbook — the staged on-device queue (2026-08)

**Owner: Jason (executes on the S23 FE). Coordinator verifies the pulled artifacts.**
**Status of the tree:** `main` @ `c1c02d4`, desktop-green (961 real tests / 83 suites, tsc clean,
eslint 0 errors). **Nothing below has ever run on the S23 FE.** Four tasks' code (14, 41, 44, 48)
plus 37's grammar fix are *believed*, not *confirmed*, until this session.

This runbook consolidates the Phase-B checklists that live scattered across five findings reports
(`task14 §10`, `task41 §14.2 + §5`, `task44 §8`, `task37`, `task48`) into **one ordered session**,
because setup cost is paid once and several checks depend on each other.

---

## Pre-flight (blocks everything)

- **P0. Authorize adb.** ✅ **DONE 2026-08-18** — device `R5CWC240D5H` = SM-S711U (S23 FE), Android 16,
  now shows `device`.
- **P0.5. Pre-merge DB preserved.** ✅ **DONE** — pulled the installed build's DB via `run-as`
  (debug build) to the laptop archive before it gets migrated: schema **2.6.0**, 13 sessions, 30 tasks
  (7 active, 3 recurring), `completion_count`/`success_rate` present-but-unwritten (confirms the handoff).
  This is real personal-ship-era data; if migration 006/007 corrupts anything on first launch, this is
  the fallback. **Move it from the session scratchpad to the permanent private archive outside the repo.**
- **P1. Build merged `main` and deploy.** This is the **first build of the merged tree** — it has
  never been built. ⚠ **The `.cxx` codegen trap** (task 24 §9.6 / `README_build.md`): a second
  app-owned TurboModule (`NativeCaptureLog`) was added since the last build. `codegenConfig` already
  points at `src/specs/` so it *should* not re-trigger, but **`rm -rf android/app/.cxx` before the
  build anyway** — the cost of being wrong is this whole session. If it breaks, it breaks loudly at
  Kotlin compile on the generated spec signatures.
- **P2. Confirm the build carries both native modules** — `NativeEpisodeAlarm` (existing) and
  `NativeCaptureLog` (new: capture writer, thermal sampler, `availableBytesFor`). If `NativeCaptureLog`
  is absent the app must still launch (capture degrades to a counted no-op via `TurboModuleRegistry.get`) —
  that graceful-absence path is itself worth confirming, but the *point* of the session is that it's present.

---

## Phase 0 — Boot & the startup guard 🔴 GATES THE CAPTURE RUN

**Why first:** the startup guard compiles every grammar before any user session. Task 37 changed all
four `.gbnf` files and task 48 changed the primitive; **if a tightened grammar won't compile on the
real llama.cpp lexer, the guard disables the grammar path and every capture taken afterward is against
prompt-JSON fallback, not the shipped extractor** — which invalidates the corpus this session exists
to start. Confirm compile *before* trusting anything downstream.

- **0.1** App launches, reaches the dashboard, no crash. (First build of merged main — the base
  everything else sits on.)
- **0.2 🔴 The startup guard compiles all grammars clean** — no fallback to prompt-JSON. This is
  task 37 + 48's device confirmation. Watch `adb logcat` for the guard's compile result. The novel
  shapes to watch: task 37's `firstChar [a-zA-Z0-9]`-led rules across extraction/breakdown/resolution/
  summary, and **task 48's `min:0` alternation** (`"" | "\"" firstChar jchar{0,n-1} "\""`) — a shape
  real llama.cpp has never parsed.
- **0.3** Run one ordinary extraction (add a task through chat). Confirm normal extraction has **not
  regressed on Bonsai** through the tightened grammar — the task saves with a real title, not a
  fallback or a `,`.

**If 0.2 fails: STOP. Report which grammar. Everything downstream is contaminated.**

---

## Phase 1 — 🔴 The DOUBLE migration 006 + 007 on real op-sqlite, against real data

**Corrected 2026-08-18 after pulling the installed DB.** The device is at **schema 2.6.0** (migration
005), *not* 2.7.0 — personal ship was demonstrated on a branch predating 006. So first launch of merged
main applies **TWO migrations that have never run on device: 006 (recurrence period engine) and 007
(session origin)**, and it does so against **real data: 7 active tasks, 3 recurring, 13 sessions.**
This is a bigger test than "007 alone" and the reason preserving the DB first (done — see below) mattered.

- **1.1** `runMigrations` walks 005→**006**→**007**. Confirm it applies **both** — this exercises the
  task-26 fix that lets the runner apply more than one migration in a single launch, on device, for the
  first time since that fix. Confirm the DB reaches **schema 2.8.0**, `sessions.origin` exists, and
  006's `last_period_shortfall` + period columns exist. Watch logcat for any migration error.
- **1.2 🔴 The recurrence engine runs on device for the FIRST TIME.** Migration 006's `advanceRecurrence`
  sweep fires at app-open against **3 real recurring tasks** (`task_recurrence` rows). This is task 36's
  entire engine — DST-correct period math, the missed-quota boost, the neglect-anchor guarantee — meeting
  hardware for the first time. **And it carries a live-scoring-bug fix:** on the installed build, urgency
  (23% of score) was broken in both directions for every recurring task. Those 3 tasks have been
  mis-scored the whole time; the sweep should correct them. Pull the DB after and confirm the recurring
  tasks' `next_due_at`/period fields advanced sanely and the neglect anchor is untouched (constraint #5).
- **1.3** `ADD COLUMN origin TEXT CHECK (origin IN ('planned','quickstart'))` — the ADD-COLUMN-with-
  self-CHECK path (task 44 deviation 2) was verified only against better-sqlite3; confirm real op-sqlite
  accepts it and every prior session row gets `origin = NULL` (not backfilled).

---

## Phase 2 — Capture: the force-kill acceptance test (task 41) 🔴 THE HEADLINE

This is the test the whole capture design was built around. Design §14.2.

- **2.1** Start a session, run an episode **past the first model call**.
- **2.2** `adb shell am force-stop com.todoai` mid-episode.
- **2.3** Relaunch, let crash recovery run, close the session.
- **2.4** `node scripts/pull-capture.js --raw-i-am-jason` — its INTEGRITY section answers all four
  §14.2 checks: the pre-kill `run`'s `seq` is contiguous from 1 with no gaps; the last user action
  before the kill is present; `lifecycle.boot` exists for both runs and the second run's
  `crash_recovery` derives the **same `episodeId`** as the first run's `episode.start`; `dropped`
  appears nowhere (or with an understood reason).

**Pass = no event before the kill is missing.** A buffering bug surfaces nowhere else.

---

## Phase 3 — The two native readings, while the module is fresh (tasks 41 + 14)

- **3.1 🔴 StatFs two-volume check.** Compare `availableBytesFor(ANDROID_EXTERNAL_FILES_PATH)` against
  `availableBytesFor(ANDROID_DATABASE_PATH)`. **Equal ⇒ emulated on one partition, path-scoping is
  merely careful. Different ⇒ path-scoping is load-bearing** and task 14 must keep the path-scoped form
  deliberately. Either answer is fine; we just need to know which world we're in.
- **3.2 Thermal sampler returns something useful.** `PowerManager.getCurrentThermalStatus()` on the
  S23 FE returns a real status (fills `TernaryBonsaiProvider`'s sampler, empty since task 6). Note the
  value under load vs cold.

---

## Phase 4 — The task-44 flows (quick-start, self-complete, blocked buttons)

- **4.1** Quick-start a task → the **full four-screen check-in** runs, then serves that one task.
- **4.2** Quick-start a task whose context the session lacks → **`QuickStartWarningScreen`** names the
  condition, **Start anyway** / **Back out** both work. (Missing *tools* deliberately does NOT warn
  here — ratified deviation; tools are checked per-task via `ToolsCheckScreen`, which quick-start
  reaches naturally, and declining ends the one-task session rather than re-planning.)
- **4.3** A task **blocked by dependencies or a pending R7 breakdown** → both Quick-start and Mark-done
  buttons are **disabled with a visible reason**, not hidden.
- **4.4** Self-complete a task → `interactions` row written with `notes:'self_completed'` and explicit
  null runtime fields; task closes via the right recurrence branch; excluded from duration learning.
  Confirm `completion_count`/`success_rate` are **not** written (the deliberate no-writer convention
  task 17 inherits).
- **4.5** `sessions.origin` is written `'quickstart'` for a quick-start session, `'planned'` for an
  ordinary one.

---

## Phase 5 — 🔴 PULL THE CORPUS BEFORE ANYTHING DESTRUCTIVE

**Everything above only writes; everything below can corrupt or fill the disk. Pull first.**

- **5.1** `adb pull` the live DB and the whole `capture/` tree to the laptop's private archive
  (outside the repo). This is the first real corpus material task 31 will read.
- **5.2** Coordinator verifies the pulled artifacts before the destructive phase runs.

---

## Phase 6 — Backup / restore / corruption (task 14) — DESTRUCTIVE, runs late

Order matters: confirm `VACUUM INTO` works **before** Phase 7 relies on it for a backup.

- **6.1** `VACUUM INTO` works on device (one `execute`), and **`ANDROID_EXTERNAL_FILES_PATH` is
  writable by op-sqlite `open()`**. If not, move slots to `ANDROID_DATABASE_PATH` (one line in
  `defaultBackupConfig()`). Record **how long a real `VACUUM INTO` takes** at session start on a warm
  device.
- **6.2 🔴 Fill the disk and confirm the no-space behaviour** — *which* error surfaces, *at which
  statement*, and whether `isDiskFullError` matches it. **If it doesn't, the block silently becomes a
  crash.** This is the single highest-value item in task 14's Phase B.
- **6.3** Truncate the working DB and confirm restore; repeat with (a) header wipe and (b) single-page
  garble; record which ladder branch each takes vs §9's measured narrowness.
- **6.4** `PRAGMA journal_mode` — confirm WAL; if WAL, re-run 6.3 with a non-empty `-wal` and confirm
  `VACUUM INTO` snapshots uncommitted WAL content.
- **6.5** Kill mid-session, confirm the ladder → connection → `runMigrations` → `recoverOpenEpisode`
  ordering: a **restore clears** `active_episode` (no phantom crash), a **salvage preserves** it.
- **6.6** Confirm `DB.delete()` removes `-wal`/`-shm`; confirm `backup_log` dates two real slots.

---

## Phase 7 — Junk-purge dry run (task 44 item 5) — read-only, but back up first

- **7.1** Take a fresh `VACUUM INTO` backup (now confirmed working in Phase 6).
- **7.2** Run `scripts/purge-junk-tags.js` in **dry-run mode** against the pulled real DB. Read what it
  *would* delete. Confirm its "junk" definition (leading-separator class only) matches intent, and that
  it **lists ambiguous tags rather than deleting them**.
- **7.3** Only if the dry run looks right: run the destructive mode. **Not required this session** —
  the dry run is the deliverable; deletion can wait for a look.

---

## What the coordinator verifies from the pull

- Phase 2's capture integrity (contiguity, both boots, matched `episodeId`, no `dropped`).
- Phase 1's schema 2.8.0 + NULL-not-backfilled origins.
- Phase 4's `interactions` conventions and `sessions.origin` values.
- The three numbers task 41 owes: **app-open time with `fsync` on vs off** (§5.3 — decides whether the
  beta `fsync` revert gets pulled forward), thermal-under-load, and the two-volume answer.
- Task 14's no-space error identity (6.2) and salvage-window branches (6.3).

Each result flips a believed → confirmed on the board, or opens a bug. Report per-phase; a Phase-0
failure stops the session.
