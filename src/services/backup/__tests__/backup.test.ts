// Task 14 — the backup half: `VACUUM INTO`, slot rotation, `backup_log`, and the no-space rule.

import { chooseSlot, createBackup, listBackupCandidates, IN_FLIGHT_MARKER } from '../backup';
import { NoSpaceError } from '../errors';
import { resolveConfig, DEFAULT_SLOT_NAMES } from '../types';
import { corruptDatabaseFile } from '../../../db/testUtils/fileDbOperations';
import {
  countRows,
  createFixture,
  seedWorking,
  WORKING,
  type Fixture,
} from '../../../db/testUtils/backupFixture';

describe('createBackup', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('writes a consistent snapshot with VACUUM INTO and records it in backup_log', async () => {
    const working = await seedWorking(fixture, 4);

    const result = await createBackup(
      { ops: fixture.ops, config: fixture.config, working, now: fixture.now },
      'pre_session',
    );

    expect(result.slot.name).toBe(DEFAULT_SLOT_NAMES[0]);
    expect(fixture.ops.exists(result.slot)).toBe(true);
    expect(result.estimatedBytes).toBeGreaterThan(0);

    const log = await working.execute('SELECT * FROM backup_log');
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].backup_type).toBe('pre_session');
    expect(log.rows[0].backup_path).toBe(DEFAULT_SLOT_NAMES[0]);
    expect(Number(log.rows[0].success)).toBe(1);
    expect(log.rows[0].error_message).toBeNull();

    const snapshot = fixture.ops.open(result.slot);
    expect(await countRows(snapshot, 'tasks')).toBe(4);
    snapshot.close();
    working.close();
  });

  it('carries its own creation row inside the snapshot, which is how slots are dated', async () => {
    const working = await seedWorking(fixture);
    const result = await createBackup(
      { ops: fixture.ops, config: fixture.config, working, now: fixture.now },
      'automatic',
    );

    const snapshot = fixture.ops.open(result.slot);
    const inside = await snapshot.execute('SELECT * FROM backup_log ORDER BY id DESC LIMIT 1');
    expect(inside.rows[0].backup_path).toBe(result.slot.name);
    expect(inside.rows[0].created_at).toBe(result.createdAt);
    // The self-row can only ever read "in flight": it was committed before the vacuum that copied
    // it. The authoritative status lives in the live database.
    expect(Number(inside.rows[0].success)).toBe(0);
    expect(inside.rows[0].error_message).toBe(IN_FLIGHT_MARKER);
    snapshot.close();
    working.close();
  });

  it('alternates slots so the newest snapshot is never the one being overwritten', async () => {
    const working = await seedWorking(fixture, 1);
    const deps = { ops: fixture.ops, config: fixture.config, working, now: fixture.now };
    const slots = resolveConfig(fixture.config).slots;

    const first = await createBackup(deps, 'automatic');
    expect(first.slot.name).toBe(slots[0].name);
    expect(await chooseSlot(working, slots)).toEqual(slots[1]);

    await working.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['b', 10]);
    const second = await createBackup(deps, 'automatic');
    expect(second.slot.name).toBe(slots[1].name);

    const third = await createBackup(deps, 'automatic');
    expect(third.slot.name).toBe(slots[0].name);

    // Both files exist throughout — that is the whole point of two slots.
    expect(fixture.ops.exists(slots[0])).toBe(true);
    expect(fixture.ops.exists(slots[1])).toBe(true);
    working.close();
  });

  it('throws NoSpaceError and records the failure when the disk is full', async () => {
    const working = await seedWorking(fixture);
    fixture.ops.setDiskFull(true);

    await expect(
      createBackup({ ops: fixture.ops, config: fixture.config, working, now: fixture.now }),
    ).rejects.toBeInstanceOf(NoSpaceError);

    const log = await working.execute('SELECT * FROM backup_log');
    expect(Number(log.rows[0].success)).toBe(0);
    expect(String(log.rows[0].error_message)).toMatch(/disk is full/i);
    working.close();
  });

  it('a failed backup costs the OLDER slot only — the newer snapshot survives', async () => {
    const working = await seedWorking(fixture, 2);
    const deps = { ops: fixture.ops, config: fixture.config, working, now: fixture.now };
    const slots = resolveConfig(fixture.config).slots;

    await createBackup(deps, 'automatic'); // slot A
    await createBackup(deps, 'automatic'); // slot B — now the newest

    fixture.ops.setDiskFull(true);
    await expect(createBackup(deps)).rejects.toBeInstanceOf(NoSpaceError);

    expect(fixture.ops.exists(slots[0])).toBe(false); // the older slot was cleared for the write
    const survivor = fixture.ops.open(slots[1]);
    expect(await countRows(survivor, 'tasks')).toBe(2);
    survivor.close();
    working.close();
  });

  it('tries the injected space-reclaim hook exactly once before giving up', async () => {
    const working = await seedWorking(fixture);
    fixture.ops.setDiskFull(true);
    const reclaimSpace = jest.fn(async () => {
      fixture.ops.setDiskFull(false);
      return 1024;
    });

    const result = await createBackup({
      ops: fixture.ops,
      config: fixture.config,
      working,
      now: fixture.now,
      reclaimSpace,
    });

    expect(reclaimSpace).toHaveBeenCalledTimes(1);
    expect(fixture.ops.exists(result.slot)).toBe(true);
    working.close();
  });

  it('still fails if reclaiming space was not enough', async () => {
    const working = await seedWorking(fixture);
    fixture.ops.setDiskFull(true);
    const reclaimSpace = jest.fn(async () => 0);

    await expect(
      createBackup({
        ops: fixture.ops,
        config: fixture.config,
        working,
        now: fixture.now,
        reclaimSpace,
      }),
    ).rejects.toBeInstanceOf(NoSpaceError);
    expect(reclaimSpace).toHaveBeenCalledTimes(1);
    working.close();
  });
});

describe('listBackupCandidates', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('reports absent slots as unusable rather than as empty databases', async () => {
    const candidates = await listBackupCandidates(fixture.ops, fixture.config);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((entry) => !entry.usable)).toBe(true);
    expect(candidates[0].reason).toBe('absent or empty');
  });

  it('orders usable snapshots newest-first using their embedded creation rows', async () => {
    const working = await seedWorking(fixture, 1);
    const deps = { ops: fixture.ops, config: fixture.config, working, now: fixture.now };
    await createBackup(deps, 'automatic'); // A
    await working.execute('INSERT INTO tasks (title, estimated_duration) VALUES (?, ?)', ['b', 10]);
    await createBackup(deps, 'automatic'); // B — newer
    working.close();

    const candidates = await listBackupCandidates(fixture.ops, fixture.config);
    expect(candidates.map((entry) => entry.slot.name)).toEqual([
      DEFAULT_SLOT_NAMES[1],
      DEFAULT_SLOT_NAMES[0],
    ]);
    expect(candidates[0].usable).toBe(true);
    expect(candidates[0].schemaVersion).toBe('2.9.0');
  });

  it('never leaks an open handle', async () => {
    const working = await seedWorking(fixture, 1);
    await createBackup(
      { ops: fixture.ops, config: fixture.config, working, now: fixture.now },
      'automatic',
    );
    working.close();
    await listBackupCandidates(fixture.ops, fixture.config);
    expect(fixture.ops.openHandles()).toBe(0);
  });

  it('rejects a corrupt snapshot instead of offering it for restore', async () => {
    const working = await seedWorking(fixture, 1);
    const result = await createBackup(
      { ops: fixture.ops, config: fixture.config, working, now: fixture.now },
      'automatic',
    );
    working.close();

    corruptDatabaseFile(fixture.ops.pathFor(result.slot), 'page');

    const candidates = await listBackupCandidates(fixture.ops, fixture.config);
    const damaged = candidates.find((entry) => entry.slot.name === result.slot.name);
    expect(damaged?.usable).toBe(false);
    expect(damaged?.reason).toBeTruthy();
  });
});

describe('the working database ref', () => {
  it('resolves the backup slots beside the working database by default', () => {
    const resolved = resolveConfig({ working: WORKING });
    expect(resolved.slots.map((slot) => slot.name)).toEqual([...DEFAULT_SLOT_NAMES]);
    expect(resolved.salvage.name).toBe('todoai.salvage.db');
  });
});
