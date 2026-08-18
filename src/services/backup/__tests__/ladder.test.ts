// Task 14 — the whole ladder, in spec §8.4's order, against genuinely damaged files.

import {
  countRows,
  createFixture,
  seedWorking,
  WORKING,
  type Fixture,
} from '../../../db/testUtils/backupFixture';
import { corruptDatabaseFile } from '../../../db/testUtils/fileDbOperations';
import { createBackup } from '../backup';
import { runRecoveryLadder } from '../ladder';
import { resolveConfig } from '../types';

describe('runRecoveryLadder', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('stops at step 1 when the database is healthy', async () => {
    const working = await seedWorking(fixture, 2);
    working.close();

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(outcome.status).toBe('healthy');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.workingDbReplaced).toBe(false);
    expect(outcome.requiresAcknowledgement).toBe(false);
    expect(outcome.consistency).toBeUndefined();
  });

  it('runs the periodic consistency sweep on a healthy database when asked', async () => {
    const working = await seedWorking(fixture, 3);
    for (const [from, to] of [
      [1, 2],
      [2, 3],
      [3, 1],
    ]) {
      await working.execute(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
        [from, to],
      );
    }
    working.close();

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
      validateWhenHealthy: true,
    });

    expect(outcome.status).toBe('healthy');
    expect(outcome.consistency?.cyclesBroken).toBe(1);
  });

  it('salvages a corrupt working database and promotes the rebuild', async () => {
    // 400 tasks so the file has real data pages; 'lastPage' then destroys one of them. The database
    // still describes itself and `integrity_check` fails - the partial-corruption case spec §8.4
    // puts salvage in front of restore for.
    const working = await seedWorking(fixture, 400);
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'lastPage');

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(outcome.status).toBe('salvaged');
    expect(outcome.integrity.ok).toBe(false);
    expect(outcome.workingDbReplaced).toBe(true);
    // Spec §8.4: partial corruption must tell the user what was recovered and what was lost.
    expect(outcome.requiresAcknowledgement).toBe(true);
    expect(outcome.salvage?.taskRowsRecovered).toBeGreaterThan(0);

    const repaired = fixture.ops.open(WORKING);
    expect(await countRows(repaired, 'tasks')).toBe(outcome.salvage?.taskRowsRecovered);
    repaired.close();

    // The salvage scratch database is cleaned up behind it.
    expect(fixture.ops.exists(resolveConfig(fixture.config).salvage)).toBe(false);
  });

  it('falls through to restore when the salvage recovers nothing worth keeping', async () => {
    const working = await seedWorking(fixture, 2);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    // A file with no readable header is not a database at all — nothing to salvage.
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'header');

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(outcome.status).toBe('restored');
    expect(outcome.attempts.map((entry) => entry.step)).toEqual([
      'integrity_check',
      'salvage',
      'restore',
    ]);
    expect(outcome.workingDbReplaced).toBe(true);

    const restored = fixture.ops.open(WORKING);
    expect(await countRows(restored, 'tasks')).toBe(2);
    restored.close();
  });

  it('honours an injected salvage policy that rejects a lossy rebuild', async () => {
    const working = await seedWorking(fixture, 400);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'lastPage');

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
      acceptSalvage: () => false,
    });

    expect(outcome.status).toBe('restored');
    expect(outcome.salvage).toBeDefined();
  });

  it('stops at "unrecoverable" and offers the destructive steps rather than taking them', async () => {
    const working = await seedWorking(fixture, 2);
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'header');

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(outcome.status).toBe('unrecoverable');
    expect(outcome.offers).toEqual(['fresh_start', 'full_reset']);
    expect(outcome.workingDbReplaced).toBe(false);
    expect(outcome.requiresAcknowledgement).toBe(true);
    // Nothing was destroyed: the damaged file is still there for a human or a later tool to try.
    expect(fixture.ops.exists(WORKING)).toBe(true);
  });

  it('reports both slots so a surface can offer restore instead of the salvage it took', async () => {
    const working = await seedWorking(fixture, 400);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'lastPage');

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });

    expect(outcome.status).toBe('salvaged');
    expect(outcome.backups.filter((entry) => entry.usable)).toHaveLength(1);
  });

  it('leaves no open handles behind on any branch', async () => {
    const working = await seedWorking(fixture, 2);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'header');

    await runRecoveryLadder({ ops: fixture.ops, config: fixture.config, now: fixture.now });
    expect(fixture.ops.openHandles()).toBe(0);
  });
});
