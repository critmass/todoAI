// Task 49 — migration 008 widens `prevent_circular_dependencies` from "the direct reverse pair"
// to a real reachability walk, so A->B->C->A is rejected at INSERT instead of quietly landing and
// permanently hiding all three tasks behind U1's dependency-blocked pre-filter.
//
// THE ASSERTION THAT MATTERS MOST is the diamond (A->B, A->C, B->D, C->D): it is not a cycle, and
// a naive "does an edge already exist between these two in any direction / is the target already
// transitively involved" check rejects it. Every guard here is worthless if that one is wrong.

import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';
import { MIGRATION_004_SQL } from '../004_algorithm_weights_reconciliation';
import { MIGRATION_005_SQL } from '../005_session_runtime';
import { MIGRATION_006_SQL } from '../006_recurrence_period';
import { MIGRATION_007_SQL } from '../007_session_origin';

function names(raw: import('better-sqlite3').Database, type: string): string[] {
  return (
    raw.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function seedTasks(conn: TestSqliteConnection, count: number): void {
  const stmt = conn.raw.prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (?, ?, ?)');
  for (let id = 1; id <= count; id++) stmt.run(id, `Task ${id}`, 10);
}

function addEdge(conn: TestSqliteConnection, from: number, to: number): void {
  conn.raw
    .prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)')
    .run(from, to);
}

function edgeCount(conn: TestSqliteConnection): number {
  return (conn.raw.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number }).n;
}

/** A device already on schema 2.8.0 (001-007 applied) - the realistic upgrade path, and the only
 *  way to get a pre-existing >=3 cycle into the table, since the new trigger refuses to create one. */
async function createLegacyV280Connection(): Promise<TestSqliteConnection> {
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
      MIGRATION_007_SQL,
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

describe('migration 008 - transitive circular-dependency guard (v2.8 -> v2.9)', () => {
  describe('fresh install', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = createTestConnection();
      await runMigrations(conn);
      seedTasks(conn, 8);
    });
    afterEach(() => conn.close());

    it('lands at 2.9.0 and records the migration name', () => {
      expect(conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('version')).toEqual({
        value: '2.9.0',
      });
      expect(
        conn.raw.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('last_migration'),
      ).toEqual({ value: 'v2_9_transitive_cycle_guard' });
    });

    it('replaces the trigger rather than adding a second one', () => {
      expect(names(conn.raw, 'trigger')).toEqual([
        'prevent_circular_dependencies',
        'update_tasks_timestamp',
      ]);
      const ddl = conn.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get('prevent_circular_dependencies') as { sql: string };
      expect(ddl.sql).toMatch(/WITH RECURSIVE/i);
    });

    // ---- the failing-first assertions -------------------------------------------------------

    it('rejects a three-task cycle: A->B->C->A', () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      expect(() => addEdge(conn, 3, 1)).toThrow(/Circular dependency detected/);
      expect(edgeCount(conn)).toBe(2);
    });

    it('rejects a four-task cycle: A->B->C->D->A', () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      addEdge(conn, 3, 4);
      expect(() => addEdge(conn, 4, 1)).toThrow(/Circular dependency detected/);
      expect(edgeCount(conn)).toBe(3);
    });

    it('still rejects the direct two-task cycle migration 001 already caught (no regression)', () => {
      addEdge(conn, 1, 2);
      expect(() => addEdge(conn, 2, 1)).toThrow(/Circular dependency detected/);
    });

    it('rejects a self-dependency (the degenerate one-node cycle)', () => {
      expect(() => addEdge(conn, 1, 1)).toThrow(/Circular dependency detected/);
    });

    it('closes a legitimate DIAMOND cleanly: A->B, A->C, B->D, C->D is not a cycle', () => {
      addEdge(conn, 1, 2); // A -> B
      addEdge(conn, 1, 3); // A -> C
      addEdge(conn, 2, 4); // B -> D
      expect(() => addEdge(conn, 3, 4)).not.toThrow(); // C -> D closes the diamond, not a cycle
      expect(edgeCount(conn)).toBe(4);
    });

    it('accepts a long acyclic chain and a second edge into the same tail', () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      addEdge(conn, 3, 4);
      addEdge(conn, 4, 5);
      expect(() => addEdge(conn, 6, 5)).not.toThrow(); // shares the tail, no cycle
      expect(() => addEdge(conn, 1, 5)).not.toThrow(); // a shortcut down its own chain, no cycle
      expect(edgeCount(conn)).toBe(6);
    });

    it('rejects an edge that closes a cycle through a shared node, not only along one chain', () => {
      // 1->2->3 and 4->3; 3->1 closes the 1/2/3 loop even though 3 also has an unrelated parent.
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      addEdge(conn, 4, 3);
      expect(() => addEdge(conn, 3, 1)).toThrow(/Circular dependency detected/);
    });

    it('keeps the exact abort message the repository maps to CircularDependencyError', () => {
      addEdge(conn, 1, 2);
      expect(() => addEdge(conn, 2, 1)).toThrow('Circular dependency detected');
    });
  });

  describe('upgrading a populated v2.8.0 database', () => {
    let conn: TestSqliteConnection;
    beforeEach(async () => {
      conn = await createLegacyV280Connection();
      seedTasks(conn, 6);
    });
    afterEach(() => conn.close());

    it('the old trigger really did let a three-cycle through - that is what 008 exists for', () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      expect(() => addEdge(conn, 3, 1)).not.toThrow();
      expect(edgeCount(conn)).toBe(3);
    });

    it('migrates a database that already contains a cycle without failing, leaving the rows for the consistency sweep', async () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      addEdge(conn, 3, 1);

      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      // DROP/CREATE TRIGGER does not validate existing rows - the cycle survives, and repairing it
      // stays validateConsistency's job (src/services/backup/consistency.ts).
      expect(edgeCount(conn)).toBe(3);
      // But nothing new can extend it.
      expect(() => addEdge(conn, 4, 1)).not.toThrow();
      expect(() => addEdge(conn, 1, 4)).toThrow(/Circular dependency detected/);
    });

    it('preserves task_dependencies rows and their ids - no table rebuild, only DROP/CREATE TRIGGER', async () => {
      addEdge(conn, 1, 2);
      addEdge(conn, 2, 3);
      const before = conn.raw.prepare('SELECT * FROM task_dependencies ORDER BY id').all();

      await runMigrations(conn);

      expect(conn.raw.prepare('SELECT * FROM task_dependencies ORDER BY id').all()).toEqual(before);
      expect(names(conn.raw, 'table')).not.toContain('task_dependencies_new');
    });

    it('is idempotent: running twice does not reapply 008 or throw', async () => {
      await runMigrations(conn);
      await expect(runMigrations(conn)).resolves.toBeUndefined();
      expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
      expect(names(conn.raw, 'trigger')).toEqual([
        'prevent_circular_dependencies',
        'update_tasks_timestamp',
      ]);
    });

    it('keeps foreign_key_check empty and enforcement restored (no rebuild dance needed here)', async () => {
      await runMigrations(conn);
      expect(conn.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });
});
