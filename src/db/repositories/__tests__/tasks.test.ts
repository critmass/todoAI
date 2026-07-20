import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createTasksRepository, neglectAccrualGapDays, type TasksRepository } from '../tasks';
import { createRecurrenceRepository } from '../recurrence';
import type { Recurrence } from '../../../types/domain';

describe('neglectAccrualGapDays (task 25 R8 — the accrual gate, pure)', () => {
  it('gates scheduled/quota types by period / (1 + quota), matching R8 worked examples', () => {
    // weekly scheduled (one day/week): 7 / (1 + 1) = 3.5 d
    expect(neglectAccrualGapDays({ type: 'scheduled', scheduledDays: ['monday'] })).toBeCloseTo(3.5, 6);
    // quota 3×/week: 7 / (1 + 3) = 1.75 d
    expect(neglectAccrualGapDays({ type: 'quota', quota: 3, period: 'week' })).toBeCloseTo(1.75, 6);
    // quota 15/week: 7 / (1 + 15) = 0.4375 d (~10.5 h)
    expect(neglectAccrualGapDays({ type: 'quota', quota: 15, period: 'week' })).toBeCloseTo(0.4375, 6);
    // scheduled_quota uses its explicit quota, not scheduledDays.length
    expect(
      neglectAccrualGapDays({
        type: 'scheduled_quota',
        quota: 2,
        period: 'week',
        scheduledDays: ['monday', 'thursday', 'friday'],
      }),
    ).toBeCloseTo(7 / 3, 6);
    // monthly quota (covers the 'month' → 30 d branch): 30 / (1 + 2) = 10 d
    expect(neglectAccrualGapDays({ type: 'quota', quota: 2, period: 'month' })).toBeCloseTo(10, 6);
  });

  it('multi-day scheduled uses the occurrence count (shorter gap, surfaces sooner)', () => {
    // Mon+Thu → 2 occurrences/week → 7 / (1 + 2) = 2.33 d (< the single-day 3.5 d)
    expect(
      neglectAccrualGapDays({ type: 'scheduled', scheduledDays: ['monday', 'thursday'] }),
    ).toBeCloseTo(7 / 3, 6);
  });

  it('does NOT gate unscheduled, count, or one-offs (accrue from the anchor as today)', () => {
    expect(neglectAccrualGapDays({ type: 'unscheduled' })).toBe(0);
    expect(neglectAccrualGapDays({ type: 'count', target: 5, progress: 0 })).toBe(0);
    expect(neglectAccrualGapDays(undefined)).toBe(0); // one-off
  });
});

describe('tasksRepository', () => {
  let conn: TestSqliteConnection;
  let repo: TasksRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createTasksRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update -> getById -> soft-delete round-trips domain types', async () => {
    const created = await repo.create({
      title: 'Take out the trash',
      estimatedDuration: 5,
      importance: 700,
      contextTags: ['home'],
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Take out the trash');
    expect(created.durationSource).toBe('model_guess'); // default per brief
    expect(created.status).toBe('active');
    expect(created.contextTags).toEqual(['home']);
    expect(created.skipReasons).toEqual([]);
    expect(created.actualDurationHistory).toEqual([]);

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.update(created.id, {
      title: 'Take out the recycling',
      contextTags: ['home', 'weekly'],
      skipReasons: ['forgot'],
    });
    expect(updated.title).toBe('Take out the recycling');
    expect(updated.contextTags).toEqual(['home', 'weekly']);
    expect(updated.skipReasons).toEqual(['forgot']);
    expect(updated.id).toBe(created.id);

    const refetched = await repo.getById(created.id);
    expect(refetched).toEqual(updated);

    await repo.softDelete(created.id);
    const afterDelete = await repo.getById(created.id);
    expect(afterDelete?.status).toBe('deleted');

    const active = await repo.listActive();
    expect(active.find((t) => t.id === created.id)).toBeUndefined();
  });

  it('honors an explicit duration_source of "user"', async () => {
    const created = await repo.create({
      title: 'Renew passport',
      estimatedDuration: 30,
      durationSource: 'user',
    });
    expect(created.durationSource).toBe('user');
  });

  it('recordUnscheduledCompletion sets last_completed_at but leaves status active', async () => {
    const created = await repo.create({ title: 'Ongoing project', estimatedDuration: 60 });
    expect(created.lastCompletedAt).toBeNull();

    const completed = await repo.recordUnscheduledCompletion(created.id);
    expect(completed.status).toBe('active');
    expect(completed.lastCompletedAt).not.toBeNull();
  });

  it('recordProgressEpisode accumulates minutes, marks in_progress, stamps last_worked_at, never skips (task 28)', async () => {
    const created = await repo.create({ title: 'Big project', estimatedDuration: 120 });
    expect(created.workState).toBe('none');
    expect(created.accumulatedMinutes).toBe(0);
    expect(created.lastWorkedAt).toBeNull();

    const afterFirst = await repo.recordProgressEpisode(created.id, 25);
    expect(afterFirst.workState).toBe('in_progress');
    expect(afterFirst.accumulatedMinutes).toBe(25);
    expect(afterFirst.lastWorkedAt).not.toBeNull();
    expect(afterFirst.status).toBe('active'); // parked tasks stay in the pool

    // A second sitting accumulates on top; still never a skip or a success-rate change.
    const afterSecond = await repo.recordProgressEpisode(created.id, 15);
    expect(afterSecond.accumulatedMinutes).toBe(40);
    expect(afterSecond.skipCount).toBe(0);
    expect(afterSecond.successRate).toBe(0);
  });

  it('listActive only returns active tasks', async () => {
    const a = await repo.create({ title: 'A', estimatedDuration: 10 });
    const b = await repo.create({ title: 'B', estimatedDuration: 10 });
    await repo.softDelete(a.id);

    const active = await repo.listActive();
    expect(active.map((t) => t.id)).toEqual([b.id]);
  });

  it('listActiveByNeglect orders most-neglected first and computes an uncapped linear multiplier', async () => {
    const older = await repo.create({ title: 'Old task', estimatedDuration: 10 });
    const newer = await repo.create({ title: 'New task', estimatedDuration: 10 });

    // Backdate `older`'s created_at by 21 days (3 weeks) so its neglect multiplier is 3 (linear).
    conn.raw
      .prepare("UPDATE tasks SET created_at = datetime('now', '-21 days') WHERE id = ?")
      .run(older.id);

    const byNeglect = await repo.listActiveByNeglect();
    expect(byNeglect[0].task.id).toBe(older.id);
    expect(byNeglect[0].weeksNeglected).toBeCloseTo(3, 1);
    expect(byNeglect[0].neglectMultiplier).toBeCloseTo(3, 1);
    expect(byNeglect[1].task.id).toBe(newer.id);
    expect(byNeglect[1].neglectMultiplier).toBeLessThan(byNeglect[0].neglectMultiplier);
  });

  describe('listActiveByNeglect — R8 accrual gate (task 25)', () => {
    let recurrence: ReturnType<typeof createRecurrenceRepository>;
    beforeEach(() => {
      recurrence = createRecurrenceRepository(conn);
    });

    /** Create a task, attach `rec`, and backdate its created_at by `ageDays`. */
    async function makeAged(rec: Recurrence | undefined, ageDays: number): Promise<number> {
      const task = await repo.create({ title: 'T', estimatedDuration: 10 });
      if (rec) await recurrence.create(task.id, rec);
      conn.raw
        .prepare(`UPDATE tasks SET created_at = datetime('now', '-${ageDays} days') WHERE id = ?`)
        .run(task.id);
      return task.id;
    }

    async function weeksFor(taskId: number): Promise<number> {
      const rows = await repo.listActiveByNeglect();
      const row = rows.find((r) => r.task.id === taskId);
      if (!row) throw new Error('task not found in neglect list');
      return row.weeksNeglected;
    }

    it('a recurring task INSIDE its gap has weeksNeglected 0 (multiplier 1.0)', async () => {
      // weekly scheduled, gap 3.5 d; only 2 days old → still inside the gap.
      const id = await makeAged({ type: 'scheduled', scheduledDays: ['monday'] }, 2);
      expect(await weeksFor(id)).toBe(0);
    });

    it('a recurring task PAST its gap accrues from accrualStart, not from the anchor', async () => {
      // weekly scheduled, gap 3.5 d; 10 days old. accrualStart = created + 3.5 d = 6.5 d ago →
      // 6.5/7 ≈ 0.93 weeks. (Ungated, it would be 10/7 ≈ 1.43 — proving the offset applied.)
      const id = await makeAged({ type: 'scheduled', scheduledDays: ['monday'] }, 10);
      expect(await weeksFor(id)).toBeCloseTo(6.5 / 7, 1);
      expect(await weeksFor(id)).toBeLessThan(10 / 7); // definitely gated
    });

    it('a quota 3×/week task gates by 1.75 d', async () => {
      // 14 days old, gap 1.75 d → accrualStart 12.25 d ago → 12.25/7 = 1.75 weeks.
      const id = await makeAged({ type: 'quota', quota: 3, period: 'week' }, 14);
      expect(await weeksFor(id)).toBeCloseTo(12.25 / 7, 1);
    });

    it('unscheduled is NOT gated — neglect is its whole resurfacing mechanism', async () => {
      const id = await makeAged({ type: 'unscheduled' }, 21);
      expect(await weeksFor(id)).toBeCloseTo(3, 1); // full 21 days / 7, no offset
    });

    it('count is NOT gated (no period to halve)', async () => {
      const id = await makeAged({ type: 'count', target: 5, progress: 0 }, 21);
      expect(await weeksFor(id)).toBeCloseTo(3, 1);
    });

    it('a one-off (no recurrence row) accrues from created_at, ungated', async () => {
      const id = await makeAged(undefined, 21);
      expect(await weeksFor(id)).toBeCloseTo(3, 1);
    });

    it('the gate offsets from the anchor: last_completed_at moves the clock, then the gap applies', async () => {
      // weekly scheduled completed 10 days ago (last_completed_at is the anchor, gap 3.5 d).
      const task = await repo.create({ title: 'T', estimatedDuration: 10 });
      await recurrence.create(task.id, { type: 'scheduled', scheduledDays: ['monday'] });
      conn.raw
        .prepare(
          `UPDATE tasks SET created_at = datetime('now', '-90 days'),
             last_completed_at = datetime('now', '-10 days') WHERE id = ?`,
        )
        .run(task.id);
      // Anchor is the 10-day-old completion, NOT the 90-day-old creation; gap 3.5 d → ≈0.93 wk.
      expect(await weeksFor(task.id)).toBeCloseTo(6.5 / 7, 1);
    });

    it('the linear curve stays unbounded three orders of magnitude out (R1 fail-safe intact)', async () => {
      // A weekly scheduled task 1000 days neglected: gate offset (3.5 d) is negligible, growth is
      // unbounded and linear — never saturates (constraint #5).
      const id = await makeAged({ type: 'scheduled', scheduledDays: ['monday'] }, 1000);
      const weeks = await weeksFor(id);
      expect(weeks).toBeCloseTo((1000 - 3.5) / 7, 0);
      expect(weeks).toBeGreaterThan(140);
    });
  });

  describe('listActiveByNeglect — last_worked_at re-anchor (task 33, §5)', () => {
    async function weeksFor(taskId: number): Promise<number> {
      const rows = await repo.listActiveByNeglect();
      const row = rows.find((r) => r.task.id === taskId);
      if (!row) throw new Error('task not found in neglect list');
      return row.weeksNeglected;
    }

    it('working a task re-anchors the clock: worked yesterday reads ≈1/7 wk regardless of created_at', async () => {
      const task = await repo.create({ title: 'Long project', estimatedDuration: 180 });
      // Created 100 days ago (would be ~14 weeks neglected) but WORKED yesterday.
      conn.raw
        .prepare(
          `UPDATE tasks SET created_at = datetime('now', '-100 days'),
             last_worked_at = datetime('now', '-1 day') WHERE id = ?`,
        )
        .run(task.id);
      const weeks = await weeksFor(task.id);
      expect(weeks).toBeCloseTo(1 / 7, 1); // anchored on the work, not creation
      expect(weeks).toBeLessThan(1); // definitely not ~14
    });

    it('the three-way max takes the LATEST of created/completed/worked', async () => {
      const task = await repo.create({ title: 'T', estimatedDuration: 30 });
      // completed 30 days ago, but worked only 3 days ago → anchor is the more recent work.
      conn.raw
        .prepare(
          `UPDATE tasks SET created_at = datetime('now', '-60 days'),
             last_completed_at = datetime('now', '-30 days'),
             last_worked_at = datetime('now', '-3 days') WHERE id = ?`,
        )
        .run(task.id);
      expect(await weeksFor(task.id)).toBeCloseTo(3 / 7, 1);
    });

    it('a NULL last_worked_at falls back to the other anchors (no NaN, no surprise)', async () => {
      const task = await repo.create({ title: 'T', estimatedDuration: 30 });
      conn.raw
        .prepare("UPDATE tasks SET created_at = datetime('now', '-14 days') WHERE id = ?")
        .run(task.id);
      // last_worked_at and last_completed_at are NULL → anchor is created_at (2 weeks).
      expect(await weeksFor(task.id)).toBeCloseTo(2, 1);
    });

    it('re-anchor composes with the R8 gate: a recurring task worked recently is inside its gap', async () => {
      const task = await repo.create({ title: 'Weekly chore', estimatedDuration: 30 });
      const recurrence = createRecurrenceRepository(conn);
      await recurrence.create(task.id, { type: 'scheduled', scheduledDays: ['monday'] });
      // Old task, but worked 1 day ago. Anchor = 1 day ago; gap 3.5 d → accrualStart is in the
      // future → weeksNeglected clamps to 0.
      conn.raw
        .prepare(
          `UPDATE tasks SET created_at = datetime('now', '-200 days'),
             last_worked_at = datetime('now', '-1 day') WHERE id = ?`,
        )
        .run(task.id);
      expect(await weeksFor(task.id)).toBe(0);
    });
  });
});
