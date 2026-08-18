// Task 14 — the backup half of spec §8.4, built on `VACUUM INTO`.
//
// WHY `VACUUM INTO` AND NOT A FILE COPY (brief §2). A byte-copy of a live SQLite database with an
// open WAL can capture a torn state; `VACUUM INTO` writes a transactionally consistent,
// defragmented snapshot from inside the engine. It is also the only option: nothing in this tree
// can write a file from JS (docs/design/capture_format_task41.md §1).
//
// WHY TWO SLOTS AND NOT ONE. `VACUUM INTO` refuses to write a target that already exists, and
// nothing here can rename a file — so a single-slot scheme must DELETE the only backup before
// writing its replacement. On a full disk that destroys the last good copy at exactly the moment
// the ladder exists to protect. Two slots written alternately mean the newer snapshot is never the
// one being overwritten: a failed backup costs the OLDER copy and nothing else. The cost is one
// extra database-sized file, and it is recorded as a tradeoff in the findings report.
//
// HOW THE SLOTS ARE ORDERED WITHOUT ANY FILE METADATA. Nothing here can stat a file for its mtime.
// Instead each snapshot carries its own identity: the `backup_log` row is written and committed
// BEFORE the vacuum, so it is inside the resulting snapshot, naming the slot it was written into
// and when. Recovery reads that row out of each slot and takes the newer one — which works even
// when the working database (the only other place that record lives) is unreadable. This is the
// whole reason migration 001's `backup_log` is used rather than retired; see the findings report.

import type { SqliteConnection } from '../../db/connection';
import { getCurrentSchemaVersion } from '../../db/migrations';
import { isDiskFullError, NoSpaceError } from './errors';
import { checkIntegrity, estimateDatabaseBytes, isEmptyDatabase } from './integrity';
import {
  resolveConfig,
  toSqliteTimestamp,
  type BackupConfig,
  type BackupType,
  type DbFileRef,
  type DbOperations,
} from './types';

/** The `error_message` a snapshot carries for its OWN creation row. That row is committed before
 *  the vacuum runs, so inside the snapshot it can only ever read "in flight" — the authoritative
 *  success/failure for the same backup is the copy of the row in the LIVE database. Documented
 *  here because a reader of a restored database would otherwise mistake it for a failed backup. */
export const IN_FLIGHT_MARKER = 'in flight at snapshot time';

export interface BackupDeps {
  ops: DbOperations;
  config: BackupConfig;
  /** The live connection on the working database. `VACUUM INTO` runs on it, which is what makes the
   *  snapshot consistent with committed state. */
  working: SqliteConnection;
  now: () => number;
  /**
   * Optional space-reclaim hook, tried exactly once before a disk-full backup is reported as a
   * failure. Task 41's design §8.3 hands `capture/` to task 14 as reclaimable space and caps it at
   * 512 MB so capture can never be the CAUSE of the condition that blocks a session. Task 14 does
   * not own `src/capture/`, so this is the contract rather than the implementation; unset, it is a
   * no-op and the ladder behaves exactly as if there were nothing to reclaim.
   */
  reclaimSpace?: () => Promise<number>;
}

export interface BackupResult {
  slot: DbFileRef;
  path: string;
  backupType: BackupType;
  /** An OVER-estimate from `page_count * page_size`; the vacuumed output is normally smaller.
   *  Nothing in this tree can stat the written file. */
  estimatedBytes: number;
  createdAt: string;
  backupLogId: number;
}

async function lastInsertId(db: Pick<SqliteConnection, 'execute'>): Promise<number> {
  const result = await db.execute('SELECT last_insert_rowid() AS id');
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
}

/** The slot to write next: whichever one did NOT receive the most recent successful backup. */
export async function chooseSlot(
  working: Pick<SqliteConnection, 'execute'>,
  slots: readonly [DbFileRef, DbFileRef],
): Promise<DbFileRef> {
  const result = await working.execute(
    'SELECT backup_path FROM backup_log WHERE success = 1 ORDER BY id DESC LIMIT 1',
  );
  const last = result.rows[0]?.backup_path;
  return last === slots[0].name ? slots[1] : slots[0];
}

/** Opens the slot only long enough to learn its absolute path, then removes the file —
 *  `VACUUM INTO` refuses to write a target that already exists. Returns the path. */
function clearSlot(ops: DbOperations, slot: DbFileRef): string {
  const managed = ops.open(slot);
  const path = managed.path();
  managed.delete();
  return path;
}

async function vacuumIntoWithRetry(
  deps: BackupDeps,
  targetPath: string,
  slot: DbFileRef,
): Promise<void> {
  try {
    await deps.working.execute('VACUUM INTO ?', [targetPath]);
    return;
  } catch (err) {
    if (!isDiskFullError(err) || !deps.reclaimSpace) throw err;
    // One reclaim, one retry, then the honest failure. A partial output from the failed attempt may
    // still be occupying the slot, so it has to go before the retry.
    await deps.reclaimSpace();
    clearSlot(deps.ops, slot);
    await deps.working.execute('VACUUM INTO ?', [targetPath]);
  }
}

/**
 * Writes a consistent snapshot of the working database into the older backup slot.
 *
 * Throws `NoSpaceError` when the device is full — the blocking behaviour spec §8.4 requires, and
 * the reciprocal of task 41 §5d's degrade-and-count. Every other failure is rethrown as-is after
 * being recorded in `backup_log`.
 */
export async function createBackup(
  deps: BackupDeps,
  backupType: BackupType = 'automatic',
): Promise<BackupResult> {
  const config = resolveConfig(deps.config);
  const slot = await chooseSlot(deps.working, config.slots);
  const estimatedBytes = await estimateDatabaseBytes(deps.working);
  const createdAt = toSqliteTimestamp(deps.now());

  await deps.working.execute(
    'INSERT INTO backup_log (backup_type, backup_path, backup_size_bytes, created_at, success, error_message) ' +
      'VALUES (?, ?, ?, ?, 0, ?)',
    [backupType, slot.name, estimatedBytes, createdAt, IN_FLIGHT_MARKER],
  );
  const backupLogId = await lastInsertId(deps.working);

  const targetPath = clearSlot(deps.ops, slot);

  try {
    await vacuumIntoWithRetry(deps, targetPath, slot);
  } catch (err) {
    await deps.working.execute('UPDATE backup_log SET success = 0, error_message = ? WHERE id = ?', [
      err instanceof Error ? err.message : String(err),
      backupLogId,
    ]);
    if (isDiskFullError(err)) {
      throw new NoSpaceError('backup', err);
    }
    throw err;
  }

  await deps.working.execute('UPDATE backup_log SET success = 1, error_message = NULL WHERE id = ?', [
    backupLogId,
  ]);

  return { slot, path: targetPath, backupType, estimatedBytes, createdAt, backupLogId };
}

export interface BackupCandidate {
  slot: DbFileRef;
  path: string;
  /** From the snapshot's own `backup_log` row. Empty when the row could not be read — such a
   *  snapshot is still restorable, it just sorts last. */
  createdAt: string;
  schemaVersion: string | null;
  usable: boolean;
  reason?: string;
}

/** Reads the snapshot's own creation row — the one committed just before the vacuum that produced
 *  this file. Returns '' if it is missing or names a different slot, which makes the snapshot sort
 *  last rather than disqualifying it. */
async function readSnapshotStamp(
  db: Pick<SqliteConnection, 'execute'>,
  slotName: string,
): Promise<string> {
  try {
    const result = await db.execute(
      'SELECT backup_path, created_at FROM backup_log ORDER BY id DESC LIMIT 1',
    );
    const row = result.rows[0];
    if (!row || row.backup_path !== slotName) return '';
    return String(row.created_at ?? '');
  } catch {
    return '';
  }
}

/**
 * Inspects both slots and returns them newest-first. Every candidate is integrity-checked here, so
 * "restore from the automatic backup" never restores a corrupt snapshot over a corrupt working
 * database.
 */
export async function listBackupCandidates(
  ops: DbOperations,
  config: BackupConfig,
): Promise<BackupCandidate[]> {
  const resolved = resolveConfig(config);
  const candidates: BackupCandidate[] = [];

  for (const slot of resolved.slots) {
    const db = ops.open(slot);
    const path = db.path();
    try {
      if (await isEmptyDatabase(db)) {
        candidates.push({
          slot,
          path,
          createdAt: '',
          schemaVersion: null,
          usable: false,
          reason: 'absent or empty',
        });
        continue;
      }
      const integrity = await checkIntegrity(db);
      if (!integrity.ok) {
        candidates.push({
          slot,
          path,
          createdAt: '',
          schemaVersion: null,
          usable: false,
          reason: integrity.problems.join('; '),
        });
        continue;
      }
      let schemaVersion: string | null = null;
      try {
        schemaVersion = await getCurrentSchemaVersion(db);
      } catch {
        schemaVersion = null;
      }
      candidates.push({
        slot,
        path,
        createdAt: await readSnapshotStamp(db, slot.name),
        schemaVersion,
        usable: true,
      });
    } finally {
      db.close();
    }
  }

  return candidates.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
