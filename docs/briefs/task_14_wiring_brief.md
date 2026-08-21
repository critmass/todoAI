# Task 14 §13 — wire the backup/recovery ladder into the running app

**Brief written by the coordinator, 2026-08-19.** This is a *sub-brief* of the main task-14 brief
(`docs/briefs/backup_recovery_task_14.md`) covering the one thing task 14 Phase A deliberately left
undone: **the backup ladder is invoked by nothing in the running app.** Phase A built and tested the
whole ladder against injected doubles; this task connects it to `src/app/` so it actually runs. Do
not re-open Phase A's internals — they are settled and device-confirmed for what has run.

> **Do not back-edit** `docs/briefs/backup_recovery_task_14.md` or `docs/eval/task14_findings_report.md`.
> They are point-in-time records. Write your own **new** report at
> `docs/eval/task14_wiring_findings_report.md`.

---

## 0. Role boundary (read first)

You are a **build subagent**. You author code, write tests, and run `npx jest` / `npx tsc --noEmit`
/ `npx eslint .` yourself to verify. **You do NOT drive the device** — this task is entirely
headless. Task 14 **Phase B** (running the backup/restore/salvage paths on the S23 FE) is a *separate,
later device session* that depends on this wiring existing; it is explicitly **not** your job and you
need no phone. When you finish, the next device batch will exercise what you wired.

The coordinator will independently re-run the suite to confirm your test count — so quote the **real**
number and beware the stale worktree (see §6).

---

## 1. What to build

Two of the three §13 call sites (site 3, `reclaimSpace`, is out of scope — see §5), plus the two UI
surfaces they key off. The definitive recipe is **`docs/eval/task14_findings_report.md` §13**; the
public API is the barrel `src/services/backup/index.ts`. Read both before writing.

### Call site 1 — recovery at launch (`src/app/appServices.ts`, `initAppServices`)

Run the recovery ladder **before `getConnection()`** (currently the first line of `initAppServices`,
line 68). Sketch from §13:

```ts
const ops = createOpSqliteOperations();     // from services/backup/opSqliteOperations
const config = resolveConfig(/* … */);      // ⚠ §13 pseudocode says defaultBackupConfig(); the
                                            //   barrel actually exports resolveConfig — read types.ts
const recovery = await runRecoveryLadder({ ops, config, now: Date.now });
// then the existing getConnection() / runMigrations()
```

- `opSqliteOperations` is **deliberately not re-exported** from the barrel (it imports the native
  module, which throws at import time outside a real RN runtime). Import it directly, and keep it out
  of any path a test loads — `initAppServices` is already the one file in `src/app/` that touches the
  native SQLite entry point, which is why recovery belongs here.
- If `recovery.workingDbReplaced`, drop any cached connection (`setConnection(null)` if that exists)
  — at launch there is none yet, which is exactly why this runs here.
- `recovery.requiresAcknowledgement` is what the launch acknowledgement screen keys off (surface B).

### Call site 2 — pre-session backup gate

`ensurePreSessionBackup(deps)` returns a `SessionStartGate`: `{ allowed: true, … }` or
`{ allowed: false, reason: 'no_space' | 'integrity', detail, quickCheck }`. Call it **before the
`sessions.create` write**, and refuse to start the session on `allowed: false`.

⚠ **The §13 recipe says "in `sessionController.startSession`", but the real shared choke point is
`createSessionRow(origin)`** (`src/app/session/sessionController.ts:278`). **Both** the planned flow
(`startSession` → `createSessionRow('planned')`) **and** quick-start
(`startQuickStartSession` → `createSessionRow('quickstart')`) pass through it, and the device session
confirmed quick-start is a normal session start that should be equally protected. **Decide where the
gate sits so both flows are covered** — most likely `createSessionRow`, or a shared guard both entry
points call before it. State your placement and reasoning in the report.

⚠ **Task 44 already edited this function** (`sessions.origin`, migration 007 — landed). You are
rebasing onto that, not racing it; `createSessionRow` already threads `origin`. Read the current
file, don't assume the report's older shape.

You will need to thread the backup deps (`ops`, `config`, and the live `working` connection) into the
session controller's dependency bundle in `appServices.ts`. Keep the controller testable against a
`better-sqlite3` double — inject the backup deps the same way every other repo is injected; do not let
`opSqliteOperations` leak into a test-loaded path.

### Surface A — "not enough space" (session start, `reason: 'no_space'`)

A blocked session with no surface is a silent no-op at session start — the whole reason this wasn't
wired in Phase A. Build the screen. 🔴 **Ruled by Jason 2026-08-19: reuse task 24's existing screen
patterns** — purely presentational against `src/app/screens/contracts.ts`, no repo/service/clock
import, wired into the router in `App.tsx` like every other screen. Copy tone/structure from an
existing task-24 screen (e.g. the mismatch "Before you start" screen is a good sibling — it also
informs-then-offers-a-choice). The screen states that a backup couldn't be made for lack of space and
tells the user to free some; `detail` carries the specifics.

### Surface B — recovery acknowledgement (launch, `requiresAcknowledgement`)

The "here is what was recovered and what was lost" screen, shown at launch when the recovery ladder
acted. Same rules as Surface A: task-24 pattern, presentational, router-wired. Its content comes from
the `RecoveryOutcome` — read `runRecoveryLadder`'s return type (`ladder.ts`) for exactly what's
available to show (which step ran, whether the working DB was replaced, what a restore cost).

### Integrity path (`reason: 'integrity'` at session start)

§13 says an integrity failure at session start means "run `runRecoveryLadder` first." Handle it, or —
if it's a bigger lift than the no-space path warrants right now — **scope it explicitly** and say so
in the report as a deliberate, surfaced deferral (not silent). The no-space surface is the primary
ask; do not let the integrity path balloon the task, but do not drop it silently either.

---

## 2. Constraints (violating any is a real bug — full list in `orientation_for_opus.md` §4)

- **No migration, no schema change.** Task 14 owns none. If you think you need one, stop and flag it.
- **Screens stay presentational** — no screen imports a repo, service, `src/execution`,
  `src/planning`, or a clock. That layering is what lets the beta visual pass swap screens without
  touching behaviour. (orientation §3.)
- **`sessions` is born `'abandoned'`** (constraint #14) — the gate runs *before* `sessions.create`,
  so a blocked session creates **no** row. Confirm no partial session state is left behind on a block.
- **Don't touch `src/services/backup/` internals** — they're Phase A, settled. You *consume* the
  barrel. Editing a Phase-A test only to chase a version/string sweep is allowed but must change no
  assertion or logic, coordinator-reviewed (this is the task-44 precedent).
- **The expiry-alarm path must never gain a `setTimeout`** (constraint #13) — you're not near it, but
  don't wire anything that regresses it.

---

## 3. Deliverable

1. **Wired code** — call sites 1 & 2, the two surfaces, the deps threaded through `appServices.ts`.
2. **Headless tests** — cover: gate blocks on `no_space` and creates no session row; gate blocks on
   `integrity`; `allowed: true` proceeds and the session starts normally; recovery runs before
   `getConnection`; `workingDbReplaced` / `requiresAcknowledgement` drive the right surface. Use the
   existing `better-sqlite3` / `DbOperations`-double patterns from `src/services/backup/__tests__/`
   and `src/db/testUtils/`. Both planned and quick-start flows hit the gate — test both.
3. **`docs/eval/task14_wiring_findings_report.md`** with, mandatory and separate:
   - **"Deviations from human decisions"** — 🔴 *every* product-shaped choice you made (gate
     placement, quick-start coverage, the copy/behaviour of both surfaces, how you scoped the
     integrity path) is **provisional until Jason rules it** and goes here, not into "decisions this
     task had to make." **Empty is a valid answer and must be written out explicitly.** Do not cite a
     brief for a decision the brief didn't authorise (the `WorkScreen.tsx` false-citation lesson).
   - The wiring as-built (which call site landed where and why), the test count (real, worktree-aware),
     `tsc`/`eslint` status, and what remains for the device session (Phase B).

---

## 4. Verify before you claim

Run and quote all three, on `main`:

```bash
npx jest
npx tsc --noEmit
npx eslint .
```

Baseline before your work: **961 real tests / 83 suites** green; `tsc` clean; `eslint` 0 errors /
56 warnings (all inline-style in `src/dev/`). Your additions should raise the test count, keep `tsc`
clean, and not add eslint errors.

---

## 5. Out of scope

- **§13 call site 3 (`reclaimSpace`)** — omit it. It depends on task 41/43 being able to delete
  capture streams, which isn't wired yet. Both deps bundles simply don't pass `reclaimSpace` for now.
- **Any device run** — Phase B, a later session.
- **The `fsync`, StatFs-under-a-real-screen, and thermal-under-load** device measurements — device
  session, not you. (That said, if the no-space surface gives StatFs's `availableBytesFor` its first
  real caller, note it — the device session wants to know.)

---

## 6. Traps that have bitten this repo

- **The stale worktree doubles every jest count.** `.claude/worktrees/interesting-shirley-e10fa1` is a
  second checkout inside the project; raw `npx jest` reports ~2× (currently 1755/151 raw = 961/83
  real + 794/68 worktree). **Halve nothing blindly — subtract the worktree's fixed 794/68**, or count
  test files. Never quote the raw number.
- **`Edit` anchors go stale the instant a file changes** — re-read before re-editing; a failed
  uniqueness match writes nothing.
- **Two grammar drift guards, not one** — irrelevant here (you're not touching grammars), but if a
  suite fails in a file you didn't touch, that's the class of trap: read the failure, don't assume you
  broke it.

---

## 7. Read these, in order

1. `docs/eval/task14_findings_report.md` — **§13 (the recipe)**, §12 (why the UI surface is required),
   §15 (the two ratified deviations D1/D2, so you don't re-derive the backup scheme).
2. `src/services/backup/index.ts` (the barrel — the exact exported names) and
   `src/services/backup/{sessionGate,ladder,restore,types}.ts` (the shapes you consume).
3. `src/app/appServices.ts` and `src/app/session/sessionController.ts` (`createSessionRow`,
   `startSession`, `startQuickStartSession`) — the call sites as they exist **now**.
4. `src/app/screens/contracts.ts` + one existing task-24 screen + the router in `App.tsx` — the
   pattern the two new surfaces reuse.
5. `docs/briefs/orientation_for_opus.md` §3 (module contracts) and §4 (constraints).
