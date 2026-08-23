// Test-only SqliteConnection backed by better-sqlite3 (a real SQLite engine), so repository and
// migration tests exercise actual SQL - CHECK constraints, triggers, json_valid, FK cascades -
// under Jest without touching the real @op-engineering/op-sqlite RN native module (which throws
// at import time outside a real RN runtime). NOT imported by any production/app code.
// Deliberately not under a __tests__ directory: Jest's default testMatch treats every file in
// __tests__ as a test suite, and this file exports a helper, not tests.
import Database from 'better-sqlite3';
import type { QueryResult, Scalar } from '@op-engineering/op-sqlite';
import type { SqliteConnection } from '../connection';

/** True only for an `Error` belonging to THIS realm: `[object Error]` proves the `[[ErrorData]]`
 *  internal slot (so it is a genuine Error, not a look-alike), and `instanceof` proves it is ours. */
function isOwnRealmError(value: unknown): value is Error {
  return value instanceof Error && Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * Turns whatever better-sqlite3 threw into a REAL `Error` of the current realm, preserving
 * `message`, `name`, `code` and the driver's stack. Errors that are already ours pass through
 * untouched, by identity, so typed `catch`/`instanceof` checks keep working.
 *
 * Task 59, and it is not defensive padding — it fixes a live, reproduced test failure. better-sqlite3's
 * `SqliteError` (lib/sqlite-error.js) is a hand-rolled pseudo-Error: a plain `function` whose prototype
 * is grafted onto `Error.prototype` with `Object.setPrototypeOf`, so its instances have **no
 * `[[ErrorData]]` slot** (`Object.prototype.toString` reports `[object Object]`). `lib/database.js`
 * hands that constructor to the native addon via `addon.setErrorConstructor(SqliteError)`, and Node
 * caches native addons **per process, not per Jest realm** — so every error the driver throws in a
 * worker is built from the constructor of whichever test file loaded better-sqlite3 FIRST, and its
 * prototype chain ends at that file's `Error.prototype`. In any other file `err instanceof Error` is
 * false; Jest's `isError()` switches on `[object Object]`, falls through to that cross-realm
 * `instanceof`, and `.rejects.toThrow()` reports "Received function did not throw" for a statement
 * that genuinely threw. That made
 * `src/services/backup/__tests__/consistency.test.ts`'s migration-008 cycle assertion fail 6/6
 * whenever its suite ran anywhere but first in its process (diagnosis:
 * docs/eval/housekeeping_2026-08-22_report.md Part B). Normalising here closes it for every suite
 * that goes through the test connection rather than one assertion at a time.
 */
export function normaliseDriverError(err: unknown): unknown {
  if (isOwnRealmError(err)) return err;
  const source = err as Partial<Error> & { code?: unknown };
  const normalised: Error & { code?: unknown } = new Error(
    typeof source?.message === 'string' ? source.message : String(err),
  );
  if (typeof source?.name === 'string') normalised.name = source.name;
  if (typeof source?.stack === 'string') normalised.stack = source.stack;
  if (source?.code !== undefined) normalised.code = source.code;
  return normalised;
}

/** Every call into better-sqlite3 goes through here, so no raw driver error escapes the boundary. */
function callDriver<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw normaliseDriverError(err);
  }
}

function runStatement(db: Database.Database, query: string, params: Scalar[]): QueryResult {
  return callDriver(() => {
    const stmt = db.prepare(query);
    if (stmt.reader) {
      const rows = stmt.all(...params) as Array<Record<string, Scalar>>;
      return { rows, rowsAffected: 0 };
    }
    const info = stmt.run(...params);
    return { rows: [], rowsAffected: info.changes, insertId: Number(info.lastInsertRowid) };
  });
}

export interface TestSqliteConnection extends SqliteConnection {
  /** Direct access to the underlying better-sqlite3 handle, for test setup/assertions. */
  raw: Database.Database;
}

export function createTestConnection(): TestSqliteConnection {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return Object.assign(wrapDatabase(db), { raw: db });
}

/** The SqliteConnection adapter over an already-open better-sqlite3 handle. Split out of
 *  `createTestConnection` so task 14's file-backed double (fileDbOperations.ts) can reuse exactly
 *  the same driver semantics against a real file instead of ':memory:'. */
export function wrapDatabase(db: Database.Database): SqliteConnection {
  const connection: SqliteConnection = {
    execute: async (query, params) => runStatement(db, query, params ?? []),
    transaction: async (fn) => {
      callDriver(() => db.exec('BEGIN'));
      try {
        await fn({
          execute: async (query, params) =>
            runStatement(db, query, params ?? []),
          commit: async () => {
            callDriver(() => db.exec('COMMIT'));
            return { rows: [], rowsAffected: 0 };
          },
          rollback: () => {
            callDriver(() => db.exec('ROLLBACK'));
            return { rows: [], rowsAffected: 0 };
          },
        });
        if (db.inTransaction) {
          callDriver(() => db.exec('COMMIT'));
        }
      } catch (err) {
        if (db.inTransaction) {
          callDriver(() => db.exec('ROLLBACK'));
        }
        // Deliberately rethrown as-is: this may be the caller's OWN typed error from `fn`, and
        // normalisation belongs at the driver boundary (callDriver), not here.
        throw err;
      }
    },
    close: () => {
      callDriver(() => db.close());
    },
  };

  return connection;
}
