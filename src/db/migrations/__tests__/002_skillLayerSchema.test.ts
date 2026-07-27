import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';

function names(raw: import('better-sqlite3').Database, type: 'view' | 'index' | 'trigger'): string[] {
  return raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type)
    .map((r: any) => r.name);
}

/** Simulates a real device already on schema 2.2.0 (001 applied, 002 not yet written) before
 *  seeding data and migrating - the realistic upgrade path task 26's brief asks to test against,
 *  not a fresh install where both migrations apply back to back with no data in between. */
async function createLegacyV220Connection(): Promise<TestSqliteConnection> {
  const conn = createTestConnection();
  await conn.transaction(async (tx) => {
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) {
      await tx.execute(statement);
    }
  });
  return conn;
}

describe('migration 002 - skill layer schema (v2.2 -> v2.3)', () => {
  let conn: TestSqliteConnection;

  beforeEach(async () => {
    conn = await createLegacyV220Connection();
    expect(await getCurrentSchemaVersion(conn)).toBe('2.2.0'); // sanity: legacy fixture is pre-002
  });

  afterEach(() => {
    conn.close();
  });

  it('upgrades a populated 2.2.0 database to 2.3.0 without losing existing rows', async () => {
    conn.raw
      .prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (?, ?, ?)')
      .run(1, 'Write report', 30);
    conn.raw
      .prepare('INSERT INTO skills (id, instruction, is_active) VALUES (?, ?, ?)')
      .run(1, 'Break down big tasks', 1);
    conn.raw
      .prepare(
        'INSERT INTO skill_conditions (skill_id, condition_key, condition_op, condition_value) VALUES (?, ?, ?, ?)',
      )
      .run(1, 'energy', 'eq', 'low');
    conn.raw.prepare('INSERT INTO skill_evidence (skill_id, evidence_type) VALUES (?, ?)').run(1, 'origin');
    conn.raw
      .prepare('INSERT INTO coaching_queue (id, trigger_type, urgency) VALUES (?, ?, ?)')
      .run(1, 'task_skipped', 'next_start');
    conn.raw.prepare('INSERT INTO coaching_tasks (coaching_id, task_id) VALUES (?, ?)').run(1, 1);

    await runMigrations(conn);

    // runMigrations walks the whole list, so the DB lands at the latest version (003, 004 and 005
    // ride along). The row-preservation assertions below are what this test is really about for 002.
    expect(await getCurrentSchemaVersion(conn)).toBe('2.6.0');

    expect(conn.raw.prepare('SELECT * FROM tasks WHERE id = 1').get()).toMatchObject({
      title: 'Write report',
    });
    expect(conn.raw.prepare('SELECT * FROM skills WHERE id = 1').get()).toMatchObject({
      instruction: 'Break down big tasks',
      is_active: 1,
    });
    expect(conn.raw.prepare('SELECT * FROM skill_conditions WHERE skill_id = 1').all()).toHaveLength(1);
    expect(conn.raw.prepare('SELECT * FROM skill_evidence WHERE skill_id = 1').all()).toHaveLength(1);
    expect(conn.raw.prepare('SELECT * FROM coaching_queue WHERE id = 1').get()).toMatchObject({
      trigger_type: 'task_skipped',
    });
    expect(conn.raw.prepare('SELECT * FROM coaching_tasks WHERE coaching_id = 1').all()).toHaveLength(1);

    expect(conn.raw.pragma('foreign_key_check')).toEqual([]);
    // The rebuild's FK-off/on dance must leave enforcement restored for ordinary app use.
    expect(conn.raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('recreates fireable_skills, coaching_priority_queue, and both rebuilt tables\' indexes; leaves triggers untouched', async () => {
    await runMigrations(conn);

    // runMigrations walks past 002 to the latest version; active_tasks_with_neglect is dropped by
    // 004 (v2.5), so it is correctly absent here even though this test targets 002's changes.
    expect(names(conn.raw, 'view')).toEqual([
      'coaching_priority_queue',
      'fireable_skills',
      'recent_session_performance',
      'tasks_due_soon',
    ]);
    expect(names(conn.raw, 'index')).toEqual(
      expect.arrayContaining(['idx_skills_active', 'idx_coaching_queue_status', 'idx_coaching_queue_urgency']),
    );
    expect(names(conn.raw, 'trigger')).toEqual(['prevent_circular_dependencies', 'update_tasks_timestamp']);
  });

  it('fireable_skills carries the index-only footgun comment in the migration source (item f)', () => {
    // SQLite does not retain a comment preceding a CREATE statement in sqlite_master.sql (true
    // for every other schema comment in 001 too - it's a source-file convention, not a live,
    // queryable one), so the comment's home is the migration source itself, checked here.
    expect(MIGRATION_002_SQL).toMatch(/ACTIVE-SKILL INDEX ONLY/);
    expect(MIGRATION_002_SQL).toMatch(/is lossy/);
    expect(MIGRATION_002_SQL).toMatch(/listConditions/);
  });

  it('fireable_skills and coaching_priority_queue still compute correctly after the rebuild', async () => {
    conn.raw.prepare('INSERT INTO skills (id, instruction, is_active) VALUES (?, ?, ?)').run(1, 'x', 1);
    conn.raw
      .prepare(
        'INSERT INTO skill_conditions (skill_id, condition_key, condition_op, condition_value) VALUES (?, ?, ?, ?)',
      )
      .run(1, 'energy', 'eq', 'low');
    conn.raw.prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (?, ?, ?)').run(1, 'T', 10);
    conn.raw
      .prepare('INSERT INTO coaching_queue (id, trigger_type, urgency) VALUES (?, ?, ?)')
      .run(1, 'task_skipped', 'immediate');
    conn.raw.prepare('INSERT INTO coaching_tasks (coaching_id, task_id) VALUES (?, ?)').run(1, 1);

    await runMigrations(conn);

    const fireable = conn.raw.prepare('SELECT * FROM fireable_skills').all() as Array<{ conditions: string }>;
    expect(fireable).toHaveLength(1);
    expect(fireable[0].conditions).toBe('energyeqlow');

    const pq = conn.raw.prepare('SELECT * FROM coaching_priority_queue').all() as Array<{
      related_task_ids: string;
    }>;
    expect(pq).toHaveLength(1);
    expect(pq[0].related_task_ids).toBe('1');
  });

  it('accepts the two new coaching_queue trigger types and still rejects a bogus one', async () => {
    await runMigrations(conn);

    expect(() =>
      conn.raw
        .prepare("INSERT INTO coaching_queue (trigger_type, urgency) VALUES ('buried_task', 'next_open')")
        .run(),
    ).not.toThrow();
    expect(() =>
      conn.raw
        .prepare("INSERT INTO coaching_queue (trigger_type, urgency) VALUES ('breakdown_complete', 'immediate')")
        .run(),
    ).not.toThrow();
    expect(() =>
      conn.raw.prepare("INSERT INTO coaching_queue (trigger_type) VALUES ('not_a_real_trigger')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('flips is_active default to FALSE for new inserts while preserving existing rows\' stored values', async () => {
    conn.raw.prepare('INSERT INTO skills (id, instruction, is_active) VALUES (?, ?, ?)').run(1, 'explicit active', 1);
    // is_active omitted -> relies on the OLD default (TRUE) at the time this row was written.
    conn.raw.prepare('INSERT INTO skills (id, instruction) VALUES (?, ?)').run(2, 'relied on old default');

    await runMigrations(conn);

    expect(conn.raw.prepare('SELECT is_active FROM skills WHERE id = 1').get()).toEqual({ is_active: 1 });
    expect(conn.raw.prepare('SELECT is_active FROM skills WHERE id = 2').get()).toEqual({ is_active: 1 });

    const info = conn.raw.prepare("INSERT INTO skills (instruction) VALUES ('born after migration')").run();
    const newRow = conn.raw.prepare('SELECT is_active FROM skills WHERE id = ?').get(info.lastInsertRowid);
    expect(newRow).toEqual({ is_active: 0 });
  });

  it('coaching_queue and skills cascade deletes still work after the rebuild', async () => {
    conn.raw.prepare('INSERT INTO tasks (id, title, estimated_duration) VALUES (?, ?, ?)').run(1, 'T', 10);
    conn.raw.prepare('INSERT INTO coaching_queue (id, trigger_type) VALUES (?, ?)').run(1, 'task_skipped');
    conn.raw.prepare('INSERT INTO coaching_tasks (coaching_id, task_id) VALUES (?, ?)').run(1, 1);
    conn.raw
      .prepare('INSERT INTO sessions (id, session_type, planned_duration, status) VALUES (?, ?, ?, ?)')
      .run('s1', 'quick', 10, 'completed');
    conn.raw.prepare('INSERT INTO coaching_sessions (coaching_id, session_id) VALUES (?, ?)').run(1, 's1');

    conn.raw.prepare('INSERT INTO skills (id, instruction) VALUES (?, ?)').run(1, 'x');
    conn.raw
      .prepare(
        'INSERT INTO skill_conditions (skill_id, condition_key, condition_op, condition_value) VALUES (?, ?, ?, ?)',
      )
      .run(1, 'k', 'eq', 'v');
    conn.raw.prepare('INSERT INTO skill_evidence (skill_id, evidence_type) VALUES (?, ?)').run(1, 'origin');

    await runMigrations(conn);

    conn.raw.prepare('DELETE FROM coaching_queue WHERE id = 1').run();
    expect(conn.raw.prepare('SELECT * FROM coaching_tasks').all()).toHaveLength(0);
    expect(conn.raw.prepare('SELECT * FROM coaching_sessions').all()).toHaveLength(0);

    conn.raw.prepare('DELETE FROM skills WHERE id = 1').run();
    expect(conn.raw.prepare('SELECT * FROM skill_conditions').all()).toHaveLength(0);
    expect(conn.raw.prepare('SELECT * FROM skill_evidence').all()).toHaveLength(0);
  });

  it('never reuses an AUTOINCREMENT id across the rebuild, even when a row was deleted first (gap the design report did not flag)', async () => {
    conn.raw.prepare('INSERT INTO skills (id, instruction) VALUES (?, ?)').run(1, 'a');
    conn.raw.prepare('INSERT INTO skills (id, instruction) VALUES (?, ?)').run(2, 'b');
    conn.raw.prepare('DELETE FROM skills WHERE id = 2').run(); // highest id gone before migration

    conn.raw.prepare('INSERT INTO coaching_queue (id, trigger_type) VALUES (?, ?)').run(1, 'task_skipped');
    conn.raw.prepare('INSERT INTO coaching_queue (id, trigger_type) VALUES (?, ?)').run(2, 'app_reorientation');
    conn.raw.prepare('DELETE FROM coaching_queue WHERE id = 2').run();

    await runMigrations(conn);

    const newSkill = conn.raw.prepare("INSERT INTO skills (instruction) VALUES ('c')").run();
    expect(Number(newSkill.lastInsertRowid)).toBe(3);

    const newCoaching = conn.raw.prepare("INSERT INTO coaching_queue (trigger_type) VALUES ('task_skipped')").run();
    expect(Number(newCoaching.lastInsertRowid)).toBe(3);
  });

  it('creates learning_state as a usable key/value store', async () => {
    await runMigrations(conn);
    conn.raw
      .prepare("INSERT INTO learning_state (key, value) VALUES ('distillation_watermark', '2026-07-01T00:00:00Z')")
      .run();
    const row = conn.raw
      .prepare("SELECT value FROM learning_state WHERE key = 'distillation_watermark'")
      .get();
    expect(row).toEqual({ value: '2026-07-01T00:00:00Z' });
  });

  it('adds skill_evidence.source, nullable, constrained to distiller|outcome', async () => {
    await runMigrations(conn);
    conn.raw.prepare('INSERT INTO skills (id, instruction) VALUES (?, ?)').run(1, 'x');
    conn.raw.prepare('INSERT INTO skill_evidence (skill_id, evidence_type) VALUES (?, ?)').run(1, 'origin'); // source omitted -> NULL
    conn.raw
      .prepare('INSERT INTO skill_evidence (skill_id, evidence_type, source) VALUES (?, ?, ?)')
      .run(1, 'corroboration', 'distiller');

    expect(() =>
      conn.raw
        .prepare('INSERT INTO skill_evidence (skill_id, evidence_type, source) VALUES (?, ?, ?)')
        .run(1, 'origin', 'bogus'),
    ).toThrow(/CHECK constraint failed/);

    const rows = conn.raw.prepare('SELECT source FROM skill_evidence ORDER BY id').all();
    expect(rows).toEqual([{ source: null }, { source: 'distiller' }]);
  });

  it('is idempotent: running twice does not reapply 002 or throw', async () => {
    await runMigrations(conn);
    await expect(runMigrations(conn)).resolves.toBeUndefined();
    expect(await getCurrentSchemaVersion(conn)).toBe('2.6.0');
  });
});
