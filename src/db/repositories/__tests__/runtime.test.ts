import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createRuntimeRepository, type RuntimeRepository } from '../runtime';
import { createSessionsRepository } from '../sessions';
import { createTasksRepository } from '../tasks';

const T0 = Date.UTC(2026, 6, 26, 9, 0, 0); // injected clock — this repository never reads one

describe('runtimeRepository', () => {
  let conn: TestSqliteConnection;
  let repo: RuntimeRepository;
  let taskId: number;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createRuntimeRepository(conn);

    const sessions = createSessionsRepository(conn);
    await sessions.create('s1', { sessionType: 'deep_focus', plannedDuration: 90, status: 'completed' });
    const tasks = createTasksRepository(conn);
    taskId = (await tasks.create({ title: 'Mix track', estimatedDuration: 60 })).id;
  });

  afterEach(() => conn.close());

  describe('session_runtime', () => {
    it('sets and then MOVES the session end (the same row, not a second one)', async () => {
      expect(await repo.getSessionRuntime('s1')).toBeUndefined();

      const created = await repo.setSessionEnd('s1', T0 + 90 * 60_000);
      expect(created).toMatchObject({ sessionId: 's1', plannedEndAtMs: T0 + 90 * 60_000 });

      const moved = await repo.setSessionEnd('s1', T0 + 115 * 60_000);
      expect(moved.plannedEndAtMs).toBe(T0 + 115 * 60_000);
      const rows = conn.raw.prepare('SELECT COUNT(*) AS n FROM session_runtime').get();
      expect(rows).toEqual({ n: 1 });
    });
  });

  describe('active_episode', () => {
    const open = () =>
      repo.openEpisode({
        sessionId: 's1',
        taskId,
        blockKind: 'countdown',
        plannedMinutes: 25,
        startedAtMs: T0,
        blockEndAtMs: T0 + 25 * 60_000,
      });

    it('opens with a clean pause ledger and no extension history', async () => {
      const episode = await open();
      expect(episode).toEqual({
        sessionId: 's1',
        taskId,
        blockKind: 'countdown',
        plannedMinutes: 25,
        startedAtMs: T0,
        blockEndAtMs: T0 + 25 * 60_000,
        pausedAtMs: null,
        pausedMs: 0,
        pauseCount: 0,
        hyperfocusQuanta: 0,
        longExtendEnqueued: false,
      });
    });

    it('stays a singleton when a second episode opens over a stale one', async () => {
      await open();
      const second = await repo.openEpisode({
        sessionId: 's1',
        taskId,
        blockKind: 'openBlock',
        plannedMinutes: 60,
        startedAtMs: T0 + 60_000,
        blockEndAtMs: T0 + 61 * 60_000,
      });
      expect(second.blockKind).toBe('openBlock');
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM active_episode').get()).toEqual({ n: 1 });
    });

    it('patches only the named fields and can clear pausedAtMs back to null', async () => {
      await open();
      const paused = await repo.updateActiveEpisode({ pausedAtMs: T0 + 5 * 60_000, pauseCount: 1 });
      expect(paused.pausedAtMs).toBe(T0 + 5 * 60_000);
      expect(paused.plannedMinutes).toBe(25); // untouched

      const resumed = await repo.updateActiveEpisode({
        pausedAtMs: null,
        pausedMs: 120_000,
        blockEndAtMs: T0 + 27 * 60_000,
      });
      expect(resumed.pausedAtMs).toBeNull();
      expect(resumed.pausedMs).toBe(120_000);
      expect(resumed.pauseCount).toBe(1); // still untouched
    });

    it('closeEpisode removes the row, so the next launch sees no crash signal', async () => {
      await open();
      await repo.closeEpisode();
      expect(await repo.getActiveEpisode()).toBeUndefined();
    });
  });

  describe('session_task_extension (the +5 ledger)', () => {
    it('accumulates presses and minutes on one row per (session, task)', async () => {
      const first = await repo.recordShortExtension('s1', taskId, 5);
      expect(first).toMatchObject({ presses: 1, minutes: 5, coachingEnqueued: false });

      const second = await repo.recordShortExtension('s1', taskId, 5);
      expect(second).toMatchObject({ presses: 2, minutes: 10 });
      expect(conn.raw.prepare('SELECT COUNT(*) AS n FROM session_task_extension').get()).toEqual({ n: 1 });
    });

    it('survives the episode boundary it spans — park, reopen, press again', async () => {
      await repo.openEpisode({
        sessionId: 's1',
        taskId,
        blockKind: 'countdown',
        plannedMinutes: 25,
        startedAtMs: T0,
        blockEndAtMs: T0 + 25 * 60_000,
      });
      await repo.recordShortExtension('s1', taskId, 5);
      await repo.closeEpisode(); // parked
      await repo.openEpisode({
        sessionId: 's1',
        taskId,
        blockKind: 'countdown',
        plannedMinutes: 20,
        startedAtMs: T0 + 40 * 60_000,
        blockEndAtMs: T0 + 60 * 60_000,
      });
      const ledger = await repo.recordShortExtension('s1', taskId, 5);

      expect(ledger).toMatchObject({ presses: 2, minutes: 10 });
    });

    it('marks the coaching row as enqueued so it is never queued twice in one session', async () => {
      await repo.recordShortExtension('s1', taskId, 5);
      await repo.markExtensionCoachingEnqueued('s1', taskId);
      expect(await repo.getExtensionLedger('s1', taskId)).toMatchObject({ coachingEnqueued: true });
    });
  });

  it('clearSessionRuntime tears down all three tables and is idempotent', async () => {
    await repo.setSessionEnd('s1', T0 + 90 * 60_000);
    await repo.openEpisode({
      sessionId: 's1',
      taskId,
      blockKind: 'countdown',
      plannedMinutes: 25,
      startedAtMs: T0,
      blockEndAtMs: T0 + 25 * 60_000,
    });
    await repo.recordShortExtension('s1', taskId, 5);

    await repo.clearSessionRuntime('s1');
    expect(await repo.getSessionRuntime('s1')).toBeUndefined();
    expect(await repo.getActiveEpisode()).toBeUndefined();
    expect(await repo.getExtensionLedger('s1', taskId)).toBeUndefined();

    await expect(repo.clearSessionRuntime('s1')).resolves.toBeUndefined();
  });
});
