import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';
import { MIGRATION_004_SQL } from '../004_algorithm_weights_reconciliation';

function names(raw: import('better-sqlite3').Database, type: 'table' | 'view' | 'index' | 'trigger'): string[] {
  return raw
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((r: any) => r.name);
}

function columns(raw: import('better-sqlite3').Database, table: string): string[] {
  return (raw.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name).sort();
}

/** A device already on schema 2.5.0 (001-004 applied) with data, before migrating - the realistic
 *  upgrade path, not a fresh install where all five apply back to back. */
async function createLegacyV250Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) await tx.execute(statement);
  });
  await conn.execute('PRAGMA foreign_keys = OFF');
  try {
    for (const sql of [MIGRATION_002_SQL, MIGRATION_003_SQL, MIGRATION_004_SQL]) {
      await conn.transaction(async (tx) => {
        for (const statement of splitSqlStatements(sql)) await tx.execute(statement);
      });
    }
  } finally {
    await conn.execute('PRAGMA foreign_keys = ON');
  }
  return conn;
}

function seedSessionAndTask(conn: TestSqliteConnection): void {
  conn.raw
    .prepare(
      "INSERT INTO sessions (id, session_type, planned_duration, status) VALUES ('s1', 'deep_focus', 90, 'completed')",
    )
    .run();
  conn.raw.prepare("INSERT INTO tasks (id, title, estimated_duration) VALUES (1, 'Mix track', 60)").run();
}

describe('migration 005 - session runtime tables (v2.5 -> v2.6)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
    });
    afterEach(() => conn.close());

    it('applies 005 and records the newest migration', () => {
      // A fresh install walks the whole list, so both metadata rows describe the LATEST migration
      // (006, 007 ride along), not 005's own 2.6.0 / v2_6_session_runtime. 005's effects — the three
      // tables and their constraints — are what the rest of this suite asserts. The old test name
      // ("lands at 2.6.0") encoded the trap task 34 §4 warns about; renamed for the same reason
      // task 13 renamed 004's.
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('version')).toEqual({
        value: '2.8.0',
      });
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('last_migration')).toEqual({
        value: 'v2_8_session_origin',
      });
    });

    it('creates the three runtime tables with their full column sets', () => {
      expect(names(conn.raw, 'table')).toEqual(
        expect.arrayContaining(['active_episode', 'session_runtime', 'session_task_extension']),
      );
      expect(columns(conn.raw, 'session_runtime')).toEqual([
        'planned_end_at_ms',
        'session_id',
        'started_at_ms',
        'updated_at',
      ]);
      expect(columns(conn.raw, 'active_episode')).toEqual([
        'block_end_at_ms',
        'block_kind',
        'hyperfocus_quanta',
        'id',
        'long_extend_enqueued',
        'pause_count',
        'paused_at_ms',
        'paused_ms',
        'planned_minutes',
        'session_id',
        'started_at_ms',
        'task_id',
      ]);
      expect(columns(conn.raw, 'session_task_extension')).toEqual([
        'coaching_enqueued',
        'minutes',
        'presses',
        'session_id',
        'task_id',
      ]);
    });

    it('enforces the active_episode singleton (CHECK id = 1)', () => {
      seedSessionAndTask(conn);
      const insert = (id: number) =>
        conn.raw
          .prepare(
            `INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms)
             VALUES (?, 's1', 1, 'countdown', 25, 1000, 1501000)`,
          )
          .run(id);

      expect(() => insert(1)).not.toThrow();
      expect(() => insert(2)).toThrow(/CHECK constraint failed/);
      // A second open episode can only replace the first, never coexist with it.
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM active_episode').get()).toEqual({ n: 1 });
    });

    it('rejects a bogus block_kind but accepts both real timer faces', () => {
      seedSessionAndTask(conn);
      const insert = (kind: string) =>
        conn.raw
          .prepare(
            `INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms)
             VALUES (1, 's1', 1, ?, 25, 1000, 1501000)`,
          )
          .run(kind);

      expect(() => insert('stopwatch')).toThrow(/CHECK constraint failed/);
      expect(() => insert('countdown')).not.toThrow();
      conn.raw.prepare('DELETE FROM active_episode').run();
      expect(() => insert('openBlock')).not.toThrow();
    });

    it('rejects a negative pause ledger', () => {
      seedSessionAndTask(conn);
      expect(() =>
        conn.raw
          .prepare(
            `INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms, paused_ms)
             VALUES (1, 's1', 1, 'countdown', 25, 1000, 1501000, -1)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('keys the +5 ledger by (session, task) so one session cannot hold two ledgers for a task', () => {
      seedSessionAndTask(conn);
      conn.raw
        .prepare("INSERT INTO session_task_extension (session_id, task_id, presses, minutes) VALUES ('s1', 1, 2, 10)")
        .run();
      expect(() =>
        conn.raw
          .prepare("INSERT INTO session_task_extension (session_id, task_id, presses, minutes) VALUES ('s1', 1, 1, 5)")
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it('cascades all three tables when the session row is deleted', () => {
      seedSessionAndTask(conn);
      conn.raw
        .prepare("INSERT INTO session_runtime (session_id, started_at_ms, planned_end_at_ms) VALUES ('s1', 0, 9000)")
        .run();
      conn.raw
        .prepare(
          `INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms)
           VALUES (1, 's1', 1, 'countdown', 25, 1000, 1501000)`,
        )
        .run();
      conn.raw
        .prepare("INSERT INTO session_task_extension (session_id, task_id) VALUES ('s1', 1)")
        .run();

      conn.raw.prepare("DELETE FROM sessions WHERE id = 's1'").run();

      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM session_runtime').get()).toEqual({ n: 0 });
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM active_episode').get()).toEqual({ n: 0 });
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM session_task_extension').get()).toEqual({ n: 0 });
    });

    it('leaves views and triggers untouched', () => {
      expect(names(conn.raw, 'view')).toEqual([
        'coaching_priority_queue',
        'fireable_skills',
        'recent_session_performance',
        'tasks_due_soon',
      ]);
      expect(names(conn.raw, 'trigger')).toEqual(['prevent_circular_dependencies', 'update_tasks_timestamp']);
    });

    it('has an empty foreign_key_check and leaves enforcement ON (no rebuild path taken)', () => {
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  describe('populated 2.5.0 upgrade', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV250Connection();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.5.0');
    });
    afterEach(() => conn.close());

    it('adds the runtime tables without disturbing existing rows', async () => {
      conn.raw.prepare("INSERT INTO tasks (id, title, estimated_duration) VALUES (7, 'Old task', 30)").run();
      conn.raw
        .prepare(
          "INSERT INTO sessions (id, session_type, planned_duration, status) VALUES ('old', 'quick', 10, 'completed')",
        )
        .run();

      await runMigrations(conn);

      expect(await getCurrentSchemaVersion(conn)).toBe('2.8.0'); // 006, 007 ride along
      expect(conn.raw.prepare('SELECT title FROM tasks WHERE id = 7').get()).toEqual({ title: 'Old task' });
      expect(conn.raw.prepare("SELECT planned_duration FROM sessions WHERE id = 'old'").get()).toEqual({
        planned_duration: 10,
      });
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM active_episode').get()).toEqual({ n: 0 });
    });

    it('keeps foreign_key_check empty and enforcement restored after upgrading a populated DB', async () => {
      await runMigrations(conn);
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('is idempotent: running twice does not reapply 005 or throw', async () => {
      await runMigrations(conn);
      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.8.0');
      expect(names(conn.raw, 'table')).toEqual(
        expect.arrayContaining(['active_episode', 'session_runtime', 'session_task_extension']),
      );
    });
  });
});
