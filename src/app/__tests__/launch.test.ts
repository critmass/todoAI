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
  let repos: {
    tasks: ReturnType<typeof createTasksRepository>;
    sessions: ReturnType<typeof createSessionsRepository>;
    coaching: ReturnType<typeof createCoachingRepository>;
    runtime: ReturnType<typeof createRuntimeRepository>;
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
    };
    deps = {
      tasks: repos.tasks,
      recurrence: createRecurrenceRepository(conn),
      interactions: createInteractionsRepository(conn),
      sessions: repos.sessions,
      coaching: repos.coaching,
      runtime: repos.runtime,
    };
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
      now: () => clock,
    });
    expect(outcome.kind).toBe('coaching');
  });

  it('goes to the dashboard when nothing is waiting', async () => {
    const outcome = await runLaunchSequence({
      episode: deps,
      coaching: repos.coaching,
      now: () => clock,
    });
    expect(outcome.kind).toBe('dashboard');
  });

  it('does not let a crash queue anything', async () => {
    await leaveCrashSignal(25, 60);
    clock += min(3);
    await runLaunchSequence({ episode: deps, coaching: repos.coaching, now: () => clock });
    // A crash is not user failure: no skip, no pattern, nothing to talk about.
    expect(await repos.coaching.priorityQueue()).toHaveLength(0);
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
