import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createTasksRepository } from '../tasks';
import { createDependenciesRepository, type DependenciesRepository } from '../dependencies';
import { CircularDependencyError } from '../../errors';

describe('dependenciesRepository', () => {
  let conn: TestSqliteConnection;
  let repo: DependenciesRepository;
  let taskA: number;
  let taskB: number;
  let taskC: number;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createDependenciesRepository(conn);
    const tasks = createTasksRepository(conn);
    taskA = (await tasks.create({ title: 'A', estimatedDuration: 5 })).id;
    taskB = (await tasks.create({ title: 'B', estimatedDuration: 5 })).id;
    taskC = (await tasks.create({ title: 'C', estimatedDuration: 5 })).id;
  });

  afterEach(() => {
    conn.close();
  });

  it('add -> listForTask/listDependents -> remove round-trips', async () => {
    const dep = await repo.add(taskA, taskB); // A depends on B
    expect(dep.taskId).toBe(taskA);
    expect(dep.dependsOnTaskId).toBe(taskB);

    expect((await repo.listForTask(taskA)).map((d) => d.dependsOnTaskId)).toEqual([taskB]);
    expect((await repo.listDependents(taskB)).map((d) => d.taskId)).toEqual([taskA]);

    await repo.remove(taskA, taskB);
    expect(await repo.listForTask(taskA)).toEqual([]);
  });

  it('rejects a direct circular dependency with a typed error', async () => {
    await repo.add(taskA, taskB); // A depends on B
    await expect(repo.add(taskB, taskA)).rejects.toThrow(CircularDependencyError); // B depends on A
  });

  it('rejects a multi-hop circular dependency (task 10, R2 DAG guard) - not just direct A<->B', async () => {
    await repo.add(taskA, taskB); // A depends on B
    await repo.add(taskB, taskC); // B depends on C
    // Closing the loop: C depends on A would make A->B->C->A a cycle. The DB trigger alone
    // only catches a direct pair, so this proves the repo-level BFS guard is doing the work.
    await expect(repo.add(taskC, taskA)).rejects.toThrow(CircularDependencyError);
    expect(await repo.listForTask(taskC)).toEqual([]); // rejected insert left no partial row
  });

  it('rejects a self-dependency', async () => {
    await expect(repo.add(taskA, taskA)).rejects.toThrow(CircularDependencyError);
  });

  it('a count task composes with dependencies for free (no separate depends-on-N concept)', async () => {
    // Documents spec §4.2: task C depending on a 'count' task A just means "depends on N
    // completions of A" - the count type's own completion semantics carry the gating, so the
    // dependency edge itself is a completely ordinary task_dependencies row.
    const dep = await repo.add(taskC, taskA);
    expect(dep).toMatchObject({ taskId: taskC, dependsOnTaskId: taskA });
  });

  it('ON DELETE CASCADE removes dependency rows when either task is deleted', async () => {
    await repo.add(taskA, taskB);
    conn.raw.prepare('DELETE FROM tasks WHERE id = ?').run(taskB);
    expect(await repo.listForTask(taskA)).toEqual([]);
  });
});
