import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createTasksRepository } from '../tasks';
import { createRecurrenceRepository, type RecurrenceRepository } from '../recurrence';
import { RecurrenceValidationError } from '../../errors';
import type { Recurrence } from '../../../types/domain';

describe('recurrenceRepository', () => {
  let conn: TestSqliteConnection;
  let repo: RecurrenceRepository;
  let taskId: number;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createRecurrenceRepository(conn);
    const tasks = createTasksRepository(conn);
    const task = await tasks.create({ title: 'Recurring task', estimatedDuration: 10 });
    taskId = task.id;
  });

  afterEach(() => {
    conn.close();
  });

  it('a true one-off has no task_recurrence row: getByTaskId returns undefined', async () => {
    expect(await repo.getByTaskId(taskId)).toBeUndefined();
  });

  const cases: Recurrence[] = [
    { type: 'scheduled_quota', quota: 3, period: 'week', scheduledDays: ['monday', 'wednesday', 'friday'] },
    { type: 'quota', quota: 15, period: 'week' },
    { type: 'scheduled', scheduledDays: ['tuesday'] },
    { type: 'unscheduled' },
    { type: 'count', target: 10, progress: 0 },
  ];

  it.each(cases)('round-trips recurrence type %o through create -> getByTaskId', async (recurrence) => {
    await repo.create(taskId, recurrence);
    const fetched = await repo.getByTaskId(taskId);
    expect(fetched).toEqual(recurrence);
  });

  it('update() replaces the recurrence shape (e.g. quota -> unscheduled)', async () => {
    await repo.create(taskId, { type: 'quota', quota: 5, period: 'week' });
    await repo.update(taskId, { type: 'unscheduled' });
    expect(await repo.getByTaskId(taskId)).toEqual({ type: 'unscheduled' });
  });

  it('remove() deletes the row, restoring "no recurrence" (true one-off)', async () => {
    await repo.create(taskId, { type: 'unscheduled' });
    await repo.remove(taskId);
    expect(await repo.getByTaskId(taskId)).toBeUndefined();
  });

  describe('incrementCountProgress', () => {
    it('increments progress and reports when target_count is reached', async () => {
      await repo.create(taskId, { type: 'count', target: 2, progress: 0 });

      const first = await repo.incrementCountProgress(taskId);
      expect(first).toEqual({ progress: 1, targetReached: false });

      const second = await repo.incrementCountProgress(taskId);
      expect(second).toEqual({ progress: 2, targetReached: true });

      const entity = await repo.getEntityByTaskId(taskId);
      expect(entity?.currentPeriodProgress).toBe(2);
    });

    it('rejects incrementing progress on a non-count recurrence', async () => {
      await repo.create(taskId, { type: 'unscheduled' });
      await expect(repo.incrementCountProgress(taskId)).rejects.toThrow(RecurrenceValidationError);
    });
  });

  it('the schema CHECK (target_count iff count) still fires for a direct raw write bypassing the repository', () => {
    expect(() =>
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, target_count)
           VALUES (?, 'quota', '{}', 5)`, // target_count set on a non-'count' type - violates the CHECK
        )
        .run(taskId),
    ).toThrow(/CHECK constraint failed/);
  });
});
