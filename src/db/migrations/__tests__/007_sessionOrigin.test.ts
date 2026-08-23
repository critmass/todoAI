import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';
import { MIGRATION_004_SQL } from '../004_algorithm_weights_reconciliation';
import { MIGRATION_005_SQL } from '../005_session_runtime';
import { MIGRATION_006_SQL } from '../006_recurrence_period';

function columns(raw: import('better-sqlite3').Database, table: string): string[] {
  return (raw.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name).sort();
}

/** A device already on schema 2.7.0 (001-006 applied) with data, before migrating - the realistic
 *  upgrade path, not a fresh install where all seven apply back to back. */
async function createLegacyV270Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) await tx.execute(statement);
  });
  await conn.execute('PRAGMA foreign_keys = OFF');
  try {
    for (const sql of [
      MIGRATION_002_SQL,
      MIGRATION_003_SQL,
      MIGRATION_004_SQL,
      MIGRATION_005_SQL,
      MIGRATION_006_SQL,
    ]) {
      await conn.transaction(async (tx) => {
        for (const statement of splitSqlStatements(sql)) await tx.execute(statement);
      });
    }
  } finally {
    await conn.execute('PRAGMA foreign_keys = ON');
  }
  return conn;
}

function seedSession(conn: TestSqliteConnection, id: string, origin?: string): void {
  if (origin === undefined) {
    conn.raw
      .prepare("INSERT INTO sessions (id, session_type, planned_duration, status) VALUES (?, 'quick', 10, 'completed')")
      .run(id);
    return;
  }
  conn.raw
    .prepare(
      "INSERT INTO sessions (id, session_type, planned_duration, status, origin) VALUES (?, 'quick', 10, 'completed', ?)",
    )
    .run(id, origin);
}

describe('migration 007 - sessions.origin (v2.7 -> v2.8)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
    });
    afterEach(() => conn.close());

    it('lands at 2.9.0 (008 rides along) and records the migration name', () => {
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('version')).toEqual({
        value: '2.9.0',
      });
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('last_migration')).toEqual({
        value: 'v2_9_transitive_cycle_guard',
      });
    });

    it('adds sessions.origin and keeps every pre-existing column', () => {
      expect(columns(conn.raw, 'sessions')).toEqual(
        expect.arrayContaining([
          'id',
          'session_type',
          'planned_duration',
          'status',
          'tasks_progressed',
          'origin',
        ]),
      );
    });

    it('defaults origin to NULL — the pre-migration distinction did not exist, not "planned"', () => {
      seedSession(conn, 's1');
      const row = conn.raw.prepare("SELECT origin FROM sessions WHERE id = 's1'").get() as { origin: unknown };
      expect(row.origin).toBeNull();
    });

    it("accepts 'planned' and 'quickstart', rejects anything else", () => {
      expect(() => seedSession(conn, 's2', 'planned')).not.toThrow();
      expect(() => seedSession(conn, 's3', 'quickstart')).not.toThrow();
      expect(() => seedSession(conn, 's4', 'bogus')).toThrow(/CHECK constraint failed/);
    });
  });

  describe('upgrading a populated v2.7.0 database', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV270Connection();
    });
    afterEach(() => conn.close());

    it('adds origin as NULL to existing rows without disturbing them', async () => {
      seedSession(conn, 'old');
      await runMigrations(conn);
      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      const row = conn.raw.prepare("SELECT * FROM sessions WHERE id = 'old'").get() as any;
      expect(row.origin).toBeNull();
      expect(row.planned_duration).toBe(10);
    });

    it('is idempotent: running twice does not reapply 007 or throw', async () => {
      await runMigrations(conn);
      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      expect(columns(conn.raw, 'sessions')).toContain('origin');
    });

    it('keeps foreign_key_check empty and enforcement restored (no rebuild dance needed here)', async () => {
      await runMigrations(conn);
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });
});
