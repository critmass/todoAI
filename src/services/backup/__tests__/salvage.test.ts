// Task 14 — step 2 of the ladder: ATTACH + INSERT…SELECT salvage.

import { getCurrentSchemaVersion } from '../../../db/migrations';
import {
  createFixture,
  seedPreExistingCycle,
  seedWorking,
  type Fixture,
} from '../../../db/testUtils/backupFixture';
import { salvageDatabase, RUNTIME_TABLES } from '../salvage';
import type { DbFileRef } from '../types';

const SOURCE: DbFileRef = { name: 'todoai.db' };
const DESTINATION: DbFileRef = { name: 'todoai.salvage.db' };

describe('salvageDatabase', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  async function seedSource(tasks = 3): Promise<void> {
    const db = await seedWorking(fixture, tasks);
    if (tasks >= 2) {
      await db.execute('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (1, 2)');
    }
    await db.execute(
      "INSERT INTO sessions (id, session_type, planned_duration, status) VALUES ('s1', 'deep_focus', 50, 'abandoned')",
    );
    await db.execute(
      'INSERT INTO session_runtime (session_id, started_at_ms, planned_end_at_ms) VALUES (?, ?, ?)',
      ['s1', 1000, 2000],
    );
    await db.execute(
      'INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms) ' +
        'VALUES (1, ?, 1, ?, 25, 1000, 2500)',
      ['s1', 'countdown'],
    );
    db.close();
  }

  it('rebuilds a fully migrated database from the readable tables', async () => {
    await seedSource(3);

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    expect(report.lost).toHaveLength(0);
    expect(report.taskRowsRecovered).toBe(3);
    expect(await getCurrentSchemaVersion(db)).toBe('2.9.0');

    const deps = await db.execute('SELECT COUNT(*) AS n FROM task_dependencies');
    expect(Number(deps.rows[0].n)).toBe(1);
    db.close();
  });

  it('skips views by construction — the table list comes from the destination schema', async () => {
    await seedSource(1);
    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    const views = await db.execute("SELECT name FROM sqlite_master WHERE type = 'view'");
    expect(views.rows.length).toBeGreaterThan(0); // the schema really does have views
    expect(report.recovered.map((entry) => entry.table)).not.toContain(
      String(views.rows[0].name),
    );
    db.close();
  });

  it('never copies schema_metadata — a stale source must not claim a stale schema', async () => {
    await seedSource(1);
    const source = fixture.ops.open(SOURCE);
    await source.execute("UPDATE schema_metadata SET value = '1.0.0' WHERE key = 'version'");
    source.close();

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });
    expect(report.recovered.map((entry) => entry.table)).not.toContain('schema_metadata');
    expect(await getCurrentSchemaVersion(db)).toBe('2.9.0');
    db.close();
  });

  it('keeps live timer state by default — a salvage recovers the instant the app died', async () => {
    await seedSource(1);
    const { db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    const episode = await db.execute('SELECT COUNT(*) AS n FROM active_episode');
    expect(Number(episode.rows[0].n)).toBe(1);
    db.close();
  });

  it('drops live timer state when asked to', async () => {
    await seedSource(1);
    const { db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
      clearRuntimeTables: true,
    });

    for (const table of RUNTIME_TABLES) {
      const rows = await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
      expect(Number(rows.rows[0].n)).toBe(0);
    }
    db.close();
  });

  it('puts the schema triggers back after the copy', async () => {
    await seedSource(1);
    const { db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    const triggers = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_circular_dependencies'",
    );
    expect(triggers.rows).toHaveLength(1);
    db.close();
  });

  it('carries a source that already contains a long cycle across, then breaks it', async () => {
    // Migration 008 (task 49) widened prevent_circular_dependencies from the direct reverse pair
    // to a full reachability walk, which makes salvage's drop-and-replay dance load-bearing for a
    // shape it never used to be: without the drop, replaying a 3-cycle through INSERT…SELECT would
    // RAISE(ABORT) and lose the whole task_dependencies copy. The copy must survive, and
    // validateConsistency must then break the cycle it carried over.
    const source = await seedWorking(fixture, 3);
    await seedPreExistingCycle(source, [
      [1, 2],
      [2, 3],
      [3, 1],
    ]);
    source.close();

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    expect(report.lost).toHaveLength(0);
    expect(report.consistency.cyclesBroken).toBe(1);
    const deps = await db.execute('SELECT COUNT(*) AS n FROM task_dependencies');
    expect(Number(deps.rows[0].n)).toBe(2);
    db.close();
  });

  it('leaves PRAGMA foreign_keys ON (constraint #9)', async () => {
    await seedSource(1);
    const { db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    const pragma = await db.execute('PRAGMA foreign_keys');
    expect(Number(Object.values(pragma.rows[0])[0])).toBe(1);
    db.close();
  });

  it('degrades to a row-at-a-time copy when the bulk statement fails', async () => {
    await seedSource(4);
    fixture.ops.setQueryFault((sql) => /INSERT OR REPLACE INTO main\."tasks" \(/.test(sql) && /SELECT/.test(sql));

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });
    fixture.ops.setQueryFault(null);

    const tasks = report.recovered.find((entry) => entry.table === 'tasks');
    expect(tasks?.degraded).toBe(true);
    expect(tasks?.rowsCopied).toBe(4);
    expect(report.taskRowsRecovered).toBe(4);
    db.close();
  });

  it('loses one table and keeps the rest when a table cannot be read at all', async () => {
    await seedSource(2);
    fixture.ops.setQueryFault((sql) => /"task_dependencies"/.test(sql));

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });
    fixture.ops.setQueryFault(null);

    expect(report.lost.map((entry) => entry.table)).toContain('task_dependencies');
    expect(report.taskRowsRecovered).toBe(2);
    db.close();
  });

  it('preserves the AUTOINCREMENT high-water mark across the rebuild (task 26 §3b)', async () => {
    await seedSource(3);
    const source = fixture.ops.open(SOURCE);
    await source.execute('DELETE FROM task_dependencies');
    await source.execute('DELETE FROM tasks WHERE id = 3');
    source.close();

    const { db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    await db.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['new', 10]);
    const inserted = await db.execute('SELECT MAX(id) AS id FROM tasks');
    // 3 was used and deleted; a naive rebuild would hand it out again.
    expect(Number(inserted.rows[0].id)).toBe(4);
    db.close();
  });

  it('repairs what enforcement would have prevented, then reports it', async () => {
    await seedSource(2);
    const source = fixture.ops.open(SOURCE);
    await source.execute('PRAGMA foreign_keys = OFF');
    await source.execute(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
      [1, 777],
    );
    source.close();

    const { report, db } = await salvageDatabase({
      ops: fixture.ops,
      source: SOURCE,
      destination: DESTINATION,
    });

    expect(report.consistency.danglingDependencies).toBe(1);
    const remaining = await db.execute(
      'SELECT COUNT(*) AS n FROM task_dependencies WHERE depends_on_task_id = 777',
    );
    expect(Number(remaining.rows[0].n)).toBe(0);
    db.close();
  });
});
