# Task 14 — Backup / restore + corruption recovery (§8.4): Phase A findings

**Phase A only. Nothing here is done.** Spec §7 of the brief is explicit: *"No Phase B, no done."* The
five-step ladder is built and green against a file-backed SQLite double, and **not one line of it has
run on the S23 FE**. §9 below is the Phase-B list.

**Status:** `src/services/backup/` (11 files) + two test-only helpers under `src/db/testUtils/`.
57 tests across 6 new suites. Full suite green — **raw 1662 / 143, which is 868 real tests / 75 real
suites** after halving for the `.claude/worktrees/interesting-shirley-e10fa1` duplicate (baseline was
811 / 69). `tsc --noEmit` clean. `eslint .` 0 errors / 56 warnings, all pre-existing inline-style
warnings in `src/dev/`.

**No schema change. No migration.** 007 stays free for task 44, and `backup_log` (migration 001) was
already exactly the table this needed.

---

## 1. What was built

| File | What it is |
|---|---|
| `types.ts` | The injected `DbOperations` seam — `open(ref) → ManagedDb` with `execute`/`transaction`/`close`/`delete()`/`path()`. One method, because that is all op-sqlite has beyond a connection. |
| `integrity.ts` | `checkIntegrity` (full or `quick_check`), `isEmptyDatabase`, `estimateDatabaseBytes`. |
| `backup.ts` | `VACUUM INTO` into two alternating slots; `backup_log` bookkeeping; `listBackupCandidates`. |
| `salvage.ts` | `ATTACH` + `INSERT…SELECT` table-by-table into a freshly migrated database. |
| `consistency.ts` | Dangling deps, cycle breaking, schema-driven orphan cleanup. |
| `restore.ts` | `promoteToWorking`, `restoreFromBackup`, `clearRuntimeTables`, `freshStart`, `fullReset`. |
| `ladder.ts` | Spec §8.4's five steps, in order. |
| `sessionGate.ts` | `ensurePreSessionBackup` — the block-on-no-space rule. |
| `opSqliteOperations.ts` | The real `DbOperations`. Deliberately **not** in the barrel: it imports the native module. |

`src/db/testUtils/fileDbOperations.ts` is the double — better-sqlite3 over **real files in a temp
directory**, with real byte-level corruption (`corruptDatabaseFile`) and an injectable full disk.
`src/db/testUtils/backupFixture.ts` is the shared fixture. Neither is imported by production code.
The one change to an existing file is `sqliteTestConnection.ts`, where the better-sqlite3 →
`SqliteConnection` adapter was split out as `wrapDatabase(db)` so the file-backed double reuses
exactly the same driver semantics; `createTestConnection()` is unchanged in behaviour.

**`VACUUM INTO` is confirmed present in the bundled engine, not assumed.**
`node_modules/@op-engineering/op-sqlite/cpp/sqlite3.h` declares `SQLITE_VERSION "3.51.3"` and
`android/CMakeLists.txt:79` compiles `../cpp/sqlite3.c` into the package — op-sqlite builds its own
amalgamation and does not link Android's system SQLite, with no `SQLITE_OMIT_VACUUM` or
`SQLITE_OMIT_ATTACH`. The brief's "verify on device before building on it" warning (§2) is therefore
discharged as a **build fact**; the device run stays on the Phase-B list as habit, not as doubt.

---

## 2. §4 (a) — where the copies live, and how many

**Decision: one working database at a fixed path, plus TWO alternating backup slots.**
Working stays at `todoai.db` in `ANDROID_DATABASE_PATH` (unchanged from `connection.ts`). Slots are
`todoai.backup.a.db` / `todoai.backup.b.db` in `ANDROID_EXTERNAL_FILES_PATH`
(`/sdcard/Android/data/com.todoai/files/`, constraint #10 — app-private, nothing on shared storage,
nothing transmits).

**Why two slots and not one.** `VACUUM INTO` refuses to write a target that already exists, and
nothing in this tree can rename a file. A single-slot scheme must therefore **delete the only backup
before writing its replacement** — so a backup that fails for want of space destroys the last good
copy at exactly the moment the ladder exists to protect. With two slots the newer snapshot is never
the one being overwritten: a failed backup costs the *older* copy and nothing else. This is pinned by
a test ("a failed backup costs the OLDER slot only").

**Cost, stated plainly:** one extra database-sized file. On a device that is already tight this makes
the tight condition slightly tighter. The trade was taken because the failure it prevents
(no backup at all, on a full disk) is categorically worse than the one it causes (less headroom).

**Why the backups go to external app-private storage rather than beside the database:** it is a
different volume from the internal `databases/` directory, so one filesystem problem is less likely
to take both copies; and it is reachable over adb, which is what makes a backup something you can
actually pull off a beta tester's device. ⚠ **Unverified on device** — see §9.

**How a slot is dated without any file metadata.** Nothing here can stat a file for its mtime. Each
snapshot instead **carries its own identity**: the `backup_log` row is written and committed *before*
the vacuum, so it is inside the resulting file, naming the slot and the timestamp. Recovery reads
that row out of each slot and takes the newer valid one — which works even when the working
database, the only other place that record lives, is unreadable.

One consequence, documented in code and pinned by a test: **inside a snapshot, its own creation row
always reads `success = 0` / `error_message = 'in flight at snapshot time'`**, because it was
committed before the copy that captured it. The authoritative status for that same backup is the row
in the live database. A reader who does not know this would mistake every snapshot for a failed
backup.

---

## 3. §4 (b) — how restore interacts with migrations

**Decision: `restoreFromBackup` runs `runMigrations` against the restored file, always, and reports
whether it moved.** A snapshot carries its own `schema_metadata.version`; the runner is forward-only,
so a restore that skipped it would leave the app on a five-migration-old schema and every repository
written since would fail on a missing column.

Pinned by a test that builds a genuine 2.2.0 database (migration 001's statements only), backs it up,
restores it, and asserts `migrated === true`, the resulting version is `2.7.0`, and a column that
only exists from migration 006 (`task_recurrence.last_period_shortfall`) is queryable.

**Salvage never copies `schema_metadata`.** The salvage destination is at the current schema by
construction; copying an older source's version row would claim otherwise. That is the same failure
mode §4b names, arriving by a different door.

Constraint #12's sweep discipline: **no migration was written, so no sweep was needed.** The only
migration-adjacent assertion added is `expect(schemaVersion).toBe('2.7.0')` in four places, which will
need the same one-line update as every other suite when 007 lands.

---

## 4. §4 (c) — the runtime tables, and why restore and salvage answer differently

**Decision: RESTORE clears migration 005's three runtime tables. SALVAGE keeps them.** This is the
deliberate call §4c asks for, and the two halves are deliberately opposite.

- **Restore clears them.** A snapshot's `active_episode` row belongs to whatever session was live
  when the snapshot was taken — possibly hours or days ago. `active_episode`'s mere existence is the
  crash signal (migration 005), so leaving it would tell `recoverOpenEpisode` that a crash just
  happened and credit elapsed time that was never worked. Clearing it is the truthful statement:
  after a restore, there is no live session.
- **Salvage keeps them.** A salvage rebuilds the database the app actually died with. The crash is
  real and its signal is real data from the same instant. Dropping it here would *lose* the crash
  recovery, which is task 13's whole job.

`sessions` rows are untouched in both paths — a running session is born `'abandoned'` (constraint
#14), which is already the truthful value to find afterwards. Pinned by a test.

`clearRuntimeTables` is exported and `salvageDatabase` takes a `clearRuntimeTables?: boolean`, so
task 13 can override either default without editing this layer.

⚠ **Coordination note for task 13.** The ladder must run **before** `recoverOpenEpisode`, and
`recoverOpenEpisode` must run before everything else (task 13 §2, `launch.ts`). Those are not in
conflict — the ladder runs before the app's shared connection is even opened — but the ordering is
now three-deep and needs to be stated somewhere task 13 will see it: **recovery ladder → open
connection → `runMigrations` → `recoverOpenEpisode` → everything else.**

---

## 5. §4 (d) — do the capture logs get backed up?

**NO. The backup path covers the product database only.** The brief's recommendation is followed and
is stated here explicitly, as it asked.

Three reasons, none of which is merely "it's easier":
1. Capture is **ephemeral by settled decision** (orientation §5: built to be removed, every stream
   independently; pruned by ship stage). Backing up something designed to be deletable inverts the
   decision.
2. It is **large** — task 41 §8.3 caps it at 512 MB — and it would compete directly for the space the
   product database's backup needs. A capture backup could be the thing that makes a product backup
   fail.
3. **Getting capture data off-device is task 42's export path, not this one.** Task 42 owns
   consent-gated egress with anonymisation at the source; a backup that quietly duplicated free-text
   capture into a second file would be a second copy nobody had governed.

**What this means for task 31's corpus:** the corpus's durability is the export path's problem, and
the collection window closing at open beta (orientation §5) makes that *more* urgent, not less. Task
14 does not and should not help.

---

## 6. §4 (e) — the no-space rule, and the reciprocal with capture

**Stated explicitly so neither task assumes the other handles it:**

> **The product database BLOCKS. Capture DEGRADES.**
> On a full disk, `ensurePreSessionBackup` returns `{ allowed: false, reason: 'no_space' }` and the
> session does not start (spec §8.4). Capture, by task 41 §5d, drops records, counts the drops and
> warns — it never blocks anything. Task 14 owns the blocking side; task 41 owns the degrading side;
> neither defers to the other.

The asymmetry is principled: a dropped capture record costs a line of diagnostics, while an
un-backed-up session risks the user's real data.

**The handoff from task 41 §8.3 is honoured as a contract, not an implementation.** `BackupDeps` and
`RestoreDeps` both take an optional `reclaimSpace?: () => Promise<number>`, tried **exactly once**
before a disk-full backup is reported as a failure (and again on `fullReset`). Task 14 does not own
`src/capture/` and cannot delete a capture file — capture's own native module owns that — so this is
the seam task 41/43 fills in. Unset, it is a no-op and the ladder behaves as if there were nothing to
reclaim. Pinned by two tests (reclaim succeeds → session allowed; reclaim insufficient → still
blocked, hook called once).

Task 41's **512 MB capture ceiling is what makes this safe**: capture cannot be the *cause* of the
condition that blocks a session, so `reclaimSpace` is a genuine last resort rather than a routine
part of every session start.

---

## 7. 🔴 The free-disk-space gap — the tradeoff, with a recommendation, not a decision

**The gap is real and unchanged: nothing in this tree can report free disk space.** Not op-sqlite
(path constants, `setReservedBytes`, no `statvfs`), not React Native core. Spec §8.4's *"block session
start if there's no space to copy"* implies knowing **before** the attempt.

**What was built:** the attempt *is* the test. The pre-session backup is the copy the spec is talking
about, so if it cannot be written for want of space, the session is blocked — and blocked before any
session state exists. `isDiskFullError` classifies `SQLITE_FULL` / `ENOSPC` and `createBackup` raises
`NoSpaceError`.

**That is a genuine implementation of the rule and NOT a substitute for knowing in advance.** What it
cannot do:
- warn at 90% full, before anything fails;
- tell the user *how much* space to free;
- avoid paying the cost of a failed write to find out;
- distinguish "disk full" from "quota exceeded" or a filesystem error that reports the same way.

### The three options, honestly costed

| | Mechanism | What you get | What it costs | Fails how |
|---|---|---|---|---|
| **1. Attempt-and-catch** *(built)* | `VACUUM INTO`, catch `SQLITE_FULL` | The correct block/allow answer, every time, with zero new dependencies | A failed write's I/O; no advance warning; no number to show the user | Honestly — you learn at the moment it matters |
| **2. `setReservedBytes`** | Reserve N bytes in the DB file so the *product DB* keeps headroom | Protects the working database from wedging when the disk fills | Does **not** answer the question — it reserves space *inside* the database file, it does not measure free space on the volume, and it does not help the backup, which is a *different* file | Silently: it looks like a guard and guards something else |
| **3. A small native call** | One TurboModule method over `StatFs.getAvailableBytes()` | The actual number: advance warning, "free 40 MB", a proactive nudge before beta testers hit it | One `src/specs/*.ts` codegen spec, one ~30-line Kotlin file, a rebuild. Precedent exists (`NativeEpisodeAlarm`), and `codegenConfig` already points at `src/specs/`, so the `.cxx` trap in task 24 §9.6 has already been paid once | Degrades to option 1 via `TurboModuleRegistry.get` if absent |

### Recommendation

**Ship option 1 now; add option 3 when there is another reason to touch the native layer.** Option 1
is complete and correct for the *blocking* rule — the only thing the spec actually mandates — and it
is already built and tested. Option 3 buys a **better user experience, not better correctness**: a
warning before the wall instead of a wall. Its real cost is not the 30 lines of Kotlin, it is a
device build cycle, which is why it is worth **bundling with task 41's `NativeCaptureLog` module**
(design §1.1 recommends adding one anyway) rather than spending a build on it alone. Two specs in one
rebuild is nearly free; two rebuilds is not.

**Option 2 should not be chosen at all, and this is the substantive correction to the brief's
preference order.** Brief §2 lists `setReservedBytes` as option (2), ahead of a native call.
`sqlite3_file_control(SQLITE_FCNTL_RESERVE_BYTES)` reserves bytes *within a database file's pages*;
it is not a free-space query and it says nothing about the volume the backup is written to. It would
read like a guard in the code and guard something else. **This is a disagreement with the brief,
stated with the mechanism, as asked.**

🔴 **This is Jason's call, not mine** — it is a build-cost decision. Nothing in the code assumes
option 3 arrives; if it does, it plugs in ahead of `ensurePreSessionBackup` without changing the
ladder.

---

## 8. `backup_log` — disposition

**USE IT. It is now load-bearing, not decorative.** Migration 001's table stays.

It is not merely "written to so the brief's §3 is satisfied" — the design **depends** on it:

- The **slot rotation pointer** is `SELECT backup_path FROM backup_log WHERE success = 1 ORDER BY id
  DESC LIMIT 1`. There is nowhere else it could live: there is no writable file outside SQLite in
  this tree, so the "which slot is newer" question can only be answered from inside a database.
- The **snapshot's self-identifying date** is its own `created_at` row, committed before the vacuum
  and therefore carried inside the file. This is what lets `listBackupCandidates` order two slots
  when the working database is unreadable.
- `restored_at` is stamped on the restored snapshot's row, so a restored database truthfully records
  where it came from.
- `success` / `error_message` record a failed backup, which is what a support conversation about lost
  data will actually want.

Every column in the migration-001 definition now has a writer and a reader except one: **`backup_size_bytes`
is an over-estimate**, `page_count * page_size` taken before the vacuum. The vacuumed output is
defragmented and normally smaller, and nothing in this tree can stat the written file to correct it.
It is labelled as an estimate in the type (`BackupResult.estimatedBytes`) and in the column's writer.
If option 3 in §7 ever lands, a real size comes with it for free.

The `backup_type` CHECK (`automatic` / `manual` / `pre_session`) is used as written: `pre_session` from
the session gate, `automatic` as the default, `manual` reserved for a user-triggered backup that no
surface offers yet.

---

## 9. What the SQLite double proves — and what it does not

This matters more here than in most tasks, because the double is a *different SQLite on a different
filesystem* and corruption is exactly where they diverge.

### What Phase A genuinely proves
- The **SQL is right**: `VACUUM INTO ?` as a bound parameter, `ATTACH DATABASE ? AS …`, `PRAGMA
  <schema>.table_info`, `PRAGMA foreign_key_check` / `foreign_key_list`, `sqlite_sequence` restore —
  all executed against a real engine over real files, not a stub.
- The **ladder's control flow** on genuinely damaged bytes: a header-destroyed file falls through
  salvage to restore; a last-page-damaged file salvages; both slots unusable stops at
  `unrecoverable` **without destroying anything**.
- **`runMigrations` really does move a 2.2.0 snapshot to 2.7.0** on restore.
- **No handle leaks** on any branch (asserted).
- The **no-space behaviour is fully exercised**, because it is injected at the `DbOperations` layer
  exactly as the brief §6 asked, rather than simulated at a filesystem that isn't there.

### What it does NOT prove — and this is the honest list
1. **Real op-sqlite corruption behaves differently.** The double is better-sqlite3 (SQLite 3.5x) on
   NTFS; the device is op-sqlite's bundled 3.51.3 on f2fs. Error *strings* differ, error *codes* may
   differ, and which statement first notices the damage may differ.
2. **A real full disk is not `setDiskFull(true)`.** The double throws `SQLITE_FULL` at the `VACUUM
   INTO`. A real Android full disk can surface as `SQLITE_IOERR`, `ENOSPC` from the VFS, or a WAL
   checkpoint failure at an entirely different statement — possibly *inside* a repository write
   rather than at the backup. `isDiskFullError` matches on both code and message and is deliberately
   loose, but it has never seen the real string.
3. **WAL is not exercised.** better-sqlite3 defaults to rollback-journal; op-sqlite may open WAL. The
   whole argument for `VACUUM INTO` over a file copy is about a live WAL, and the double cannot test
   the case the argument is about.
4. **Corruption shape is synthetic.** Real corruption comes from a partial write, a bad flash block
   or a kill mid-checkpoint. `corruptDatabaseFile` overwrites bytes. **A measured detail from Phase
   A worth carrying to Phase B:** against *this* schema (~40 tables), damaging anything broader than
   the final page takes `sqlite_master` out too — its pages are spread through the file — and `ATTACH`
   itself then returns `SQLITE_CORRUPT`, leaving nothing to salvage. So **the window in which salvage
   beats restore may be narrower on real hardware than the ladder's ordering implies.**
5. **The external-storage path has never been opened.** `ANDROID_EXTERNAL_FILES_PATH` exists in
   op-sqlite's TurboModule spec, but this tree has never opened a database there.
6. **Nothing about timing.** A `VACUUM INTO` of a real database at session start has a cost, and it
   is unmeasured. If it is slow enough to be felt, the pre-session gate is the wrong place for it.

---

## 10. Phase B — what must be checked on the S23 FE

In rough order. Items 1–3 are the gate; the rest are the brief's §6 list plus what Phase A surfaced.

1. **`VACUUM INTO` works on device.** One `execute`. Expected to pass (§1) — confirm anyway.
2. **`ANDROID_EXTERNAL_FILES_PATH` is writable by op-sqlite's `open()`.** If it is not, move the
   slots to `ANDROID_DATABASE_PATH` — a one-line change in `defaultBackupConfig()`, no design change.
3. **How long a real `VACUUM INTO` takes** on a database with a realistic amount of data, at session
   start, on a warm device. Report the number.
4. **Fill the disk and confirm the no-space behaviour.** Specifically: *which* error surfaces,
   *at which statement*, and whether `isDiskFullError` matches it. If it does not, that predicate is
   wrong and the block silently becomes a crash. **This is the single highest-value Phase-B item.**
5. **Truncate the working DB and confirm restore**, then repeat with (a) a header wipe and (b) a
   single-page garble, and record which branch of the ladder each takes. Compare against §9's
   measured narrowness of the salvage window.
6. **Confirm WAL.** `PRAGMA journal_mode` on the live connection. If it is WAL, re-run item 5 with a
   non-empty `-wal` present, and confirm `VACUUM INTO` produces a snapshot that includes uncommitted-
   to-main-file WAL content.
7. **Kill mid-session and confirm the ladder interacts correctly with crash recovery** (overlaps task
   13 — coordinate). The ordering to verify is §4's three-deep one: ladder → connection →
   `runMigrations` → `recoverOpenEpisode`. Specifically confirm that a **restore** clears
   `active_episode` (no phantom crash) and a **salvage** preserves it (real crash recovered).
8. **Confirm `op-sqlite`'s `DB.delete()` removes `-wal`/`-shm` too.** The double does; the real one is
   assumed to.
9. **Confirm `backup_log` survives a real restore** with the self-identifying row intact — i.e. that
   `listBackupCandidates` can date two real slots on device.

---

## 11. Decisions this task had to make (beyond §4 a–e)

1. **Steps 4 and 5 are OFFERED, never taken.** `runRecoveryLadder` stops at `unrecoverable`, returns
   `offers: ['fresh_start', 'full_reset']`, and touches nothing. `freshStart` and `fullReset` are
   separate exported functions, and `fullReset` throws `ConsentRequiredError` without
   `{ consent: true }`. Spec §8.4 words step 4 as an *offer* and step 5 as requiring *explicit
   consent*; a ladder that wiped a device because it ran out of automatic options would be the worst
   bug this task could ship.
2. **Salvage drops the schema's triggers for the duration and replays their DDL verbatim.**
   `INSERT … SELECT` fires triggers, and `prevent_circular_dependencies` would `RAISE(ABORT)` on a
   damaged dependency graph — taking the whole `task_dependencies` copy down. The trigger SQL is read
   from `sqlite_master` and re-executed, so nothing is reconstructed by hand.
3. **Salvage copies with `INSERT OR REPLACE` and degrades to row-at-a-time on failure**, counting
   skipped rows. That is spec §8.4's "malformed records skipped with logging" — a row that violates a
   CHECK costs that row, not the table.
4. **Salvage preserves the AUTOINCREMENT high-water mark** (task 26 §3b). A salvage is a rebuild with
   the *certainty* that rows are missing, which is precisely the condition under which SQLite silently
   re-uses an id.
5. **Orphan cleanup is schema-driven, not list-driven.** `PRAGMA foreign_key_check` finds the
   violations; `PRAGMA foreign_key_list` says what the schema wanted (`SET NULL` → null the column,
   otherwise delete the row). A future migration cannot leave this sweep out of date.
6. **The cycle breaker is deterministic** — nodes and edges visited in ascending task id — so the same
   damaged graph always loses the same edge.

### A schema gap found in passing, stated and not fixed

**Migration 001's `prevent_circular_dependencies` trigger only catches cycles of length two.** Its
`WHEN` clause tests for a single row that is the direct reverse of the one being inserted. `A→B→C→A`
inserts cleanly today, with enforcement and triggers fully on — pinned by a test in
`consistency.test.ts` that inserts exactly that and asserts it succeeds before the validator repairs
it. `validateConsistency` is currently the only thing in the tree that sees a cycle of length three
or more, and it only runs when something calls it.

Not fixed here because widening the trigger is a schema change and **007 is claimed by task 44**.
Worth numbering as its own item.

---

## 12. Deliberately deferred

- **The service is not wired into `src/app/`.** No file in `src/app/` was touched. The reason is not
  scope-avoidance: the session gate's whole behaviour is to *block a session*, and blocking without a
  "not enough space" surface would turn a full disk into a silent no-op at session start. That
  surface is task 24's screens. The wiring recipe is §13.
- **Import payload format.** `freshStart(deps, importer?)` takes a typed hook; the format is task 42's
  (spec §8.5 data export/import), and nothing in this tree reads or writes one yet.
- **Periodic consistency validation has no scheduler.** `validateConsistency` is exported and
  `runRecoveryLadder` takes `validateWhenHealthy`; nothing calls it on a timer. Spec §8.4 says
  "periodic" without saying how often. App-open is the obvious seam (`launch.ts` already sweeps
  recurrence there) but that is task 24/44 territory.
- **No manual-backup surface.** `backup_type = 'manual'` is supported and unused.

---

## 13. Wiring recipe (for whoever does it — 3 call sites)

1. **Recovery, before anything else.** In `initAppServices` (`src/app/appServices.ts`), *before*
   `getConnection()`:
   ```ts
   const ops = createOpSqliteOperations();          // from services/backup/opSqliteOperations
   const config = defaultBackupConfig();
   const recovery = await runRecoveryLadder({ ops, config, now: Date.now });
   // then the existing getConnection() / runMigrations()
   ```
   If `recovery.workingDbReplaced`, any cached connection must be dropped (`setConnection(null)`) —
   at this point in the launch there is none, which is exactly why it belongs here.
   `recovery.requiresAcknowledgement` is what the "here is what was recovered and what was lost"
   screen keys off.
2. **Pre-session backup.** In `sessionController.startSession`, before `sessions.create`:
   `await ensurePreSessionBackup({ ops, config, working: connection, now: deps.now })`, and refuse to
   start on `allowed: false`. ⚠ **This needs a UI affordance that does not exist** — see §12.
   ⚠ Task 44 also edits this function (`sessions.origin`); whoever lands second rebases.
3. **Space reclaim.** When task 41/43 can delete capture streams, pass `reclaimSpace` into both deps
   bundles. Until then, omit it.

---

## 14. Files touched

**New, mine:**
`src/services/backup/{types,errors,integrity,backup,salvage,consistency,restore,ladder,sessionGate,opSqliteOperations,index}.ts`
`src/services/backup/__tests__/{backup,salvage,consistency,restore,ladder,sessionGate}.test.ts`
`src/db/testUtils/{fileDbOperations,backupFixture}.ts`

**Modified, mine:** `src/db/testUtils/sqliteTestConnection.ts` — extracted `wrapDatabase(db)`;
`createTestConnection()` behaviour unchanged.

**`src/app/`: none.** **`src/capture/`, `src/llm/`, `src/specs/`, Kotlin, `scripts/`,
`jest.setup.js`: none.** **No migration.**

---

## 15. Deviations from human decisions

Two, both against the literal wording of **spec §8.4**, both provisional until Jason rules.

**D1 — the spec says "work on the copy"; this works on the original and copies to the backup.**
Spec §8.4 reads: *"copy DB at session start; work on the copy; keep prior as backup."* That describes
a rotation in which the **working path moves every session**. What was built keeps `todoai.db` fixed
and writes the snapshot into a backup slot.

*The mechanism that forces it:* a moving working path requires the app to know, at launch, which of
the rotating files is the live one — and that pointer cannot live in either database, because reading
it requires already knowing which one to open. It would have to live in a file outside SQLite, and
**there is no way to write a file from JS in this tree** (task 41 Phase 1). A moving working path is
therefore not implementable here, not merely inconvenient.

*What is preserved:* the property the sentence is protecting — at every moment there exists a
consistent copy of the database that the app is not writing to. *What differs:* which file has the
newer data. Under the spec's wording the backup is the *previous* session's state; under this
implementation the backup is the *snapshot at the start of this* session, which is the same instant.

**D2 — the spec's scheme is one backup; this keeps two.**
Brief §4a restates it: *"One backup + working is the spec's scheme."* Two slots are kept. The
mechanism is in §2 above: with one slot, `VACUUM INTO`'s refusal to overwrite plus the absence of
`rename` forces deleting the only backup before writing its replacement, so a backup that fails for
space leaves **zero** backups. The cost is one extra database-sized file. If Jason prefers the single
slot, `DEFAULT_SLOT_NAMES` and `chooseSlot` are the only two things that change, and the failure mode
described above returns.

**One further disagreement, recorded here rather than acted on:** brief §2's free-space preference
order puts `setReservedBytes` ahead of a native call. §7 argues it should not be used at all, with
the mechanism. That is a disagreement with a *brief*, not a ruling, and the code takes neither option
— it ships attempt-and-catch, which is the brief's own first choice.

**Nothing else.** Every other §4 decision follows the brief's stated recommendation or the spec's
literal order, including the two the brief flagged: capture logs are **not** backed up (§5), and the
capture/product-DB reciprocal is stated explicitly (§6). No schema change was made and migration 007
was not touched.

---

## Appendix — the coordinator's spawn prompt (added for completeness)

*Added by the coordinator 2026-08-19, recording verbatim the inline prompt sent when spawning this task's Phase A subagent. Supplements the pre-existing brief `docs/briefs/backup_recovery_task_14.md`.*

> You are executing **task 14, Phase A only** on the todoAI project (repo root: `C:\Users\physi\Documents\projects\todoAI`, branch `main`). You are the builder, not the coordinator. Jason is the sole developer and decision-maker. You do not have the device. Phase B is his.
>
> **Work order:** `docs/briefs/backup_recovery_task_14.md` is your brief — read it fully. It was rewritten 2026-08-07 because the original approach was wrong for this tree; make sure you are reading the current version. Then read `docs/briefs/orientation_for_opus.md` §3, §4, §5. Phase A is the whole headless ladder against an injected DB-operations layer: `PRAGMA integrity_check`, salvage, restore-from-backup, the space behaviour, and the consistency validator (dangling deps / cycles / orphans). Phase B — the S23 FE run — is explicitly not yours; nothing you produce is "done" until Jason runs it; say so in your report.
>
> **Two things already verified for you, so you do not re-derive or wrongly doubt them:** (1) 🔴 `VACUUM INTO` is available — settled, do not treat it as a risk. The brief warns to verify on device and says "if absent, stop and report." op-sqlite 17.1.2 compiles its own bundled amalgamation (`cpp/sqlite3.c`, wired in `android/CMakeLists.txt`), it is SQLite 3.51.3, no `SQLITE_OMIT_VACUUM`/`SQLITE_OMIT_ATTACH` flags; it does not link Android's system SQLite, so the version is a build fact. Build Phase A on `VACUUM INTO` with confidence (Jason still sees it work on hardware in Phase B, as habit). (2) Do not file-copy the database — task 41 Phase 1 established there is no way to write a file from JS in this tree, and a byte-copy of a live SQLite DB with an open WAL can capture a torn state. The whole ladder is reachable at SQL level with no new native module: `VACUUM INTO` for an atomic consistent backup, `PRAGMA integrity_check`, `ATTACH` + `INSERT…SELECT` for salvage (which skips views and steps past a corrupt table).
>
> **Decisions the brief asks you to make (§4 a–e):** work through all five. (d) Do capture logs get backed up? Recommendation: NO — database only; they are ephemeral by settled decision, large, and compete for the space the product DB needs; task 42's export owns getting capture data off-device. (e) The no-space reciprocal: task 41 §5d rules capture degrades where the product DB blocks; task 14 owns the blocking side — state the reciprocal explicitly; capture has a 512 MB ceiling specifically so it cannot be the cause of the no-space condition that blocks you, and task 14 should treat `capture/` as reclaimable space. 🔴 The known gap you must bring back as a tradeoff, not silently solve: nothing in this tree reports free disk space. Options are attempt-and-catch `SQLITE_FULL`, `setReservedBytes`, or a small native call. "Block before starting" implies knowing in advance, which attempt-and-catch cannot do. Give Jason the tradeoff with a recommendation; do not pick a native module on his behalf.
>
> **Constraints:** `PRAGMA foreign_keys = ON` per connection (#9) — a restore/rebuild path must not quietly drop it, and `ATTACH`-based salvage interacts with FK enforcement; plan for it. `active_episode`'s mere existence is the crash signal (migration 005) — a restored backup has no live session, so restore almost certainly clears the runtime tables; be deliberate, not incidental, because clearing it means "no crash happened" to the recovery path. Restore must run `runMigrations` against the restored file — do not restore a stale schema and assume it is current; obey constraint #12's sweep discipline. Local-only; app-private external storage only. 🔴 Do NOT create migration 007 — it is claimed by task 44 (`sessions.origin`); if you conclude you genuinely need a schema change, stop and report. `backup_log` (migration 001) has never been written to or read — you are its only natural consumer: use it or recommend retiring it, and say which.
>
> **Verification:** `npx jest`, `npx tsc --noEmit`, `npx eslint .`. 🔴 Jest count trap (~double, stale worktree; Jason ruled it stays). Current real baseline: 811 tests / 69 suites green (raw 1605/137); tsc clean; eslint 0 errors / 56 warnings. Halve any count; check real tree vs duplicate on a failure.
>
> **File scope:** yours is `src/db/` and a new service directory for the backup/salvage ladder. Task 41 Phase 2 owns `src/capture/`, `src/llm/errors.ts`, `src/llm/provider/ladder.ts`, `src/specs/`, the Android Kotlin sources, `scripts/`, `jest.setup.js`. Task 44 owns migration 007 and parts of `src/app/`. If wiring the pre-session backup hook forces you into `src/app/`, keep it minimal and list every file you touched there.
>
> **Deliverable:** `docs/eval/task14_findings_report.md` covering the §4 (a)–(e) decisions, the free-disk-space tradeoff with a recommendation, the `backup_log` disposition, what your SQLite double does and does not prove about real op-sqlite corruption, and everything Phase B must check on hardware. 🔴 A section titled exactly "Deviations from human decisions" — empty is a valid answer and must be written out explicitly. Code comments must cite the document that authorises them. Commit at natural breakpoints; do not push. If the brief is wrong, say so plainly with the mechanism.
