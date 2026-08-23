// Test-only fixture for task 14's backup/recovery suites. NOT imported by any production/app code.
// Deliberately not under a __tests__ directory: this preset's Jest testMatch collects EVERY file in
// __tests__ as a suite, and this one exports helpers - the same reason sqliteTestConnection.ts
// lives here.

import { runMigrations } from '../migrations';
import type { BackupConfig, DbFileRef, ManagedDb } from '../../services/backup/types';
import { createFileDbOperations, type FileDbOperations } from './fileDbOperations';

export const WORKING: DbFileRef = { name: 'todoai.db' };

export function testConfig(): BackupConfig {
  return { working: WORKING };
}

export interface Fixture {
  ops: FileDbOperations;
  config: BackupConfig;
  /** A monotonic injected clock — one tick per read, so backups always sort deterministically. */
  now: () => number;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const ops = createFileDbOperations();
  let clock = Date.parse('2026-08-17T09:00:00.000Z');
  return {
    ops,
    config: testConfig(),
    now: () => {
      clock += 1000;
      return clock;
    },
    cleanup: () => ops.cleanup(),
  };
}

/** Opens the working database, migrates it to the current schema and seeds `count` tasks. */
export async function seedWorking(fixture: Fixture, count = 3): Promise<ManagedDb> {
  const db = fixture.ops.open(WORKING);
  await runMigrations(db);
  for (let i = 0; i < count; i++) {
    await db.execute('INSERT INTO tasks (title, importance, estimated_duration) VALUES (?, ?, ?)', [
      `task ${i + 1}`,
      500,
      30,
    ]);
  }
  return db;
}

/**
 * Writes dependency edges that the live `prevent_circular_dependencies` trigger refuses, by
 * dropping the trigger, inserting, and putting its own DDL back verbatim — the same dance
 * `salvage.ts` performs around its table copy.
 *
 * Since migration 008 (task 49) the trigger rejects a cycle of ANY length at INSERT, so this is
 * the only way to produce the damaged shape `validateConsistency`'s cycle breaker still exists to
 * repair: rows that predate the migration, or that a salvage recovered with the trigger dropped.
 * Tests that want that state must ask for it explicitly rather than relying on a hole in the
 * schema.
 */
export async function seedPreExistingCycle(
  db: { execute: ManagedDb['execute'] },
  edges: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
  const existing = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_circular_dependencies'",
  );
  const ddl = existing.rows[0]?.sql == null ? null : String(existing.rows[0].sql);
  await db.execute('DROP TRIGGER IF EXISTS prevent_circular_dependencies');
  try {
    for (const [from, to] of edges) {
      await db.execute(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
        [from, to],
      );
    }
  } finally {
    if (ddl !== null) await db.execute(ddl);
  }
}

export async function countRows(
  db: { execute: ManagedDb['execute'] },
  table: string,
): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  return Number(result.rows[0]?.n ?? 0);
}
