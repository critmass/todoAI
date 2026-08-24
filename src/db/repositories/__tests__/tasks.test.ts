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

describe('neglectAccrualGapDays with task 46 repeat modes (R8 still reads the DEFINITION)', () => {
  // The gate is `cycle / (1 + occurrences per cycle)`. A repeat mode changes both halves of that
  // fraction and nothing else: it is still a START condition, never a cap (constraint #5).

  it('an absent or explicit everyWeek is the pre-task-46 answer, unchanged', () => {
    expect(neglectAccrualGapDays({ type: 'scheduled', scheduledDays: ['monday'] })).toBeCloseTo(3.5, 6);
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: ['monday'],
        repeat: { mode: 'everyWeek' },
      }),
    ).toBeCloseTo(3.5, 6);
  });

  it('interval stretches the cycle: every other Wednesday is 14 / (1 + 1) = 7 d', () => {
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: ['wednesday'],
        repeat: { mode: 'interval', weeks: 2 },
      }),
    ).toBeCloseTo(7, 6);
    // Three-week stride, two days per on-week: 21 / (1 + 2) = 7 d
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: ['tuesday', 'thursday'],
        repeat: { mode: 'interval', weeks: 3 },
      }),
    ).toBeCloseTo(7, 6);
  });

  it('ordinal is a MONTHLY cycle: 1st & 3rd Wednesday is 30 / (1 + 2) ≈ 10 d (brief §4)', () => {
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: ['wednesday'],
        repeat: { mode: 'ordinal', ordinals: [1, 3] },
      }),
    ).toBeCloseTo(10, 6);
    // Two weekdays x one ordinal, every other month: 60 / (1 + 2) = 20 d
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: ['monday', 'friday'],
        repeat: { mode: 'ordinal', ordinals: ['last'], months: 2 },
      }),
    ).toBeCloseTo(20, 6);
  });

  it('dayOfMonth counts dates, not weekdays: the 15th is 30 / (1 + 1) = 15 d', () => {
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [15] },
      }),
    ).toBeCloseTo(15, 6);
    // 1st & 15th, quarterly: 90 / (1 + 2) = 30 d
    expect(
      neglectAccrualGapDays({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [1, 15], months: 3 },
      }),
    ).toBeCloseTo(30, 6);
  });

  it('never returns a gap that would gate accrual forever, however sparse the schedule', () => {
    // A yearly reminder still starts accruing — the fail-safe is uncapped and must remain reachable.
    const gap = neglectAccrualGapDays({
      type: 'scheduled',
      scheduledDays: [],
      repeat: { mode: 'dayOfMonth', days: [1], months: 12 },
    });
    expect(gap).toBeCloseTo(180, 6);
    expect(Number.isFinite(gap)).toBe(true);
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

  it('recordSkipEpisode increments skip_count and appends the reason chip (task 13)', async () => {
    const created = await repo.create({ title: 'Email inbox', estimatedDuration: 20 });
    expect(created.skipCount).toBe(0);

    const first = await repo.recordSkipEpisode(created.id);
    expect(first.skipCount).toBe(1);
    expect(first.skipReasons).toEqual([]); // the chip is optional

    const second = await repo.recordSkipEpisode(created.id, 'too boring');
    expect(second.skipCount).toBe(2);
    expect(second.skipReasons).toEqual(['too boring']);
  });

  it('recordSkipEpisode RETAINS an in-progress task’s accumulated time (design §1.3)', async () => {
    const created = await repo.create({ title: 'Big project', estimatedDuration: 120 });
    await repo.recordProgressEpisode(created.id, 40);

    const skipped = await repo.recordSkipEpisode(created.id);
    expect(skipped.skipCount).toBe(1);
    expect(skipped.workState).toBe('in_progress'); // skipping does not un-park
    expect(skipped.accumulatedMinutes).toBe(40); // and does not discard the work
  });

  it('the park and skip primitives cannot reach each other’s columns (constraint #11)', async () => {
    const created = await repo.create({ title: 'Mix track', estimatedDuration: 60 });

    const parked = await repo.recordProgressEpisode(created.id, 30);
    expect(parked.skipCount).toBe(0);
    expect(parked.skipReasons).toEqual([]);

    const skipped = await repo.recordSkipEpisode(created.id, 'not now');
    expect(skipped.accumulatedMinutes).toBe(30); // unchanged by the skip
    expect(skipped.lastWorkedAt).toBe(parked.lastWorkedAt); // skip is not attention
  });

  // ── Task 17 Phase A — the historical-success counters (the writer that did not exist) ────────
  //
  // The invariant both primitives maintain, and the ONLY definition of "attempt" in the codebase:
  //     success_rate = completion_count / (completion_count + skip_count)
  // which is exactly the denominator `scoreTask` already passes to `historicalSuccessFactor`
  // (`completionCount + skipCount`). Holding it means R6's shrinkage collapses to the Laplace
  // form (C + 1)/(C + S + 2) — see the module comment on recordHistoricalCompletion.
  describe('historical-success counters (task 17 Phase A)', () => {
    /** The invariant, asserted directly. Every test below ends by calling this. */
    async function expectInvariant(id: number): Promise<void> {
      const task = await repo.getById(id);
      expect(task).not.toBeNull();
      const { completionCount, skipCount, successRate } = task!;
      const attempts = completionCount + skipCount;
      expect(successRate).toBeCloseTo(attempts === 0 ? 0 : completionCount / attempts, 10);
    }

    it('recordHistoricalCompletion increments completion_count and recomputes success_rate', async () => {
      const created = await repo.create({ title: 'Water the plants', estimatedDuration: 5 });
      expect(created.completionCount).toBe(0);
      expect(created.successRate).toBe(0);

      const first = await repo.recordHistoricalCompletion(created.id);
      expect(first.completionCount).toBe(1);
      expect(first.skipCount).toBe(0);
      expect(first.successRate).toBeCloseTo(1, 10); // 1/1
      await expectInvariant(created.id);

      const second = await repo.recordHistoricalCompletion(created.id);
      expect(second.completionCount).toBe(2);
      expect(second.successRate).toBeCloseTo(1, 10); // 2/2
      await expectInvariant(created.id);
    });

    it('recordSkipEpisode recomputes success_rate too — a skip is an attempt that failed', async () => {
      const created = await repo.create({ title: 'Call the dentist', estimatedDuration: 10 });

      const skipped = await repo.recordSkipEpisode(created.id, 'not now');
      expect(skipped.skipCount).toBe(1);
      expect(skipped.completionCount).toBe(0);
      expect(skipped.successRate).toBeCloseTo(0, 10); // 0/1
      await expectInvariant(created.id);

      const done = await repo.recordHistoricalCompletion(created.id);
      expect(done.successRate).toBeCloseTo(0.5, 10); // 1/(1+1)
      await expectInvariant(created.id);

      // The DISCRIMINATING case, and the reason the two assertions above are not enough on their
      // own: everything so far would also pass if only the completion writer recomputed. A skip
      // that lands AFTER a completion can only come out right if the SKIP writer recomputes too.
      const skippedAgain = await repo.recordSkipEpisode(created.id);
      expect(skippedAgain.successRate).toBeCloseTo(1 / 3, 10); // 1/(1+2), not still 0.5
      await expectInvariant(created.id);
    });

    it('holds the invariant across an interleaved history (2 done / 8 skipped → 0.2)', async () => {
      const created = await repo.create({ title: 'Tidy the garage', estimatedDuration: 45 });
      const script = ['skip', 'done', 'skip', 'skip', 'skip', 'done', 'skip', 'skip', 'skip', 'skip'];
      for (const step of script) {
        if (step === 'done') await repo.recordHistoricalCompletion(created.id);
        else await repo.recordSkipEpisode(created.id);
        await expectInvariant(created.id); // holds after EVERY write, not just at the end
      }
      const final = await repo.getById(created.id);
      expect(final?.completionCount).toBe(2);
      expect(final?.skipCount).toBe(8);
      expect(final?.successRate).toBeCloseTo(0.2, 10);
    });

    it('is REAL division, not SQLite integer division (1 completion + 3 skips is 0.25, not 0)', async () => {
      // SQLite's `/` on two INTEGER columns truncates: `1/4` is 0. The rate would then be a
      // step function that is 0 everywhere below 1.0 — silently plausible and completely wrong.
      const created = await repo.create({ title: 'Practice scales', estimatedDuration: 15 });
      await repo.recordHistoricalCompletion(created.id);
      await repo.recordSkipEpisode(created.id);
      await repo.recordSkipEpisode(created.id);
      const after = await repo.recordSkipEpisode(created.id);
      expect(after.successRate).toBeCloseTo(0.25, 10);
      expect(after.successRate).not.toBe(0);
    });

    it('stays inside the migration-001 CHECK (0.0 ≤ success_rate ≤ 1.0) at both extremes', async () => {
      const allDone = await repo.create({ title: 'All done', estimatedDuration: 5 });
      for (let i = 0; i < 5; i += 1) await repo.recordHistoricalCompletion(allDone.id);
      expect((await repo.getById(allDone.id))?.successRate).toBe(1);

      const allSkipped = await repo.create({ title: 'All skipped', estimatedDuration: 5 });
      for (let i = 0; i < 5; i += 1) await repo.recordSkipEpisode(allSkipped.id);
      expect((await repo.getById(allSkipped.id))?.successRate).toBe(0);
    });

    it('the park primitive still touches neither counter (constraint #11 — a park is not an attempt)', async () => {
      const created = await repo.create({ title: 'Mix track', estimatedDuration: 60 });
      await repo.recordHistoricalCompletion(created.id); // give it a real rate to disturb
      await repo.recordSkipEpisode(created.id);
      const before = await repo.getById(created.id);

      const parked = await repo.recordProgressEpisode(created.id, 30);
      expect(parked.completionCount).toBe(before?.completionCount);
      expect(parked.skipCount).toBe(before?.skipCount);
      expect(parked.successRate).toBe(before?.successRate);
    });

    it('recordUnscheduledCompletion alone moves NEITHER counter — the counters are a separate primitive', async () => {
      // The neglect-clock primitive and the historical-success counters are deliberately not the
      // same write: `completeTask` calls both, and the split is what keeps a park/recovery from
      // ever reaching these columns. See services/taskCompletion.ts.
      const created = await repo.create({ title: 'Ongoing project', estimatedDuration: 60 });
      const after = await repo.recordUnscheduledCompletion(created.id);
      expect(after.completionCount).toBe(0);
      expect(after.skipCount).toBe(0);
      expect(after.successRate).toBe(0);
    });

    it('a pre-writer row (skips recorded, completion_count 0) is already on the invariant', async () => {
      // Every row in Jason's alpha database is in this state: skip_count may be nonzero, but
      // completion_count is 0 everywhere because no writer ever existed, and success_rate is at
      // its 0.0 default. 0/(0+S) = 0 — so the invariant holds retroactively and Phase A needs no
      // migration or backfill to become consistent.
      const created = await repo.create({ title: 'Legacy row', estimatedDuration: 20 });
      await conn.execute('UPDATE tasks SET skip_count = 8, success_rate = 0.0 WHERE id = ?', [
        created.id,
      ]);
      await expectInvariant(created.id);

      // And the very first completion moves it onto the curve correctly: 1/(1+8).
      const done = await repo.recordHistoricalCompletion(created.id);
      expect(done.successRate).toBeCloseTo(1 / 9, 10);
      await expectInvariant(created.id);
    });
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
