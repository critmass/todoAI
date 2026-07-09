// Test-only SqliteConnection backed by better-sqlite3 (a real SQLite engine), so repository and
// migration tests exercise actual SQL - CHECK constraints, triggers, json_valid, FK cascades -
// under Jest without touching the real @op-engineering/op-sqlite RN native module (which throws
// at import time outside a real RN runtime). NOT imported by any production/app code.
// Deliberately not under a __tests__ directory: Jest's default testMatch treats every file in
// __tests__ as a test suite, and this file exports a helper, not tests.
import Database from 'better-sqlite3';
import type { QueryResult, Scalar } from '@op-engineering/op-sqlite';
import type { SqliteConnection } from '../connection';

function runStatement(db: Database.Database, query: string, params: Scalar[]): QueryResult {
  const stmt = db.prepare(query);
  if (stmt.reader) {
    const rows = stmt.all(...params) as Array<Record<string, Scalar>>;
    return { rows, rowsAffected: 0 };
  }
  const info = stmt.run(...params);
  return { rows: [], rowsAffected: info.changes, insertId: Number(info.lastInsertRowid) };
}

export interface TestSqliteConnection extends SqliteConnection {
  /** Direct access to the underlying better-sqlite3 handle, for test setup/assertions. */
  raw: Database.Database;
}

export function createTestConnection(): TestSqliteConnection {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const connection: SqliteConnection = {
    execute: async (query, params) => runStatement(db, query, params ?? []),
    transaction: async (fn) => {
      db.exec('BEGIN');
      try {
        await fn({
          execute: async (query, params) =>
            runStatement(db, query, params ?? []),
          commit: async () => {
            db.exec('COMMIT');
            return { rows: [], rowsAffected: 0 };
          },
          rollback: () => {
            db.exec('ROLLBACK');
            return { rows: [], rowsAffected: 0 };
          },
        });
        if (db.inTransaction) {
          db.exec('COMMIT');
        }
      } catch (err) {
        if (db.inTransaction) {
          db.exec('ROLLBACK');
        }
        throw err;
      }
    },
    close: () => db.close(),
  };

  return Object.assign(connection, { raw: db });
}
