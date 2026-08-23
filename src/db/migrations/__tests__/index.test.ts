import { createTestConnection } from '../../testUtils/sqliteTestConnection';
import { getCurrentSchemaVersion, runMigrations } from '../index';
import { splitSqlStatements } from '../statementSplitter';
import { MIGRATION_001_SQL } from '../001_initial_schema';

function tableNames(raw: import('better-sqlite3').Database): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
}

function viewNames(raw: import('better-sqlite3').Database): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
    .all()
    .map((r: any) => r.name);
}

function triggerNames(raw: import('better-sqlite3').Database): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .map((r: any) => r.name);
}

describe('splitSqlStatements', () => {
  it('keeps trigger bodies (BEGIN...END with an internal ;) as a single statement', () => {
    const statements = splitSqlStatements(MIGRATION_001_SQL);
    const triggerStatements = statements.filter((s) => /CREATE TRIGGER/i.test(s));
    expect(triggerStatements).toHaveLength(2);
    for (const stmt of triggerStatements) {
      expect(stmt.trim().toUpperCase().endsWith('END')).toBe(true);
    }
  });

  it('does not split a plain script incorrectly', () => {
    const statements = splitSqlStatements("SELECT 1; SELECT 'a;b'; SELECT 2;");
    expect(statements).toEqual(["SELECT 1", "SELECT 'a;b'", 'SELECT 2']);
  });
});

describe('runMigrations', () => {
  it('applies every migration on an empty database: all tables, views, and triggers exist', async () => {
    const conn = createTestConnection();
    expect(await getCurrentSchemaVersion(conn)).toBeNull();

    await runMigrations(conn);

    // A fresh DB walks the whole MIGRATIONS list, not just 001 - it should land on the latest
    // recorded version (008 bumps schema_metadata to 2.9.0), with each migration's additions present.
    expect(await getCurrentSchemaVersion(conn)).toBe('2.9.0');
    expect(tableNames(conn.raw)).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_recurrence',
        'sessions',
        'schema_metadata',
        'learning_state',
        'session_runtime',
        'active_episode',
        'session_task_extension',
      ]),
    );
    // active_tasks_with_neglect is dropped by migration 004 (see its migration comment for why).
    expect(viewNames(conn.raw)).toEqual([
      'coaching_priority_queue',
      'fireable_skills',
      'recent_session_performance',
      'tasks_due_soon',
    ]);
    expect(triggerNames(conn.raw)).toEqual([
      'prevent_circular_dependencies',
      'update_tasks_timestamp',
    ]);

    conn.close();
  });

  it('seeds algorithm_weights and data_retention', async () => {
    const conn = createTestConnection();
    await runMigrations(conn);

    // 5 seeded by 001, then context_fit removed by 004 - see 004's migration comment.
    const weights = conn.raw.prepare('SELECT factor_name FROM algorithm_weights').all();
    expect(weights).toHaveLength(4);

    const retention = conn.raw.prepare('SELECT table_name FROM data_retention').all();
    expect(retention.length).toBeGreaterThan(0);

    conn.close();
  });

  it('is a no-op on an already-migrated database', async () => {
    const conn = createTestConnection();
    await runMigrations(conn);
    await expect(runMigrations(conn)).resolves.toBeUndefined();
    const weights = conn.raw.prepare('SELECT factor_name FROM algorithm_weights').all();
    expect(weights).toHaveLength(4); // not re-seeded/duplicated
    conn.close();
  });

  it('enforces the circular-dependency trigger and FK cascades end to end', async () => {
    const conn = createTestConnection();
    await runMigrations(conn);

    conn.raw
      .prepare("INSERT INTO tasks (id, title, estimated_duration) VALUES (1, 'A', 10)")
      .run();
    conn.raw
      .prepare("INSERT INTO tasks (id, title, estimated_duration) VALUES (2, 'B', 10)")
      .run();
    conn.raw
      .prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (1, 2)')
      .run();

    expect(() =>
      conn.raw
        .prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (2, 1)')
        .run(),
    ).toThrow(/Circular dependency detected/);

    conn.raw.prepare('DELETE FROM tasks WHERE id = 1').run();
    const remainingDeps = conn.raw.prepare('SELECT * FROM task_dependencies').all();
    expect(remainingDeps).toHaveLength(0); // ON DELETE CASCADE

    conn.close();
  });
});
