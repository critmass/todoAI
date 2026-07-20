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

  describe('cumulative-duration fold (task 28 §2)', () => {
    it('folds multi-sitting time into exactly ONE actual_duration_history entry equal to the sum', async () => {
      const id = await makeTask(); // one-off
      // Five parked sittings, then a final completing episode.
      for (const m of [10, 20, 5, 15, 30]) await tasks.recordProgressEpisode(id, m); // 80 accumulated
      const result = await completeTask(deps, id, { episodeMinutes: 20 }); // + 20 = 100 total

      expect(result.task.actualDurationHistory).toEqual([100]); // ONE entry, the sum
      expect(result.task.averageActualDuration).toBe(100);
      expect(result.task.accumulatedMinutes).toBe(0); // reset
      expect(result.task.workState).toBe('none'); // parked state cleared
      expect(result.task.status).toBe('completed'); // one-off still closes
    });

    it('averages across completions (an unscheduled task worked in sittings each fold once)', async () => {
      const id = await makeTask({ type: 'unscheduled' });
      // First occurrence: 60 min across two sittings.
      await tasks.recordProgressEpisode(id, 40);
      await completeTask(deps, id, { episodeMinutes: 20 });
      // Second occurrence: 30 min in one go.
      const second = await completeTask(deps, id, { episodeMinutes: 30 });

      expect(second.task.actualDurationHistory).toEqual([60, 30]);
      expect(second.task.averageActualDuration).toBe(45); // mean of totals, not sittings
      expect(second.task.status).toBe('active'); // unscheduled stays active
    });

    it('count folds per increment: each increment records its own multi-sitting total', async () => {
      const id = await makeTask({ type: 'count', target: 3, progress: 0 });
      await tasks.recordProgressEpisode(id, 12);
      const first = await completeTask(deps, id, { episodeMinutes: 3 }); // increment 1: 15 min
      expect(first.task.actualDurationHistory).toEqual([15]);
      expect(first.task.accumulatedMinutes).toBe(0);

      await tasks.recordProgressEpisode(id, 20);
      const second = await completeTask(deps, id, { episodeMinutes: 0 }); // increment 2: 20 min
      expect(second.task.actualDurationHistory).toEqual([15, 20]);
    });

    it('omitting episodeMinutes folds only the accumulated time (R7 check-off path)', async () => {
      const id = await makeTask({ type: 'unscheduled' });
      await tasks.recordProgressEpisode(id, 45);
      const result = await completeTask(deps, id); // no opts → episodeMinutes 0
      expect(result.task.actualDurationHistory).toEqual([45]);
    });

    it('a zero-work completion adds no history entry (no false 0-minute observation)', async () => {
      const id = await makeTask(); // never worked
      const result = await completeTask(deps, id); // no accumulated, no episode
      expect(result.task.actualDurationHistory).toEqual([]);
      expect(result.task.averageActualDuration).toBeNull();
    });
  });
});
