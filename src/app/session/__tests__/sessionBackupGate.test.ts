// Task 14 §13 — the pre-session backup GATE, wired into the session controller. These drive the
// controller against task 14's file-backed `DbOperations` double (the same one the backup service's
// own suites use), so all three gate branches run for real: a healthy start takes a `pre_session`
// backup and proceeds; `setDiskFull` produces the true no-space block; `setQueryFault` on
// `quick_check` produces the integrity block. The load-bearing contract (constraint #14, brief §2):
// a BLOCK leaves NO `sessions` row behind, because the gate runs before `sessions.create`.
//
// Both entry points are covered — the planned flow (`startSession`) and quick-start
// (`startQuickStartSession`) — because both pass through `createSessionRow`, which is where the gate
// sits. The device session confirmed quick-start is a normal session start that must be as
// protected as any other.

import { createFixture, seedWorking, type Fixture } from '../../../db/testUtils/backupFixture';
import { createCoachingRepository } from '../../../db/repositories/coaching';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { createInteractionsRepository } from '../../../db/repositories/interactions';
import { createRecurrenceRepository } from '../../../db/repositories/recurrence';
import { createRuntimeRepository } from '../../../db/repositories/runtime';
import { createSessionsRepository } from '../../../db/repositories/sessions';
import { createTasksRepository } from '../../../db/repositories/tasks';
import type { EpisodeExpiryScheduler, EpisodeServiceDeps } from '../../../execution';
import type { PlanningRepositories } from '../../../planning/service';
import type { ManagedDb } from '../../../services/backup';
import type { Task } from '../../../types/domain';
import { createSessionController } from '../sessionController';

function makeScheduler(): EpisodeExpiryScheduler {
  return { schedule() {}, cancel() {} };
}

describe('pre-session backup gate wired into the session controller (task 14 §13)', () => {
  let fixture: Fixture;
  let working: ManagedDb;
  let repos: {
    tasks: ReturnType<typeof createTasksRepository>;
    recurrence: ReturnType<typeof createRecurrenceRepository>;
    interactions: ReturnType<typeof createInteractionsRepository>;
    sessions: ReturnType<typeof createSessionsRepository>;
    coaching: ReturnType<typeof createCoachingRepository>;
    dependencies: ReturnType<typeof createDependenciesRepository>;
    runtime: ReturnType<typeof createRuntimeRepository>;
  };
  let episode: EpisodeServiceDeps;
  let planning: PlanningRepositories;
  let clock: number;

  const now = () => clock;

  function controller(withGate = true) {
    return createSessionController({
      episode,
      planning,
      catalog: repos.tasks,
      sessions: repos.sessions,
      recurrence: { tasks: repos.tasks, recurrence: repos.recurrence },
      backup: withGate ? { ops: fixture.ops, config: fixture.config, working } : undefined,
      now,
      rng: () => 0.5,
      newSessionId: () => 'sess-1',
    });
  }

  async function makeTask(overrides: Partial<Task> & { title: string }): Promise<Task> {
    return repos.tasks.create({
      estimatedDuration: 25,
      contextTags: [],
      toolRequirements: [],
      ...overrides,
    });
  }

  async function startSession(ctl: ReturnType<typeof controller>, minutes = 30) {
    await ctl.begin();
    ctl.setEnergy('med');
    ctl.setDuration(minutes, 'moderate');
    await ctl.setContexts([]);
    return ctl.getState();
  }

  async function quickStart(ctl: ReturnType<typeof controller>, taskId: number, minutes = 30) {
    await ctl.beginQuickStart(taskId);
    ctl.setEnergy('med');
    ctl.setDuration(minutes, 'moderate');
    await ctl.setContexts([]);
    return ctl.getState();
  }

  beforeEach(async () => {
    fixture = createFixture();
    working = await seedWorking(fixture, 0); // migrated, empty; tasks are seeded through the repo
    repos = {
      tasks: createTasksRepository(working),
      recurrence: createRecurrenceRepository(working),
      interactions: createInteractionsRepository(working),
      sessions: createSessionsRepository(working),
      coaching: createCoachingRepository(working),
      dependencies: createDependenciesRepository(working),
      runtime: createRuntimeRepository(working),
    };
    episode = {
      tasks: repos.tasks,
      recurrence: repos.recurrence,
      interactions: repos.interactions,
      sessions: repos.sessions,
      coaching: repos.coaching,
      runtime: repos.runtime,
      scheduler: makeScheduler(),
    };
    planning = { tasks: repos.tasks, dependencies: repos.dependencies, coaching: repos.coaching };
    clock = Date.now();
  });

  afterEach(() => {
    working.close();
    fixture.cleanup();
  });

  describe('the planned flow (startSession)', () => {
    it('takes a pre_session backup and proceeds when there is space', async () => {
      await makeTask({ title: 'Mix track' });
      const state = await startSession(controller());

      expect(state.phase.kind).toBe('work');
      expect((await repos.sessions.getById('sess-1'))?.status).toBe('abandoned');
      // The gate actually wrote the snapshot the spec calls for, tagged pre_session.
      const log = await working.execute(
        "SELECT backup_type FROM backup_log WHERE success = 1 ORDER BY id DESC LIMIT 1",
      );
      expect(log.rows[0]?.backup_type).toBe('pre_session');
    });

    it('BLOCKS with reason no_space and writes NO session row when the disk is full', async () => {
      await makeTask({ title: 'Mix track' });
      fixture.ops.setDiskFull(true);
      const state = await startSession(controller());

      expect(state.phase.kind).toBe('blocked');
      if (state.phase.kind !== 'blocked') throw new Error('expected blocked');
      expect(state.phase.reason).toBe('no_space');
      expect(state.phase.detail.length).toBeGreaterThan(0);
      // Constraint #14 / brief §2: a blocked start leaves nothing behind.
      expect(await repos.sessions.getById('sess-1')).toBeUndefined();
      expect(await repos.runtime.getSessionRuntime('sess-1')).toBeUndefined();
      expect(state.sessionId).toBeNull();
    });

    it('BLOCKS with reason integrity when the pre-session quick_check fails', async () => {
      await makeTask({ title: 'Mix track' });
      // Make ONLY the gate's `PRAGMA quick_check` fail the way an unreadable page does.
      fixture.ops.setQueryFault((sql) => /quick_check/i.test(sql));
      const state = await startSession(controller());

      expect(state.phase.kind).toBe('blocked');
      if (state.phase.kind !== 'blocked') throw new Error('expected blocked');
      expect(state.phase.reason).toBe('integrity');
      expect(await repos.sessions.getById('sess-1')).toBeUndefined();
    });
  });

  describe('quick-start (task 44 §3) hits the same gate', () => {
    it('takes a pre_session backup and proceeds when there is space', async () => {
      const task = await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      const state = await quickStart(controller(), task.id);

      expect(state.phase.kind).toBe('work');
      expect((await repos.sessions.getById('sess-1'))?.origin).toBe('quickstart');
    });

    it('BLOCKS with reason no_space and writes NO session row when the disk is full', async () => {
      const task = await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      fixture.ops.setDiskFull(true);
      const state = await quickStart(controller(), task.id);

      expect(state.phase.kind).toBe('blocked');
      if (state.phase.kind !== 'blocked') throw new Error('expected blocked');
      expect(state.phase.reason).toBe('no_space');
      expect(await repos.sessions.getById('sess-1')).toBeUndefined();
    });
  });

  it('is skipped entirely when no backup bundle is injected (unchanged behaviour)', async () => {
    await makeTask({ title: 'Mix track' });
    // Disk full, but no gate wired: the session must start exactly as it did before task 14.
    fixture.ops.setDiskFull(true);
    const state = await startSession(controller(false));

    expect(state.phase.kind).toBe('work');
    expect((await repos.sessions.getById('sess-1'))?.status).toBe('abandoned');
  });
});
