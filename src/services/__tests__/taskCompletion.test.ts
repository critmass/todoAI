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
import {
  createInteractionsRepository,
  type InteractionsRepository,
} from '../../db/repositories/interactions';
import {
  completeTask,
  selfCompleteTask,
  SELF_COMPLETED_MARKER,
  type TaskCompletionDeps,
} from '../taskCompletion';

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

  // -- Task 17 Phase A: the historical-success write, at the completion choke point -----------
  //
  // "Attempt" is defined here and nowhere else: a completion or a skip. `completeTask` is the one
  // choke point every completion in the app passes through (episode `Done`, self-complete, the R7
  // breakdown check-off), so counting here counts each of them EXACTLY once and cannot be reached
  // by a park or a crash recovery, neither of which calls it.
  describe('historical-success counters (task 17 Phase A)', () => {
    async function countersOf(id: number) {
      const task = await tasks.getById(id);
      return {
        completionCount: task?.completionCount,
        skipCount: task?.skipCount,
        successRate: task?.successRate,
      };
    }

    it('counts a one-off completion once, with a rate of 1/1', async () => {
      const id = await makeTask();
      const result = await completeTask(deps, id);
      expect(result.task.completionCount).toBe(1); // the RETURNED row is already current
      expect(result.task.successRate).toBeCloseTo(1, 10);
      expect(await countersOf(id)).toEqual({ completionCount: 1, skipCount: 0, successRate: 1 });
    });

    it('counts every recurrence branch exactly once - none of the six is missed or doubled', async () => {
      const oneOff = await makeTask();
      const unscheduled = await makeTask({ type: 'unscheduled' });
      const scheduled = await makeTask({ type: 'scheduled', scheduledDays: ['monday'] });
      const count = await makeTask({ type: 'count', target: 3, progress: 0 });
      const quota = await makeTask({ type: 'quota', quota: 2, period: 'week' });
      const schedQuota = await makeTask({
        type: 'scheduled_quota',
        quota: 3,
        period: 'week',
        scheduledDays: ['monday', 'wednesday', 'friday'],
      });

      for (const id of [oneOff, unscheduled, scheduled, count, quota, schedQuota]) {
        await completeTask(deps, id);
        expect((await tasks.getById(id))?.completionCount).toBe(1);
      }

      // A count task's INCREMENTAL completions each count: three increments, three completions,
      // and the third (which closes it) is not counted twice.
      await completeTask(deps, count); // 2
      const closing = await completeTask(deps, count); // 3 -> target reached, closes
      expect(closing.outcome).toMatchObject({ recurrence: 'count', closed: true });
      expect((await tasks.getById(count))?.completionCount).toBe(3);
    });

    it('a completion after skips moves the rate off the floor (2 done of 10 attempts -> 0.2)', async () => {
      const id = await makeTask({ type: 'unscheduled' });
      await completeTask(deps, id);
      for (let i = 0; i < 4; i += 1) await tasks.recordSkipEpisode(id);
      await completeTask(deps, id);
      for (let i = 0; i < 4; i += 1) await tasks.recordSkipEpisode(id);
      expect(await countersOf(id)).toEqual({ completionCount: 2, skipCount: 8, successRate: 0.2 });
    });

    it('never writes completion_count without success_rate (task 44 section 3, constraint 1)', async () => {
      // The state task 44 explicitly rejected as WORSE than both-untouched: n looking non-zero
      // to anything using it as a "has this been observed" proxy while the rate stays fictional.
      const id = await makeTask({ type: 'unscheduled' });
      for (let i = 0; i < 3; i += 1) {
        await completeTask(deps, id);
        const task = await tasks.getById(id);
        expect(task?.completionCount).toBe(i + 1);
        expect(task?.successRate).not.toBe(0); // never left at the fictional default
        expect(task?.successRate).toBeCloseTo(
          task!.completionCount / (task!.completionCount + task!.skipCount),
          10,
        );
      }
    });
  });
});

describe('selfCompleteTask (task 44) - historical-success treatment (task 17 Phase A)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let recurrence: RecurrenceRepository;
  let interactions: InteractionsRepository;
  let deps: TaskCompletionDeps & { interactions: InteractionsRepository };

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    interactions = createInteractionsRepository(conn);
    deps = { tasks, recurrence, interactions };
  });

  afterEach(() => conn.close());

  // PRODUCT-INTENT, provisional until Jason rules (see the Phase A findings report): a
  // self-completion is a FULL completion for the historical-success signal - numerator AND
  // denominator. The task really is done; nothing about doing it away from the app makes it a
  // lesser success. The `notes='self_completed'` marker stays the hook for DURATION-weighted
  // aggregates, which are the ones that must exclude it (there is no episode to time).
  it('counts a self-completion as a completion, numerator and denominator both', async () => {
    const task = await tasks.create({ title: 'Posted the letter', estimatedDuration: 10 });
    await recurrence.create(task.id, { type: 'unscheduled' });

    await selfCompleteTask(deps, task.id);
    const after = await tasks.getById(task.id);
    expect(after?.completionCount).toBe(1);
    expect(after?.skipCount).toBe(0);
    expect(after?.successRate).toBeCloseTo(1, 10);

    // It is indistinguishable from an in-app completion in the COUNTERS, and distinguishable
    // only through the interactions marker - exactly the split task 44 section 3 asked for.
    const rows = (
      await conn.execute(
        `SELECT i.notes, i.duration_minutes, i.session_id
           FROM interactions i
           JOIN interaction_tasks it ON it.interaction_id = i.id
          WHERE it.task_id = ?`,
        [task.id],
      )
    ).rows as unknown as Array<{ notes: string | null; duration_minutes: number | null; session_id: string | null }>;
    expect(rows.map((r) => r.notes)).toEqual([SELF_COMPLETED_MARKER]);
    expect(rows[0].duration_minutes).toBeNull();
    expect(rows[0].session_id).toBeNull();
  });

  it('is not double-counted: one self-completion is one attempt, not two', async () => {
    const task = await tasks.create({ title: 'Watered plants', estimatedDuration: 5 });
    await recurrence.create(task.id, { type: 'unscheduled' });
    await selfCompleteTask(deps, task.id);
    await selfCompleteTask(deps, task.id);
    expect((await tasks.getById(task.id))?.completionCount).toBe(2);
    expect((await tasks.getById(task.id))?.successRate).toBeCloseTo(1, 10);
  });
});
