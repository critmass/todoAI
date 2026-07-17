// Task 10, R2 — the breakdown -> dependencies step. Given a validated breakdown, persists each
// subtask (mapper.ts's breakdownToSubtaskWrites already bands importance by transitive fan-out)
// and, for `ordered: true`, chains them with REAL task_dependencies edges instead of relying on
// importance alone to convey sequence. This lives here rather than in mapper.ts because the
// dependency edges must reference the ids tasks.create() assigns - mapper.ts stays pure and
// persistence-free on purpose (see its module comment).
//
// Edge direction mirrors sequentialUnlocks: subtask i "unlocks" i+1, i.e. i+1 depends_on i.
// Every edge is written through dependenciesRepository.add(), so the multi-hop DAG guard (task
// 10, R2) runs on each one - defense in depth, even though a freshly generated chain can't
// already contain a cycle.

import type { Task } from '../types/domain';
import type { TasksRepository } from '../db/repositories/tasks';
import type { DependenciesRepository } from '../db/repositories/dependencies';
import { breakdownToSubtaskWrites, sequentialUnlocks, type ParentContext } from '../llm/breakdown/mapper';
import type { TaskBreakdownV1 } from '../llm/breakdown/validator';

export interface BreakdownPersistenceDeps {
  tasks: Pick<TasksRepository, 'create'>;
  dependencies: Pick<DependenciesRepository, 'add'>;
}

/**
 * Persists a validated breakdown's subtasks and, when `ordered`, the dependency chain that
 * sequences them. Returns the created tasks in generation order (index i of the result
 * corresponds to `valid.subtasks[i]`, not to importance/fan-out order).
 */
export async function persistBreakdown(
  deps: BreakdownPersistenceDeps,
  valid: TaskBreakdownV1,
  parent: ParentContext,
): Promise<Task[]> {
  const writes = breakdownToSubtaskWrites(valid, parent);
  const created: Task[] = [];
  for (const write of writes) {
    created.push(await deps.tasks.create(write));
  }

  if (valid.ordered) {
    const unlocks = sequentialUnlocks(created.length, true);
    for (const [from, unlockedIndices] of unlocks) {
      for (const to of unlockedIndices) {
        await deps.dependencies.add(created[to].id, created[from].id); // `to` depends_on `from`
      }
    }
  }

  return created;
}
