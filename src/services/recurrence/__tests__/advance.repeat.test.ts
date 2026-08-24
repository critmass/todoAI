// Task 46 Phase 1 — the sweep, against a real SQLite engine, for the four `scheduled` repeat modes.
//
// The stride anchor is the task's CREATION date (ruled: no date-picker is introduced — the app has
// none), which on disk is `task_recurrence.created_at`. Every test here sets it explicitly, because
// a stride whose phase depends on an implicit clock reading is a stride nobody can test.
//
// 2026-08-03 is a Monday. Wednesdays: Aug 5/12/19/26, Sep 2/9/16/23/30.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createRecurrenceRepository, type RecurrenceRepository } from '../../../db/repositories/recurrence';
import { createTasksRepository, type TasksRepository } from '../../../db/repositories/tasks';
import type { Recurrence } from '../../../types/domain';
import { advanceRecurrence, type RecurrenceSweepDeps } from '../advance';

const MONDAY = '2026-08-03';

describe('advanceRecurrence with scheduled repeat modes (task 46)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let recurrence: RecurrenceRepository;
  let deps: RecurrenceSweepDeps;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    deps = { tasks, recurrence };
  });

  afterEach(() => conn.close());

  async function makeTask(
    title: string,
    rec: Recurrence,
    fields?: { createdOn?: string; nextDueAt?: string | null; lastCompletedAt?: string },
  ): Promise<number> {
    const task = await tasks.create({
      title,
      estimatedDuration: 20,
      nextDueAt: fields?.nextDueAt ?? null,
    });
    await recurrence.create(task.id, rec);
    conn.raw
      .prepare('UPDATE task_recurrence SET created_at = ? WHERE task_id = ?')
      .run(`${fields?.createdOn ?? MONDAY} 09:00:00`, task.id);
    if (fields?.lastCompletedAt !== undefined) {
      conn.raw
        .prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?')
        .run(fields.lastCompletedAt, task.id);
    }
    return task.id;
  }

  /** Inserts a row with a hand-written pattern — used to reproduce the alpha DB's exact JSON. */
  async function makeLegacyTask(title: string, pattern: string): Promise<number> {
    const task = await tasks.create({ title, estimatedDuration: 20, nextDueAt: null });
    conn.raw
      .prepare(
        `INSERT INTO task_recurrence (task_id, recurrence_type, recurrence_pattern, created_at)
         VALUES (?, 'scheduled', ?, '2026-08-03 09:00:00')`,
      )
      .run(task.id, pattern);
    return task.id;
  }

  const dueOf = async (taskId: number) => (await tasks.getById(taskId))!.nextDueAt;
  const recOf = async (taskId: number) => (await recurrence.getEntityByTaskId(taskId))!;

  // ── 🔴 the compatibility pin ──────────────────────────────────────────────────────────────

  describe('a pre-task-46 row', () => {
    it('sweeps exactly as it did before: no repeat key means every week', async () => {
      // The literal JSON shape of the three live alpha rows.
      const id = await makeLegacyTask('Bins out', '{"scheduledDays":["tuesday"]}');

      await advanceRecurrence(deps, MONDAY);

      expect(await dueOf(id)).toBe('2026-08-04'); // tomorrow, as it always was
      expect((await recOf(id)).recurrence).toEqual({ type: 'scheduled', scheduledDays: ['tuesday'] });
    });

    it('keeps advancing weekly week after week, never fortnightly', async () => {
      const id = await makeLegacyTask('Standup notes', '{"scheduledDays":["wednesday"]}');
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-05');

      conn.raw.prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?').run('2026-08-05 18:00:00', id);
      await advanceRecurrence(deps, '2026-08-05');
      expect(await dueOf(id)).toBe('2026-08-12'); // the very next Wednesday
    });
  });

  // ── the modes, through the sweep ──────────────────────────────────────────────────────────

  describe('interval', () => {
    const everyOtherWed: Recurrence = {
      type: 'scheduled',
      scheduledDays: ['wednesday'],
      repeat: { mode: 'interval', weeks: 2 },
    };

    it('seeds the due date on the first on-week occurrence', async () => {
      const id = await makeTask('Bin day', everyOtherWed, { createdOn: MONDAY });
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-05');
    });

    it('skips the off week after the occurrence is completed', async () => {
      const id = await makeTask('Bin day', everyOtherWed, {
        createdOn: MONDAY,
        nextDueAt: '2026-08-05',
        lastCompletedAt: '2026-08-05 19:00:00',
      });
      await advanceRecurrence(deps, '2026-08-05');
      expect(await dueOf(id)).toBe('2026-08-19'); // NOT the 12th
    });

    it('phases off the creation date, so two identically-defined tasks can differ', async () => {
      const a = await makeTask('Created week 0', everyOtherWed, { createdOn: MONDAY });
      const b = await makeTask('Created week 1', everyOtherWed, { createdOn: '2026-08-10' });
      await advanceRecurrence(deps, '2026-08-10');
      expect(await dueOf(a)).toBe('2026-08-19');
      expect(await dueOf(b)).toBe('2026-08-12');
    });
  });

  describe('ordinal', () => {
    const firstAndThirdWed: Recurrence = {
      type: 'scheduled',
      scheduledDays: ['wednesday'],
      repeat: { mode: 'ordinal', ordinals: [1, 3] },
    };

    it('is due on the 1st Wednesday, then the 3rd', async () => {
      const id = await makeTask('Pay the cleaner', firstAndThirdWed);
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-05');

      conn.raw.prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?').run('2026-08-05 19:00:00', id);
      await advanceRecurrence(deps, '2026-08-05');
      expect(await dueOf(id)).toBe('2026-08-19');
    });

    it('crosses into the next month when the month’s ordinals are spent', async () => {
      const id = await makeTask('Pay the cleaner', firstAndThirdWed, {
        nextDueAt: '2026-08-19',
        lastCompletedAt: '2026-08-19 19:00:00',
      });
      await advanceRecurrence(deps, '2026-08-19');
      expect(await dueOf(id)).toBe('2026-09-02');
    });

    it("'last' follows the month, not a fixed week number", async () => {
      const lastWed: Recurrence = {
        type: 'scheduled',
        scheduledDays: ['wednesday'],
        repeat: { mode: 'ordinal', ordinals: ['last'] },
      };
      const id = await makeTask('Meter reading', lastWed);
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-26'); // Aug has four Wednesdays

      conn.raw.prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?').run('2026-08-26 19:00:00', id);
      await advanceRecurrence(deps, '2026-08-26');
      expect(await dueOf(id)).toBe('2026-09-30'); // Sep has five — the fifth, not the fourth
    });
  });

  describe('dayOfMonth', () => {
    const fifteenth: Recurrence = {
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [15] },
    };

    it('is due on the 15th, with no weekday involved at all', async () => {
      const id = await makeTask('Rent', fifteenth);
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-15');
    });

    it('clamps the 31st into February rather than skipping the month', async () => {
      const id = await makeTask(
        'Rent',
        { type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [31] } },
        { createdOn: '2027-01-01', nextDueAt: '2027-01-31', lastCompletedAt: '2027-01-31 19:00:00' },
      );
      await advanceRecurrence(deps, '2027-01-31');
      expect(await dueOf(id)).toBe('2027-02-28');
    });
  });

  // ── what must NOT have changed ────────────────────────────────────────────────────────────

  describe('leaves the rest of the engine exactly where task 36 left it', () => {
    const modes: Array<[string, Recurrence]> = [
      ['everyWeek (absent)', { type: 'scheduled', scheduledDays: ['wednesday'] }],
      [
        'interval',
        { type: 'scheduled', scheduledDays: ['wednesday'], repeat: { mode: 'interval', weeks: 2 } },
      ],
      [
        'ordinal',
        { type: 'scheduled', scheduledDays: ['wednesday'], repeat: { mode: 'ordinal', ordinals: [1, 3] } },
      ],
      ['dayOfMonth', { type: 'scheduled', scheduledDays: [], repeat: { mode: 'dayOfMonth', days: [15] } }],
    ];

    it.each(modes)('%s: still no period accounting — reset_date stays null', async (_name, rec) => {
      // `scheduled` has never had a period, and these modes do not give it one. Rolling one would
      // record a shortfall against `current_period_progress`, which NOTHING increments for
      // `scheduled` (the repository refuses by design) — a permanent fabricated miss.
      const id = await makeTask('Task', rec);
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-10-01');
      const entity = await recOf(id);
      expect(entity.resetDate).toBeNull();
      expect(entity.lastPeriodShortfall).toBe(0);
      expect(entity.currentPeriodProgress).toBe(0);
    });

    it.each(modes)('%s: never re-anchors the neglect clock (constraint #5)', async (_name, rec) => {
      const id = await makeTask('Task', rec);
      const before = await tasks.getById(id);

      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-09-15');
      await advanceRecurrence(deps, '2026-12-01');

      const after = await tasks.getById(id);
      // created_at / last_completed_at / last_worked_at — the three-way anchor (R8 + task 28).
      expect(after!.createdAt).toBe(before!.createdAt);
      expect(after!.lastCompletedAt).toBe(before!.lastCompletedAt);
      expect(after!.lastWorkedAt).toBe(before!.lastWorkedAt);
    });

    it.each(modes)('%s: is idempotent — three sweeps produce one advancement', async (_name, rec) => {
      const id = await makeTask('Task', rec);
      const first = await advanceRecurrence(deps, MONDAY);
      const second = await advanceRecurrence(deps, MONDAY);
      const third = await advanceRecurrence(deps, MONDAY);
      expect(first.advanced).toHaveLength(1);
      expect(first.advanced[0].taskId).toBe(id);
      expect(second.advanced).toEqual([]);
      expect(third.advanced).toEqual([]);
    });

    it.each(modes)('%s: a long absence lands on the NEXT occurrence, not a backlog', async (_name, rec) => {
      const id = await makeTask('Task', rec, { nextDueAt: '2026-08-05' });
      const result = await advanceRecurrence(deps, '2026-11-10'); // three months away
      const due = await dueOf(id);
      expect(due).not.toBeNull();
      expect(due! >= '2026-11-10').toBe(true);
      expect(result.advanced).toHaveLength(1);
      // And one sweep is enough.
      expect((await advanceRecurrence(deps, '2026-11-10')).advanced).toEqual([]);
    });

    it('scheduled_quota is untouched by any of this — it carries no repeat and stays weekly', async () => {
      const id = await makeTask('Gym', {
        type: 'scheduled_quota',
        quota: 2,
        period: 'week',
        scheduledDays: ['wednesday'],
      });
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-05');
      expect((await recOf(id)).resetDate).toBe('2026-08-10'); // its period still seeds
    });
  });
});
