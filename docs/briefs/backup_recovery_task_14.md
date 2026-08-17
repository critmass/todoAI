# Task 14 — Backup / restore + corruption recovery (§8.4)

**Owner:** **Opus.** **Carries `P`** — real storage limits and real corruption only happen on hardware. Phase A is a full headless build against a SQLite double; Phase B validates on the S23 FE.
**Not on the personal-ship path** (personal ship is met), but **the highest-value beta hardening** — it's what stops a stranger losing all their data to a bad write or a full disk.
**Refreshed 2026-08-07.** The 2026-07-31 version assumed a file-copy backup scheme. §2 replaces it; read that first even if you've seen this brief before.

---

## 0. Read first

1. This brief in full — **§2 especially**, which corrects the original approach.
2. `docs/briefs/orientation_for_opus.md` §3 (`src/db/`, `connection.ts`, repositories), §4 (constraint #9 `PRAGMA foreign_keys`, #12 migration-sweep discipline), §5 (settled decisions).
3. `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` §8.4 — recovery order and the local-only backup scheme. **v2.4, not v2.3.**
4. `docs/eval/task26_findings_report.md` §2–3 — the SQLite rebuild / view-drop / `sqlite_sequence` discipline.
5. `docs/design/capture_format_task41.md` §1 — the filesystem finding this brief now depends on.
6. `src/db/migrations/index.ts` — `runMigrations` and the version bookkeeping a restore must respect.

---

## 1. What this builds

The local-only data-resilience layer from spec §8.4. No cloud, no remote — disciplined local copies and a graceful recovery ladder.

**The recovery ladder, in order (spec §8.4):**

1. `PRAGMA integrity_check`
2. salvage readable data
3. restore from the automatic backup
4. offer a fresh start with import
5. full reset with explicit consent — last resort only

**Partial corruption** salvages tasks/preferences and rebuilds the rest, telling the user what was recovered vs lost. **Total loss** (both DBs unrecoverable) informs the user, clears files, reinitialises, and requires explicit acknowledgment.

**Consistency validation** (periodic): remove dangling dependencies, break circular references, clean orphans; malformed records skipped with logging and sensible defaults.

---

## 2. 🔴 The approach changed — do not file-copy the database

The original brief said *"copy the DB at session start."* **Two findings invalidate that.**

**a. There is no way to write a file from JS in this tree.** Task 41's Phase 1 design (`docs/design/capture_format_task41.md` §1) established it: no `react-native-fs`, no FS TurboModule, and `op-sqlite` exposes path constants but no general write. React Native core has no file-write API; `fetch('file://…')` reads but cannot append.

**b. A filesystem copy of a live SQLite database is unsafe anyway.** With an open connection and a WAL, a byte-copy can capture a torn state. **This would have been a latent data-integrity bug even if a filesystem API existed** — the backup would look fine and restore inconsistently.

**What you actually have is better.** `op-sqlite`'s DB object (`node_modules/@op-engineering/op-sqlite/src/types.ts`) exposes: `execute` (arbitrary SQL), `executeSync`, `delete()`, `attach({secondaryDbFileName, alias, location})` / `detach`, `getDbPath(location?)`, `loadFile(location)`, `sync()`, `setReservedBytes()` / `getReservedBytes()`.

So the whole ladder is reachable at the **SQL and DB-API level**, with no new native module:

| Operation | Mechanism |
|---|---|
| **Backup** | **`VACUUM INTO '<backup path>'`** — atomic, transactionally consistent, defragmented. The correct way to copy a live SQLite DB. Requires the target to *not* exist, so delete the previous backup first. |
| **Delete a DB file** | `open(...).delete()` — op-sqlite's own API. |
| **Integrity check** | `execute('PRAGMA integrity_check')`. Also consider `PRAGMA quick_check` for the cheap pre-session pass. |
| **Salvage** | `ATTACH` the damaged DB to a fresh one, then `INSERT INTO … SELECT` table by table. **This is also the answer to "what does salvage read"** — it naturally skips views and can proceed table-by-table past a corrupt one. |
| **Restore** | Delete the working DB, then `VACUUM INTO` the working path from the backup (or attach-and-copy). |

⚠ **Verify `VACUUM INTO` on device before building on it.** It needs SQLite ≥ 3.27; op-sqlite bundles a recent build so it should be present, but this is a one-line `execute` to confirm and the project's rule is that the device is ground truth. **If it's absent, say so and stop** — the fallback is attach-and-copy, which is slower and less atomic, and that changes the design.

🔴 **The one piece that may still need a native call: free-space checking.** Nothing in op-sqlite or RN core reports free disk space. Options, in preference order: (1) attempt the `VACUUM INTO` and catch `SQLITE_FULL` — honest, but you learn *after* the attempt; (2) `setReservedBytes` as an indirect guard; (3) a small native call. **Bring the tradeoff back rather than silently picking one** — the spec's "block session start if there isn't space" implies knowing *before*, and if that's not achievable without a native module, that's a product decision about whether to add one.

---

## 3. `backup_log` already exists and has never been written to

⚠ Migration 001 created:

```sql
CREATE TABLE backup_log (
  id, backup_type TEXT CHECK (backup_type IN ('automatic','manual','pre_session')),
  backup_path, backup_size_bytes, created_at, restored_at,
  success BOOLEAN DEFAULT TRUE, error_message
);
```

**Nothing has ever written to it or read it.** Task 14 is its natural and only consumer. Use it, or retire it in a migration — but it does not stay as a table that implies a guarantee the app doesn't make. *(This is the third such table found this month: `data_retention` — now task 42's — and `algorithm_weights`, which task 17 owns. Check for a writer before assuming a table is live.)*

---

## 4. Decisions to make and record

**a. Where the copies live, and how many.** App-private storage (`/sdcard/Android/data/com.todoai/files/`, constraint #10). One backup + working is the spec's scheme. Confirm the space question per §2.

**b. How restore interacts with migrations.** A restored DB carries its own schema version. If the app has since migrated forward, restore must run `runMigrations` against the restored file — obeying constraint #12's sweep discipline. **Do not restore a stale schema and assume it's current.** On-device schema is **2.7.0** (migration 006); **007 is claimed by task 44**, so expect the number to move.

**c. Interaction with task 13's runtime tables.** Migration 005's `session_runtime` / `active_episode` / `session_task_extension` hold *live* state, and **`active_episode`'s mere existence is the crash signal.** A restored backup has no live session, so restore almost certainly clears them — but be deliberate, not incidental, because clearing it means "no crash happened" to the recovery path.

**d. 🔴 Do the capture logs get backed up?** New question — they didn't exist when this brief was written. Task 41 writes append-only JSONL to its own directory. Arguments both ways: they're the corpus (task 31 depends on them, and the collection window closes at open beta), *but* they're explicitly ephemeral by settled decision, they're large, and backing them up competes for the space the product DB needs. **Recommendation: no — back up the database only, and say so explicitly in the report** so task 42's export path, not the backup path, owns getting capture data off the device. **Jason's call if you disagree.**

**e. The no-space rule, reconciled with capture.** Task 41 §5d states capture **degrades** (drops, counts, warns) where the product DB **blocks**. Task 14 owns the blocking side. State the reciprocal explicitly in the report so the two tasks don't each assume the other handles it.

---

## 5. Constraints that bite here

- **#9** — every connection sets `PRAGMA foreign_keys = ON`; a restore/rebuild path must not quietly drop it. Note that `ATTACH`-based salvage interacts with FK enforcement — plan for it.
- **#12** — any schema touch or rebuild follows task 26's discipline and sweeps prior migration suites.
- **Local-only** — no cloud backup, no remote. Device-local by design. Nothing here transmits.
- **`active_episode` is a crash signal** — see §4c.
- **Constraint #10** — app-private external dir only.

---

## 6. Phase split

**Phase A (headless).** The whole ladder against a SQLite double: integrity-check on a deliberately-corrupted file, salvage, restore-from-backup, the space behaviour, and the consistency validator on dangling deps / cycles / orphans. **Inject the DB-operations layer** (not "the filesystem" — see §2) so "no space" and "both DBs corrupt" are testable.

**Phase B (device — closes `P`).** On the S23 FE: confirm `VACUUM INTO` exists and works; fill the disk and confirm the space behaviour; corrupt the working DB (truncate the file) and confirm restore; kill mid-session and confirm backup/restore interacts correctly with crash recovery (overlaps task 13 — coordinate). **Real op-sqlite corruption behaves differently from `better-sqlite3`.**

---

## 7. Definition of done

- The backup scheme + the five-step ladder + the consistency validator, implemented.
- Full suite + `tsc --noEmit` + `eslint .` clean; migration suites swept if a schema touch landed.
- Phase B on the S23 FE: `VACUUM INTO` confirmed, no-space behaviour confirmed, working-DB corruption restored, crash-recovery interaction confirmed. **No Phase B, no done.**
- `docs/eval/task14_findings_report.md` covering: the §4 (a)–(e) decisions, what real op-sqlite corruption did vs the double, the `backup_log` disposition, and **a section titled "Deviations from human decisions" — empty is a valid answer and must be stated explicitly** (coordinator handoff §4).
