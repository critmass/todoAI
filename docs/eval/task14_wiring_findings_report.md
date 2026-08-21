# Task 14 §13 wiring — findings report

**Build subagent, 2026-08-21.** This is the report for the *wiring* task: connecting task 14 Phase A's
already-built backup/recovery ladder (`src/services/backup/`) into the running app. It is a **new**
record — it does not back-edit `docs/briefs/backup_recovery_task_14.md` or
`docs/eval/task14_findings_report.md`, which are point-in-time Phase A history. The work order was
`docs/briefs/task_14_wiring_brief.md`.

Scope done: the two in-scope §13 call sites (recovery-at-launch, pre-session gate) and the two UI
surfaces they key off. Out of scope and untouched: §13 call site 3 (`reclaimSpace`), and all device
(Phase B) work.

---

## 1. What was wired

### Call site 1 — recovery ladder at launch (`src/app/appServices.ts`, `initAppServices`)

The ladder now runs as the **first act of `initAppServices`, before `getConnection()`**. Every
restore/salvage path replaces the working-database FILE, so it must run before the shared connection
caches a handle to it (this is `restore.ts`'s own header warning). Placement:

```ts
const backupOps = createOpSqliteOperations();
const backupConfig = defaultBackupConfig();
const recovery = await runRecoveryLadder({ ops: backupOps, config: backupConfig, now: Date.now });
if (recovery.workingDbReplaced) setConnection(null);   // defensive: no cached connection exists yet
const connection = getConnection();
await runMigrations(connection);
```

- **`opSqliteOperations` is imported directly**, not through the barrel. It imports the native module;
  the barrel deliberately keeps it out so headless tests never load it. `initAppServices` is already
  the one file in `src/app/` that touches the native SQLite entry point, which is exactly why recovery
  belongs here.
- **The `defaultBackupConfig()` from the §13 pseudocode is real** — it lives in `opSqliteOperations.ts`
  alongside `createOpSqliteOperations`, not in the barrel. The brief flagged a possible mismatch
  ("§13 says `defaultBackupConfig()`; the barrel exports `resolveConfig`"). Reconciled: `resolveConfig`
  is the *internal* config normaliser that the ladder and gate call for themselves; the app-level
  config factory the recipe meant is `defaultBackupConfig()`, which exists. Both `createOpSqliteOperations`
  and `defaultBackupConfig` are imported from `../services/backup/opSqliteOperations`.
- `AppServices` now carries `recovery: RecoveryOutcome` (drives surface B) and
  `backup: PreSessionBackupDeps` (the `{ ops, config, working }` bundle threaded into the session
  controller).

### Call site 2 — pre-session backup gate (`src/app/session/sessionController.ts`)

The gate sits at the **top of `createSessionRow(origin)`**, before `deps.sessions.create`, **not** in
`startSession`. Reasoning:

- `createSessionRow` is the **one shared choke point** both entry paths pass through —
  `startSession → createSessionRow('planned')` and
  `startQuickStartSession → createSessionRow('quickstart')`. Putting the gate here covers **both**
  flows with a single placement; putting it in `startSession` would have left quick-start unprotected,
  and the device session already ruled quick-start a normal session start that must be equally guarded.
- It runs **before** the row is written, so a block leaves **no `sessions` row** behind (constraint
  #14's born-`'abandoned'` row is never inserted) and **no runtime state**. This is the property spec
  §8.4 protects by blocking *before* rather than after.

```ts
if (deps.backup) {
  const gate = await ensurePreSessionBackup({ ...deps.backup, now: deps.now });
  if (!gate.allowed) {
    setPhase({ kind: 'blocked', reason: gate.reason, detail: gate.detail });
    return null;                       // callers bail without starting the engine
  }
}
```

- The `backup` dep is **optional** (`backup?: PreSessionBackupDeps`). When absent the controller starts
  sessions exactly as before, so every pre-existing headless controller test is untouched and still
  passes without wiring a gate.
- `createSessionRow` now returns `{ sessionId, startedAtMs } | null`; both callers were updated to bail
  on `null` (the blocked screen is already set).
- `PreSessionBackupDeps = Omit<BackupDeps, 'now'>` — `now` comes from the controller's own injected
  clock, so it is not duplicated in the bundle. `ensurePreSessionBackup` is imported from the **barrel**,
  which is native-free.

### Surface A — session-start block (`SessionBlockedScreen.tsx`)

A new session phase `{ kind: 'blocked'; reason: 'no_space' | 'integrity'; detail }` (in
`session/types.ts`) rendered by a new `SessionBlockedScreen`, wired into `SessionFlow`'s switch in
`App.tsx` exactly like every other session screen. It is strictly presentational against a new
`SessionBlockedProps` in `contracts.ts` — no repo/service/clock import. It informs, reassures that
nothing was lost, and gives the one actionable next step; `detail` is shown small (for support/adb).
Dismiss routes back to the dashboard — there is nothing to abandon because no session was created.

### Surface B — launch recovery acknowledgement (`RecoveryAckScreen.tsx` + `recoveryAck.ts`)

Shown once at launch when the ladder acted (`requiresAcknowledgement`). Two pieces:

- **`src/app/recoveryAck.ts`** — a pure view-model function `buildRecoveryAck(outcome) → content | null`.
  It imports only the `RecoveryOutcome` *type* (no service, no clock), turning the outcome into
  plain-language `{ title, body, details[], grave }`. Returns `null` on a healthy launch (the common
  case), so nothing renders. This keeps the screen presentational and makes the copy/logic unit-testable
  without React.
- **`RecoveryAckScreen.tsx`** — presentational against a new `RecoveryAckProps` in `contracts.ts`.
- **Wiring**: `AppRoot` holds `recoveryAck` state; `boot()` sets it from `buildRecoveryAck(services.recovery)`
  after choosing the post-boot route. When non-null the screen **overlays** whatever route boot picked
  (rendered before `<Router>`, like `BootFailed`/`Booting`); acknowledging clears it and reveals the
  route underneath. Spec §8.4's "partial corruption tells what was recovered vs lost; total loss requires
  explicit acknowledgement" — the button is that acknowledgement.

### Deps threading

`initAppServices` builds `backup: { ops: backupOps, config: backupConfig, working: connection }` (the
`working` connection is the live one the gate's `VACUUM INTO` runs on, which is what makes the snapshot
consistent with committed state). `App.tsx`'s `boot()` passes `backup: services.backup` into
`createSessionController`. `reclaimSpace` is **not** passed into either bundle (out of scope, §13 site 3).

### Files touched

**Modified:**
- `src/app/appServices.ts` — recovery ladder before `getConnection`; `AppServices.backup` + `.recovery`.
- `src/app/session/sessionController.ts` — `backup?` dep, `PreSessionBackupDeps`, gate in `createSessionRow`, both callers bail on `null`.
- `src/app/session/types.ts` — new `blocked` session phase.
- `src/app/screens/contracts.ts` — new `SessionBlockedProps` + `RecoveryAckProps`.
- `src/app/App.tsx` — thread `backup` into the controller; surface-A `blocked` case; surface-B launch overlay.

**New:**
- `src/app/screens/SessionBlockedScreen.tsx` (surface A)
- `src/app/screens/RecoveryAckScreen.tsx` (surface B)
- `src/app/recoveryAck.ts` (surface B view-model)
- `src/app/session/__tests__/sessionBackupGate.test.ts` (gate integration)
- `src/app/__tests__/recoveryAck.test.ts` (presenter unit tests)

**No migration, no schema change. `src/services/backup/` internals untouched** (consumed via the barrel,
except the deliberate direct import of `opSqliteOperations` in `appServices.ts`, which the barrel's own
header prescribes).

---

## 2. Deviations from human decisions

Every item below is a **product-shaped choice I made and is PROVISIONAL until Jason rules it.** None of
these is authorised by the brief or the §13 recipe — they are my calls, surfaced here rather than buried
in "decisions this task had to make." (Not empty — listed explicitly.)

**D1 — Integrity block at session start defers to the launch ladder instead of running it inline.**
§13 loosely says an `integrity` failure at session start means "run `runRecoveryLadder` first." I did
**not** run the ladder inline. On `reason: 'integrity'` the gate blocks the session with a screen telling
the user to close and reopen the app, so the **launch-time** ladder (call site 1) handles the recovery on
the next start. Rationale/tradeoff, stated plainly: the ladder *replaces the working-database file*, which
would leave every repository the running controller holds pointing at a deleted inode. Recovering safely
requires dropping and rebuilding the whole connection/repository graph, which only `initAppServices` can do
— the controller cannot reopen the shared connection from inside a session. Running the ladder inline at
session start is therefore a genuinely bigger and riskier lift than the no-space path warrants. The cost of
my choice: on integrity failure the user must relaunch once (a manual step) instead of the app self-healing
mid-flight. This is a real scoping decision; if Jason wants inline recovery, it needs a controller→shell
"tear down and re-init" seam that does not exist today.

**D2 — All user-facing copy on both surfaces is mine.** Product voice is Jason's call. Specifically:
- `SessionBlockedScreen` — the `no_space` strings ("Not enough space" / "Before every session your data
  is backed up, and there isn't enough free space… Free up a little space and start again — nothing has
  been lost.") and the `integrity` strings ("Can't start just yet" / "Something looks wrong with your saved
  data… Close the app completely and open it again… Nothing has been deleted."), plus the single "Back"
  button.
- `buildRecoveryAck` — the `salvaged` copy ("Recovered your data" / "…rebuilt from everything that could
  still be read. Most of it should be here, but some of the newest changes may be missing."), the
  `restored` copy ("Restored a backup" / "…your most recent backup was restored. Anything you changed after
  that backup was taken may be missing."), the `unrecoverable` copy ("Couldn't open your data" / "…Nothing
  has been deleted. You can start fresh from the app when you are ready."), and the detail lines ("Kept N of
  your tasks", "Rebuilt N tables of data", "Couldn't recover N tables", "Restored a backup from <timestamp>",
  "The backup was updated to the current version").

**D3 — The `grave` tone + button copy mapping.** Only `unrecoverable` is rendered `grave` (danger-coloured
detail lines, button "I understand"); `salvaged`/`restored` are non-grave (button "Continue"). This
tone-by-status mapping is my product judgement.

**D4 — One `SessionBlockedScreen` handles BOTH `no_space` and `integrity`, reason-driven.** I chose a single
screen with per-reason copy rather than two separate screens. The brief named surface A specifically as
"not enough space"; folding integrity into the same frame (rather than a distinct screen or a silent no-op)
is my decision, made so the integrity path is surfaced rather than dropped — but it is a structural choice
Jason may want split.

**D5 — Surface B is a launch OVERLAY, not a dedicated route.** `RecoveryAckScreen` renders over whatever
route `boot()` chose (via `AppRoot` state, ahead of `<Router>`), rather than being added to the `Route`
union. This keeps the `Route` union and its exhaustive switch unchanged and models the ack as a one-shot
launch gate. A dedicated `{ kind: 'recoveryAck' }` route was the alternative; I judged the overlay simpler
and less error-prone, but it is a UX/architecture choice.

**D6 — `recoveryAck.ts` placement and existence.** I introduced a new pure view-model module at
`src/app/recoveryAck.ts` (root of `src/app/`) to hold the `RecoveryOutcome → props` mapping, so it is
testable and the screen stays presentational. Its location and its very existence (vs inlining the mapping
in `App.tsx`) is my call.

**D7 — The blocked state is modelled as a session PHASE, not a top-level route.** Consistent with
`quick_start_warning`, `plan_empty`, etc., the block lives inside `SessionFlow`. This follows the existing
pattern but is still a modelling choice worth a ruling.

**D8 — The defensive `setConnection(null)` on `workingDbReplaced`.** At launch no connection is cached yet,
so this is belt-and-braces, following `restore.ts`'s guidance rather than a product decision — noted for
completeness, not as a product choice.

If Jason rules on any of these, the changes are local: copy lives in `SessionBlockedScreen.tsx` and
`recoveryAck.ts`; the overlay-vs-route choice is `AppRoot`; the integrity-inline question is the one that
would require new plumbing.

---

## 3. Verification

Coordinator-verified (I did not re-run after the reset; numbers are theirs and match my pre-reset run):

- **jest:** raw 1767 tests / 154 suites → **real 973 tests / 86 suites, all green** (the stale worktree
  `.claude/worktrees/interesting-shirley-e10fa1` contributes a fixed 794/68). The true prior baseline was
  962/84 (the board's "961/83" was itself one test/suite stale, predating commit `2c9c546`), so the two new
  suites / 11 tests land exactly: 962→973, 84→86. Never quote the raw 1767/154.
- **tsc --noEmit:** clean.
- **eslint .:** 0 errors / 56 warnings — identical to baseline (all pre-existing inline-style warnings in
  `src/dev/`; my files add none).

New tests: `sessionBackupGate.test.ts` (6) drives the real gate through the file-backed `DbOperations`
double for all three branches on **both** flows — allowed→`pre_session` backup written + session starts;
`no_space` (via `setDiskFull`)→blocked, no session row, no runtime; `integrity` (via a `quick_check`
`setQueryFault`)→blocked, no session row; plus the "no backup bundle → gate skipped" backward-compat case.
`recoveryAck.test.ts` (5) pins the presenter: healthy→null, `requiresAcknowledgement:false`→null, and the
salvaged/restored/unrecoverable content + `grave` tone.

Note for the record: the pre-existing root `__tests__/App.test.tsx` renders the real `App`, so it now
exercises `initAppServices → runRecoveryLadder` against jest's op-sqlite mock; it passes, meaning the mock
presents a healthy database and the ladder returns `healthy` (no ack at launch under test). This is the only
place `opSqliteOperations` is loaded under jest, and only because the native module is mocked there — the
heavily-tested controller path never imports it (deps are injected), which is the constraint that mattered.

---

## 4. What remains for device Phase B (S23 FE)

This wiring makes the following reachable **for the first time** on hardware; only the device can settle
them:

1. **The pre-session `VACUUM INTO` backup at session start.** Every session start now calls
   `createBackup(…, 'pre_session')` on the live op-sqlite connection against the app-private *external*
   files directory. Phase B must confirm op-sqlite's `open()` can write the backup slots at
   `ANDROID_EXTERNAL_FILES_PATH` (never opened there before — `opSqliteOperations.ts`'s own ⚠ note), and
   that the added latency at session start is acceptable on f2fs.

2. **The `no_space` identity via a REAL full disk.** The headless double models no-space by throwing at
   `VACUUM INTO`. On device, Phase B must verify a genuine full disk actually surfaces as `SQLITE_FULL` at
   that statement so `isDiskFullError` matches, `NoSpaceError` is raised, and `SessionBlockedScreen` shows
   with `reason: 'no_space'` — and that no partial session state is left behind.

3. **`StatFs.availableBytesFor` still has NO real caller.** Flagged because the brief asked. My no-space
   path is **attempt-and-catch** (the gate's own mechanism: try the backup, catch `SQLITE_FULL`), which is
   the design Phase A shipped — it does **not** consult `StatFs`. So this wiring gives `availableBytesFor`
   **zero** new callers; it remains uncalled. If Jason later wants "warn at 90% full / say how much is
   needed," that is a separate change that would introduce the first caller. Recording this so the device
   session does not go looking for a StatFs call that this wiring never makes.

4. **Corruption → launch ladder → the acknowledgement screen, end to end.** With a genuinely corrupt
   `todoai.db` on device, Phase B should confirm: the ladder runs at launch *before* `getConnection`;
   `workingDbReplaced` correctly drops the (nonexistent-yet) connection; salvage vs restore is chosen as
   Phase A intends against real op-sqlite corruption strings (a device fact, not proven by better-sqlite3);
   and `RecoveryAckScreen` shows the right `salvaged`/`restored`/`unrecoverable` content with accurate
   recovered/lost counts.

5. **The integrity-block relaunch round-trip (see D1).** On device, corrupt the DB such that the
   pre-session `quick_check` fails at session start: confirm the session is blocked with the integrity
   screen, and that closing/reopening the app then lets the launch ladder recover it. If Jason rules D1 the
   other way (inline recovery), this round-trip is replaced by the new plumbing.

Nothing here is "done" until it runs on the S23 FE.
