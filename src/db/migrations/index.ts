// Minimal forward-only migration runner. Reads the current version from schema_metadata (key
// 'version') and applies every migration in MIGRATIONS whose version is newer than what's
// currently recorded, in order - so a fresh (empty) DB walks the whole list and an
// already-migrated DB only picks up what's new. No down-migrations. To add 003_*.sql: create
// 003_whatever.ts the same way as 001's/002's (see those files' headers) and append it to
// MIGRATIONS below with its target version.
import type { SqliteConnection } from '../connection';
import { MIGRATION_001_SQL } from './001_initial_schema';
import { MIGRATION_002_SQL } from './002_skill_layer_schema';
import { MIGRATION_003_SQL } from './003_multisession_work';
import { MIGRATION_004_SQL } from './004_algorithm_weights_reconciliation';
import { splitSqlStatements } from './statementSplitter';

interface Migration {
  version: string;
  sql: string;
  /** Set when the migration rebuilds a table to change a CHECK constraint or column DEFAULT
   *  (SQLite has no ALTER TABLE ... ALTER COLUMN for either). PRAGMA foreign_keys is a no-op
   *  when toggled from inside an open transaction (verified against this repo's SQLite build),
   *  so a rebuild needs enforcement disabled *before* the transaction opens and restored *after*
   *  it commits - applyMigration does that dance only when this flag is set. */
  rebuildsTables?: boolean;
}

const MIGRATIONS: Migration[] = [
  { version: '2.2.0', sql: MIGRATION_001_SQL },
  { version: '2.3.0', sql: MIGRATION_002_SQL, rebuildsTables: true },
  { version: '2.4.0', sql: MIGRATION_003_SQL, rebuildsTables: true },
  { version: '2.5.0', sql: MIGRATION_004_SQL, rebuildsTables: true },
];

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

/** Dot-separated numeric version compare (e.g. '2.3.0' > '2.2.0'); missing trailing parts
 *  compare as 0, so '2.3' > '2.2.9' is false but '2.3.0' > '2.2.9' is true. */
function isNewerVersion(candidate: string, current: string): boolean {
  const c = candidate.split('.').map(Number);
  const cur = current.split('.').map(Number);
  const length = Math.max(c.length, cur.length);
  for (let i = 0; i < length; i++) {
    const a = c[i] ?? 0;
    const b = cur[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function runStatements(
  tx: Pick<SqliteConnection, 'execute'>,
  statements: string[],
  migrationVersion: string,
): Promise<void> {
  for (const statement of statements) {
    const result = await tx.execute(statement);
    if (/^PRAGMA\s+foreign_key_check/i.test(statement) && result.rows.length > 0) {
      throw new Error(
        `Migration ${migrationVersion}: foreign_key_check found ${result.rows.length} ` +
          `violation(s): ${JSON.stringify(result.rows)}`,
      );
    }
  }
}

async function applyMigration(db: SqliteConnection, migration: Migration): Promise<void> {
  const statements = splitSqlStatements(migration.sql);

  if (!migration.rebuildsTables) {
    await db.transaction((tx) => runStatements(tx, statements, migration.version));
    return;
  }

  // A CHECK/DEFAULT rebuild needs foreign_keys OFF for the DROP+RENAME dance, and that pragma
  // only takes effect with no transaction open - so it's set here, outside db.transaction(),
  // and restored after, regardless of success or failure.
  await db.execute('PRAGMA foreign_keys = OFF');
  try {
    await db.transaction((tx) => runStatements(tx, statements, migration.version));
  } finally {
    await db.execute('PRAGMA foreign_keys = ON');
  }
}

/** Applies every migration newer than the DB's current recorded version, in order. On a fresh
 *  (empty) DB this walks the full list starting from 001_initial_schema.sql, which seeds
 *  schema_metadata.version itself. */
export async function runMigrations(db: SqliteConnection): Promise<void> {
  let currentVersion = await getCurrentSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (currentVersion !== null && !isNewerVersion(migration.version, currentVersion)) {
      continue;
    }
    await applyMigration(db, migration);
    currentVersion = migration.version;
  }
}
