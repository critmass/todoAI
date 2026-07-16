import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createTasksRepository, type TasksRepository } from '../../db/repositories/tasks';
import {
  createRecurrenceRepository,
  type RecurrenceRepository,
} from '../../db/repositories/recurrence';
import { NotFoundError } from '../../db/errors';
import type { Recurrence } from '../../types/domain';
import { completeTask, type TaskCompletionDeps } from '../taskCompletion';

describe('completeTask (six-way completion-primitive dispatch)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let recurrence: RecurrenceRepository;
  let deps: TaskCompletionDeps;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    deps = { tasks, recurrence };
  });

  afterEach(() => conn.close());

  async function makeTask(recur?: Recurrence): Promise<number> {
    const task = await tasks.create({ title: 'T', estimatedDuration: 30 });
    if (recur) await recurrence.create(task.id, recur);
    return task.id;
  }

  it('closes a true one-off (no recurrence row) permanently', async () => {
    const id = await makeTask();
    const result = await completeTask(deps, id);
    expect(result.outcome).toEqual({ recurrence: 'one_off', closed: true });
    expect(result.task.status).toBe('completed');
    const fetched = await tasks.getById(id);
    expect(fetched?.status).toBe('completed');
  });

  it('resets the neglect clock but keeps an unscheduled task active (§4.2, not interchangeable with one-off)', async () => {
    const id = await makeTask({ type: 'unscheduled' });
    expect((await tasks.getById(id))?.lastCompletedAt).toBeNull();

    const result = await completeTask(deps, id);
    expect(result.outcome).toEqual({ recurrence: 'unscheduled', closed: false });
    expect(result.task.status).toBe('active'); // never closes
    expect(result.task.lastCompletedAt).not.toBeNull(); // clock reset
  });

  it('increments a count task and closes only at target', async () => {
    const id = await makeTask({ type: 'count', target: 3, progress: 0 });

    const first = await completeTask(deps, id);
    expect(first.outcome).toEqual({
      recurrence: 'count',
      closed: false,
      progress: 1,
      target: 3,
      targetReached: false,
    });
    expect(first.task.status).toBe('active');
    expect(first.task.lastCompletedAt).not.toBeNull(); // clock reset each increment

    await completeTask(deps, id); // progress 2
    const third = await completeTask(deps, id); // progress 3 → target
    expect(third.outcome).toEqual({
      recurrence: 'count',
      closed: true,
      progress: 3,
      target: 3,
      targetReached: true,
    });
    expect(third.task.status).toBe('completed');
  });

  it('keeps a scheduled task active and resets its clock (next_due_at advancement is task 13)', async () => {
    const id = await makeTask({ type: 'scheduled', scheduledDays: ['monday', 'thursday'] });
    const result = await completeTask(deps, id);
    expect(result.outcome).toEqual({ recurrence: 'scheduled', closed: false });
    expect(result.task.status).toBe('active');
    expect(result.task.lastCompletedAt).not.toBeNull();
  });

  it('increments quota progress, stays active even once the quota is met (period reset is task 13)', async () => {
    const id = await makeTask({ type: 'quota', quota: 2, period: 'week' });

    const first = await completeTask(deps, id);
    expect(first.outcome).toEqual({
      recurrence: 'quota',
      closed: false,
      progress: 1,
      quota: 2,
      quotaReached: false,
    });
    expect(first.task.status).toBe('active');

    const second = await completeTask(deps, id);
    expect(second.outcome).toEqual({
      recurrence: 'quota',
      closed: false,
      progress: 2,
      quota: 2,
      quotaReached: true,
    });
    expect(second.task.status).toBe('active'); // quota met, but completion never closes it
  });

  it('increments scheduled_quota progress and stays active', async () => {
    const id = await makeTask({
      type: 'scheduled_quota',
      quota: 3,
      period: 'week',
      scheduledDays: ['monday', 'wednesday', 'friday'],
    });
    const result = await completeTask(deps, id);
    expect(result.outcome).toEqual({
      recurrence: 'scheduled_quota',
      closed: false,
      progress: 1,
      quota: 3,
      quotaReached: false,
    });
    expect(result.task.status).toBe('active');
  });

  it('throws NotFoundError for a task that does not exist', async () => {
    await expect(completeTask(deps, 9999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
