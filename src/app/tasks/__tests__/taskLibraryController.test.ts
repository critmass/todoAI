// Task 24 — the editor's persistence, against real SQLite. The three-way recurrence upsert is the
// only thing here with a real trap in it, so that is what these mostly test.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createCoachingRepository } from '../../../db/repositories/coaching';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { createInteractionsRepository } from '../../../db/repositories/interactions';
import { createRecurrenceRepository } from '../../../db/repositories/recurrence';
import { createTasksRepository } from '../../../db/repositories/tasks';
import { createTaskLibraryController } from '../taskLibraryController';
import { recurrenceKindPatch } from '../taskDraft';

describe('task library controller (task 24)', () => {
  let conn: TestSqliteConnection;
  let tasks: ReturnType<typeof createTasksRepository>;
  let recurrence: ReturnType<typeof createRecurrenceRepository>;
  let dependencies: ReturnType<typeof createDependenciesRepository>;
  let coaching: ReturnType<typeof createCoachingRepository>;
  let interactions: ReturnType<typeof createInteractionsRepository>;

  function controller() {
    return createTaskLibraryController({ tasks, recurrence, dependencies, coaching, interactions });
  }

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    dependencies = createDependenciesRepository(conn);
    coaching = createCoachingRepository(conn);
    interactions = createInteractionsRepository(conn);
  });

  afterEach(() => conn.close());

  it('creates a task and its recurrence row together', async () => {
    const ctl = controller();
    ctl.openNew();
    ctl.change({ title: 'Stretch', estimatedDuration: '5', kind: 'quota', quota: '3', period: 'week' });
    expect(await ctl.save()).toBe(true);

    const [created] = await tasks.listActive();
    expect(created.title).toBe('Stretch');
    expect(await recurrence.getByTaskId(created.id)).toEqual({
      type: 'quota',
      quota: 3,
      period: 'week',
    });
  });

  it('creates NO recurrence row for a one-off', async () => {
    const ctl = controller();
    ctl.openNew();
    ctl.change({ title: 'Renew passport', estimatedDuration: '30' });
    await ctl.save();

    const [created] = await tasks.listActive();
    expect(await recurrence.getByTaskId(created.id)).toBeUndefined();
  });

  describe('the three-way recurrence upsert', () => {
    async function seedRepeating() {
      const task = await tasks.create({ title: 'Stretch', estimatedDuration: 5 });
      await recurrence.create(task.id, { type: 'quota', quota: 3, period: 'week' });
      return task;
    }

    it('UPDATES an existing row when the kind changes to another repeating kind', async () => {
      const task = await seedRepeating();
      const ctl = controller();
      await ctl.open(task.id);
      ctl.change({ kind: 'count', target: '10' });
      await ctl.save();

      expect(await recurrence.getByTaskId(task.id)).toEqual({
        type: 'count',
        target: 10,
        progress: 0,
      });
    });

    it('DELETES the row when the task goes back to being a one-off', async () => {
      const task = await seedRepeating();
      const ctl = controller();
      await ctl.open(task.id);
      ctl.change({ kind: 'once' });
      await ctl.save();

      // The constraint-#7 bug this exists to prevent: writing {type:'unscheduled'} here would
      // silently turn a task that closes on completion into one that never closes.
      expect(await recurrence.getByTaskId(task.id)).toBeUndefined();
    });

    it('CREATES a row when a one-off becomes repeating', async () => {
      const task = await tasks.create({ title: 'Renew passport', estimatedDuration: 30 });
      const ctl = controller();
      await ctl.open(task.id);
      ctl.change({ kind: 'ongoing' });
      await ctl.save();

      expect(await recurrence.getByTaskId(task.id)).toEqual({ type: 'unscheduled' });
    });
  });

  describe('delete', () => {
    it('is a soft delete — the row survives for history and foreign keys', async () => {
      const task = await tasks.create({ title: 'Mix track', estimatedDuration: 25 });
      const ctl = controller();
      await ctl.open(task.id);
      expect(ctl.getState().canDelete).toBe(true);
      expect(await ctl.remove()).toBe(true);

      expect((await tasks.getById(task.id))?.status).toBe('deleted');
      expect(await tasks.listActive()).toHaveLength(0);
    });

    it('is refused while another task depends on this one', async () => {
      const blocker = await tasks.create({ title: 'Buy paint', estimatedDuration: 20 });
      const dependent = await tasks.create({ title: 'Paint the shed', estimatedDuration: 60 });
      await dependencies.add(dependent.id, blocker.id);

      const ctl = controller();
      await ctl.open(blocker.id);
      expect(ctl.getState().canDelete).toBe(false);
      expect(await ctl.remove()).toBe(false);
      expect((await tasks.getById(blocker.id))?.status).toBe('active');
    });
  });

  it('will not save an invalid draft', async () => {
    const ctl = controller();
    ctl.openNew();
    ctl.change({ title: '' });
    expect(await ctl.save()).toBe(false);
    expect(await tasks.listActive()).toHaveLength(0);
  });

  it('summarises each row with its recurrence, length and work state', async () => {
    const task = await tasks.create({ title: 'Write chapter', estimatedDuration: 45 });
    await recurrence.create(task.id, { type: 'unscheduled' });
    await tasks.recordProgressEpisode(task.id, 12);

    const ctl = controller();
    await ctl.refresh();
    expect(ctl.getState().rows).toEqual([
      {
        id: task.id,
        title: 'Write chapter',
        summary: 'Ongoing · 45 min · In progress',
        blocked: false,
        blockedReason: null,
      },
    ]);
  });

  // Task 44 §0 ruling 1 — "a task blocked by other tasks gets both buttons disabled."
  describe('blocked status (task 44)', () => {
    it('flags a dependency-blocked task, with a reason naming the blocker', async () => {
      const blocker = await tasks.create({ title: 'Buy paint', estimatedDuration: 20 });
      const dependent = await tasks.create({ title: 'Paint the shed', estimatedDuration: 60 });
      await dependencies.add(dependent.id, blocker.id);

      const ctl = controller();
      await ctl.refresh();
      const row = ctl.getState().rows.find((r) => r.id === dependent.id);
      expect(row?.blocked).toBe(true);
      expect(row?.blockedReason).toBe('blocked by Buy paint');

      const blockerRow = ctl.getState().rows.find((r) => r.id === blocker.id);
      expect(blockerRow?.blocked).toBe(false);
    });

    it('flags a parent held for R7 breakdown_complete', async () => {
      const parent = await tasks.create({ title: 'Ship the release', estimatedDuration: 30 });
      const entry = await coaching.create({ triggerType: 'breakdown_complete', urgency: 'immediate' });
      await coaching.linkTask(entry.id, parent.id);

      const ctl = controller();
      await ctl.refresh();
      const row = ctl.getState().rows.find((r) => r.id === parent.id);
      expect(row?.blocked).toBe(true);
      expect(row?.blockedReason).toMatch(/breakdown check-off/);
    });
  });

  // Task 44 §4 — self-complete.
  describe('selfComplete (task 44)', () => {
    it('reuses completeTask (closes a one-off) and writes an interactions row with explicit nulls', async () => {
      const task = await tasks.create({ title: 'Renew passport', estimatedDuration: 30 });
      const ctl = controller();
      await ctl.refresh();

      expect(await ctl.selfComplete(task.id)).toBe(true);
      expect((await tasks.getById(task.id))?.status).toBe('completed');

      // self-complete writes session_id = NULL, so listBySession (which filters ON a session id)
      // can't find it — query the table directly instead.
      const raw = conn.raw
        .prepare('SELECT * FROM interactions WHERE interaction_type = ?')
        .all('task_completion') as any[];
      expect(raw).toHaveLength(1);
      expect(raw[0]).toMatchObject({
        session_id: null,
        user_energy_level_start: null,
        user_energy_level_end: null,
        duration_minutes: null,
        completion_status: 'completed',
        notes: 'self_completed',
      });

      const link = conn.raw
        .prepare('SELECT * FROM interaction_tasks WHERE interaction_id = ?')
        .get(raw[0].id) as any;
      expect(link.task_id).toBe(task.id);
    });

    it('keeps an unscheduled/recurring task active and resets its neglect clock', async () => {
      const task = await tasks.create({ title: 'Water plants', estimatedDuration: 5 });
      await recurrence.create(task.id, { type: 'unscheduled' });
      const ctl = controller();
      await ctl.refresh();

      expect(await ctl.selfComplete(task.id)).toBe(true);
      const after = await tasks.getById(task.id);
      expect(after?.status).toBe('active');
      expect(after?.lastCompletedAt).not.toBeNull();
    });

    it('refuses on a blocked task even if asked directly (defence in depth)', async () => {
      const blocker = await tasks.create({ title: 'Buy paint', estimatedDuration: 20 });
      const dependent = await tasks.create({ title: 'Paint the shed', estimatedDuration: 60 });
      await dependencies.add(dependent.id, blocker.id);

      const ctl = controller();
      await ctl.refresh();
      expect(await ctl.selfComplete(dependent.id)).toBe(false);
      expect((await tasks.getById(dependent.id))?.status).toBe('active');
    });

    it('does not invent a duration: no accumulated time means no actual_duration_history entry', async () => {
      const task = await tasks.create({ title: 'Renew passport', estimatedDuration: 30 });
      const ctl = controller();
      await ctl.refresh();
      await ctl.selfComplete(task.id);
      const after = await tasks.getById(task.id);
      expect(after?.actualDurationHistory).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Task 46 phase 2 — REACHABILITY, end to end and against real SQLite.
  //
  // Phase 1 shipped an engine nothing could construct a `repeat` for. These are the tests that say
  // it is no longer true: the editor's own patches go in at the top, and a real `task_recurrence`
  // row with a real `repeat` comes out at the bottom.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('task 46 phase 2 — the four scheduled modes, editor to database', () => {
    function pattern(taskId: number): string {
      const row = conn.raw
        .prepare('SELECT recurrence_pattern FROM task_recurrence WHERE task_id = ?')
        .get(taskId) as { recurrence_pattern: string };
      return row.recurrence_pattern;
    }

    it('🔴 opening a legacy weekly task and saving it untouched leaves the row alone', async () => {
      const task = await tasks.create({ title: 'Stretch', estimatedDuration: 5 });
      await recurrence.create(task.id, { type: 'scheduled', scheduledDays: ['monday', 'friday'] });
      const before = pattern(task.id);

      const ctl = controller();
      await ctl.open(task.id);
      expect(await ctl.save()).toBe(true);

      // Byte-for-byte: no `repeat` key appears, so the three real recurring tasks in the live alpha
      // database are not quietly migrated by being opened.
      expect(pattern(task.id)).toBe(before);
      expect(pattern(task.id)).not.toContain('repeat');
      expect(await recurrence.getByTaskId(task.id)).toEqual({
        type: 'scheduled',
        scheduledDays: ['monday', 'friday'],
      });
    });

    it('writes "every N weeks" as a real interval repeat', async () => {
      const ctl = controller();
      ctl.openNew();
      ctl.change({ title: 'Bins out', estimatedDuration: '5' });
      ctl.change(recurrenceKindPatch('schedule_interval'));
      ctl.change({ scheduledDays: ['tuesday'], weekInterval: '2' });
      expect(await ctl.save()).toBe(true);

      const [created] = await tasks.listActive();
      expect(await recurrence.getByTaskId(created.id)).toEqual({
        type: 'scheduled',
        scheduledDays: ['tuesday'],
        repeat: { mode: 'interval', weeks: 2 },
      });
    });

    it('writes "weeks of the month" as the ticked cells, and only those', async () => {
      const ctl = controller();
      ctl.openNew();
      ctl.change({ title: 'Pay the cleaner', estimatedDuration: '5' });
      ctl.change(recurrenceKindPatch('schedule_ordinal'));
      ctl.change({
        ordinalCells: [
          { ordinal: 1, weekday: 'monday' },
          { ordinal: 3, weekday: 'wednesday' },
        ],
        monthInterval: '1',
      });
      expect(await ctl.save()).toBe(true);

      const [created] = await tasks.listActive();
      expect(await recurrence.getByTaskId(created.id)).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        // TWO occurrences a month, not the four a row × column cross product would have written.
        repeat: {
          mode: 'ordinal',
          cells: [
            { ordinal: 1, weekday: 'monday' },
            { ordinal: 3, weekday: 'wednesday' },
          ],
        },
      });
    });

    it('writes "dates" as days of the month, with a stride', async () => {
      const ctl = controller();
      ctl.openNew();
      ctl.change({ title: 'Read the meter', estimatedDuration: '5' });
      ctl.change(recurrenceKindPatch('schedule_dates'));
      ctl.change({ monthDays: [1, 15], monthInterval: '2' });
      expect(await ctl.save()).toBe(true);

      const [created] = await tasks.listActive();
      expect(await recurrence.getByTaskId(created.id)).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [1, 15], months: 2 },
      });
    });

    it('🔴 a weekly task switched to Dates in the editor SAVES — the repository does not reject it', async () => {
      const task = await tasks.create({ title: 'Water the plants', estimatedDuration: 5 });
      await recurrence.create(task.id, {
        type: 'scheduled',
        scheduledDays: ['monday', 'thursday'],
      });

      const ctl = controller();
      await ctl.open(task.id);
      expect(ctl.getState().draft.scheduledDays).toEqual(['monday', 'thursday']);
      // Exactly what the dropdown sends: the kind AND the cleared weekdays, in one patch.
      ctl.change(recurrenceKindPatch('schedule_dates'));
      ctl.change({ monthDays: [1] });

      expect(await ctl.save()).toBe(true);
      expect(ctl.getState().error).toBeNull();
      expect(await recurrence.getByTaskId(task.id)).toEqual({
        type: 'scheduled',
        scheduledDays: [],
        repeat: { mode: 'dayOfMonth', days: [1] },
      });
    });

    it('re-opens each saved mode as itself, so a second save is a no-op', async () => {
      const ctl = controller();
      ctl.openNew();
      ctl.change({ title: 'Pay the cleaner', estimatedDuration: '5' });
      ctl.change(recurrenceKindPatch('schedule_ordinal'));
      ctl.change({ ordinalCells: [{ ordinal: 'last', weekday: 'friday' }], monthInterval: '3' });
      await ctl.save();

      const [created] = await tasks.listActive();
      const stored = pattern(created.id);

      const reopened = controller();
      await reopened.open(created.id);
      expect(reopened.getState().draft.kind).toBe('schedule_ordinal');
      expect(reopened.getState().draft.monthInterval).toBe('3');
      expect(await reopened.save()).toBe(true);
      expect(pattern(created.id)).toBe(stored);
    });
  });
});
