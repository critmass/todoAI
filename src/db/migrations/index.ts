// Minimal forward-only migration runner. Reads the current version from schema_metadata (key
// 'version'); if the DB is empty, applies 001_initial_schema.sql in one transaction. No
// down-migrations. To add 002_*.sql: create 002_initial_schema.ts the same way as 001's (see
// that file's header), add it to MIGRATIONS below with its target version, and runMigrations
// will apply any migrations whose version is newer than what's currently recorded.
import type { SqliteConnection } from '../connection';
import { MIGRATION_001_SQL } from './001_initial_schema';
import { splitSqlStatements } from './statementSplitter';

interface Migration {
  version: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [{ version: '2.2.0', sql: MIGRATION_001_SQL }];

export async function getCurrentSchemaVersion(db: SqliteConnection): Promise<string | null> {
  const tableCheck = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'",
  );
  if (tableCheck.rows.length === 0) {
    return null;
  }
  const versionResult = await db.execute("SELECT value FROM schema_metadata WHERE key = 'version'");
  const row = versionResult.rows[0] as { value: string } | undefined;
  return row?.value ?? null;
}

async function applyMigration(db: SqliteConnection, migration: Migration): Promise<void> {
  const statements = splitSqlStatements(migration.sql);
  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(statement);
    }
  });
}

/** Applies any migrations newer than the DB's current recorded version. On a fresh (empty) DB
 *  this applies 001_initial_schema.sql, which seeds schema_metadata.version itself. */
export async function runMigrations(db: SqliteConnection): Promise<void> {
  const currentVersion = await getCurrentSchemaVersion(db);
  if (currentVersion === null) {
    await applyMigration(db, MIGRATIONS[0]);
    return;
  }
  // Only one migration exists today, and it seeds the version this function just read as
  // non-null, so there is nothing pending. Future entries in MIGRATIONS get applied here,
  // in order, skipping any whose version is not newer than currentVersion.
}
