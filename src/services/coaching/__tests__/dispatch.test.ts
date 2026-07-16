import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createTasksRepository, type TasksRepository } from '../../../db/repositories/tasks';
import {
  createDependenciesRepository,
  type DependenciesRepository,
} from '../../../db/repositories/dependencies';
import { NotFoundError, CircularDependencyError } from '../../../db/errors';
import { validateCoachingResolution, type CoachingResolutionV1 } from '../../../llm';
import { dispatchResolution, type ResolutionDispatchDeps } from '../dispatch';

const TODAY = '2026-07-15';

describe('dispatchResolution (grammar-union → repository actions, D8)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let dependencies: DependenciesRepository;
  let deps: ResolutionDispatchDeps;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    dependencies = createDependenciesRepository(conn);
    deps = { tasks, dependencies };
  });
  afterEach(() => conn.close());

  // Guard: every canned object below is a REAL valid union (matches the task-5 validator), so the
  // dispatcher is tested against exactly what the ladder would hand it.
  function valid(resolution: CoachingResolutionV1): CoachingResolutionV1 {
    return validateCoachingResolution(resolution);
  }

  it('modify_task applies duration/context/energy and appends an approach note', async () => {
    const t = await tasks.create({
      title: 'Big task',
      estimatedDuration: 60,
      description: 'original',
    });
    const outcome = await dispatchResolution(
      deps,
      valid({
        action: 'modify_task',
        task_id: t.id,
        changes: {
          duration_minutes: 20,
          context_tags: ['home'],
          energy: 'high',
          approach_notes: 'start with one drawer',
        },
      }),
      { todayISO: TODAY },
    );
    expect(outcome).toMatchObject({ action: 'modify_task', taskId: t.id });
    const updated = await tasks.getById(t.id);
    expect(updated?.estimatedDuration).toBe(20);
    expect(updated?.contextTags).toEqual(['home']);
    expect(updated?.energyRequirement).toBe(5); // high → internal 5
    expect(updated?.description).toBe('original\n\nApproach: start with one drawer');
  });

  it('modify_task leaves null fields untouched', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30, contextTags: ['office'] });
    await dispatchResolution(
      deps,
      valid({
        action: 'modify_task',
        task_id: t.id,
        changes: { duration_minutes: 45, context_tags: null, energy: null, approach_notes: null },
      }),
      { todayISO: TODAY },
    );
    const updated = await tasks.getById(t.id);
    expect(updated?.estimatedDuration).toBe(45);
    expect(updated?.contextTags).toEqual(['office']); // unchanged
  });

  it('break_down_task is a staged stub (task unchanged)', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'break_down_task', task_id: t.id }),
      { todayISO: TODAY },
    );
    expect(outcome).toEqual({ action: 'break_down_task', taskId: t.id, staged: true });
    expect((await tasks.getById(t.id))?.status).toBe('active');
  });

  it('eliminate_task soft-deletes (status=deleted, never hard delete)', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'eliminate_task', task_id: t.id, reason: 'no longer needed' }),
      { todayISO: TODAY },
    );
    expect(outcome).toMatchObject({ action: 'eliminate_task', reason: 'no longer needed' });
    expect((await tasks.getById(t.id))?.status).toBe('deleted');
  });

  it('defer_task with a DueSpec resolves next_due_at', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'defer_task', task_id: t.id, until: { kind: 'in_days', days: 3 } }),
      { todayISO: TODAY },
    );
    expect(outcome).toEqual({ action: 'defer_task', taskId: t.id, deferredUntil: '2026-07-18' });
    expect((await tasks.getById(t.id))?.nextDueAt).toBe('2026-07-18');
  });

  it('defer_task with a condition clears next_due_at and returns the condition', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30, nextDueAt: '2026-08-01' });
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'defer_task', task_id: t.id, until: { condition: 'when I hear back from HR' } }),
      { todayISO: TODAY },
    );
    expect(outcome).toEqual({
      action: 'defer_task',
      taskId: t.id,
      deferredUntil: null,
      condition: 'when I hear back from HR',
    });
    expect((await tasks.getById(t.id))?.nextDueAt).toBeNull();
  });

  it('add_dependency records the dependency', async () => {
    const a = await tasks.create({ title: 'A', estimatedDuration: 30 });
    const b = await tasks.create({ title: 'B', estimatedDuration: 30 });
    await dispatchResolution(
      deps,
      valid({ action: 'add_dependency', task_id: a.id, depends_on_task_id: b.id }),
      { todayISO: TODAY },
    );
    const forA = await dependencies.listForTask(a.id);
    expect(forA.map((d) => d.dependsOnTaskId)).toContain(b.id);
  });

  it('add_dependency surfaces a circular dependency as a typed error', async () => {
    const a = await tasks.create({ title: 'A', estimatedDuration: 30 });
    const b = await tasks.create({ title: 'B', estimatedDuration: 30 });
    await dependencies.add(a.id, b.id); // A depends on B
    await expect(
      dispatchResolution(
        deps,
        valid({ action: 'add_dependency', task_id: b.id, depends_on_task_id: a.id }),
        { todayISO: TODAY },
      ),
    ).rejects.toBeInstanceOf(CircularDependencyError);
  });

  it('add_missing_task is a staged stub carrying the title', async () => {
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'add_missing_task', title: 'Buy stamps' }),
      { todayISO: TODAY },
    );
    expect(outcome).toEqual({ action: 'add_missing_task', title: 'Buy stamps', staged: true });
  });

  it('no_change is a first-class no-op with a reason', async () => {
    const outcome = await dispatchResolution(
      deps,
      valid({ action: 'no_change', reason: 'the plan is fine as-is' }),
      { todayISO: TODAY },
    );
    expect(outcome).toEqual({ action: 'no_change', reason: 'the plan is fine as-is' });
  });

  it('throws NotFoundError when the target task does not exist', async () => {
    await expect(
      dispatchResolution(
        deps,
        valid({ action: 'eliminate_task', task_id: 9999, reason: 'x' }),
        { todayISO: TODAY },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
