import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createTasksRepository, type TasksRepository } from '../../db/repositories/tasks';
import {
  createDependenciesRepository,
  type DependenciesRepository,
} from '../../db/repositories/dependencies';
import { validate } from '../../llm/breakdown/validator';
import type { ParentContext } from '../../llm/breakdown/mapper';
import { persistBreakdown, type BreakdownPersistenceDeps } from '../breakdown';

describe('persistBreakdown (task 10, R2 — the breakdown -> dependencies step)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let dependencies: DependenciesRepository;
  let deps: BreakdownPersistenceDeps;

  const parent: ParentContext = { importance: 700, energyRequirement: 3, contextTags: ['home'] };

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    dependencies = createDependenciesRepository(conn);
    deps = { tasks, dependencies };
  });

  afterEach(() => conn.close());

  it('ordered breakdown creates a real dependency chain, sequenced by fan-out', async () => {
    const parentTask = await tasks.create({ title: 'Clean out the garage', estimatedDuration: 90 });
    const valid = validate({
      parent_task_id: parentTask.id,
      ordered: true,
      subtasks: [
        { title: 'clear a shelf', estimated_duration_minutes: 20, duration_from_user: false },
        { title: 'sort into piles', estimated_duration_minutes: 30, duration_from_user: false },
        { title: 'haul to donation center', estimated_duration_minutes: 40, duration_from_user: false },
      ],
    });

    const created = await persistBreakdown(deps, valid, parent);
    expect(created).toHaveLength(3);
    expect(created.map((t) => t.title)).toEqual([
      'clear a shelf',
      'sort into piles',
      'haul to donation center',
    ]);

    // step 2 depends on step 1, step 3 depends on step 2 - a real chain, not just importance.
    const step1 = created[0].id;
    const step2 = created[1].id;
    const step3 = created[2].id;
    expect((await dependencies.listForTask(step2)).map((d) => d.dependsOnTaskId)).toEqual([step1]);
    expect((await dependencies.listForTask(step3)).map((d) => d.dependsOnTaskId)).toEqual([step2]);
    expect(await dependencies.listForTask(step1)).toEqual([]); // nothing blocks the first step

    // fan-out based importance still lands the way mapper.test.ts proves in isolation: the
    // high-leverage unblocker (step 1) outranks what it unlocks.
    expect(created[0].importance).toBeGreaterThan(created[1].importance!);
    expect(created[1].importance).toBeGreaterThan(created[2].importance!);
  });

  it('unordered breakdown persists subtasks with no dependency edges', async () => {
    const parentTask = await tasks.create({ title: 'Call vendors', estimatedDuration: 30 });
    const valid = validate({
      parent_task_id: parentTask.id,
      ordered: false,
      subtasks: [
        { title: 'call vendor A', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'call vendor B', estimated_duration_minutes: 10, duration_from_user: false },
      ],
    });

    const created = await persistBreakdown(deps, valid, parent);
    expect(created).toHaveLength(2);
    expect(created[0].importance).toBe(created[1].importance);
    for (const task of created) {
      expect(await dependencies.listForTask(task.id)).toEqual([]);
    }
  });
});
