// Task 14 — the whole ladder, in spec §8.4's order, against genuinely damaged files.

import {
  countRows,
  createFixture,
  seedPreExistingCycle,
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
    // Migration 008's trigger refuses to CREATE a cycle of any length, so the damaged shape the
    // sweep exists to repair has to be seeded around it — see seedPreExistingCycle.
    await seedPreExistingCycle(working, [
      [1, 2],
      [2, 3],
      [3, 1],
    ]);
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

  it('falls through to restore when the file cannot be salvaged at all', async () => {
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

  it('rejects a salvage that rebuilds the tasks table EMPTY and restores the backup instead', async () => {
    // The rejecting branch of `defaultAcceptSalvage` — the guard that keeps a successful-but-empty
    // salvage from being promoted over the top of a good backup (task 53 finding W1). The
    // discriminating shape is a salvage that SUCCEEDS with `tasks` in `recovered` and ZERO rows in
    // it: `tasksRecovered === true` AND `taskRowsRecovered === 0`. The test above damages the file
    // badly enough that `salvageDatabase` throws, so it leaves via the `catch` and never reaches
    // the policy at all; only this shape separates `taskRowsRecovered > 0` from a policy that
    // accepts any salvage that produced a `tasks` table.
    //
    // How it is produced: 'lastPage' makes `integrity_check` genuinely fail (so the ladder reaches
    // step 2), and the query fault makes every read of the SOURCE's task rows fail the way an
    // unreadable page does. The rowid scan is deliberately left working, so `copyTable` degrades to
    // the row-at-a-time path, skips all 400 rows, and still reports the table as recovered. That is
    // the real data-loss shape: the working database's tasks are gone, the backup still holds all
    // 400, and accepting this salvage would call `promoteToWorking` and return before step 3 ever
    // runs.
    const working = await seedWorking(fixture, 400);
    await createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now });
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'lastPage');
    fixture.ops.setQueryFault((sql) => /salvagesrc\."tasks"/.test(sql) && !/rowid AS rid/.test(sql));

    const outcome = await runRecoveryLadder({
      ops: fixture.ops,
      config: fixture.config,
      now: fixture.now,
    });
    fixture.ops.setQueryFault(null);

    // The DEFAULT policy ran and rejected — this is the accept/reject branch, not the exception
    // path. `tasks` did come back, so `taskRowsRecovered > 0` is the only thing standing between
    // the user and a promoted empty database.
    expect(outcome.salvage?.recovered.some((entry) => entry.table === 'tasks')).toBe(true);
    expect(outcome.salvage?.taskRowsRecovered).toBe(0);

    expect(outcome.status).toBe('restored');
    expect(outcome.attempts.map((entry) => entry.step)).toEqual([
      'integrity_check',
      'salvage',
      'restore',
    ]);
    expect(outcome.attempts.find((entry) => entry.step === 'salvage')?.detail).toMatch(
      /^salvage rejected:/,
    );
    expect(outcome.workingDbReplaced).toBe(true);

    // All 400 rows are back, and they came from the backup — not from the empty salvage.
    const rebuilt = fixture.ops.open(WORKING);
    expect(await countRows(rebuilt, 'tasks')).toBe(400);
    rebuilt.close();
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
