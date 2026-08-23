// Task 14 — steps 3, 4 and 5: restore from backup, fresh start, full reset.

import { MIGRATION_001_SQL } from '../../../db/migrations/001_initial_schema';
import { getCurrentSchemaVersion, runMigrations } from '../../../db/migrations';
import { splitSqlStatements } from '../../../db/migrations/statementSplitter';
import {
  countRows,
  createFixture,
  seedWorking,
  WORKING,
  type Fixture,
} from '../../../db/testUtils/backupFixture';
import { corruptDatabaseFile } from '../../../db/testUtils/fileDbOperations';
import { createBackup } from '../backup';
import { ConsentRequiredError, NoUsableBackupError } from '../errors';
import { freshStart, fullReset, restoreFromBackup } from '../restore';
import { resolveConfig } from '../types';

describe('restoreFromBackup', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('replaces the working database with the newest usable snapshot', async () => {
    const working = await seedWorking(fixture, 2);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    // Work done after the backup is what a restore is expected to lose.
    await working.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['c', 5]);
    expect(await countRows(working, 'tasks')).toBe(3);
    working.close();

    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'page');

    const result = await restoreFromBackup({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(result.from.usable).toBe(true);
    const restored = fixture.ops.open(WORKING);
    expect(await countRows(restored, 'tasks')).toBe(2);
    restored.close();
  });

  it('re-runs migrations against the restored file rather than trusting its version', async () => {
    // A snapshot genuinely taken on an older app build: migration 001 only, schema 2.2.0. A restore
    // that skipped `runMigrations` would leave the app running against a five-migration-old schema
    // and every repository written since would fail on a missing column (brief §4b).
    const old = fixture.ops.open({ name: 'oldbuild.db' });
    for (const statement of splitSqlStatements(MIGRATION_001_SQL)) {
      await old.execute(statement);
    }
    await old.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['old', 20]);
    expect(await getCurrentSchemaVersion(old)).toBe('2.2.0');
    await createBackup({
      ops: fixture.ops,
      config: fixture.config,
      working: old,
      now: fixture.now,
    });
    old.close();

    const result = await restoreFromBackup({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(result.from.schemaVersion).toBe('2.2.0');
    expect(result.migrated).toBe(true);
    expect(result.schemaVersion).toBe('2.9.0');

    const restored = fixture.ops.open(WORKING);
    expect(await countRows(restored, 'tasks')).toBe(1);
    // A column that only exists from migration 006 onwards - proof the sweep really ran.
    await restored.execute('SELECT last_period_shortfall FROM task_recurrence');
    restored.close();
  });

  it('clears the runtime tables — a restored backup has no live session (brief §4c)', async () => {
    const working = await seedWorking(fixture, 1);
    await working.execute(
      "INSERT INTO sessions (id, session_type, planned_duration, status) VALUES ('s1', 'deep_focus', 50, 'abandoned')",
    );
    await working.execute(
      'INSERT INTO session_runtime (session_id, started_at_ms, planned_end_at_ms) VALUES (?, ?, ?)',
      ['s1', 1000, 2000],
    );
    await working.execute(
      'INSERT INTO active_episode (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms) ' +
        "VALUES (1, 's1', 1, 'countdown', 25, 1000, 2500)",
    );
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();

    const result = await restoreFromBackup({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });
    expect(result.runtimeRowsCleared).toBe(2);

    const restored = fixture.ops.open(WORKING);
    // `active_episode`'s mere existence is the crash signal — after a restore there was no crash.
    expect(await countRows(restored, 'active_episode')).toBe(0);
    expect(await countRows(restored, 'session_runtime')).toBe(0);
    // The historical session row is untouched, and still truthfully 'abandoned' (constraint #14).
    const sessions = await restored.execute('SELECT status FROM sessions');
    expect(sessions.rows[0].status).toBe('abandoned');
    restored.close();
  });

  it('stamps restored_at on the snapshot row that travelled inside the file', async () => {
    const working = await seedWorking(fixture, 1);
    const backup = await createBackup({
      ops: fixture.ops,
      config: fixture.config,
      working,
      now: fixture.now,
    });
    working.close();

    await restoreFromBackup({ ops: fixture.ops, config: fixture.config, now: fixture.now });

    const restored = fixture.ops.open(WORKING);
    const log = await restored.execute(
      'SELECT backup_path, restored_at FROM backup_log ORDER BY id DESC LIMIT 1',
    );
    expect(log.rows[0].backup_path).toBe(backup.slot.name);
    expect(log.rows[0].restored_at).toBeTruthy();
    restored.close();
  });

  it('prefers the newer slot and falls back to the older one when it is damaged', async () => {
    const working = await seedWorking(fixture, 1);
    const deps = { ops: fixture.ops, config: fixture.config, working, now: fixture.now };
    await createBackup(deps); // slot A — 1 task
    await working.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['b', 5]);
    await createBackup(deps); // slot B — 2 tasks, newer
    working.close();

    const slots = resolveConfig(fixture.config).slots;
    corruptDatabaseFile(fixture.ops.pathFor(slots[1]), 'page');

    const result = await restoreFromBackup({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });
    expect(result.from.slot.name).toBe(slots[0].name);

    const restored = fixture.ops.open(WORKING);
    expect(await countRows(restored, 'tasks')).toBe(1);
    restored.close();
  });

  it('throws NoUsableBackupError when both slots are unusable, without touching the working file', async () => {
    const working = await seedWorking(fixture, 1);
    working.close();

    await expect(
      restoreFromBackup({ ops: fixture.ops, config: fixture.config, now: fixture.now }),
    ).rejects.toBeInstanceOf(NoUsableBackupError);

    const untouched = fixture.ops.open(WORKING);
    expect(await countRows(untouched, 'tasks')).toBe(1);
    untouched.close();
  });

  it('leaves no open handles behind', async () => {
    const working = await seedWorking(fixture, 1);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    await restoreFromBackup({ ops: fixture.ops, config: fixture.config, now: fixture.now });
    expect(fixture.ops.openHandles()).toBe(0);
  });
});

describe('freshStart', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('creates an empty, fully migrated database', async () => {
    const working = await seedWorking(fixture, 3);
    working.close();

    const result = await freshStart({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });
    expect(result.schemaVersion).toBe('2.9.0');
    expect(result.imported).toBe(false);

    const db = fixture.ops.open(WORKING);
    expect(await countRows(db, 'tasks')).toBe(0);
    db.close();
  });

  it('hands the new database to an importer when one is supplied', async () => {
    const result = await freshStart(
      { ops: fixture.ops, config: fixture.config, now: fixture.now },
      async (db) => {
        await db.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', [
          'imported',
          15,
        ]);
      },
    );
    expect(result.imported).toBe(true);

    const db = fixture.ops.open(WORKING);
    expect(await countRows(db, 'tasks')).toBe(1);
    db.close();
  });
});

describe('fullReset', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('refuses to run without explicit consent', async () => {
    await expect(
      fullReset(
        { ops: fixture.ops, config: fixture.config, now: fixture.now },
        { consent: false },
      ),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('clears the working database and both slots, then reinitialises', async () => {
    const working = await seedWorking(fixture, 2);
    const deps = { ops: fixture.ops, config: fixture.config, working, now: fixture.now };
    await createBackup(deps);
    await createBackup(deps);
    working.close();

    const reclaimSpace = jest.fn(async () => 4096);
    const result = await fullReset(
      { ops: fixture.ops, config: fixture.config, now: fixture.now, reclaimSpace },
      { consent: true },
    );

    expect(result.schemaVersion).toBe('2.9.0');
    expect(reclaimSpace).toHaveBeenCalledTimes(1);
    const slots = resolveConfig(fixture.config).slots;
    expect(fixture.ops.exists(slots[0])).toBe(false);
    expect(fixture.ops.exists(slots[1])).toBe(false);

    const db = fixture.ops.open(WORKING);
    expect(await countRows(db, 'tasks')).toBe(0);
    db.close();
  });
});

describe('runMigrations against a restored file', () => {
  it('is forward-only, which is why the restore path must call it explicitly', async () => {
    const fixture = createFixture();
    const db = fixture.ops.open({ name: 'probe.db' });
    await runMigrations(db);
    expect(await getCurrentSchemaVersion(db)).toBe('2.9.0');
    db.close();
    fixture.cleanup();
  });
});
