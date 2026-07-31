# Task 14 — Backup / restore + corruption recovery (§8.4)

**Owner:** Opus. **Carries `P`** — real storage limits and real corruption only happen on hardware. Phase A is a full headless build against a SQLite double; Phase B validates on the S23 FE.
**Not on the personal-ship path** (personal ship is met), but **it's the highest-value beta hardening** — it's what stops a stranger losing all their data to a bad write or a full disk.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` §3 (`src/db/`, `connection.ts`, the repositories), §4 (constraint #9 `PRAGMA foreign_keys`, #12 the migration-sweep discipline).
2. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §8.4 — the recovery order and the local-only backup scheme.
3. `docs/eval/task26_findings_report.md` §2–3 — the SQLite rebuild/view-drop/`sqlite_sequence` discipline; you'll be doing DB-file operations and need it.
4. `src/db/migrations/index.ts` — `runMigrations` and the version bookkeeping a restore must respect.

---

## 1. What this builds

The local-only data-resilience layer from spec §8.4. No cloud, no remote — just disciplined local copies and a graceful recovery ladder.

**The backup scheme:**
- **Copy the DB at session start**; apply the session's changes to the working copy; keep the prior DB as the backup; rotate on the next session.
- **Block session start if there isn't space to make the copy** — with a clear storage message, not a silent failure. (A backup you couldn't write is worse than none.)
- Restore from the pre-session backup on working-DB corruption.

**The recovery ladder (in order, spec §8.4):**
1. `PRAGMA integrity_check`
2. salvage readable data
3. restore from the automatic backup
4. offer a fresh start with import
5. full reset with explicit consent — last resort only.

**Partial corruption** salvages tasks/preferences and rebuilds the rest, telling the user what was recovered vs lost. **Total loss** (both DBs unrecoverable) informs the user, clears files, reinitializes, and requires explicit acknowledgment.

**Consistency validation** (can run periodically): remove dangling dependencies, break circular references, clean orphans; malformed records skipped with logging and sensible defaults.

## 2. Decisions to make and record

**a. Where do the copies live, and how many.** App-private storage (`/sdcard/Android/data/com.todoai/`), one backup + working is the spec's scheme. Confirm the space-check is real (stat the free space before copying, not after failing).

**b. How a restore interacts with migrations.** A restored DB carries its own schema version. If the app has since migrated forward, the restore must run `runMigrations` against the restored file — and that path must obey the migration-sweep discipline (#12). Don't restore a stale schema and assume it's current.

**c. What "salvage" actually reads.** Define the salvage read-path that doesn't itself trip on the corruption it's recovering from (e.g. read tasks/preferences directly, skip the views and the FKs that might be the corrupt part).

**d. Interaction with task 13's runtime tables.** Migration 005's `session_runtime` / `active_episode` / `session_task_extension` hold *live* state. A restore mid-session is an edge: decide whether a backup taken at session start even contains an open episode, and whether restore should clear the runtime tables (almost certainly yes — a restored backup has no live session).

## 3. Constraints that bite here

- **#9** — every connection sets `PRAGMA foreign_keys = ON`; a restore/rebuild path must not quietly drop it.
- **#12** — any schema touch or rebuild follows task 26's discipline and sweeps prior migration suites.
- **Local-only (constraint #7 in the handoff's list)** — no cloud backup, no remote. This is a device-local scheme by design.
- **`active_episode` is a crash signal** — clearing it is meaningful (it's how recovery detects a crash). A restore path must be deliberate about it, not incidental.

## 4. Phase split

**Phase A (headless).** The whole ladder against a SQLite double: integrity-check on a deliberately-corrupted file, salvage, restore-from-backup, the space-check blocking a start, the consistency validator on dangling deps / cycles / orphans. Injectable filesystem so "no space" and "both DBs corrupt" are testable.

**Phase B (device — closes `P`).** On the S23 FE: fill the disk and confirm session start blocks with the storage message; corrupt the working DB (truncate the file) and confirm restore-from-backup; kill mid-session and confirm the backup/restore interacts correctly with crash recovery (this overlaps task 13's territory — coordinate). Real op-sqlite corruption behaves differently from `better-sqlite3`.

## 5. Definition of done

- The backup scheme + the five-step ladder + the consistency validator, implemented.
- Full suite + `tsc --noEmit` + `eslint .` clean; migration suites swept if a schema touch landed.
- Phase B on the S23 FE: no-space block, working-DB corruption restore, and the crash-recovery interaction all confirmed. **No Phase B, no done.**
- Findings report at `docs/eval/task14_findings_report.md`: the (a)–(d) decisions, what real op-sqlite corruption did vs the double, and anything left open.
