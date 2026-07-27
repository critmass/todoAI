import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';

function names(raw: import('better-sqlite3').Database, type: 'view' | 'index'): string[] {
  return raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type)
    .map((r: any) => r.name);
}

/** A device already on schema 2.3.0 (001 + 002 applied, 003 not yet) with data, before migrating -
 *  the realistic upgrade path, not a fresh install where all three apply back to back. */
async function createLegacyV230Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) await tx.execute(statement);
  });
  // 002 rebuilds tables, so it needs the foreign_keys-off dance runMigrations does — but running
  // 001+002 via the real runner up to 2.3.0 is simplest and exactly what a 2.3.0 device is.
  await conn.execute('PRAGMA foreign_keys = OFF');
  try {
    await conn.transaction(async (tx) => {
      for (const statement of splitSqlStatements(MIGRATION_002_SQL)) await tx.execute(statement);
    });
  } finally {
    await conn.execute('PRAGMA foreign_keys = ON');
  }
  return conn;
}

describe('migration 003 - multi-session work (v2.3 -> v2.4)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
    });
    afterEach(() => conn.close());

    it('creates the new task columns with their defaults', () => {
      conn.raw.prepare('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)').run('T', 30);
      const row = conn.raw.prepare('SELECT * FROM tasks WHERE id = 1').get() as any;
      expect(row.duration_type).toBe('estimate');
      expect(row.work_state).toBe('none');
      expect(row.accumulated_minutes).toBe(0);
      expect(row.last_worked_at).toBeNull();
    });

    it('adds sessions.tasks_progressed defaulting to 0', () => {
      conn.raw
        .prepare("INSERT INTO sessions (id, session_type, planned_duration, status) VALUES ('s1','quick',10,'completed')")
        .run();
      const row = conn.raw.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as any;
      expect(row.tasks_progressed).toBe(0);
    });

    it('accepts the new interactions enum values and rejects bogus ones', () => {
      expect(() =>
        conn.raw
          .prepare("INSERT INTO interactions (interaction_type, completion_status) VALUES ('task_progress','progress')")
          .run(),
      ).not.toThrow();
      expect(() =>
        conn.raw.prepare("INSERT INTO interactions (interaction_type) VALUES ('not_a_type')").run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        conn.raw
          .prepare("INSERT INTO interactions (interaction_type, completion_status) VALUES ('task_completion','bogus')")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects bogus duration_type / work_state values (CHECK constraints applied)', () => {
      expect(() =>
        conn.raw
          .prepare("INSERT INTO tasks (title, estimated_duration, duration_type) VALUES ('T',30,'nonsense')")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        conn.raw
          .prepare("INSERT INTO tasks (title, estimated_duration, work_state) VALUES ('T',30,'busy')")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        conn.raw
          .prepare("INSERT INTO tasks (title, estimated_duration, accumulated_minutes) VALUES ('T',30,-5)")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('recreates all three interactions indexes after the rebuild', () => {
      const indexes = names(conn.raw, 'index');
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_interactions_timestamp',
          'idx_interactions_type',
          'idx_interactions_session',
        ]),
      );
    });

    it('leaves the schema views intact (none depends on interactions)', () => {
      // runMigrations walks past 003 to the latest version; active_tasks_with_neglect is dropped
      // by 004 (v2.5, unrelated to interactions), so it is correctly absent here even though this
      // test targets 003's changes.
      expect(names(conn.raw, 'view')).toEqual(
        expect.arrayContaining([
          'tasks_due_soon',
          'recent_session_performance',
          'coaching_priority_queue',
          'fireable_skills',
        ]),
      );
    });

    it('has an empty foreign_key_check after migrating', () => {
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });

  describe('populated 2.3.0 upgrade', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV230Connection();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.3.0');
    });
    afterEach(() => conn.close());

    it('preserves existing interaction rows and their ids across the rebuild', async () => {
      conn.raw
        .prepare("INSERT INTO interactions (id, interaction_type) VALUES (1,'task_completion'),(2,'task_skip')")
        .run();
      // Delete row 2 so sqlite_sequence's high-water mark (2) exceeds MAX(id) (1) — the exact
      // condition 002 found silently resets a rowid on rebuild.
      conn.raw.prepare('DELETE FROM interactions WHERE id = 2').run();

      await runMigrations(conn);
      // runMigrations walks past 003 to the latest version (004 and 005 ride along).
      expect(await getCurrentSchemaVersion(conn)).toBe('2.6.0');

      const rows = conn.raw.prepare('SELECT id, interaction_type FROM interactions ORDER BY id').all();
      expect(rows).toEqual([{ id: 1, interaction_type: 'task_completion' }]);

      // sqlite_sequence high-water mark survived the rebuild → the next insert gets id 3, not 2.
      conn.raw.prepare("INSERT INTO interactions (interaction_type) VALUES ('task_input')").run();
      const maxId = (conn.raw.prepare('SELECT MAX(id) AS m FROM interactions').get() as any).m;
      expect(maxId).toBe(3);
    });

    it('backfills existing task rows with the new column defaults', async () => {
      conn.raw.prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (7, ?, ?)').run('Old task', 30);
      await runMigrations(conn);
      const row = conn.raw.prepare('SELECT * FROM tasks WHERE id = 7').get() as any;
      expect(row.duration_type).toBe('estimate');
      expect(row.work_state).toBe('none');
      expect(row.accumulated_minutes).toBe(0);
      expect(row.last_worked_at).toBeNull();
    });

    it('keeps foreign_key_check empty after upgrading a populated DB', async () => {
      await runMigrations(conn);
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });
});
