// Opens the shared SQLite connection. Android-only for now (see README_build.md).
//
// Repositories are constructed with an injected SqliteConnection (see repositories/*.ts and
// db/index.ts) rather than reaching for a module singleton directly - that keeps them testable
// against a non-native double (see migrations/__tests__ and repositories/__tests__) without ever
// importing the real @op-engineering/op-sqlite RN entrypoint, which throws immediately if
// NativeModules.OPSQLite isn't present (e.g. under Jest, outside a real RN runtime).
import { Platform } from 'react-native';
import { ANDROID_DATABASE_PATH, open, type DB } from '@op-engineering/op-sqlite';

/** The subset of op-sqlite's DB that repositories and the migration runner depend on. */
export type SqliteConnection = Pick<DB, 'execute' | 'transaction' | 'close'>;

const DB_NAME = 'todoai.db';

let sharedConnection: SqliteConnection | null = null;

function applyForeignKeys(db: DB): void {
  // SQLite defaults foreign_keys OFF per-connection; the schema relies on FK cascades
  // (ON DELETE CASCADE / SET NULL throughout). Must be set on every connection open.
  db.executeSync('PRAGMA foreign_keys = ON;');
}

/** Opens a brand-new connection to the app-private database. Most callers want
 *  getConnection() (the shared singleton) instead. */
export function openConnection(): SqliteConnection {
  if (Platform.OS !== 'android') {
    throw new Error(
      `openConnection: only Android is supported today (got "${Platform.OS}") - see README_build.md`,
    );
  }
  const db = open({ name: DB_NAME, location: ANDROID_DATABASE_PATH });
  applyForeignKeys(db);
  return db;
}

/** The app's single shared connection, opened lazily on first use. */
export function getConnection(): SqliteConnection {
  if (!sharedConnection) {
    sharedConnection = openConnection();
  }
  return sharedConnection;
}

/** Test/advanced-use seam: inject an alternate connection (e.g. a test double), or clear it
 *  by passing null so the next getConnection() call reopens. */
export function setConnection(connection: SqliteConnection | null): void {
  sharedConnection = connection;
}
