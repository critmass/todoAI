import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';

function names(raw: import('better-sqlite3').Database, type: 'view' | 'index' | 'trigger'): string[] {
  return raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type)
    .map((r: any) => r.name);
}

/** A device already on schema 2.4.0 (001+002+003 applied, 004 not yet) with data, before
 *  migrating - the realistic upgrade path, not a fresh install where all four apply back to back. */
async function createLegacyV240Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) await tx.execute(statement);
  });
  await conn.execute('PRAGMA foreign_keys = OFF');
  try {
    await conn.transaction(async (tx) => {
      for (const statement of splitSqlStatements(MIGRATION_002_SQL)) await tx.execute(statement);
    });
    await conn.transaction(async (tx) => {
      for (const statement of splitSqlStatements(MIGRATION_003_SQL)) await tx.execute(statement);
    });
  } finally {
    await conn.execute('PRAGMA foreign_keys = ON');
  }
  return conn;
}

describe('migration 004 - algorithm_weights reconciliation (v2.4 -> v2.5)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
    });
    afterEach(() => conn.close());

    it('applies 004 with algorithm_weights seeded 31/23/23/23 and no context_fit', () => {
      // A fresh install walks the whole list, so the recorded version is the LATEST (005 rides
      // along), not 004's own 2.5.0. 004's effects are what this test asserts.
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('version')).toEqual({
        value: '2.6.0',
      });
      const rows = conn.raw
        .prepare('SELECT factor_name, weight_percentage FROM algorithm_weights ORDER BY factor_name')
        .all();
      expect(rows).toEqual([
        { factor_name: 'energy_match', weight_percentage: 23 },
        { factor_name: 'historical_success', weight_percentage: 23 },
        { factor_name: 'importance', weight_percentage: 31 },
        { factor_name: 'urgency', weight_percentage: 23 },
      ]);
    });

    it('sums the surviving weights to 100', () => {
      const total = conn.raw
        .prepare('SELECT SUM(weight_percentage) AS total FROM algorithm_weights')
        .get() as { total: number };
      expect(total.total).toBe(100);
    });

    it('rejects context_fit as a factor_name (CHECK constraint applied)', () => {
      expect(() =>
        conn.raw
          .prepare("INSERT INTO algorithm_weights (factor_name, weight_percentage) VALUES ('context_fit', 10)")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('drops active_tasks_with_neglect and leaves the other four views intact', () => {
      expect(names(conn.raw, 'view')).toEqual([
        'coaching_priority_queue',
        'fireable_skills',
        'recent_session_performance',
        'tasks_due_soon',
      ]);
    });

    it('leaves triggers untouched', () => {
      expect(names(conn.raw, 'trigger')).toEqual(['prevent_circular_dependencies', 'update_tasks_timestamp']);
    });

    it('has an empty foreign_key_check after migrating', () => {
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  describe('populated 2.4.0 upgrade', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV240Connection();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.4.0');
    });
    afterEach(() => conn.close());

    it('leaves a row with data_points_count > 0 completely untouched (the learned-data guard)', async () => {
      // Simulate task 17's learning loop having already updated importance's weight.
      conn.raw
        .prepare(
          "UPDATE algorithm_weights SET weight_percentage = 40, data_points_count = 12, confidence_level = 0.6 WHERE factor_name = 'importance'",
        )
        .run();

      await runMigrations(conn);

      const importance = conn.raw
        .prepare('SELECT weight_percentage, data_points_count, confidence_level FROM algorithm_weights WHERE factor_name = ?')
        .get('importance');
      expect(importance).toEqual({ weight_percentage: 40, data_points_count: 12, confidence_level: 0.6 });
    });

    it('reseeds a row with data_points_count = 0 to the new default, leaving data_points_count alone', async () => {
      await runMigrations(conn);
      const urgency = conn.raw
        .prepare('SELECT weight_percentage, data_points_count FROM algorithm_weights WHERE factor_name = ?')
        .get('urgency');
      expect(urgency).toEqual({ weight_percentage: 23, data_points_count: 0 });
    });

    it('deletes context_fit unconditionally, even if it has learned data (the asymmetry)', async () => {
      // context_fit has "learned" data too - it still must go, because the factor itself is gone.
      conn.raw
        .prepare(
          "UPDATE algorithm_weights SET weight_percentage = 18, data_points_count = 7 WHERE factor_name = 'context_fit'",
        )
        .run();

      await runMigrations(conn);

      const contextFit = conn.raw.prepare("SELECT * FROM algorithm_weights WHERE factor_name = 'context_fit'").get();
      expect(contextFit).toBeUndefined();
      const all = conn.raw.prepare('SELECT factor_name FROM algorithm_weights').all();
      expect(all).toHaveLength(4);
    });

    it('never reuses an AUTOINCREMENT id across the rebuild, even though context_fit (the highest id) is deleted', async () => {
      // 001's seed order gives context_fit id 4 (importance=1, urgency=2, energy_match=3,
      // context_fit=4, historical_success=5) - not the highest id here, so also delete
      // historical_success first to put context_fit at the true high-water mark before migrating.
      conn.raw.prepare("DELETE FROM algorithm_weights WHERE factor_name = 'historical_success'").run();

      await runMigrations(conn);

      const inserted = conn.raw
        .prepare("INSERT INTO algorithm_weights (factor_name, weight_percentage) VALUES ('historical_success', 23)")
        .run();
      // Without the sqlite_sequence save/restore, the rebuild's copied rows would leave
      // sqlite_sequence at MAX(id) of the three survivors (3, energy_match), and this insert
      // would reuse id 4 - context_fit's old, deleted id.
      expect(Number(inserted.lastInsertRowid)).toBe(6);
    });

    it('keeps foreign_key_check empty and enforcement restored after upgrading a populated DB', async () => {
      await runMigrations(conn);
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('is idempotent: running twice does not reapply 004 or throw', async () => {
      await runMigrations(conn);
      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.6.0');
      const all = conn.raw.prepare('SELECT factor_name FROM algorithm_weights').all();
      expect(all).toHaveLength(4);
    });
  });
});
