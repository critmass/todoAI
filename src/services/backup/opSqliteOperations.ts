// Task 14 — the real `DbOperations`, over op-sqlite.
//
// DELIBERATELY NOT EXPORTED FROM `./index.ts`. Importing `@op-engineering/op-sqlite` outside a real
// RN runtime throws at import time (see `src/db/connection.ts`'s header and `jest.setup.js`), so the
// barrel stays free of it and every headless test drives the ladder through an injected double.
// This file is the one place in `src/services/backup/` that touches the native module.
//
// CONSTRAINT #9: every connection this returns sets `PRAGMA foreign_keys = ON`, exactly as
// `connection.ts` does. A restore or a rebuild must not quietly drop it, and the connections the
// recovery ladder opens are connections like any other.

import {
  ANDROID_DATABASE_PATH,
  ANDROID_EXTERNAL_FILES_PATH,
  open,
  type DB,
} from '@op-engineering/op-sqlite';
import type { BackupConfig, DbFileRef, DbOperations, ManagedDb } from './types';

/** The live database, matching `src/db/connection.ts`'s `DB_NAME` and location. */
export const WORKING_DB_NAME = 'todoai.db';

export function createOpSqliteOperations(): DbOperations {
  return {
    open(ref: DbFileRef): ManagedDb {
      const db: DB = open({ name: ref.name, location: ref.location ?? ANDROID_DATABASE_PATH });
      db.executeSync('PRAGMA foreign_keys = ON;');
      return {
        execute: db.execute.bind(db),
        transaction: db.transaction.bind(db),
        close: db.close.bind(db),
        delete: db.delete.bind(db),
        path: () => db.getDbPath(ref.location ?? ANDROID_DATABASE_PATH),
      };
    },
  };
}

/**
 * The shipped layout.
 *
 * The working database stays where `connection.ts` already puts it. The backup slots go to the
 * app-private EXTERNAL files directory (`/sdcard/Android/data/<pkg>/files/`, constraint #10) for two
 * reasons: it is a different volume from the internal databases directory, so a filesystem problem
 * that takes the working database is less likely to take both copies with it; and it is reachable
 * over adb, which is what makes a backup something Jason can actually pull off a device during
 * beta. It is still app-private — nothing here is on shared storage and nothing transmits.
 *
 * ⚠ PHASE B MUST CONFIRM the external path is writable by op-sqlite's `open()` on the S23 FE. The
 * constant exists in op-sqlite's TurboModule spec, but this tree has never opened a database there.
 */
export function defaultBackupConfig(): BackupConfig {
  return {
    working: { name: WORKING_DB_NAME, location: ANDROID_DATABASE_PATH },
    backupLocation: ANDROID_EXTERNAL_FILES_PATH,
    salvageLocation: ANDROID_DATABASE_PATH,
  };
}
