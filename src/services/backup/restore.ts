// Task 14 — steps 3, 4 and 5 of spec §8.4's ladder: restore from the automatic backup, offer a
// fresh start with import, and (last resort, consent required) a full reset.
//
// EVERY PATH HERE REPLACES THE WORKING DATABASE FILE, so every path here must run BEFORE the app's
// shared connection is opened and its repositories are built. `src/db/connection.ts` caches the
// connection in a module singleton; a restore performed after that leaves every repository holding
// a handle to a deleted inode. The ladder reports `workingDbReplaced` so a caller that got there
// anyway can call `setConnection(null)` — but the supported ordering is recovery first, wiring
// second. See the findings report's wiring recipe.
//
// WHY THERE IS NO RENAME. Nothing in this tree can move a file (docs/design/capture_format_task41.md
// §1), so "make this database the working database" is expressed the only way it can be: delete the
// working path, then `VACUUM INTO` it from the database being promoted. That is also the safer
// primitive — the promoted copy is written by the engine and is transactionally consistent, which a
// rename of a file with a live WAL would not be.

import { getCurrentSchemaVersion, runMigrations } from '../../db/migrations';
import type { SqliteConnection } from '../../db/connection';
import { listBackupCandidates, type BackupCandidate } from './backup';
import { validateConsistency, type ConsistencyReport } from './consistency';
import { ConsentRequiredError, isDiskFullError, NoSpaceError, NoUsableBackupError } from './errors';
import { RUNTIME_TABLES } from './salvage';
import {
  resolveConfig,
  toSqliteTimestamp,
  type BackupConfig,
  type DbFileRef,
  type DbOperations,
  type ManagedDb,
} from './types';

export interface RestoreDeps {
  ops: DbOperations;
  config: BackupConfig;
  now: () => number;
  /** Optional space-reclaim hook — see `BackupDeps.reclaimSpace`. */
  reclaimSpace?: () => Promise<number>;
}

export interface RestoreResult {
  from: BackupCandidate;
  /** The restored working database's schema version AFTER migrations were re-run against it. */
  schemaVersion: string | null;
  /** True when the snapshot was behind and `runMigrations` moved it forward (brief §4b). */
  migrated: boolean;
  runtimeRowsCleared: number;
  consistency: ConsistencyReport;
}

/**
 * Makes `source` the working database: deletes the working file and vacuums a consistent copy of
 * `source` into its path.
 *
 * ⚠ There is a window with no working database, between the delete and the vacuum. It is accepted
 * rather than mitigated because every caller reaches this function only when the working database
 * is already unusable — there is nothing at the working path worth protecting. The BACKUPS are what
 * the window would endanger, and they are untouched here.
 */
export async function promoteToWorking(
  ops: DbOperations,
  source: Pick<SqliteConnection, 'execute'>,
  working: DbFileRef,
): Promise<string> {
  const handle = ops.open(working);
  const workingPath = handle.path();
  handle.delete();
  try {
    await source.execute('VACUUM INTO ?', [workingPath]);
  } catch (err) {
    if (isDiskFullError(err)) throw new NoSpaceError('restore', err);
    throw err;
  }
  return workingPath;
}

/**
 * Empties migration 005's three runtime tables.
 *
 * DELIBERATE, NOT INCIDENTAL (brief §4c). `active_episode`'s mere existence IS the crash signal
 * (migration 005), so clearing it tells the recovery path "no crash happened". That is the truthful
 * statement for a RESTORE: the snapshot's live-session state belongs to a session that ended
 * whenever the snapshot was taken, and crediting its elapsed time now would credit hours that were
 * never worked. It is NOT the truthful statement for a salvage, which recovers the instant the app
 * actually died — so `salvageDatabase` keeps these tables by default. Two different answers,
 * arrived at on purpose.
 *
 * `sessions` rows are left exactly as they are: a running session is born `'abandoned'`
 * (constraint #14) and that is already the truthful value to find after a restore.
 */
export async function clearRuntimeTables(db: Pick<SqliteConnection, 'execute'>): Promise<number> {
  let cleared = 0;
  for (const table of RUNTIME_TABLES) {
    try {
      const result = await db.execute(`DELETE FROM "${table}"`);
      cleared += result.rowsAffected ?? 0;
    } catch {
      // A restored snapshot from before migration 005 has no such table. runMigrations has already
      // created it in that case, so this only fires on a table that genuinely cannot be written.
    }
  }
  return cleared;
}

/** Restores the newest backup slot that passes `PRAGMA integrity_check`. */
export async function restoreFromBackup(
  deps: RestoreDeps,
  explicitSlot?: DbFileRef,
): Promise<RestoreResult> {
  const config = resolveConfig(deps.config);
  const candidates = await listBackupCandidates(deps.ops, deps.config);
  const chosen = explicitSlot
    ? candidates.find((entry) => entry.slot.name === explicitSlot.name && entry.usable)
    : candidates.find((entry) => entry.usable);

  if (!chosen) {
    throw new NoUsableBackupError(
      candidates.map((entry) => `${entry.slot.name}: ${entry.reason ?? 'unusable'}`),
    );
  }

  const backup = deps.ops.open(chosen.slot);
  try {
    await promoteToWorking(deps.ops, backup, config.working);
  } finally {
    backup.close();
  }

  const working = deps.ops.open(config.working);
  try {
    // A restored database carries its OWN schema version (brief §4b). Do not assume it is current.
    const before = await getCurrentSchemaVersion(working);
    await runMigrations(working);
    const after = await getCurrentSchemaVersion(working);
    const runtimeRowsCleared = await clearRuntimeTables(working);
    const consistency = await validateConsistency(working);
    await markRestored(working, chosen.slot.name, deps.now());
    return {
      from: chosen,
      schemaVersion: after,
      migrated: before !== after,
      runtimeRowsCleared,
      consistency,
    };
  } finally {
    working.close();
  }
}

/** Stamps `restored_at` on the snapshot's own creation row — the one that travelled inside the
 *  file. This is the only write `backup_log` has ever had a reader for, and it is what makes a
 *  restored database say, truthfully, where it came from. */
async function markRestored(
  db: Pick<SqliteConnection, 'execute'>,
  slotName: string,
  nowMs: number,
): Promise<void> {
  try {
    await db.execute(
      'UPDATE backup_log SET restored_at = ? WHERE id = (SELECT MAX(id) FROM backup_log WHERE backup_path = ?)',
      [toSqliteTimestamp(nowMs), slotName],
    );
  } catch {
    // A snapshot old enough to predate the table is still worth restoring.
  }
}

export interface FreshStartResult {
  schemaVersion: string | null;
  imported: boolean;
}

/**
 * Step 4 — a brand-new, fully migrated working database, optionally seeded from an import.
 *
 * The import payload's FORMAT IS NOT DEFINED HERE. Spec §8.5's data export/import is task 42's, and
 * nothing in this tree reads or writes one yet; `importer` is the typed seam it will occupy. Called
 * without one this is simply a clean install that keeps the app usable.
 *
 * DESTRUCTIVE, and deliberately not reached automatically — `runRecoveryLadder` stops and reports
 * `unrecoverable` rather than calling this, because spec §8.4 words step 4 as an OFFER.
 */
export async function freshStart(
  deps: RestoreDeps,
  importer?: (db: ManagedDb) => Promise<void>,
): Promise<FreshStartResult> {
  const config = resolveConfig(deps.config);
  deps.ops.open(config.working).delete();
  const working = deps.ops.open(config.working);
  try {
    await runMigrations(working);
    if (importer) await importer(working);
    return { schemaVersion: await getCurrentSchemaVersion(working), imported: Boolean(importer) };
  } finally {
    working.close();
  }
}

/**
 * Step 5 — total loss. Clears the working database, BOTH backup slots and any salvage scratch, then
 * reinitialises.
 *
 * `consent` is not a boolean flag for tidiness: spec §8.4 makes explicit consent the precondition
 * for this step, so the type system refuses to let a caller reach it by accident.
 */
export async function fullReset(
  deps: RestoreDeps,
  options: { consent: boolean },
): Promise<FreshStartResult> {
  if (options.consent !== true) throw new ConsentRequiredError('fullReset');
  const config = resolveConfig(deps.config);
  for (const ref of [config.slots[0], config.slots[1], config.salvage]) {
    deps.ops.open(ref).delete();
  }
  if (deps.reclaimSpace) await deps.reclaimSpace();
  return freshStart(deps);
}
