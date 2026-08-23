import type { SqliteConnection } from '../connection';
import { CircularDependencyError, NotFoundError } from '../errors';
import { taskDependencyRowToDomain, type TaskDependency } from '../../types/domain';
import type { TaskDependencyRow } from '../../types/db';

/** Task 10, R2 needs the transitive-fan-out computation (mapper.ts) to be safe over an acyclic
 *  graph, so add() below walks the existing depends_on graph itself before every insert and
 *  rejects a multi-hop cycle in TS, with a typed CircularDependencyError.
 *
 *  This guard was originally load-bearing: the prevent_circular_dependencies DB trigger only
 *  caught a direct two-node cycle (A depends on B, then B depends on A) and let A->B->C->A
 *  through. Migration 008 (task 49) widened the trigger to a real reachability walk, so the two
 *  now agree on every shape. The TS walk is kept deliberately as defence in depth and because it
 *  is what produces the typed error the coaching dispatch surfaces; the catch below still maps
 *  the trigger's ABORT for any row that reaches the table another way. */
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

  /** For every ACTIVE task, the ids of tasks it depends_on that are NOT yet completed — the input
   *  the U1 dependency pre-filter (scoring/filter.ts `filterDependencyBlocked`) needs to hold
   *  blocked tasks out of the ranked pool. A dependency counts as resolved only when the
   *  depended-on task is `status='completed'`; anything else (still active, deleted, archived)
   *  keeps the edge live. The eliminate-a-subtask edge case (a subtask that will never complete
   *  blocking its parent forever) is handled by REMOVING the edge on eliminate_task — see the
   *  coaching dispatch — not by treating a deleted blocker as resolved here. Tasks with no live
   *  blockers are simply absent from the returned map. */
  async function listUnresolvedBlockersForActiveTasks(): Promise<Map<number, number[]>> {
    const result = await db.execute(
      `SELECT d.task_id AS task_id, d.depends_on_task_id AS blocker_id
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id
         JOIN tasks blocker ON blocker.id = d.depends_on_task_id
        WHERE t.status = 'active' AND blocker.status != 'completed'`,
    );
    const rows = result.rows as unknown as Array<{ task_id: number; blocker_id: number }>;
    const map = new Map<number, number[]>();
    for (const row of rows) {
      const existing = map.get(row.task_id);
      if (existing) existing.push(row.blocker_id);
      else map.set(row.task_id, [row.blocker_id]);
    }
    return map;
  }

  return { add, remove, listForTask, listDependents, listUnresolvedBlockersForActiveTasks };
}

export type DependenciesRepository = ReturnType<typeof createDependenciesRepository>;
