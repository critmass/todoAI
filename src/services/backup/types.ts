// Task 14 — the injected DB-operations seam, and the vocabulary the whole ladder speaks.
//
// WHY A SEAM WIDER THAN `SqliteConnection`. `src/db/connection.ts` exports the subset of
// op-sqlite's DB that repositories need (`execute` / `transaction` / `close`). Backup, salvage and
// restore need three things beyond that — the absolute path of a database FILE, the ability to
// DELETE that file, and the ability to open a database other than the shared one. op-sqlite has all
// three (`getDbPath`, `delete`, `open`); nothing else in this tree does. The brief (§6) says to
// inject "the DB-operations layer (not 'the filesystem')" precisely so that "no space" and "both
// DBs corrupt" are reachable in a headless test — this file is that layer's type.
//
// WHAT IS DELIBERATELY ABSENT: any general file API. There is none in this tree
// (docs/design/capture_format_task41.md §1), and a byte-copy of a live SQLite database with an open
// WAL can capture a torn state anyway (brief §2b). Every operation below is expressible in SQL or
// in op-sqlite's own DB API, and no new native module is required.

import type { SqliteConnection } from '../../db/connection';

/** Identifies a database FILE the way op-sqlite's `open()` does: a name within a location. */
export interface DbFileRef {
  name: string;
  /** Absolute directory. Omitted means op-sqlite's default database directory. */
  location?: string;
}

/** A database file opened for management, not just for querying. */
export interface ManagedDb extends SqliteConnection {
  /** op-sqlite `DB.delete()` — closes and removes the underlying file. */
  delete(): void;
  /** op-sqlite `DB.getDbPath()` — the absolute path, which is what `VACUUM INTO` and `ATTACH` take. */
  path(): string;
}

/** The whole of what task 14 needs from the database layer. One method, by design. */
export interface DbOperations {
  /** Opens (creating an empty file if absent, exactly as op-sqlite does) the named database. */
  open(ref: DbFileRef): ManagedDb;
}

/** The two rotating backup slots. See `backup.ts` for why there are two and not one. */
export const DEFAULT_SLOT_NAMES: readonly [string, string] = ['todoai.backup.a.db', 'todoai.backup.b.db'];

/** The scratch database salvage builds into before it is promoted over the working path. */
export const DEFAULT_SALVAGE_NAME = 'todoai.salvage.db';

export interface BackupConfig {
  /** The live database the app works on. Its path never moves — see the report's decision (a). */
  working: DbFileRef;
  /** Where the two backup slots live. Constraint #10: app-private storage only. */
  backupLocation?: string;
  slotNames?: readonly [string, string];
  /** Where the salvage scratch database is built. Defaults to the working DB's location. */
  salvageLocation?: string;
  salvageName?: string;
}

export type BackupType = 'automatic' | 'manual' | 'pre_session';

export interface ResolvedConfig {
  working: DbFileRef;
  slots: readonly [DbFileRef, DbFileRef];
  salvage: DbFileRef;
}

export function resolveConfig(config: BackupConfig): ResolvedConfig {
  const names = config.slotNames ?? DEFAULT_SLOT_NAMES;
  const location = config.backupLocation ?? config.working.location;
  return {
    working: config.working,
    slots: [
      { name: names[0], location },
      { name: names[1], location },
    ],
    salvage: {
      name: config.salvageName ?? DEFAULT_SALVAGE_NAME,
      location: config.salvageLocation ?? config.working.location,
    },
  };
}

/** Formats an epoch-ms instant the way this schema's DATETIME columns read, with milliseconds
 *  added so two backups in the same second still sort. Sorts correctly against SQLite's own
 *  CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS'), which shares the prefix. */
export function toSqliteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');
}
