// Task 14 — spec §8.4's "block session start if there's no space to copy", and its reciprocal with
// task 41 §5d (capture degrades where the product database blocks).

import { createFixture, seedWorking, type Fixture } from '../../../db/testUtils/backupFixture';
import { corruptDatabaseFile } from '../../../db/testUtils/fileDbOperations';
import { WORKING } from '../../../db/testUtils/backupFixture';
import { ensurePreSessionBackup } from '../sessionGate';

describe('ensurePreSessionBackup', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('allows the session and takes a pre_session backup on a healthy database', async () => {
    const working = await seedWorking(fixture, 2);

    const gate = await ensurePreSessionBackup({
      ops: fixture.ops,
      config: fixture.config,
      working,
      now: fixture.now,
    });

    expect(gate.allowed).toBe(true);
    if (!gate.allowed) throw new Error('unreachable');
    expect(gate.backup.backupType).toBe('pre_session');
    expect(fixture.ops.exists(gate.backup.slot)).toBe(true);
    working.close();
  });

  it('BLOCKS the session when there is no space — it does not degrade', async () => {
    const working = await seedWorking(fixture, 2);
    fixture.ops.setDiskFull(true);

    const gate = await ensurePreSessionBackup({
      ops: fixture.ops,
      config: fixture.config,
      working,
      now: fixture.now,
    });

    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error('unreachable');
    expect(gate.reason).toBe('no_space');
    working.close();
  });

  it('reclaims space first when a hook is wired, and then allows the session', async () => {
    const working = await seedWorking(fixture, 2);
    fixture.ops.setDiskFull(true);

    const gate = await ensurePreSessionBackup({
      ops: fixture.ops,
      config: fixture.config,
      working,
      now: fixture.now,
      // Task 41 §8.3 hands `capture/` to task 14 as reclaimable space. This is that contract.
      reclaimSpace: async () => {
        fixture.ops.setDiskFull(false);
        return 512 * 1024 * 1024;
      },
    });

    expect(gate.allowed).toBe(true);
    working.close();
  });

  it('blocks with reason "integrity" and takes no backup when quick_check fails', async () => {
    const working = await seedWorking(fixture, 400);
    working.close();
    corruptDatabaseFile(fixture.ops.pathFor(WORKING), 'lastPage');

    const reopened = fixture.ops.open(WORKING);
    const gate = await ensurePreSessionBackup({
      ops: fixture.ops,
      config: fixture.config,
      working: reopened,
      now: fixture.now,
    });

    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error('unreachable');
    expect(gate.reason).toBe('integrity');
    // A snapshot of a damaged database would overwrite a good slot with a bad copy.
    const log = await reopened.execute('SELECT COUNT(*) AS n FROM backup_log');
    expect(Number(log.rows[0].n)).toBe(0);
    reopened.close();
  });
});
