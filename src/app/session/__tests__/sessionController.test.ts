// Task 24 — the session controller against real SQLite and the real engine. These are the tests
// that pin the CONTRACTS the brief says are easiest to get wrong: the `sessions` row's birth
// status, park-is-not-a-skip surviving the surface layer, backgrounding never pausing, the alarm
// seam actually being driven, and the three recovery routings.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createCoachingRepository } from '../../../db/repositories/coaching';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { createInteractionsRepository } from '../../../db/repositories/interactions';
import { createRecurrenceRepository } from '../../../db/repositories/recurrence';
import { createRuntimeRepository } from '../../../db/repositories/runtime';
import { createSessionsRepository } from '../../../db/repositories/sessions';
import { createTasksRepository } from '../../../db/repositories/tasks';
import { MS_PER_MINUTE, type EpisodeExpiryScheduler, type EpisodeServiceDeps } from '../../../execution';
import type { PlanningRepositories } from '../../../planning/service';
import type { Task } from '../../../types/domain';
import { createSessionController, formatClock } from '../sessionController';

const min = (n: number) => n * MS_PER_MINUTE;

function makeScheduler(): EpisodeExpiryScheduler & { scheduled: number[]; cancels: number } {
  const calls = {
    scheduled: [] as number[],
    cancels: 0,
    schedule(atMs: number) {
      calls.scheduled.push(atMs);
    },
    cancel() {
      calls.cancels += 1;
    },
  };
  return calls;
}

describe('session controller (task 24)', () => {
  let conn: TestSqliteConnection;
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
  let scheduler: ReturnType<typeof makeScheduler>;
  let clock: number;

  const now = () => clock;

  function controller() {
    return createSessionController({
      episode,
      planning,
      catalog: repos.tasks,
      sessions: repos.sessions,
      recurrence: { tasks: repos.tasks, recurrence: repos.recurrence },
      now,
      // Deterministic: the novelty shuffle is proportional sampling, and a test that re-rolls
      // the agenda between runs is a flake generator, not a test.
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

  /** Drives the check-in end to end and lands on the first task. */
  async function startSession(ctl: ReturnType<typeof controller>, minutes = 30) {
    await ctl.begin();
    ctl.setEnergy('med');
    ctl.setDuration(minutes, 'moderate');
    await ctl.setContexts([]);
    return ctl.getState();
  }

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repos = {
      tasks: createTasksRepository(conn),
      recurrence: createRecurrenceRepository(conn),
      interactions: createInteractionsRepository(conn),
      sessions: createSessionsRepository(conn),
      coaching: createCoachingRepository(conn),
      dependencies: createDependenciesRepository(conn),
      runtime: createRuntimeRepository(conn),
    };
    scheduler = makeScheduler();
    episode = {
      tasks: repos.tasks,
      recurrence: repos.recurrence,
      interactions: repos.interactions,
      sessions: repos.sessions,
      coaching: repos.coaching,
      runtime: repos.runtime,
      scheduler,
    };
    planning = {
      tasks: repos.tasks,
      dependencies: repos.dependencies,
      coaching: repos.coaching,
    };
    clock = Date.now();
  });

  afterEach(() => conn.close());

  describe('starting a session (the 13/24 boundary)', () => {
    it('creates the sessions row BORN abandoned, with energy projected through scales', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);

      const row = await repos.sessions.getById('sess-1');
      // Constraint #14: `sessions.status` has no in-progress value, so a running session must
      // carry a terminal one, and a crash must leave the truthful thing behind.
      expect(row?.status).toBe('abandoned');
      expect(row?.sessionType).toBe('moderate');
      expect(row?.plannedDuration).toBe(30);
      // Constraint #6: 'med' → internal 3. A raw user-facing value must never reach the column.
      expect(row?.userEnergyStart).toBe(3);
    });

    it('hands the clock to task 13 and lands on a task with a hidden plan behind it', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);

      const runtime = await repos.runtime.getSessionRuntime('sess-1');
      expect(runtime?.plannedEndAtMs).toBe(runtime!.startedAtMs + min(30));
      expect(ctl.getState().phase.kind).toBe('work');
    });

    it('routes to the tools check first when the task needs something', async () => {
      await makeTask({ title: 'Call dentist', toolRequirements: ['phone'] });
      const ctl = controller();
      await startSession(ctl);
      expect(ctl.getState().phase.kind).toBe('tools');
    });

    // Task 36 — session start is the sweep's second seam. The app can sit open for days, so the
    // plan has to be built against today's due dates rather than the ones that were current when
    // the process started.
    it('sweeps recurrence before planning, so the plan sees today’s due dates', async () => {
      const task = await makeTask({ title: 'Bins out' });
      await repos.tasks.update(task.id, { nextDueAt: '2020-01-01' });
      await repos.recurrence.create(task.id, {
        type: 'scheduled',
        scheduledDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      });

      await controller().begin();

      const after = await repos.tasks.getById(task.id);
      expect(after!.nextDueAt).not.toBe('2020-01-01');
    });

    it('still opens the check-in when the sweep fails, rather than costing the user a session', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const ctl = createSessionController({
        episode,
        planning,
        catalog: repos.tasks,
        sessions: repos.sessions,
        recurrence: {
          tasks: repos.tasks,
          recurrence: {
            ...repos.recurrence,
            listSweepable: async () => {
              throw new Error('sweep exploded');
            },
          },
        },
        now,
        rng: () => 0,
        newSessionId: () => 'sess-1',
      });

      await ctl.begin();

      // The check-in opens regardless; a failed repair pass costs today's due dates, not the
      // session. It is LOGGED rather than shown, because `setPhase` clears the error banner on
      // every phase change by design — silent failure was a Phase B finding, so the log matters.
      expect(ctl.getState().phase.kind).toBe('check_in_energy');
      expect(warn).toHaveBeenCalledWith('[todoAI] session step failed:', expect.any(Error));
      warn.mockRestore();
    });

    it('reports plan_empty rather than pretending, when nothing is eligible', async () => {
      await makeTask({ title: 'Garage', contextTags: ['garage'] });
      const ctl = controller();
      await ctl.begin();
      ctl.setEnergy('med');
      ctl.setDuration(30, 'moderate');
      await ctl.setContexts(['office']); // the garage task is unreachable from here
      const phase = ctl.getState().phase;
      expect(phase.kind).toBe('plan_empty');
      if (phase.kind === 'plan_empty') expect(phase.outcome).toBe('no_eligible_tasks');
    });
  });

  describe('the block', () => {
    it('opens an episode and schedules the alarm at the block end', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');

      await ctl.beginBlock(phase.item);
      const open = await repos.runtime.getActiveEpisode();
      expect(open?.taskId).toBe(phase.item.task.id);
      // Constraint #13's seam: the engine decided WHEN; the platform call is task 24's.
      expect(scheduler.scheduled).toEqual([open!.blockEndAtMs]);
    });

    it('does NOT pause when the app returns to the foreground', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);

      clock += min(2); // two minutes elsewhere on the phone — music, a call, anything
      await ctl.onForeground();

      const open = await repos.runtime.getActiveEpisode();
      expect(open?.pausedAtMs).toBeNull();
      expect(open?.pauseCount).toBe(0);
      const timer = await ctl.readTimer();
      // The time away counted as worked, because backgrounding is not abandonment.
      expect(timer?.workedMs).toBe(min(2));
    });

    it('raises the prompt on return when the boundary passed while away', async () => {
      await makeTask({ title: 'Mix track', estimatedDuration: 5 });
      const ctl = controller();
      await startSession(ctl);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);

      clock += min(6);
      await ctl.onForeground();
      expect(ctl.getState().phase.kind).toBe('prompt');
    });

    it('offers five options at a real boundary and three when ending early', async () => {
      await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      const ctl = controller();
      await startSession(ctl);
      const work = ctl.getState().phase;
      if (work.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(work.item);

      clock += min(2);
      await ctl.requestEndOfBlock(work.item);
      const early = ctl.getState().phase;
      if (early.kind !== 'prompt') throw new Error('expected prompt');
      expect(early.atBoundary).toBe(false);
      // "+5" and "Keep going" answer "the block ran out"; that is not the question here.
      expect(early.prompt.options).toEqual(['done', 'park', 'easier']);

      clock += min(10);
      await ctl.requestEndOfBlock(work.item);
      const atBoundary = ctl.getState().phase;
      if (atBoundary.kind !== 'prompt') throw new Error('expected prompt');
      expect(atBoundary.atBoundary).toBe(true);
      expect(atBoundary.prompt.options).toEqual([
        'done',
        'short_extension',
        'keep_going',
        'park',
        'easier',
      ]);
    });

    it('offers skip instead of park inside the 60-second gate', async () => {
      await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      const ctl = controller();
      await startSession(ctl);
      const work = ctl.getState().phase;
      if (work.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(work.item);

      clock += 30_000;
      await ctl.requestEndOfBlock(work.item);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'prompt') throw new Error('expected prompt');
      expect(phase.prompt.options).toContain('skip');
      expect(phase.prompt.options).not.toContain('park');
    });
  });

  describe('the dispositions', () => {
    async function openBlockOn(title: string, minutes = 25) {
      await makeTask({ title, estimatedDuration: minutes });
      const ctl = controller();
      await startSession(ctl, 60);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);
      clock += min(5);
      return { ctl, taskId: phase.item.task.id };
    }

    it('done folds the completion and counts it on the session', async () => {
      const { ctl, taskId } = await openBlockOn('Mix track');
      await ctl.done();

      const task = await repos.tasks.getById(taskId);
      expect(task?.status).toBe('completed');
      expect(task?.actualDurationHistory).toEqual([5]);
      const row = await repos.sessions.getById('sess-1');
      expect(row?.tasksCompleted).toBe(1);
      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
      expect(scheduler.cancels).toBeGreaterThan(0);
    });

    it('park keeps the progress and writes NO skip (constraint #11)', async () => {
      const { ctl, taskId } = await openBlockOn('Mix track');
      await ctl.park();

      const task = await repos.tasks.getById(taskId);
      expect(task?.accumulatedMinutes).toBe(5);
      expect(task?.workState).toBe('in_progress');
      expect(task?.status).toBe('active');
      // The whole point: nothing on the skip path moved.
      expect(task?.skipCount).toBe(0);
      expect(task?.skipReasons).toEqual([]);
      const row = await repos.sessions.getById('sess-1');
      expect(row?.tasksProgressed).toBe(1);
      expect(row?.tasksSkipped).toBe(0);
      const queue = await repos.coaching.priorityQueue();
      expect(queue).toHaveLength(0);
    });

    it('skip records the decline and queues the follow-up', async () => {
      const { ctl, taskId } = await openBlockOn('Mix track');
      await ctl.skip('boring');

      const task = await repos.tasks.getById(taskId);
      expect(task?.skipCount).toBe(1);
      expect(task?.skipReasons).toEqual(['boring']);
      const queue = await repos.coaching.priorityQueue();
      expect(queue.map((entry) => entry.triggerType)).toContain('task_skipped');
    });

    it('declining a task that was never STARTED still records the skip', async () => {
      // The work screen offers "Not this one" before the block begins. The engine's disposition
      // calls all require an open episode, so this used to throw and the button did nothing.
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl, 60);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      expect(phase.episodeOpen).toBe(false);

      await ctl.skip('not now');

      const task = await repos.tasks.getById(phase.item.task.id);
      expect(task?.skipCount).toBe(1);
      expect(task?.skipReasons).toEqual(['not now']);
      expect((await repos.sessions.getById('sess-1'))?.tasksSkipped).toBe(1);
      expect(await repos.coaching.priorityQueue()).not.toHaveLength(0);
      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
    });

    it('the third skip in a session interrupts rather than serving another task', async () => {
      // Short enough that none is "major", so the plan is a flat run of tasks with no deep-focus
      // block and therefore no break to walk past — the skip sequence is what is under test here.
      for (const title of ['One', 'Two', 'Three', 'Four']) {
        await makeTask({ title, estimatedDuration: 5 });
      }
      const ctl = controller();
      await startSession(ctl, 90);

      for (let i = 0; i < 3; i++) {
        const phase = ctl.getState().phase;
        if (phase.kind !== 'work') throw new Error(`expected work, got ${phase.kind}`);
        await ctl.beginBlock(phase.item);
        clock += 5_000;
        await ctl.skip();
      }

      // spec §7.2: stop serving tasks and talk about what they can take on right now.
      const phase = ctl.getState().phase;
      expect(phase.kind).toBe('coaching_interrupt');
      if (phase.kind === 'coaching_interrupt') {
        expect(phase.trigger).toBe('session_recalibration');
      }
      // The session is closed before the conversation — a fresh one afterwards is the rematch.
      expect((await repos.sessions.getById('sess-1'))?.status).toBe('completed');
      expect((await repos.sessions.getById('sess-1'))?.tasksSkipped).toBe(3);
      const queue = await repos.coaching.priorityQueue();
      expect(queue.map((entry) => entry.triggerType)).toContain('session_recalibration');
    });

    it('the escape valve works before the block starts too', async () => {
      await makeTask({ title: 'Long thing', estimatedDuration: 40 });
      await makeTask({ title: 'Short thing', estimatedDuration: 10 });
      const ctl = controller();
      await startSession(ctl, 90);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');

      await ctl.somethingEasier();

      // Never started ⇒ 0 ms worked ⇒ past no gate ⇒ the engine reads the escape as a skip, which
      // is the honest disposition for a task the user declined without opening.
      expect((await repos.sessions.getById('sess-1'))?.escapeValveUsed).toBe(true);
      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
    });

    it('the escape valve marks the session and replans the tail', async () => {
      await makeTask({ title: 'Long thing', estimatedDuration: 40 });
      await makeTask({ title: 'Short thing', estimatedDuration: 10 });
      const ctl = controller();
      await startSession(ctl, 90);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);
      clock += min(5);

      await ctl.somethingEasier();
      const row = await repos.sessions.getById('sess-1');
      expect(row?.escapeValveUsed).toBe(true);
    });
  });

  describe('the two extends (constraint #12)', () => {
    async function openBlockOn() {
      await makeTask({ title: 'Mix track', estimatedDuration: 25 });
      const ctl = controller();
      await startSession(ctl, 60);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);
      return { ctl, item: phase.item };
    }

    it('+5 is flat, leaves the face alone and never sets extended', async () => {
      const { ctl, item } = await openBlockOn();
      const before = (await repos.runtime.getActiveEpisode())!;
      await ctl.plusFive(item);
      const after = (await repos.runtime.getActiveEpisode())!;

      expect(after.blockEndAtMs).toBe(before.blockEndAtMs + min(5));
      expect(after.hyperfocusQuanta).toBe(0);
      expect((await ctl.readTimer())?.face).toBe('countdown');
      expect((await repos.sessions.getById('sess-1'))?.extended).toBe(false);
      expect(ctl.getState().phase.kind).toBe('work');
    });

    it('keep going adds a quantum and flips the face to count-up', async () => {
      const { ctl, item } = await openBlockOn();
      const before = (await repos.runtime.getActiveEpisode())!;
      await ctl.keepGoing(item);
      const after = (await repos.runtime.getActiveEpisode())!;

      expect(after.blockEndAtMs).toBe(before.blockEndAtMs + min(25));
      expect(after.hyperfocusQuanta).toBe(1);
      expect((await ctl.readTimer())?.face).toBe('countup');
    });
  });

  describe('ending', () => {
    it('closeSession overwrites the born-abandoned status', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);
      clock += min(12);
      await ctl.finish();

      const row = await repos.sessions.getById('sess-1');
      expect(row?.status).toBe('completed');
      expect(row?.actualDuration).toBe(12);
      expect(row?.completedAt).not.toBeNull();
      // No phantom crash signal survives a clean end.
      expect(await repos.runtime.getSessionRuntime('sess-1')).toBeUndefined();
      expect(ctl.getState().phase.kind).toBe('summary');
    });

    it('records the end-of-session energy through scales', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);
      await ctl.finish();
      await ctl.recordEndEnergy('low');
      expect((await repos.sessions.getById('sess-1'))?.userEnergyEnd).toBe(1);
    });
  });

  describe('quick-start (task 44 §3)', () => {
    /** Drives the check-in end to end for a specific task, mirroring `startSession` above. */
    async function quickStart(ctl: ReturnType<typeof controller>, taskId: number, minutes = 30) {
      await ctl.beginQuickStart(taskId);
      ctl.setEnergy('med');
      ctl.setDuration(minutes, 'moderate');
      await ctl.setContexts([]);
      return ctl.getState();
    }

    it('writes origin=quickstart on the sessions row (migration 007)', async () => {
      const task = await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await quickStart(ctl, task.id);
      expect((await repos.sessions.getById('sess-1'))?.origin).toBe('quickstart');
    });

    it('an ordinary begin() writes origin=planned', async () => {
      await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl);
      expect((await repos.sessions.getById('sess-1'))?.origin).toBe('planned');
    });

    it('serves exactly the requested task, ignoring the rest of the pool', async () => {
      const target = await makeTask({ title: 'Target task' });
      await makeTask({ title: 'Some other task' });
      const ctl = controller();
      const state = await quickStart(ctl, target.id);
      expect(state.phase.kind === 'work' && state.phase.item.task.id).toBe(target.id);
    });

    it('goes straight to work when the task passes the mirrored predicates', async () => {
      const task = await makeTask({ title: 'Mix track', estimatedDuration: 10, contextTags: [] });
      const ctl = controller();
      const state = await quickStart(ctl, task.id, 30);
      expect(state.phase.kind).toBe('work');
    });

    it('warns — naming the specific condition — when context would have filtered it out', async () => {
      const task = await makeTask({ title: 'Mix track', contextTags: ['studio'] });
      const ctl = controller();
      const state = await quickStart(ctl, task.id, 30); // check-in contexts: []
      expect(state.phase.kind).toBe('quick_start_warning');
      if (state.phase.kind === 'quick_start_warning') {
        expect(state.phase.reasons.join(' ')).toMatch(/context/);
        expect(state.phase.reasons.join(' ')).toMatch(/studio/);
      }
    });

    it('routes a tool-requiring task through the ordinary ToolsCheckScreen, same as any session', async () => {
      // Tools are never a check-in-time filter in this codebase (see quickStartReasons's own
      // comment) — the real check is the per-task tools screen, which quick-start reaches exactly
      // like an ordinary session because `serveQuickStartTask` builds a real AgendaTaskItem.
      const task = await makeTask({ title: 'Edit video', toolRequirements: ['laptop'] });
      const ctl = controller();
      const state = await quickStart(ctl, task.id, 30);
      expect(state.phase.kind).toBe('tools');
    });

    it('ends the session (rather than replanning the whole pool) when tools are declined missing', async () => {
      const task = await makeTask({ title: 'Edit video', toolRequirements: ['laptop'] });
      await makeTask({ title: 'Another easy task' });
      const ctl = controller();
      const state = await quickStart(ctl, task.id, 30);
      expect(state.phase.kind).toBe('tools');
      const item = (state.phase as { item: import('../../../planning/agenda').AgendaTaskItem }).item;
      await ctl.toolsMissing(item);
      expect(ctl.getState().phase.kind).toBe('summary');
    });

    it('warns when the task does not fit the planned duration', async () => {
      const task = await makeTask({ title: 'Long thing', estimatedDuration: 90 });
      const ctl = controller();
      const state = await quickStart(ctl, task.id, 10);
      expect(state.phase.kind).toBe('quick_start_warning');
      if (state.phase.kind === 'quick_start_warning') {
        expect(state.phase.reasons.join(' ')).toMatch(/fit/);
      }
    });

    it('proceedQuickStart goes ahead anyway, informed rather than blocked', async () => {
      const task = await makeTask({ title: 'Mix track', contextTags: ['studio'] });
      const ctl = controller();
      await quickStart(ctl, task.id, 30);
      await ctl.proceedQuickStart();
      const state = ctl.getState();
      expect(state.phase.kind).toBe('work');
    });

    it('cancelQuickStart ends the session cleanly (the back-out)', async () => {
      const task = await makeTask({ title: 'Mix track', contextTags: ['studio'] });
      const ctl = controller();
      await quickStart(ctl, task.id, 30);
      await ctl.cancelQuickStart();
      expect(ctl.getState().phase.kind).toBe('summary');
      expect((await repos.sessions.getById('sess-1'))?.status).toBe('completed');
    });

    it('is one task long: finishing the task ends the session rather than serving another', async () => {
      const task = await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      await makeTask({ title: 'Another task' });
      const ctl = controller();
      await quickStart(ctl, task.id, 30);
      await ctl.beginBlock((ctl.getState().phase as { item: import('../../../planning/agenda').AgendaTaskItem }).item);
      await ctl.done();
      expect(ctl.getState().phase.kind).toBe('summary');
    });

    it('the escape valve does not pull in the rest of the pool mid quick-start', async () => {
      const task = await makeTask({ title: 'Mix track', estimatedDuration: 10 });
      await makeTask({ title: 'Another easy task', estimatedDuration: 5 });
      const ctl = controller();
      await quickStart(ctl, task.id, 30);
      const item = (ctl.getState().phase as { item: import('../../../planning/agenda').AgendaTaskItem }).item;
      await ctl.beginBlock(item);
      await ctl.somethingEasier();
      // Ruling §5's reasoning: quick-start bypasses runSelectionBoundary entirely, so the escape
      // valve must not silently reintroduce it — the session simply ends.
      expect(ctl.getState().phase.kind).toBe('summary');
    });
  });

  describe('recovery routing', () => {
    it('resume_block re-opens the SAME block end rather than handing back the dead minutes', async () => {
      await makeTask({ title: 'Mix track', estimatedDuration: 25 });
      const ctl = controller();
      await startSession(ctl, 60);
      const phase = ctl.getState().phase;
      if (phase.kind !== 'work') throw new Error('expected work');
      await ctl.beginBlock(phase.item);
      const original = (await repos.runtime.getActiveEpisode())!;

      clock += min(3);
      const resumed = controller();
      await resumed.adoptRecoveredSession({
        sessionId: 'sess-1',
        creditedMinutes: 3,
        directive: {
          kind: 'resume_block',
          taskId: phase.item.task.id,
          blockEndAtMs: original.blockEndAtMs,
          blockKind: 'countdown',
          plannedMinutes: 25,
        },
      });

      expect(resumed.getState().phase.kind).toBe('work');
      expect((await repos.runtime.getActiveEpisode())?.blockEndAtMs).toBe(original.blockEndAtMs);
    });

    it('block_expired asks what to do rather than inventing a disposition', async () => {
      const task = await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl, 60);

      const recovered = controller();
      await recovered.adoptRecoveredSession({
        sessionId: 'sess-1',
        creditedMinutes: 4,
        directive: { kind: 'block_expired', taskId: task.id },
      });
      const phase = recovered.getState().phase;
      expect(phase.kind).toBe('recovered');
      if (phase.kind === 'recovered') {
        expect(phase.creditedMinutes).toBe(4);
        expect(phase.task.id).toBe(task.id);
      }
      // Nothing was opened, nothing was written: the engine already parked it at launch.
      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
    });

    it('"leave it for later" writes nothing at all — recovery already parked it', async () => {
      const task = await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl, 60);
      const recovered = controller();
      await recovered.adoptRecoveredSession({
        sessionId: 'sess-1',
        creditedMinutes: 4,
        directive: { kind: 'block_expired', taskId: task.id },
      });

      await recovered.resolveRecovered(task, 'later');
      const after = await repos.tasks.getById(task.id);
      expect(after?.skipCount).toBe(0);
      expect(await repos.interactions.listTaskIdsBySession('sess-1')).toEqual([]);
      // It asks where the user is now, because the plan died with the process.
      expect(recovered.getState().phase.kind).toBe('check_in_context');
    });

    it('"it\'s done" completes the task through the normal fold', async () => {
      // Mirrors the device case: a task with credited work from the crash, then the user says it
      // was finished. The zero-length episode exists so the completion goes through completeTask
      // rather than around it — the fold must produce ONE history entry of the accumulated total.
      const task = await makeTask({ title: 'Mix track' });
      await repos.tasks.recordProgressEpisode(task.id, 2);
      const ctl = controller();
      await startSession(ctl, 60);
      const recovered = controller();
      await recovered.adoptRecoveredSession({
        sessionId: 'sess-1',
        creditedMinutes: 2,
        directive: { kind: 'block_expired', taskId: task.id },
      });

      const parked = (await repos.tasks.getById(task.id))!;
      await recovered.resolveRecovered(parked, 'done');

      const after = await repos.tasks.getById(task.id);
      expect(after?.status).toBe('completed');
      expect(after?.actualDurationHistory).toEqual([2]);
      expect(after?.accumulatedMinutes).toBe(0);
      expect(after?.workState).toBe('none');
      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
    });

    it('session_over goes straight to the summary', async () => {
      const task = await makeTask({ title: 'Mix track' });
      const ctl = controller();
      await startSession(ctl, 60);
      const recovered = controller();
      await recovered.adoptRecoveredSession({
        sessionId: 'sess-1',
        creditedMinutes: 9,
        directive: { kind: 'session_over', taskId: task.id },
      });
      expect(recovered.getState().phase.kind).toBe('summary');
    });
  });

  describe('formatClock', () => {
    it('renders mm:ss, and h:mm:ss once past an hour', () => {
      expect(formatClock(0)).toBe('00:00');
      expect(formatClock(65_000)).toBe('01:05');
      expect(formatClock(min(90))).toBe('1:30:00');
      expect(formatClock(-5_000)).toBe('00:00');
    });
  });
});
