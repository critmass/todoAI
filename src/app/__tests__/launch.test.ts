// Task 24 — the launch sequence. One of these tests exists purely to pin an ORDERING, because the
// ordering is the whole contract: `recoverOpenEpisode` runs before anything else reads anything.

import { createTestConnection, type TestSqliteConnection } from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createCoachingRepository } from '../../db/repositories/coaching';
import { createInteractionsRepository } from '../../db/repositories/interactions';
import { createRecurrenceRepository } from '../../db/repositories/recurrence';
import { createRuntimeRepository } from '../../db/repositories/runtime';
import { createSessionsRepository } from '../../db/repositories/sessions';
import { createTasksRepository } from '../../db/repositories/tasks';
import { MS_PER_MINUTE, startEpisode, startSessionRuntime, type EpisodeServiceDeps } from '../../execution';
import type { AgendaTaskItem } from '../../planning/agenda';
import type { CoachingPriorityQueueEntry } from '../../types/domain';
import { sweepDateFrom, type RecurrenceSweepDeps } from '../../services/recurrence';
import { pendingAtAppOpen, pendingAtSessionStart, runLaunchSequence } from '../launch';

const min = (n: number) => n * MS_PER_MINUTE;

function entry(
  overrides: Partial<CoachingPriorityQueueEntry> & Pick<CoachingPriorityQueueEntry, 'urgency'>,
): CoachingPriorityQueueEntry {
  return {
    id: 1,
    triggerType: 'task_skipped',
    triggerData: null,
    status: 'pending',
    createdAt: null,
    relatedTaskIds: [],
    relatedSessionIds: [],
    relatedExternalDependencyIds: [],
    ...overrides,
  };
}

describe('launch sequence (task 24)', () => {
  let conn: TestSqliteConnection;
  let deps: EpisodeServiceDeps;
  let recurrenceDeps: RecurrenceSweepDeps;
  let repos: {
    tasks: ReturnType<typeof createTasksRepository>;
    sessions: ReturnType<typeof createSessionsRepository>;
    coaching: ReturnType<typeof createCoachingRepository>;
    runtime: ReturnType<typeof createRuntimeRepository>;
    recurrence: ReturnType<typeof createRecurrenceRepository>;
  };
  let clock: number;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repos = {
      tasks: createTasksRepository(conn),
      sessions: createSessionsRepository(conn),
      coaching: createCoachingRepository(conn),
      runtime: createRuntimeRepository(conn),
      recurrence: createRecurrenceRepository(conn),
    };
    deps = {
      tasks: repos.tasks,
      recurrence: repos.recurrence,
      interactions: createInteractionsRepository(conn),
      sessions: repos.sessions,
      coaching: repos.coaching,
      runtime: repos.runtime,
    };
    recurrenceDeps = { tasks: repos.tasks, recurrence: repos.recurrence };
    clock = Date.now();
  });

  afterEach(() => conn.close());

  /** Leaves an open episode behind, the way a force-kill would. */
  async function leaveCrashSignal(blockMinutes: number, sessionMinutes: number) {
    const task = await repos.tasks.create({ title: 'Mix track', estimatedDuration: blockMinutes });
    await repos.sessions.create('sess-1', {
      sessionType: 'moderate',
      plannedDuration: sessionMinutes,
      status: 'abandoned',
    });
    await startSessionRuntime(deps, {
      sessionId: 'sess-1',
      startedAtMs: clock,
      plannedMinutes: sessionMinutes,
    });
    const item: AgendaTaskItem = {
      kind: 'task',
      task,
      blockKind: 'countdown',
      plannedMinutes: blockMinutes,
      deepFocus: false,
      resumeClaim: false,
    };
    await startEpisode(deps, { sessionId: 'sess-1', item, now: clock });
    return task;
  }

  it('recovers an open episode and routes to it, before any other decision', async () => {
    await leaveCrashSignal(25, 60);
    clock += min(3);

    const outcome = await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') return;
    expect(outcome.sessionId).toBe('sess-1');
    expect(outcome.directive.kind).toBe('resume_block');
    expect(outcome.creditedMinutes).toBe(3);
  });

  it('reads the crash signal BEFORE the coaching queue', async () => {
    await leaveCrashSignal(25, 60);
    const order: string[] = [];
    const watchedRuntime = {
      ...repos.runtime,
      getActiveEpisode: async () => {
        order.push('recovery');
        return repos.runtime.getActiveEpisode();
      },
    };
    const watchedCoaching = {
      priorityQueue: async () => {
        order.push('coaching');
        return repos.coaching.priorityQueue();
      },
    };

    await runLaunchSequence({
      episode: { ...deps, runtime: watchedRuntime },
      coaching: watchedCoaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });

    // A queue read that landed first would be reasoning about state the recovery has not
    // reconciled yet — the exact bug task 13 exists to prevent.
    expect(order[0]).toBe('recovery');
  });

  it('routes a block that expired while the app was dead', async () => {
    await leaveCrashSignal(5, 60);
    clock += min(9);

    const outcome = await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });
    expect(outcome.kind).toBe('recovered');
    if (outcome.kind === 'recovered') expect(outcome.directive.kind).toBe('block_expired');
  });

  it('routes to a queued conversation on a clean launch', async () => {
    await repos.coaching.create({ triggerType: 'app_reorientation', urgency: 'next_open' });
    const outcome = await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });
    expect(outcome.kind).toBe('coaching');
  });

  it('goes to the dashboard when nothing is waiting', async () => {
    const outcome = await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });
    expect(outcome.kind).toBe('dashboard');
  });

  it('does not let a crash queue anything', async () => {
    await leaveCrashSignal(25, 60);
    clock += min(3);
    await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      recurrence: recurrenceDeps,
      now: () => clock,
    });
    // A crash is not user failure: no skip, no pattern, nothing to talk about.
    expect(await repos.coaching.priorityQueue()).toHaveLength(0);
  });

  // Task 36 — app open is one of the sweep's two seams, and the ORDERING matters twice over: after
  // the crash recovery (like everything else), but before the branch that returns on a recovery.
  describe('the recurrence period sweep (task 36)', () => {
    async function scheduledTask(days: Array<'monday' | 'tuesday'>, nextDueAt: string | null) {
      const task = await repos.tasks.create({ title: 'Bins out', estimatedDuration: 10, nextDueAt });
      await repos.recurrence.create(task.id, { type: 'scheduled', scheduledDays: days });
      return task.id;
    }

    it('brings a stale due date up to date on a clean launch', async () => {
      const id = await scheduledTask(['monday', 'tuesday'], '2020-01-01');

      await runLaunchSequence({
        episode: deps,
        coaching: repos.coaching,
        recurrence: recurrenceDeps,
        now: () => clock,
      });

      const after = await repos.tasks.getById(id);
      expect(after!.nextDueAt).not.toBe('2020-01-01');
      expect(after!.nextDueAt! >= sweepDateFrom(clock)).toBe(true);
    });

    it('sweeps even when the launch ends in a crash recovery', async () => {
      // The recovered branch returns early. A sweep placed after it would never run for the user
      // who relaunches straight into a recovered session — which is exactly the user most likely to
      // have been away.
      const id = await scheduledTask(['monday', 'tuesday'], '2020-01-01');
      await leaveCrashSignal(25, 60);
      clock += min(3);

      const outcome = await runLaunchSequence({
        episode: deps,
        coaching: repos.coaching,
        recurrence: recurrenceDeps,
        now: () => clock,
      });

      expect(outcome.kind).toBe('recovered');
      expect((await repos.tasks.getById(id))!.nextDueAt).not.toBe('2020-01-01');
    });

    it('runs AFTER the crash recovery, never before it', async () => {
      await leaveCrashSignal(25, 60);
      const order: string[] = [];
      const watchedRuntime = {
        ...repos.runtime,
        getActiveEpisode: async () => {
          order.push('recovery');
          return repos.runtime.getActiveEpisode();
        },
      };
      const watchedRecurrence: RecurrenceSweepDeps = {
        tasks: recurrenceDeps.tasks,
        recurrence: {
          ...recurrenceDeps.recurrence,
          listSweepable: async () => {
            order.push('sweep');
            return recurrenceDeps.recurrence.listSweepable();
          },
        },
      };

      await runLaunchSequence({
        episode: { ...deps, runtime: watchedRuntime },
        coaching: repos.coaching,
        recurrence: watchedRecurrence,
        now: () => clock,
      });

      expect(order).toEqual(['recovery', 'sweep']);
    });

    it('is idempotent across two launches in the same second', async () => {
      const id = await scheduledTask(['monday', 'tuesday'], null);
      const launch = () =>
        runLaunchSequence({
          episode: deps,
          coaching: repos.coaching,
          recurrence: recurrenceDeps,
          now: () => clock,
        });

      await launch();
      const afterFirst = (await repos.tasks.getById(id))!.nextDueAt;
      await launch();

      expect((await repos.tasks.getById(id))!.nextDueAt).toBe(afterFirst);
    });
  });

  describe('the urgency tiers decide which seam a conversation belongs to', () => {
    it('an app open takes immediate and next_open, never next_start', () => {
      expect(pendingAtAppOpen([entry({ urgency: 'next_start' })])).toBeNull();
      expect(pendingAtAppOpen([entry({ urgency: 'next_open' })])).not.toBeNull();
      expect(pendingAtAppOpen([entry({ urgency: 'immediate' })])).not.toBeNull();
    });

    it('a session start takes immediate and next_start, never next_open', () => {
      expect(pendingAtSessionStart([entry({ urgency: 'next_open' })])).toBeNull();
      expect(pendingAtSessionStart([entry({ urgency: 'next_start' })])).not.toBeNull();
      expect(pendingAtSessionStart([entry({ urgency: 'immediate' })])).not.toBeNull();
    });
  });
});
