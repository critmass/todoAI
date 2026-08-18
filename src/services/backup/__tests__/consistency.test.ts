// Task 14 — spec §8.4's consistency validation: dangling deps, cycles, orphans.

import { findBackEdge, validateConsistency } from '../consistency';
import { createFixture, seedWorking, type Fixture } from '../../../db/testUtils/backupFixture';
import type { ManagedDb } from '../types';

describe('findBackEdge', () => {
  it('returns null for an acyclic graph', () => {
    expect(findBackEdge([{ id: 1, from: 1, to: 2 }, { id: 2, from: 2, to: 3 }])).toBeNull();
  });

  it('finds the edge that closes a two-cycle', () => {
    const back = findBackEdge([
      { id: 1, from: 1, to: 2 },
      { id: 2, from: 2, to: 1 },
    ]);
    expect(back).toEqual({ id: 2, from: 2, to: 1 });
  });

  it('finds a cycle of length three, which the schema trigger does NOT catch', () => {
    const back = findBackEdge([
      { id: 1, from: 1, to: 2 },
      { id: 2, from: 2, to: 3 },
      { id: 3, from: 3, to: 1 },
    ]);
    expect(back).toEqual({ id: 3, from: 3, to: 1 });
  });

  it('is deterministic — the same damaged graph always loses the same edge', () => {
    const edges = [
      { id: 7, from: 3, to: 1 },
      { id: 5, from: 2, to: 3 },
      { id: 9, from: 1, to: 2 },
    ];
    expect(findBackEdge(edges)).toEqual(findBackEdge([...edges].reverse()));
  });
});

describe('validateConsistency', () => {
  let fixture: Fixture;
  let db: ManagedDb;

  beforeEach(async () => {
    fixture = createFixture();
    db = await seedWorking(fixture, 3);
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  it('is a no-op on a healthy database', async () => {
    const report = await validateConsistency(db);
    expect(report.repairs).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
  });

  it('removes dependency edges pointing at a task that no longer exists', async () => {
    // Only reachable with enforcement off — which is exactly the state salvage leaves behind.
    await db.execute('PRAGMA foreign_keys = OFF');
    await db.execute(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
      [1, 999],
    );
    const report = await validateConsistency(db);
    await db.execute('PRAGMA foreign_keys = ON');

    expect(report.danglingDependencies).toBe(1);
    const remaining = await db.execute('SELECT COUNT(*) AS n FROM task_dependencies');
    expect(Number(remaining.rows[0].n)).toBe(0);
  });

  it('breaks a three-task dependency cycle the schema trigger lets through', async () => {
    // Migration 001's prevent_circular_dependencies only tests the direct reverse pair, so this
    // inserts cleanly with enforcement and triggers fully ON. That is the point of the assertion.
    for (const [from, to] of [
      [1, 2],
      [2, 3],
      [3, 1],
    ]) {
      await db.execute('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', [
        from,
        to,
      ]);
    }

    const report = await validateConsistency(db);
    expect(report.cyclesBroken).toBe(1);
    const remaining = await db.execute('SELECT COUNT(*) AS n FROM task_dependencies');
    expect(Number(remaining.rows[0].n)).toBe(2);
    // And the graph really is acyclic now.
    expect((await validateConsistency(db)).cyclesBroken).toBe(0);
  });

  it('nulls an orphan whose constraint declares ON DELETE SET NULL', async () => {
    await db.execute('PRAGMA foreign_keys = OFF');
    await db.execute(
      "INSERT INTO interactions (interaction_type, session_id) VALUES ('task_completion', 'ghost-session')",
    );
    const report = await validateConsistency(db);
    await db.execute('PRAGMA foreign_keys = ON');

    expect(report.orphansNulled).toBe(1);
    expect(report.orphansDeleted).toBe(0);
    const row = await db.execute('SELECT session_id FROM interactions');
    expect(row.rows[0].session_id).toBeNull();
  });

  it('deletes an orphan whose constraint declares ON DELETE CASCADE', async () => {
    await db.execute('PRAGMA foreign_keys = OFF');
    await db.execute(
      'INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern) VALUES (?, ?, ?)',
      [4242, 'scheduled', '{}'],
    );
    const report = await validateConsistency(db);
    await db.execute('PRAGMA foreign_keys = ON');

    expect(report.orphansDeleted).toBe(1);
    const remaining = await db.execute('SELECT COUNT(*) AS n FROM task_recurrence');
    expect(Number(remaining.rows[0].n)).toBe(0);
  });

  it('records a sweep it could not run instead of abandoning the rest', async () => {
    fixture.ops.setQueryFault((sql) => /FROM task_dependencies d/.test(sql));
    const report = await validateConsistency(db);
    fixture.ops.setQueryFault(null);

    expect(report.skipped.map((entry) => entry.check)).toContain('dangling_dependencies');
    // The orphan sweep still ran.
    expect(report.skipped.map((entry) => entry.check)).not.toContain('orphans');
  });
});
