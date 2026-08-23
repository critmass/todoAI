import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';
import { MIGRATION_004_SQL } from '../004_algorithm_weights_reconciliation';
import { MIGRATION_005_SQL } from '../005_session_runtime';

function names(raw: import('better-sqlite3').Database, type: 'table' | 'view' | 'index' | 'trigger'): string[] {
  return raw
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((r: any) => r.name);
}

function columns(raw: import('better-sqlite3').Database, table: string): string[] {
  return (raw.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name).sort();
}

/** A device already on schema 2.6.0 (001-005 applied) with data, before migrating - the realistic
 *  upgrade path, not a fresh install where all six apply back to back. */
async function createLegacyV260Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) await tx.execute(statement);
  });
  await conn.execute('PRAGMA foreign_keys = OFF');
  try {
    for (const sql of [MIGRATION_002_SQL, MIGRATION_003_SQL, MIGRATION_004_SQL, MIGRATION_005_SQL]) {
      await conn.transaction(async (tx) => {
        for (const statement of splitSqlStatements(sql)) await tx.execute(statement);
      });
    }
  } finally {
    await conn.execute('PRAGMA foreign_keys = ON');
  }
  return conn;
}

function seedTask(conn: TestSqliteConnection, id: number, title = 'Water the plants'): void {
  conn.raw.prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (?, ?, 10)').run(id, title);
}

describe('migration 006 - recurrence period columns (v2.6 -> v2.7)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
    });
    afterEach(() => conn.close());

    it('lands at 2.9.0 (007-008 ride along) and records the migration name', () => {
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('version')).toEqual({
        value: '2.9.0',
      });
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('last_migration')).toEqual({
        value: 'v2_9_transitive_cycle_guard',
      });
    });

    it('adds last_period_shortfall and keeps every pre-existing column', () => {
      expect(columns(conn.raw, 'task_recurrence')).toEqual([
        'created_at',
        'current_period_progress',
        'id',
        'is_currently_active',
        'last_period_shortfall',
        'recurrence_pattern',
        'recurrence_type',
        'reset_date',
        'target_count',
        'task_id',
      ]);
    });

    it('defaults last_period_shortfall to 0 and rejects a negative one', () => {
      seedTask(conn, 1);
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern)
           VALUES (1, 'quota', '{"quota":3,"period":"week"}')`,
        )
        .run();
      expect(conn.raw.prepare('SELECT last_period_shortfall AS s FROM task_recurrence').get()).toEqual({ s: 0 });

      expect(() =>
        conn.raw.prepare('UPDATE task_recurrence SET last_period_shortfall = -1 WHERE task_id = 1').run(),
      ).toThrow(/CHECK constraint failed/);
    });

    // The rule 001 could only state in a comment. Both types have no period and no reset (§4.2);
    // giving one a reset_date is the invisible conflation constraint #7 exists to prevent.
    it.each(['unscheduled', 'count'])('refuses a reset_date on a %s row', (type) => {
      seedTask(conn, 1);
      const target = type === 'count' ? 5 : null;
      expect(() =>
        conn.raw
          .prepare(
            `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, target_count, reset_date)
             VALUES (1, ?, '{}', ?, '2026-08-03')`,
          )
          .run(type, target),
      ).toThrow(/CHECK constraint failed/);
    });

    it('still accepts a reset_date on each of the three period-bearing types', () => {
      const rows: Array<[number, string, string]> = [
        [1, 'quota', '{"quota":3,"period":"week"}'],
        [2, 'scheduled_quota', '{"quota":3,"period":"week","scheduledDays":["monday"]}'],
        [3, 'scheduled', '{"scheduledDays":["tuesday"]}'],
      ];
      for (const [id, type, pattern] of rows) {
        seedTask(conn, id, `Task ${id}`);
        expect(() =>
          conn.raw
            .prepare(
              `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, reset_date)
               VALUES (?, ?, ?, '2026-08-03')`,
            )
            .run(id, type, pattern),
        ).not.toThrow();
      }
    });

    it('keeps the original target_count-iff-count CHECK through the rebuild', () => {
      seedTask(conn, 1);
      expect(() =>
        conn.raw
          .prepare(
            `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, target_count)
             VALUES (1, 'quota', '{}', 5)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('keeps the FK to tasks: deleting the task cascades the recurrence row away', () => {
      seedTask(conn, 1);
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern)
           VALUES (1, 'scheduled', '{"scheduledDays":["tuesday"]}')`,
        )
        .run();
      conn.raw.prepare('DELETE FROM tasks WHERE id = 1').run();
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM task_recurrence').get()).toEqual({ n: 0 });
    });

    it('recreates idx_task_recurrence_type and leaves views and triggers untouched', () => {
      expect(names(conn.raw, 'index')).toEqual(expect.arrayContaining(['idx_task_recurrence_type']));
      expect(names(conn.raw, 'view')).toEqual([
        'coaching_priority_queue',
        'fireable_skills',
        'recent_session_performance',
        'tasks_due_soon',
      ]);
      expect(names(conn.raw, 'trigger')).toEqual(['prevent_circular_dependencies', 'update_tasks_timestamp']);
    });

    it('has an empty foreign_key_check and leaves enforcement ON after the rebuild', () => {
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('leaves no rebuild scaffolding behind', () => {
      expect(names(conn.raw, 'table')).not.toContain('task_recurrence_new');
      expect(names(conn.raw, 'table')).not.toContain('_task_recurrence_seq_save');
    });
  });

  describe('populated 2.6.0 upgrade', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV260Connection();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.6.0');
    });
    afterEach(() => conn.close());

    it('preserves existing recurrence rows and their ids across the rebuild', async () => {
      seedTask(conn, 1, 'Gym');
      seedTask(conn, 2, 'Journal');
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (id, task_id, recurrence_type, recurrence_pattern, target_count, current_period_progress)
           VALUES (1, 1, 'quota', '{"quota":3,"period":"week"}', NULL, 2),
                  (2, 2, 'count', '{}', 10, 4)`,
        )
        .run();
      // Delete a row so sqlite_sequence's high-water mark exceeds MAX(id) - the condition 002
      // found silently resets a rowid on rebuild.
      conn.raw.prepare('DELETE FROM task_recurrence WHERE id = 2').run();

      await runMigrations(conn);

      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      expect(conn.raw.prepare('SELECT * FROM task_recurrence ORDER BY id').all()).toEqual([
        expect.objectContaining({
          id: 1,
          task_id: 1,
          recurrence_type: 'quota',
          current_period_progress: 2, // in-flight progress is NOT reset by the migration
          reset_date: null,
          last_period_shortfall: 0,
        }),
      ]);

      seedTask(conn, 3, 'New one');
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern)
           VALUES (3, 'unscheduled', '{}')`,
        )
        .run();
      // The high-water mark survived: the next id is 3, not a reused 2.
      expect(conn.raw.prepare('SELECT id FROM task_recurrence WHERE task_id = 3').get()).toEqual({ id: 3 });
    });

    it('sanitizes a stale reset_date on unscheduled/count rows rather than failing the upgrade', async () => {
      seedTask(conn, 1, 'Ongoing novel');
      seedTask(conn, 2, 'Review deck');
      // Only reachable by a hand-written row today (nothing has ever written reset_date), but an
      // upgrade that dies on the user's own database is the worse outcome.
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, target_count, reset_date)
           VALUES (1, 'unscheduled', '{}', NULL, '2026-01-01'),
                  (2, 'count', '{}', 10, '2026-01-01')`,
        )
        .run();

      await expect(runMigrations(conn)).resolves.toBeUndefined();

      expect(conn.raw.prepare('SELECT task_id, reset_date FROM task_recurrence ORDER BY task_id').all()).toEqual([
        { task_id: 1, reset_date: null },
        { task_id: 2, reset_date: null },
      ]);
    });

    it('keeps foreign_key_check empty and enforcement restored after upgrading a populated DB', async () => {
      seedTask(conn, 1);
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern)
           VALUES (1, 'scheduled', '{"scheduledDays":["monday"]}')`,
        )
        .run();

      await runMigrations(conn);

      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('is idempotent: running twice does not reapply 006 or throw', async () => {
      await runMigrations(conn);
      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      expect(columns(conn.raw, 'task_recurrence')).toContain('last_period_shortfall');
    });
  });
});
