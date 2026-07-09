import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createTasksRepository, type TasksRepository } from '../tasks';

describe('tasksRepository', () => {
  let conn: TestSqliteConnection;
  let repo: TasksRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createTasksRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update -> getById -> soft-delete round-trips domain types', async () => {
    const created = await repo.create({
      title: 'Take out the trash',
      estimatedDuration: 5,
      importance: 700,
      contextTags: ['home'],
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Take out the trash');
    expect(created.durationSource).toBe('model_guess'); // default per brief
    expect(created.status).toBe('active');
    expect(created.contextTags).toEqual(['home']);
    expect(created.skipReasons).toEqual([]);
    expect(created.actualDurationHistory).toEqual([]);

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.update(created.id, {
      title: 'Take out the recycling',
      contextTags: ['home', 'weekly'],
      skipReasons: ['forgot'],
    });
    expect(updated.title).toBe('Take out the recycling');
    expect(updated.contextTags).toEqual(['home', 'weekly']);
    expect(updated.skipReasons).toEqual(['forgot']);
    expect(updated.id).toBe(created.id);

    const refetched = await repo.getById(created.id);
    expect(refetched).toEqual(updated);

    await repo.softDelete(created.id);
    const afterDelete = await repo.getById(created.id);
    expect(afterDelete?.status).toBe('deleted');

    const active = await repo.listActive();
    expect(active.find((t) => t.id === created.id)).toBeUndefined();
  });

  it('honors an explicit duration_source of "user"', async () => {
    const created = await repo.create({
      title: 'Renew passport',
      estimatedDuration: 30,
      durationSource: 'user',
    });
    expect(created.durationSource).toBe('user');
  });

  it('recordUnscheduledCompletion sets last_completed_at but leaves status active', async () => {
    const created = await repo.create({ title: 'Ongoing project', estimatedDuration: 60 });
    expect(created.lastCompletedAt).toBeNull();

    const completed = await repo.recordUnscheduledCompletion(created.id);
    expect(completed.status).toBe('active');
    expect(completed.lastCompletedAt).not.toBeNull();
  });

  it('listActive only returns active tasks', async () => {
    const a = await repo.create({ title: 'A', estimatedDuration: 10 });
    const b = await repo.create({ title: 'B', estimatedDuration: 10 });
    await repo.softDelete(a.id);

    const active = await repo.listActive();
    expect(active.map((t) => t.id)).toEqual([b.id]);
  });

  it('listActiveByNeglect orders most-neglected first and computes an uncapped squared multiplier', async () => {
    const older = await repo.create({ title: 'Old task', estimatedDuration: 10 });
    const newer = await repo.create({ title: 'New task', estimatedDuration: 10 });

    // Backdate `older`'s created_at by 21 days (3 weeks) so its neglect multiplier is 3^2 = 9.
    conn.raw
      .prepare("UPDATE tasks SET created_at = datetime('now', '-21 days') WHERE id = ?")
      .run(older.id);

    const byNeglect = await repo.listActiveByNeglect();
    expect(byNeglect[0].task.id).toBe(older.id);
    expect(byNeglect[0].weeksNeglected).toBeCloseTo(3, 1);
    expect(byNeglect[0].neglectMultiplier).toBeCloseTo(9, 1);
    expect(byNeglect[1].task.id).toBe(newer.id);
    expect(byNeglect[1].neglectMultiplier).toBeLessThan(byNeglect[0].neglectMultiplier);
  });
});
