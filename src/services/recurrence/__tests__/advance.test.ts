// Task 36 — the period sweep, against a real SQLite engine (better-sqlite3) with an INJECTED
// clock: every test passes `today` as a literal calendar date, so a three-week absence and a DST
// crossing are ordinary cases here.
//
// 2026-08-03 is a Monday. Every fixture date in this file is anchored to that week:
//   Mon 08-03, Tue 08-04, Wed 08-05, Thu 08-06, Fri 08-07, Sat 08-08, Sun 08-09, Mon 08-10.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createRecurrenceRepository, type RecurrenceRepository } from '../../../db/repositories/recurrence';
import { createTasksRepository, type TasksRepository } from '../../../db/repositories/tasks';
import { importanceFactor } from '../../../scoring/factors';
import { scoreTask, type SessionCheckIn } from '../../../scoring/score';
import type { Recurrence } from '../../../types/domain';
import { advanceRecurrence, sweepDateFrom, type RecurrenceSweepDeps } from '../advance';

const MONDAY = '2026-08-03';

describe('advanceRecurrence (task 36)', () => {
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
    rec: Recurrence | undefined,
    fields?: { nextDueAt?: string | null; lastCompletedAt?: string; progress?: number },
  ): Promise<number> {
    const task = await tasks.create({
      title,
      estimatedDuration: 20,
      nextDueAt: fields?.nextDueAt ?? null,
    });
    if (rec) await recurrence.create(task.id, rec);
    if (fields?.lastCompletedAt !== undefined) {
      conn.raw
        .prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?')
        .run(fields.lastCompletedAt, task.id);
    }
    if (fields?.progress !== undefined) {
      conn.raw
        .prepare('UPDATE task_recurrence SET current_period_progress = ? WHERE task_id = ?')
        .run(fields.progress, task.id);
    }
    return task.id;
  }

  const dueOf = async (taskId: number) => (await tasks.getById(taskId))!.nextDueAt;
  const recOf = async (taskId: number) => (await recurrence.getEntityByTaskId(taskId))!;

  // ── next_due_at advancement ───────────────────────────────────────────────────────────────

  describe('scheduled', () => {
    it('seeds a due date on a task that has never had one (the editor writes null)', async () => {
      // src/app/tasks/taskDraft.ts sets nextDueAt null for every recurring kind, so a "Schedule"
      // task saved from the editor arrives here with no due date at all.
      const id = await makeTask('Bins out', { type: 'scheduled', scheduledDays: ['tuesday'] });
      expect(await dueOf(id)).toBeNull();

      const result = await advanceRecurrence(deps, MONDAY);

      expect(await dueOf(id)).toBe('2026-08-04');
      expect(result.advanced).toEqual([{ taskId: id, dueAdvancedTo: '2026-08-04' }]);
    });

    it('leaves a due date that is already in the future alone', async () => {
      const id = await makeTask(
        'Bins out',
        { type: 'scheduled', scheduledDays: ['tuesday'] },
        { nextDueAt: '2026-08-04' },
      );
      const result = await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe('2026-08-04');
      expect(result.advanced).toEqual([]);
    });

    it('is due TODAY, and stays due today, when today is the scheduled day and nothing is done', async () => {
      const id = await makeTask('Standup notes', { type: 'scheduled', scheduledDays: ['monday'] });
      await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBe(MONDAY);
    });

    // THE REPORTED BUG. completeTask cannot advance this (it owns the completion-driven half
    // only), so before this engine existed a weekly task completed on its day read due-or-overdue
    // for the rest of time.
    it('advances past today once today’s occurrence has been completed', async () => {
      const id = await makeTask(
        'Standup notes',
        { type: 'scheduled', scheduledDays: ['monday'] },
        { nextDueAt: MONDAY, lastCompletedAt: `${MONDAY} 09:14:00` },
      );

      await advanceRecurrence(deps, MONDAY);

      expect(await dueOf(id)).toBe('2026-08-10'); // next Monday
    });

    it('does not stack a missed occurrence: a stale due date jumps to the NEXT one', async () => {
      // Due last Monday, never completed, and it is now Wednesday. The missed slot resets (§4.2);
      // what surfaces a repeatedly-missed task is the neglect clock, not a backlog.
      const id = await makeTask(
        'Water plants',
        { type: 'scheduled', scheduledDays: ['monday', 'friday'] },
        { nextDueAt: '2026-07-27' },
      );

      await advanceRecurrence(deps, '2026-08-05');

      expect(await dueOf(id)).toBe('2026-08-07'); // Friday, not a queue of missed Mondays
    });

    it('never fabricates a due date for a schedule that names no days', async () => {
      const id = await makeTask('Vague', { type: 'scheduled', scheduledDays: [] });
      const result = await advanceRecurrence(deps, MONDAY);
      expect(await dueOf(id)).toBeNull();
      expect(result.advanced).toEqual([]);
    });
  });

  // ── period rollover ───────────────────────────────────────────────────────────────────────

  describe('quota', () => {
    it('seeds the first period without recording a shortfall or losing progress', async () => {
      // reset_date has had no writer since migration 001, so every existing row arrives null. A
      // user who has already logged 2 of 3 this week must not lose them to the engine arriving.
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 2 });

      const result = await advanceRecurrence(deps, MONDAY);

      const entity = await recOf(id);
      expect(entity.resetDate).toBe('2026-08-10');
      expect(entity.currentPeriodProgress).toBe(2); // untouched
      expect(entity.lastPeriodShortfall).toBe(0); // nothing has closed yet
      expect(result.advanced).toEqual([
        { taskId: id, period: { resetDate: '2026-08-10', periodsElapsed: 0, shortfall: 0 } },
      ]);
    });

    it('rolls at the boundary: progress zeroed, boundary advanced, shortfall recorded', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 1 });
      await advanceRecurrence(deps, MONDAY); // seeds boundary 08-10

      await advanceRecurrence(deps, '2026-08-10');

      const entity = await recOf(id);
      expect(entity.resetDate).toBe('2026-08-17');
      expect(entity.currentPeriodProgress).toBe(0);
      expect(entity.lastPeriodShortfall).toBe(2); // quota 3 - progress 1
    });

    it('records no shortfall when the quota was met, and clears a previous one', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 0 });
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-10'); // missed week -> shortfall 3
      expect((await recOf(id)).lastPeriodShortfall).toBe(3);

      conn.raw.prepare('UPDATE task_recurrence SET current_period_progress = 4 WHERE task_id = ?').run(id);
      await advanceRecurrence(deps, '2026-08-17'); // over-achieved week

      expect((await recOf(id)).lastPeriodShortfall).toBe(0); // replaced, never accumulated
    });

    it('leaves next_due_at alone: "15/week, whenever" has no day it is due on', async () => {
      const id = await makeTask('Steps', { type: 'quota', quota: 15, period: 'week' });
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-24');
      expect(await dueOf(id)).toBeNull();
    });

    it('rolls a daily and a monthly period on their own boundaries', async () => {
      const daily = await makeTask('Meds', { type: 'quota', quota: 2, period: 'day' }, { progress: 1 });
      const monthly = await makeTask('Deep clean', { type: 'quota', quota: 1, period: 'month' });
      await advanceRecurrence(deps, MONDAY);
      expect((await recOf(daily)).resetDate).toBe('2026-08-04');
      expect((await recOf(monthly)).resetDate).toBe('2026-09-03');

      await advanceRecurrence(deps, '2026-08-04');

      expect((await recOf(daily)).resetDate).toBe('2026-08-05');
      expect((await recOf(daily)).lastPeriodShortfall).toBe(1);
      expect((await recOf(monthly)).resetDate).toBe('2026-09-03'); // still inside its period
      expect((await recOf(monthly)).lastPeriodShortfall).toBe(0);
    });
  });

  describe('scheduled_quota', () => {
    it('advances the due date AND rolls the period', async () => {
      const id = await makeTask(
        'Run',
        {
          type: 'scheduled_quota',
          quota: 3,
          period: 'week',
          scheduledDays: ['monday', 'wednesday', 'friday'],
        },
        { progress: 1 },
      );
      await advanceRecurrence(deps, MONDAY); // due today, boundary seeded to 08-10

      const result = await advanceRecurrence(deps, '2026-08-11'); // the following Tuesday

      expect(await dueOf(id)).toBe('2026-08-12'); // Wednesday
      const entity = await recOf(id);
      expect(entity.resetDate).toBe('2026-08-17');
      expect(entity.currentPeriodProgress).toBe(0);
      expect(entity.lastPeriodShortfall).toBe(2);
      expect(result.advanced).toEqual([
        {
          taskId: id,
          dueAdvancedTo: '2026-08-12',
          period: { resetDate: '2026-08-17', periodsElapsed: 1, shortfall: 2 },
        },
      ]);
    });
  });

  // ── idempotency: the whole design constraint (brief §3a) ──────────────────────────────────

  describe('idempotency', () => {
    it('three calls in the same second produce exactly one advancement', async () => {
      const scheduled = await makeTask('Bins out', { type: 'scheduled', scheduledDays: ['tuesday'] });
      const quota = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 1 });

      const first = await advanceRecurrence(deps, MONDAY);
      const second = await advanceRecurrence(deps, MONDAY);
      const third = await advanceRecurrence(deps, MONDAY);

      expect(first.advanced).toHaveLength(2);
      expect(second.advanced).toEqual([]);
      expect(third.advanced).toEqual([]);
      expect(await dueOf(scheduled)).toBe('2026-08-04');
      const entity = await recOf(quota);
      expect(entity.resetDate).toBe('2026-08-10');
      expect(entity.currentPeriodProgress).toBe(1); // NOT zeroed by the repeat calls
      expect(entity.lastPeriodShortfall).toBe(0);
    });

    it('is still idempotent when the repeat lands after a real roll', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 1 });
      await advanceRecurrence(deps, MONDAY);

      const rolled = await advanceRecurrence(deps, '2026-08-10');
      const repeat = await advanceRecurrence(deps, '2026-08-10');

      expect(rolled.advanced).toHaveLength(1);
      expect(repeat.advanced).toEqual([]);
      expect((await recOf(id)).lastPeriodShortfall).toBe(2); // not re-derived from a zeroed progress
    });

    it('scans every eligible row even when nothing moves', async () => {
      await makeTask('Bins out', { type: 'scheduled', scheduledDays: ['tuesday'] });
      await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' });
      await advanceRecurrence(deps, MONDAY);

      const repeat = await advanceRecurrence(deps, MONDAY);
      expect(repeat.scanned).toBe(2);
      expect(repeat.advanced).toEqual([]);
    });
  });

  // ── catch-up after an absence (brief §3c) ─────────────────────────────────────────────────

  describe('catch-up after a long absence', () => {
    it('lands three weeks later in the CURRENT period, with one period of shortfall, not three', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 1 });
      await advanceRecurrence(deps, MONDAY); // boundary 08-10

      const result = await advanceRecurrence(deps, '2026-08-24'); // three weeks away

      const entity = await recOf(id);
      expect(entity.resetDate).toBe('2026-08-31'); // the period containing today
      expect(entity.currentPeriodProgress).toBe(0);
      // Three weeks missed at 3/week is nine occurrences. The user owes NONE of them. The recorded
      // fact is the shortfall of the ONE period the engine actually observed - the one that was
      // open when they left, quota 3 against progress 1 - not the sum (8), and not "the last two
      // weeks were empty so call it a full 3". The empty weeks in between are an ABSENCE, not
      // measured evidence of failure, and treating them as data is how a backlog gets fabricated
      // (brief §2.4). See the findings report §3c.
      expect(entity.lastPeriodShortfall).toBe(2);
      expect(result.advanced[0].period).toEqual({
        resetDate: '2026-08-31',
        periodsElapsed: 3,
        shortfall: 2,
      });
    });

    it('a scheduled task returning after a fortnight is due on the next occurrence, not a backlog', async () => {
      const id = await makeTask(
        'Water plants',
        { type: 'scheduled', scheduledDays: ['monday', 'thursday'] },
        { nextDueAt: '2026-07-20' },
      );

      await advanceRecurrence(deps, '2026-08-05'); // Wednesday

      expect(await dueOf(id)).toBe('2026-08-06'); // Thursday. One date, not four missed ones.
    });

    it('one sweep after the absence is enough: an immediate second sweep changes nothing', async () => {
      await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' });
      await makeTask('Water plants', { type: 'scheduled', scheduledDays: ['monday'] });
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-24');

      expect((await advanceRecurrence(deps, '2026-08-24')).advanced).toEqual([]);
    });
  });

  describe('across a DST transition', () => {
    it('rolls a weekly period to the right calendar date across spring-forward', async () => {
      // 2027-03-08 is a Monday; US DST starts Sunday 2027-03-14 (a 23-hour local day).
      const id = await makeTask('Gym', { type: 'quota', quota: 2, period: 'week' });
      await advanceRecurrence(deps, '2027-03-08');
      expect((await recOf(id)).resetDate).toBe('2027-03-15');

      await advanceRecurrence(deps, '2027-03-15');

      expect((await recOf(id)).resetDate).toBe('2027-03-22'); // seven calendar days, not 7x24h
    });

    it('puts a scheduled occurrence on the right weekday across fall-back', async () => {
      // 2027-11-07 is the Sunday the clocks go back (a 25-hour local day).
      const id = await makeTask('Sunday reset', { type: 'scheduled', scheduledDays: ['sunday'] });
      await advanceRecurrence(deps, '2027-11-05'); // Friday
      expect(await dueOf(id)).toBe('2027-11-07');

      conn.raw
        .prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?')
        .run('2027-11-07 10:00:00', id);
      await advanceRecurrence(deps, '2027-11-07');

      expect(await dueOf(id)).toBe('2027-11-14');
    });
  });

  // ── the negative tests: what the sweep must never touch (constraint #7) ───────────────────

  describe('never touches', () => {
    it('a true one-off (no recurrence row)', async () => {
      const id = await makeTask('Renew passport', undefined, { nextDueAt: '2026-07-01' });

      const result = await advanceRecurrence(deps, MONDAY);

      expect(await dueOf(id)).toBe('2026-07-01'); // still overdue, correctly: it is a deadline
      expect(result.scanned).toBe(0);
      expect(result.advanced).toEqual([]);
    });

    it('an unscheduled task — its neglect clock IS its resurfacing mechanism', async () => {
      const id = await makeTask('Write the novel', { type: 'unscheduled' });

      const result = await advanceRecurrence(deps, MONDAY);

      expect(await dueOf(id)).toBeNull();
      const entity = await recOf(id);
      expect(entity.resetDate).toBeNull();
      expect(entity.lastPeriodShortfall).toBe(0);
      expect(result.scanned).toBe(0);
    });

    it('a count task — N total ever, no period to roll', async () => {
      const id = await makeTask('Review deck', { type: 'count', target: 10, progress: 4 });

      const result = await advanceRecurrence(deps, '2026-12-25');

      expect(await dueOf(id)).toBeNull();
      const entity = await recOf(id);
      expect(entity.resetDate).toBeNull();
      expect(entity.currentPeriodProgress).toBe(4); // the running total, NOT period progress
      expect(result.scanned).toBe(0);
    });

    it('a completed or deleted task, whatever its recurrence', async () => {
      const done = await makeTask('Old routine', { type: 'scheduled', scheduledDays: ['monday'] });
      const gone = await makeTask('Dropped routine', { type: 'quota', quota: 3, period: 'week' });
      await tasks.update(done, { status: 'completed' });
      await tasks.softDelete(gone);

      const result = await advanceRecurrence(deps, MONDAY);

      expect(result.scanned).toBe(0);
      expect(await dueOf(done)).toBeNull();
      expect((await recOf(gone)).resetDate).toBeNull();
    });

    it('the neglect clock: no sweep write lands on a column listActiveByNeglect anchors to', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' });
      const before = await tasks.getById(id);

      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-24');

      const after = await tasks.getById(id);
      // created_at / last_completed_at / last_worked_at are the three-way anchor (R8 + task 33).
      // Nothing here may re-anchor it: that would pause accrual and saturate the fail-safe
      // (constraint #5).
      expect(after!.createdAt).toBe(before!.createdAt);
      expect(after!.lastCompletedAt).toBe(before!.lastCompletedAt);
      expect(after!.lastWorkedAt).toBe(before!.lastWorkedAt);
    });
  });

  // ── composition: the first time period data and the scorer have ever run together ────────

  describe('composition with scoring and R8 (brief §3e)', () => {
    const CHECK_IN: SessionCheckIn = { energy: 'med', contexts: [], tools: [] };
    const NOW = Date.UTC(2026, 7, 10);

    it('a rolled-with-shortfall period reaches scoring as a boost, with importance UNCHANGED on disk', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 1 });
      await tasks.update(id, { importance: 500 });
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-10'); // rolls: shortfall 2

      const pool = await tasks.listActiveByNeglect();
      const item = pool.find((entry) => entry.task.id === id)!;

      expect(item.missedQuota).toEqual({ shortfall: 2, quota: 3, progress: 0 });
      // The whole point of deriving it: the user's own importance value never moved.
      expect(item.task.importance).toBe(500);
      expect(scoreTask(item, CHECK_IN, NOW).factors.importance).toBeGreaterThan(importanceFactor(500));
      expect(
        scoreTask({ ...item, missedQuota: null }, CHECK_IN, NOW).factors.importance,
      ).toBe(importanceFactor(500));
    });

    it('a met period reaches scoring with no boost at all', async () => {
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' }, { progress: 3 });
      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-10');

      const item = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;
      expect(item.missedQuota).toBeNull();
    });

    it('R8’s accrual gate is untouched by rollovers — it reads the DEFINITION, not the period state', async () => {
      // The gate is period/(1+quota) off the anchor. Both come from the recurrence pattern, which
      // no sweep writes; and the anchor's three columns are completion/work-driven, which no sweep
      // writes either. So a period rolling cannot move the gate, in either direction. This is the
      // composition the brief asked to check: they compose by NOT overlapping.
      const id = await makeTask('Gym', { type: 'quota', quota: 3, period: 'week' });
      const before = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;

      await advanceRecurrence(deps, MONDAY);
      await advanceRecurrence(deps, '2026-08-24'); // three periods roll at once

      const after = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;
      expect(after.weeksNeglected).toBeCloseTo(before.weeksNeglected, 5);
    });

    it('a scheduled task’s urgency stops being a constant — the bug this task exists for', async () => {
      // Before the engine: a due date set once by extraction and never advanced reads urgency 1.0
      // forever (overdue), so the factor carried no information for ANY recurring task; one created
      // through the editor had no due date at all and never carried urgency. Both are now truthful.
      const id = await makeTask(
        'Standup notes',
        { type: 'scheduled', scheduledDays: ['monday'] },
        { nextDueAt: '2026-06-01' }, // stale: months overdue
      );
      const stale = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;
      expect(scoreTask(stale, CHECK_IN, NOW).factors.urgency).toBe(1);

      await advanceRecurrence(deps, '2026-08-10'); // a Monday, uncompleted -> due today
      const dueToday = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;
      expect(scoreTask(dueToday, CHECK_IN, Date.UTC(2026, 7, 10)).factors.urgency).toBe(1);

      conn.raw
        .prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?')
        .run('2026-08-10 09:00:00', id);
      await advanceRecurrence(deps, '2026-08-10');
      const done = (await tasks.listActiveByNeglect()).find((entry) => entry.task.id === id)!;
      expect(done.task.nextDueAt).toBe('2026-08-17');
      expect(scoreTask(done, CHECK_IN, Date.UTC(2026, 7, 10)).factors.urgency).toBeLessThan(1);
    });
  });

  describe('input handling', () => {
    it('refuses anything that is not a calendar date, rather than writing junk dates', async () => {
      await expect(advanceRecurrence(deps, '2026-08-03 09:00:00')).rejects.toThrow(/calendar date/);
      await expect(advanceRecurrence(deps, 'today')).rejects.toThrow(/calendar date/);
    });

    it('sweepDateFrom converts a clock reading to the local calendar date callers pass in', () => {
      const now = Date.now();
      const local = new Date(now);
      expect(sweepDateFrom(now)).toBe(
        `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
          local.getDate(),
        ).padStart(2, '0')}`,
      );
    });
  });
});
