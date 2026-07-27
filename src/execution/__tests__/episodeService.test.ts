import { createTestConnection, type TestSqliteConnection } from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createCoachingRepository } from '../../db/repositories/coaching';
import { createInteractionsRepository } from '../../db/repositories/interactions';
import { createRecurrenceRepository } from '../../db/repositories/recurrence';
import { createRuntimeRepository } from '../../db/repositories/runtime';
import { createSessionsRepository } from '../../db/repositories/sessions';
import { createTasksRepository } from '../../db/repositories/tasks';
import type { AgendaTaskItem } from '../../planning/agenda';
import type { Task } from '../../types/domain';
import { MS_PER_MINUTE } from '../timer';
import { ParkGateError } from '../errors';
import {
  applyHyperfocusExtension,
  applyShortExtension,
  checkSessionLapse,
  closeSession,
  completeEpisode,
  currentTimer,
  endOfBlockPrompt,
  escapeToEasier,
  parkEpisode,
  pauseEpisode,
  recoverOpenEpisode,
  resumeEpisode,
  skipEpisode,
  startEpisode,
  startSessionRuntime,
  type EpisodeExpiryScheduler,
  type EpisodeServiceDeps,
} from '../episodeService';

const T0 = Date.UTC(2026, 6, 26, 9, 0, 0);
const min = (n: number) => n * MS_PER_MINUTE;
const SESSION = 's1';

/** Records what the alarm hook was asked to do — the scheduling side of "when a task timer
 *  expires the app takes focus like an alarm" (task 24 owns the presentation). */
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

describe('episode lifecycle (task 13)', () => {
  let conn: TestSqliteConnection;
  let deps: EpisodeServiceDeps;
  let scheduler: ReturnType<typeof makeScheduler>;
  // Full repositories for arranging and asserting; `deps` deliberately exposes only the narrow
  // slice the service is allowed to touch, so tests read the database through these instead.
  let repos: {
    tasks: ReturnType<typeof createTasksRepository>;
    sessions: ReturnType<typeof createSessionsRepository>;
    interactions: ReturnType<typeof createInteractionsRepository>;
    coaching: ReturnType<typeof createCoachingRepository>;
    runtime: ReturnType<typeof createRuntimeRepository>;
  };

  async function makeTask(overrides: { title?: string; estimatedDuration?: number } = {}): Promise<Task> {
    return repos.tasks.create({
      title: overrides.title ?? 'Mix track',
      estimatedDuration: overrides.estimatedDuration ?? 25,
    });
  }

  function item(task: Task, overrides: Partial<AgendaTaskItem> = {}): AgendaTaskItem {
    return {
      kind: 'task',
      task,
      blockKind: 'countdown',
      plannedMinutes: 25,
      deepFocus: false,
      resumeClaim: false,
      ...overrides,
    };
  }

  /** Pending coaching rows, newest last, with their trigger_data kind flattened for assertions. */
  async function queued(): Promise<Array<{ trigger: string; kind: unknown }>> {
    const rows = await repos.coaching.priorityQueue();
    return rows.map((r) => ({ trigger: r.triggerType, kind: r.triggerData?.kind }));
  }

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    scheduler = makeScheduler();
    repos = {
      tasks: createTasksRepository(conn),
      sessions: createSessionsRepository(conn),
      interactions: createInteractionsRepository(conn),
      coaching: createCoachingRepository(conn),
      runtime: createRuntimeRepository(conn),
    };
    deps = {
      tasks: repos.tasks,
      recurrence: createRecurrenceRepository(conn),
      interactions: repos.interactions,
      sessions: repos.sessions,
      coaching: repos.coaching,
      runtime: repos.runtime,
      scheduler,
    };
    // Task 24 creates the sessions row; a running session is born 'abandoned' because
    // sessions.status has no in-progress value — so a crash leaves the truthful status behind,
    // and closeSession overwrites it on a clean end.
    await repos.sessions.create(SESSION, {
      sessionType: 'deep_focus',
      plannedDuration: 90,
      status: 'abandoned',
    });
    await startSessionRuntime(deps, { sessionId: SESSION, startedAtMs: T0, plannedMinutes: 90 });
  });

  afterEach(() => conn.close());

  // ── Opening, pausing, the alarm hook ─────────────────────────────────────────────────────────

  describe('opening and pausing', () => {
    it('opens an episode against the agenda item and schedules the expiry alarm', async () => {
      const task = await makeTask();
      const episode = await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      expect(episode).toMatchObject({
        taskId: task.id,
        blockKind: 'countdown',
        plannedMinutes: 25,
        startedAtMs: T0,
        blockEndAtMs: T0 + min(25),
      });
      expect(scheduler.scheduled).toEqual([T0 + min(25)]);
    });

    it('pausing MOVES the block end on resume, so the interruption does not eat the block', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await pauseEpisode(deps, T0 + min(10));
      const resumed = await resumeEpisode(deps, T0 + min(17));

      expect(resumed.pausedMs).toBe(min(7));
      expect(resumed.pauseCount).toBe(1);
      expect(resumed.blockEndAtMs).toBe(T0 + min(32)); // 25 + the 7 paused
      // The persisted end-time is the timer: 15 minutes of block were left before the pause and
      // 15 are left after it.
      expect((await currentTimer(deps, T0 + min(17)))?.remainingMs).toBe(min(15));
      expect(scheduler.cancels).toBe(1);
      expect(scheduler.scheduled).toEqual([T0 + min(25), T0 + min(32)]);
    });

    it('pause and resume are both idempotent', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await pauseEpisode(deps, T0 + min(5));
      const twice = await pauseEpisode(deps, T0 + min(9));
      expect(twice.pauseCount).toBe(1);
      expect(twice.pausedAtMs).toBe(T0 + min(5));

      await resumeEpisode(deps, T0 + min(10));
      const resumedTwice = await resumeEpisode(deps, T0 + min(12));
      expect(resumedTwice.pausedMs).toBe(min(5));
    });
  });

  // ── The five-option prompt ───────────────────────────────────────────────────────────────────

  describe('the end-of-block prompt', () => {
    it('is silent before the boundary and offers all five options at it', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      expect(await endOfBlockPrompt(deps, T0 + min(24))).toBeNull();

      const prompt = await endOfBlockPrompt(deps, T0 + min(25));
      expect(prompt).toMatchObject({
        taskId: task.id,
        options: ['done', 'short_extension', 'keep_going', 'park', 'easier'],
        selfCareNudge: false,
      });
    });

    it('offers skip instead of park when the gate has not opened', async () => {
      const task = await makeTask();
      await startEpisode(deps, {
        sessionId: SESSION,
        item: item(task, { plannedMinutes: 0 }),
        now: T0,
      });
      const prompt = await endOfBlockPrompt(deps, T0);
      expect(prompt?.options).toContain('skip');
      expect(prompt?.options).not.toContain('park');
    });

    it('carries the self-care line on the second consecutive hyperfocus quantum', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await applyHyperfocusExtension(deps);
      expect((await endOfBlockPrompt(deps, T0 + min(50)))?.selfCareNudge).toBe(false);

      await applyHyperfocusExtension(deps);
      const second = await endOfBlockPrompt(deps, T0 + min(75));
      expect(second?.selfCareNudge).toBe(true);
      expect(second?.face).toBe('countup');
    });

    it('never carries the self-care line for a chain of +5 presses', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      for (let i = 0; i < 6; i++) await applyShortExtension(deps);

      const prompt = await endOfBlockPrompt(deps, T0 + min(55));
      expect(prompt?.selfCareNudge).toBe(false);
      expect(prompt?.face).toBe('countdown'); // and the face never changed either
    });
  });

  // ── Done ─────────────────────────────────────────────────────────────────────────────────────

  describe('Done — the completion path', () => {
    it('routes through completeTask, folding accumulated + this episode into ONE history entry', async () => {
      const task = await makeTask({ estimatedDuration: 60 });
      await repos.tasks.recordProgressEpisode(task.id, 40); // an earlier parked sitting
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await completeEpisode(deps, T0 + min(22));

      expect(result.outcome).toBe('completed');
      expect(result.episodeMinutes).toBe(22);
      expect(result.completion?.outcome).toEqual({ recurrence: 'one_off', closed: true });

      const after = await repos.tasks.getById(task.id);
      expect(after?.actualDurationHistory).toEqual([62]); // 40 parked + 22 this episode, ONE entry
      expect(after?.accumulatedMinutes).toBe(0);
      expect(after?.workState).toBe('none');
      expect(after?.status).toBe('completed');
    });

    it('writes a linked task_completion episode row and counts it on the session', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      const result = await completeEpisode(deps, T0 + min(25));

      const row = await repos.interactions.getById(result.interactionId);
      expect(row).toMatchObject({
        interactionType: 'task_completion',
        completionStatus: 'completed',
        sessionId: SESSION,
        durationMinutes: 25,
      });
      expect(await repos.interactions.listTaskIdsBySession(SESSION)).toEqual([task.id]);
      expect((await repos.sessions.getById(SESSION))?.tasksCompleted).toBe(1);
    });

    it('closes the runtime row and cancels the alarm', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      await completeEpisode(deps, T0 + min(25));

      expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
      expect(scheduler.cancels).toBe(1);
    });
  });

  // ── Park ─────────────────────────────────────────────────────────────────────────────────────

  describe('Pause for later — the park path', () => {
    it('accumulates minutes, marks in_progress, and counts in tasks_progressed', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await parkEpisode(deps, T0 + min(25));

      expect(result.outcome).toBe('progress');
      const after = await repos.tasks.getById(task.id);
      expect(after?.accumulatedMinutes).toBe(25);
      expect(after?.workState).toBe('in_progress');
      expect(after?.status).toBe('active'); // parked tasks stay in the pool
      expect(after?.lastWorkedAt).not.toBeNull(); // and the neglect clock re-anchors

      const session = await repos.sessions.getById(SESSION);
      expect(session?.tasksProgressed).toBe(1);
      expect(session?.tasksSkipped).toBe(0);
      expect(session?.tasksCompleted).toBe(0);
    });

    it('IS NEVER A SKIP: no skip_count, no coaching, no contribution to the 3-skip counter', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      for (let i = 0; i < 3; i++) {
        await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 + min(30 * i) });
        await parkEpisode(deps, T0 + min(30 * i + 25));
      }

      const after = await repos.tasks.getById(task.id);
      expect(after?.skipCount).toBe(0);
      expect(after?.skipReasons).toEqual([]);
      expect(after?.successRate).toBe(0);
      expect((await repos.sessions.getById(SESSION))?.tasksSkipped).toBe(0);
      // Three parks in one session enqueue nothing at all — not a skip row, not a recalibration.
      expect(await queued()).toEqual([]);
    });

    it('writes a task_progress / progress episode row', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      const result = await parkEpisode(deps, T0 + min(25));

      expect(await repos.interactions.getById(result.interactionId)).toMatchObject({
        interactionType: 'task_progress',
        completionStatus: 'progress',
        durationMinutes: 25,
      });
    });

    it('REFUSES inside the first minute rather than silently downgrading to a skip', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await expect(parkEpisode(deps, T0 + 30_000)).rejects.toThrow(ParkGateError);
      expect(await repos.runtime.getActiveEpisode()).toBeDefined(); // nothing was closed
      expect((await repos.tasks.getById(task.id))?.accumulatedMinutes).toBe(0);

      // One second later the gate is open and park is park, because the user says so.
      await expect(parkEpisode(deps, T0 + 60_000)).resolves.toMatchObject({ outcome: 'progress' });
    });
  });

  // ── Skip ─────────────────────────────────────────────────────────────────────────────────────

  describe('the skip path', () => {
    it('increments skip_count, queues task_skipped for next start, and retains accumulated time', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await repos.tasks.recordProgressEpisode(task.id, 40);
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await skipEpisode(deps, T0 + min(2), { reason: 'wrong headspace' });

      expect(result.outcome).toBe('skipped');
      const after = await repos.tasks.getById(task.id);
      expect(after?.skipCount).toBe(1);
      expect(after?.skipReasons).toEqual(['wrong headspace']);
      expect(after?.accumulatedMinutes).toBe(40); // declining now says nothing about earlier work
      expect(await queued()).toEqual([{ trigger: 'task_skipped', kind: undefined }]);
    });

    it('fires session_recalibration on the third skip in a session, once', async () => {
      const tasks = [await makeTask({ title: 'A' }), await makeTask({ title: 'B' }), await makeTask({ title: 'C' }), await makeTask({ title: 'D' })];
      for (const [i, task] of tasks.entries()) {
        await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 + min(i) });
        await skipEpisode(deps, T0 + min(i) + 10_000);
      }

      const recalibrations = (await queued()).filter((q) => q.trigger === 'session_recalibration');
      expect(recalibrations).toHaveLength(1); // fired at the 3rd, not again at the 4th
      expect((await repos.sessions.getById(SESSION))?.tasksSkipped).toBe(4);
    });
  });

  // ── +5 minutes ───────────────────────────────────────────────────────────────────────────────

  describe('+5 minutes — "I\'m almost done"', () => {
    it('moves the block end by five, leaves the face alone, and does NOT set sessions.extended', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await applyShortExtension(deps);

      expect(result.episode.blockEndAtMs).toBe(T0 + min(30));
      expect(result.episode.hyperfocusQuanta).toBe(0);
      expect(result.sessionExtended).toBe(false);
      expect((await repos.sessions.getById(SESSION))?.extended).toBe(false);
      expect((await currentTimer(deps, T0 + min(26)))?.face).toBe('countdown');
    });

    it('leaves the session end alone while there is slack ahead', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await applyShortExtension(deps);

      expect(result.sessionEndMoved).toBe(false);
      expect((await repos.runtime.getSessionRuntime(SESSION))?.plannedEndAtMs).toBe(T0 + min(90));
    });

    it('moves the session end only once the block end actually passes it — still not "extended"', async () => {
      const task = await makeTask();
      await startEpisode(deps, {
        sessionId: SESSION,
        item: item(task, { plannedMinutes: 88 }),
        now: T0,
      });

      const result = await applyShortExtension(deps);

      expect(result.sessionEndMoved).toBe(true);
      expect((await repos.runtime.getSessionRuntime(SESSION))?.plannedEndAtMs).toBe(T0 + min(93));
      // The flag means "the session ran long on hyperfocus". A +5 is definitionally not that.
      expect((await repos.sessions.getById(SESSION))?.extended).toBe(false);
    });

    it('is never capped: ten presses, ten extensions, no resistance and no coaching mid-flow', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      for (let i = 0; i < 10; i++) await applyShortExtension(deps);

      const episode = await repos.runtime.getActiveEpisode();
      expect(episode?.blockEndAtMs).toBe(T0 + min(75));
      expect(await repos.runtime.getExtensionLedger(SESSION, task.id)).toMatchObject({
        presses: 10,
        minutes: 50,
      });
      // The entire response happens later, at task close — never here.
      expect(await queued()).toEqual([]);
    });
  });

  // ── Keep going ───────────────────────────────────────────────────────────────────────────────

  describe('Keep going — hyperfocus', () => {
    it('adds a 25-minute quantum, chains, and switches the face to count-up', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await applyHyperfocusExtension(deps);
      const second = await applyHyperfocusExtension(deps);

      expect(second.episode.blockEndAtMs).toBe(T0 + min(75));
      expect(second.episode.hyperfocusQuanta).toBe(2);
      expect((await currentTimer(deps, T0 + min(30)))?.face).toBe('countup');
    });

    it('moves the session end and sets sessions.extended when it crosses', async () => {
      const task = await makeTask();
      await startEpisode(deps, {
        sessionId: SESSION,
        item: item(task, { plannedMinutes: 80 }),
        now: T0,
      });

      const before = await repos.sessions.getById(SESSION);
      expect(before?.extended).toBe(false);

      const result = await applyHyperfocusExtension(deps);

      expect(result.sessionEndMoved).toBe(true);
      expect(result.sessionExtended).toBe(true);
      expect((await repos.runtime.getSessionRuntime(SESSION))?.plannedEndAtMs).toBe(T0 + min(105));
      expect((await repos.sessions.getById(SESSION))?.extended).toBe(true);
    });

    it('queues long_extend once, past 2x the original block, for the NEXT session', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      await applyHyperfocusExtension(deps); // 25 + 25 = exactly 2x — silent
      expect(await queued()).toEqual([]);

      const crossing = await applyHyperfocusExtension(deps); // 25 + 50 = 3x
      expect(crossing.coaching).toEqual([{ trigger: 'pattern_detected', kind: 'long_extend' }]);
      const rows = await repos.coaching.priorityQueue();
      expect(rows[0]).toMatchObject({ triggerType: 'pattern_detected', urgency: 'next_start' });
      expect(rows[0]?.triggerData).toMatchObject({ kind: 'long_extend', quanta: 2 });

      await applyHyperfocusExtension(deps); // further quanta do not re-queue
      expect((await queued()).filter((q) => q.kind === 'long_extend')).toHaveLength(1);
    });
  });

  // ── repeated_extension, at task close ────────────────────────────────────────────────────────

  describe('repeated +5 → a conversation at task close', () => {
    it('enqueues nothing at press time and one row at close, on the count arm', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      for (let i = 0; i < 3; i++) await applyShortExtension(deps);
      expect(await queued()).toEqual([]);

      const result = await completeEpisode(deps, T0 + min(40));

      expect(result.coaching).toEqual([{ trigger: 'pattern_detected', kind: 'repeated_extension' }]);
      const row = (await repos.coaching.priorityQueue())[0];
      expect(row).toMatchObject({ urgency: 'next_start' });
      expect(row?.triggerData).toMatchObject({
        kind: 'repeated_extension',
        arm: 'count',
        presses: 3,
        cumulativeMinutes: 15,
        estimatedDuration: 120,
      });
      expect(row?.relatedTaskIds).toEqual([task.id]);
    });

    it('writes ONE row per task per session even when the task is parked and resumed', async () => {
      const task = await makeTask({ estimatedDuration: 120 });

      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      for (let i = 0; i < 3; i++) await applyShortExtension(deps);
      await parkEpisode(deps, T0 + min(40));

      // Same task, same session, a second serving with three more presses.
      const parked = (await repos.tasks.getById(task.id)) as Task;
      await startEpisode(deps, { sessionId: SESSION, item: item(parked), now: T0 + min(45) });
      for (let i = 0; i < 3; i++) await applyShortExtension(deps);
      await completeEpisode(deps, T0 + min(80));

      expect((await queued()).filter((q) => q.kind === 'repeated_extension')).toHaveLength(1);
      // The ledger kept accumulating across the episode boundary all the same.
      expect(await repos.runtime.getExtensionLedger(SESSION, task.id)).toMatchObject({
        presses: 6,
        coachingEnqueued: true,
      });
    });

    it('does not fire for a single press on a small task (the 10-minute floor)', async () => {
      const task = await makeTask({ estimatedDuration: 10 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task, { plannedMinutes: 10 }), now: T0 });
      await applyShortExtension(deps);
      await completeEpisode(deps, T0 + min(15));

      expect((await queued()).filter((q) => q.kind === 'repeated_extension')).toHaveLength(0);
    });
  });

  // ── Pause-percentage coaching ────────────────────────────────────────────────────────────────

  describe('>20% paused (spec §8.2)', () => {
    it('queues a conversation at close when the episode was mostly interrupted', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      await pauseEpisode(deps, T0 + min(2));
      await resumeEpisode(deps, T0 + min(12)); // 10 of 30 wall minutes paused

      const result = await parkEpisode(deps, T0 + min(30));

      expect(result.coaching).toEqual([{ trigger: 'pattern_detected', kind: 'high_pause_ratio' }]);
      expect((await repos.coaching.priorityQueue())[0]?.triggerData).toMatchObject({
        kind: 'high_pause_ratio',
        pauseCount: 1,
      });
    });

    it('stays quiet for an ordinary short interruption', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      await pauseEpisode(deps, T0 + min(5));
      await resumeEpisode(deps, T0 + min(7));
      await parkEpisode(deps, T0 + min(30));

      expect((await queued()).filter((q) => q.kind === 'high_pause_ratio')).toHaveLength(0);
    });
  });

  // ── Tail directives ──────────────────────────────────────────────────────────────────────────

  describe('what happens to the tail', () => {
    it('leaves the tail alone after an ordinary block — and after a +5', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      await applyShortExtension(deps);

      const result = await completeEpisode(deps, T0 + min(30));
      expect(result.tail).toEqual({ kind: 'continue' });
    });

    it('regenerates after a hyperfocus stretch, passing the stretch length for the break-first rule', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
      await applyHyperfocusExtension(deps);

      const result = await completeEpisode(deps, T0 + min(50));

      expect(result.tail).toMatchObject({
        kind: 'regenerate',
        remainingMinutes: 40,
        precededByStretchMinutes: 50, // ≥ 50 → task 11 opens the new agenda with a break
        easier: false,
        excludeTaskIds: [task.id],
      });
    });

    it('goes to summary when no session time remains', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 + min(80) });
      const result = await completeEpisode(deps, T0 + min(95));
      expect(result.tail).toEqual({ kind: 'summary' });
    });

    it('the escape valve parks the current task, replans easier, and flags the session', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await escapeToEasier(deps, T0 + min(10));

      expect(result.outcome).toBe('progress'); // past the gate, real work was done
      expect(result.tail).toMatchObject({ kind: 'regenerate', easier: true, excludeTaskIds: [task.id] });
      expect((await repos.sessions.getById(SESSION))?.escapeValveUsed).toBe(true);
      expect((await repos.tasks.getById(task.id))?.skipCount).toBe(0);
    });

    it('the escape valve inside the first minute is a skip, not a park', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });

      const result = await escapeToEasier(deps, T0 + 20_000);

      expect(result.outcome).toBe('skipped');
      expect((await repos.tasks.getById(task.id))?.skipCount).toBe(1);
    });
  });

  // ── Crash / relaunch recovery — the part that must be right ──────────────────────────────────

  describe('crash / relaunch recovery (design §1.4)', () => {
    /** Simulates a process kill: the runtime row survives, everything in memory does not. */
    async function crashDuringEpisode(task: Task, overrides: Partial<AgendaTaskItem> = {}) {
      await startEpisode(deps, { sessionId: SESSION, item: item(task, overrides), now: T0 });
    }

    it('closes the episode as abandoned, credits elapsed minus pauses, and WRITES NO SKIP', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);
      await pauseEpisode(deps, T0 + min(3));
      await resumeEpisode(deps, T0 + min(8)); // 5 minutes of known pause

      const result = await recoverOpenEpisode(deps, T0 + min(20));

      expect(result.recovered).toBe(true);
      expect(result.creditedMinutes).toBe(15); // 20 elapsed − 5 paused

      const after = await repos.tasks.getById(task.id);
      expect(after?.accumulatedMinutes).toBe(15);
      expect(after?.workState).toBe('in_progress');
      expect(after?.status).toBe('active');
      // The three things a crash must never produce:
      expect(after?.skipCount).toBe(0);
      expect(await queued()).toEqual([]);
      expect((await repos.sessions.getById(SESSION))?.tasksSkipped).toBe(0);
    });

    it('writes an abandoned episode row that names the task and says why', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);
      const result = await recoverOpenEpisode(deps, T0 + min(10));

      const row = await repos.interactions.getById(result.interactionId as number);
      expect(row).toMatchObject({ completionStatus: 'abandoned', durationMinutes: 10 });
      expect(row?.notes).toContain('relaunch recovery');
      expect(await repos.interactions.listTaskIdsBySession(SESSION)).toEqual([task.id]);
    });

    it('never abandons the TASK by inference — only the episode', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);
      await recoverOpenEpisode(deps, T0 + min(10));

      const after = await repos.tasks.getById(task.id);
      expect(after?.status).toBe('active');
      expect(after?.accumulatedMinutes).toBe(10); // the work is kept, not written off
    });

    it('resumes the SAME block when block and session time both remain', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);

      const result = await recoverOpenEpisode(deps, T0 + min(10));

      expect(result.directive).toEqual({
        kind: 'resume_block',
        taskId: task.id,
        blockEndAtMs: T0 + min(25),
        blockKind: 'countdown',
        plannedMinutes: 25,
      });
      // Re-opening against the original end means the timer really did keep running: 15 left.
      await startEpisode(deps, {
        sessionId: SESSION,
        item: item((await repos.tasks.getById(task.id)) as Task),
        now: T0 + min(10),
        blockEndAtMs: T0 + min(25),
      });
      expect((await currentTimer(deps, T0 + min(10)))?.remainingMs).toBe(min(15));
    });

    it('opens to the end-of-block prompt when the block expired while the app was dead', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);

      const result = await recoverOpenEpisode(deps, T0 + min(40));

      expect(result.directive).toEqual({ kind: 'block_expired', taskId: task.id });
      expect(result.creditedMinutes).toBe(25); // bounded by the block, not by the 40 elapsed
    });

    it('ends the session when its own end passed too — without touching the task', async () => {
      const task = await makeTask({ estimatedDuration: 300 });
      await crashDuringEpisode(task, { plannedMinutes: 120 });

      const result = await recoverOpenEpisode(deps, T0 + min(200));

      expect(result.directive).toEqual({ kind: 'session_over', taskId: task.id });
      const session = await repos.sessions.getById(SESSION);
      expect(session?.status).toBe('abandoned');
      // Session status and task work_state are orthogonal.
      expect((await repos.tasks.getById(task.id))?.status).toBe('active');
      expect((await repos.tasks.getById(task.id))?.workState).toBe('in_progress');
      expect(await repos.runtime.getSessionRuntime(SESSION)).toBeUndefined();
    });

    it('is a no-op on a clean launch, and never runs twice on the same episode', async () => {
      expect(await recoverOpenEpisode(deps, T0)).toEqual({ recovered: false, coaching: [] });

      const task = await makeTask({ estimatedDuration: 120 });
      await crashDuringEpisode(task);
      await recoverOpenEpisode(deps, T0 + min(10));

      // The row is gone, so a second launch credits nothing — no double count.
      expect(await recoverOpenEpisode(deps, T0 + min(20))).toEqual({ recovered: false, coaching: [] });
      expect((await repos.tasks.getById(task.id))?.accumulatedMinutes).toBe(10);
    });

    it('finds nothing after a clean close — every outcome path clears the crash signal', async () => {
      const task = await makeTask({ estimatedDuration: 120 });
      for (const close of [completeEpisode, parkEpisode, skipEpisode]) {
        await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
        await close(deps, T0 + min(5));
        expect(await recoverOpenEpisode(deps, T0 + min(6))).toMatchObject({ recovered: false });
      }
    });
  });

  // ── Session lapse ────────────────────────────────────────────────────────────────────────────

  describe('session lapse while a prompt is open (brief §1.5)', () => {
    it('reports no lapse before the session end', async () => {
      expect(await checkSessionLapse(deps, { sessionId: SESSION, now: T0 + min(89) })).toEqual({
        lapsed: false,
        coaching: [],
      });
    });

    it('queues one conversation for next start and deduplicates on repeat polls', async () => {
      const first = await checkSessionLapse(deps, { sessionId: SESSION, now: T0 + min(91) });
      expect(first.lapsed).toBe(true);
      expect(first.coaching).toEqual([{ trigger: 'pattern_detected', kind: 'session_lapsed' }]);

      const second = await checkSessionLapse(deps, { sessionId: SESSION, now: T0 + min(95) });
      expect(second).toEqual({ lapsed: true, coaching: [] });
      expect((await queued()).filter((q) => q.kind === 'session_lapsed')).toHaveLength(1);
    });

    it('moves with the session end when hyperfocus extends it', async () => {
      const task = await makeTask();
      await startEpisode(deps, { sessionId: SESSION, item: item(task, { plannedMinutes: 80 }), now: T0 });
      await applyHyperfocusExtension(deps); // session end 90 → 105

      expect((await checkSessionLapse(deps, { sessionId: SESSION, now: T0 + min(95) })).lapsed).toBe(false);
      expect((await checkSessionLapse(deps, { sessionId: SESSION, now: T0 + min(106) })).lapsed).toBe(true);
    });
  });

  // ── Closing the session ──────────────────────────────────────────────────────────────────────

  it('closeSession writes the terminal fields and leaves no runtime trace', async () => {
    const task = await makeTask();
    await startEpisode(deps, { sessionId: SESSION, item: item(task), now: T0 });
    await completeEpisode(deps, T0 + min(25));

    await closeSession(deps, { sessionId: SESSION, now: T0 + min(60), status: 'completed' });

    const session = await repos.sessions.getById(SESSION);
    expect(session).toMatchObject({ status: 'completed', actualDuration: 60, tasksCompleted: 1 });
    expect(await repos.runtime.getSessionRuntime(SESSION)).toBeUndefined();
    expect(await repos.runtime.getActiveEpisode()).toBeUndefined();
  });
});
