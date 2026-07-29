// Task 24 — the editor's persistence, against real SQLite. The three-way recurrence upsert is the
// only thing here with a real trap in it, so that is what these mostly test.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { createRecurrenceRepository } from '../../../db/repositories/recurrence';
import { createTasksRepository } from '../../../db/repositories/tasks';
import { createTaskLibraryController } from '../taskLibraryController';

describe('task library controller (task 24)', () => {
  let conn: TestSqliteConnection;
  let tasks: ReturnType<typeof createTasksRepository>;
  let recurrence: ReturnType<typeof createRecurrenceRepository>;
  let dependencies: ReturnType<typeof createDependenciesRepository>;

  function controller() {
    return createTaskLibraryController({ tasks, recurrence, dependencies });
  }

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    dependencies = createDependenciesRepository(conn);
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
      { id: task.id, title: 'Write chapter', summary: 'Ongoing · 45 min · In progress' },
    ]);
  });
});
