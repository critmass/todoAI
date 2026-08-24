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

  describe('incrementPeriodProgress', () => {
    it('increments quota progress and reports when the per-period quota is met', async () => {
      await repo.create(taskId, { type: 'quota', quota: 2, period: 'week' });

      const first = await repo.incrementPeriodProgress(taskId);
      expect(first).toEqual({ progress: 1, quota: 2, quotaReached: false });

      const second = await repo.incrementPeriodProgress(taskId);
      expect(second).toEqual({ progress: 2, quota: 2, quotaReached: true });

      const entity = await repo.getEntityByTaskId(taskId);
      expect(entity?.currentPeriodProgress).toBe(2);
    });

    it('works for scheduled_quota (also quota-bearing)', async () => {
      await repo.create(taskId, {
        type: 'scheduled_quota',
        quota: 3,
        period: 'week',
        scheduledDays: ['monday', 'wednesday', 'friday'],
      });
      expect(await repo.incrementPeriodProgress(taskId)).toEqual({
        progress: 1,
        quota: 3,
        quotaReached: false,
      });
    });

    it('rejects a recurrence type that has no per-period quota', async () => {
      await repo.create(taskId, { type: 'scheduled', scheduledDays: ['tuesday'] });
      await expect(repo.incrementPeriodProgress(taskId)).rejects.toThrow(RecurrenceValidationError);
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

  it('the same CHECK also fires the other direction: count without a target_count', () => {
    expect(() =>
      conn.raw
        .prepare(
          `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, target_count)
           VALUES (?, 'count', '{}', NULL)`, // 'count' type but target_count missing - violates the CHECK
        )
        .run(taskId),
    ).toThrow(/CHECK constraint failed/);
  });
});

// ── Task 46 — the repeat field at the data boundary ──────────────────────────────────────────

describe('recurrenceRepository with scheduled repeat modes (task 46)', () => {
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

  afterEach(() => conn.close());

  const legal: Recurrence[] = [
    { type: 'scheduled', scheduledDays: ['wednesday'], repeat: { mode: 'everyWeek' } },
    { type: 'scheduled', scheduledDays: ['wednesday'], repeat: { mode: 'interval', weeks: 2 } },
    {
      type: 'scheduled',
      scheduledDays: [],
      repeat: {
        mode: 'ordinal',
        cells: [
          { ordinal: 1, weekday: 'monday' },
          { ordinal: 3, weekday: 'wednesday' }, // mixed cells: two occurrences a month, not four
        ],
      },
    },
    { type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [1, 15], months: 2 } },
  ];

  it.each(legal)('stores and reads back %j without a new recurrence_type', async (recurrence) => {
    await repo.create(taskId, recurrence);
    const stored = conn.raw
      .prepare('SELECT recurrence_type FROM task_recurrence WHERE task_id = ?')
      .get(taskId) as { recurrence_type: string };
    expect(stored.recurrence_type).toBe('scheduled'); // no CHECK rebuild anywhere in this task

    // everyWeek normalises to the pre-task-46 shape (absent); the rest round-trip verbatim.
    const expected =
      recurrence.type === 'scheduled' && recurrence.repeat?.mode === 'everyWeek'
        ? { type: 'scheduled', scheduledDays: recurrence.scheduledDays }
        : recurrence;
    expect(await repo.getByTaskId(taskId)).toEqual(expected);
  });

  it('🔴 refuses to store a dayOfMonth recurrence that still carries weekdays', async () => {
    await expect(
      repo.create(taskId, {
        type: 'scheduled',
        scheduledDays: ['monday'],
        repeat: { mode: 'dayOfMonth', days: [15] },
      }),
    ).rejects.toThrow(RecurrenceValidationError);
    expect(await repo.getByTaskId(taskId)).toBeUndefined(); // nothing was written
  });

  it('🔴 refuses an ordinal recurrence that still carries weekdays, on create AND on update', async () => {
    // The same one rule, at both writers: scheduledDays is used by everyWeek and interval only.
    const withStrayDays: Recurrence = {
      type: 'scheduled',
      scheduledDays: ['monday'],
      repeat: { mode: 'ordinal', cells: [{ ordinal: 1, weekday: 'monday' }] },
    };
    await expect(repo.create(taskId, withStrayDays)).rejects.toThrow(RecurrenceValidationError);
    expect(await repo.getByTaskId(taskId)).toBeUndefined();

    await repo.create(taskId, { type: 'scheduled', scheduledDays: ['monday'] });
    await expect(repo.update(taskId, withStrayDays)).rejects.toThrow(RecurrenceValidationError);
    expect(await repo.getByTaskId(taskId)).toEqual({ type: 'scheduled', scheduledDays: ['monday'] });
  });

  it('refuses an illegal stride or ordinal list, on create and on update alike', async () => {
    await expect(
      repo.create(taskId, {
        type: 'scheduled',
        scheduledDays: ['monday'],
        repeat: { mode: 'interval', weeks: 0 },
      }),
    ).rejects.toThrow(RecurrenceValidationError);

    await repo.create(taskId, { type: 'scheduled', scheduledDays: ['monday'] });
    await expect(
      repo.update(taskId, {
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'ordinal', cells: [] },
      }),
    ).rejects.toThrow(RecurrenceValidationError);
    // The stored row is untouched by the rejected update.
    expect(await repo.getByTaskId(taskId)).toEqual({ type: 'scheduled', scheduledDays: ['monday'] });
  });
});
