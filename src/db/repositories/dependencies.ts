import type { SqliteConnection } from '../connection';
import { CircularDependencyError, NotFoundError } from '../errors';
import { taskDependencyRowToDomain, type TaskDependency } from '../../types/domain';
import type { TaskDependencyRow } from '../../types/db';

/** The prevent_circular_dependencies DB trigger only catches a direct two-node cycle (A depends
 *  on B, then B depends on A) - it does not walk longer chains (A->B->C->A). Task 10, R2 needs
 *  the transitive-fan-out computation (mapper.ts) to be safe over an acyclic graph, so add()
 *  below walks the existing depends_on graph itself before every insert - a multi-hop cycle is
 *  rejected here, in TS, the same way the trigger rejects a direct one. The trigger stays as a
 *  backstop (defense in depth; also still the only guard for any row written outside add()). */
export function createDependenciesRepository(db: SqliteConnection) {
  /** Tasks that `taskId` depends on. */
  async function listForTask(taskId: number): Promise<TaskDependency[]> {
    const result = await db.execute('SELECT * FROM task_dependencies WHERE task_id = ?', [taskId]);
    return (result.rows as unknown as TaskDependencyRow[]).map(taskDependencyRowToDomain);
  }

  /** Would inserting (taskId depends_on dependsOnTaskId) close a cycle? True iff
   *  dependsOnTaskId already (transitively) depends on taskId - walked via BFS over the
   *  existing depends_on edges, so any chain length is caught, not just direct A<->B. */
  async function wouldCreateCycle(taskId: number, dependsOnTaskId: number): Promise<boolean> {
    if (taskId === dependsOnTaskId) return true; // self-dependency, a degenerate 1-node cycle
    const visited = new Set<number>();
    const queue = [dependsOnTaskId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = await listForTask(current);
      for (const dep of deps) queue.push(dep.dependsOnTaskId);
    }
    return false;
  }

  async function add(taskId: number, dependsOnTaskId: number): Promise<TaskDependency> {
    if (await wouldCreateCycle(taskId, dependsOnTaskId)) {
      throw new CircularDependencyError(taskId, dependsOnTaskId);
    }
    let result;
    try {
      result = await db.execute(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
        [taskId, dependsOnTaskId],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Circular dependency detected/i.test(message)) {
        throw new CircularDependencyError(taskId, dependsOnTaskId);
      }
      throw err;
    }
    const id = result.insertId;
    if (id == null) {
      throw new Error('dependenciesRepository.add: insert did not return an id');
    }
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('task_dependency', id);
    }
    return created;
  }

  async function getById(id: number): Promise<TaskDependency | undefined> {
    const result = await db.execute('SELECT * FROM task_dependencies WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as TaskDependencyRow | undefined;
    return row ? taskDependencyRowToDomain(row) : undefined;
  }

  async function remove(taskId: number, dependsOnTaskId: number): Promise<void> {
    await db.execute(
      'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?',
      [taskId, dependsOnTaskId],
    );
  }

  /** Tasks that depend on `taskId` (its dependents/blockees). */
  async function listDependents(taskId: number): Promise<TaskDependency[]> {
    const result = await db.execute(
      'SELECT * FROM task_dependencies WHERE depends_on_task_id = ?',
      [taskId],
    );
    return (result.rows as unknown as TaskDependencyRow[]).map(taskDependencyRowToDomain);
  }

  return { add, remove, listForTask, listDependents };
}

export type DependenciesRepository = ReturnType<typeof createDependenciesRepository>;
