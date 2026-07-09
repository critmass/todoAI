import type { SqliteConnection } from '../connection';
import { CircularDependencyError, NotFoundError } from '../errors';
import { taskDependencyRowToDomain, type TaskDependency } from '../../types/domain';
import type { TaskDependencyRow } from '../../types/db';

/** add()'s prevent_circular_dependencies trigger only catches a direct two-node cycle
 *  (A depends on B, then B depends on A) - it does not walk longer chains (A->B->C->A).
 *  dependency_check_cache exists in the schema for deeper cycle detection but populating/
 *  querying it is a service-layer concern (out of scope here; the DAO only exposes the
 *  primitive add/remove). Flagged for awareness, not "fixed" per constraint #8. */
export function createDependenciesRepository(db: SqliteConnection) {
  async function add(taskId: number, dependsOnTaskId: number): Promise<TaskDependency> {
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

  /** Tasks that `taskId` depends on. */
  async function listForTask(taskId: number): Promise<TaskDependency[]> {
    const result = await db.execute('SELECT * FROM task_dependencies WHERE task_id = ?', [taskId]);
    return (result.rows as unknown as TaskDependencyRow[]).map(taskDependencyRowToDomain);
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
