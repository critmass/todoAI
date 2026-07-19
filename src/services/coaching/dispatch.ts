// Task 12 — coaching resolution dispatch. A VALIDATED coaching_resolution union (via
// validateCoachingResolution, task 5) is mapped to deterministic repository actions here. This is
// grammar-union dispatch, NOT native tool-calling (D8 / constraint #8): the model emits a union
// object, the APP applies it. break_down_task and add_missing_task are STAGED stubs (D8) — they
// signal that a follow-up staged call is needed, they don't inline a second schema's output.
//
// Completion primitives: none of these actions COMPLETE a task, so none touch the completeTask
// dispatch (task 9). eliminate_task is a soft-delete (status='deleted'), deliberately NOT a
// completion — completing vs eliminating are different dispositions, and completion (with its
// null≠unscheduled recurrence handling) stays owned by services/taskCompletion.ts.

import type { Task } from '../../types/domain';
import type { TasksRepository } from '../../db/repositories/tasks';
import type { DependenciesRepository } from '../../db/repositories/dependencies';
import type { CoachingResolutionV1 } from '../../llm';
import { userToInternalEnergy } from '../../types/scales';
import { resolveDue, type DueSpec } from '../../llm/due/dueSpec';
import { NotFoundError } from '../../db/errors';

export interface ResolutionDispatchDeps {
  tasks: Pick<TasksRepository, 'getById' | 'update' | 'softDelete'>;
  dependencies: Pick<DependenciesRepository, 'add' | 'listDependents' | 'remove'>;
}

export interface ResolutionContext {
  /** Today's date (YYYY-MM-DD), for resolving a defer_task `until` DueSpec. */
  todayISO: string;
}

export type DispatchOutcome =
  | { action: 'modify_task'; taskId: number; task: Task }
  | { action: 'break_down_task'; taskId: number; staged: true }
  | { action: 'eliminate_task'; taskId: number; reason: string }
  | { action: 'defer_task'; taskId: number; deferredUntil: string | null; condition?: string }
  | { action: 'add_dependency'; taskId: number; dependsOnTaskId: number }
  | { action: 'add_missing_task'; title: string; staged: true }
  | { action: 'no_change'; reason: string };

async function requireTask(deps: ResolutionDispatchDeps, taskId: number): Promise<Task> {
  const task = await deps.tasks.getById(taskId);
  if (!task) throw new NotFoundError('task', taskId);
  return task;
}

/**
 * Applies a validated coaching resolution to the data layer and returns a description of what it
 * did. Assumes `resolution` already passed validateCoachingResolution (the ladder does that); this
 * function is the deterministic effect, not another validation layer.
 */
export async function dispatchResolution(
  deps: ResolutionDispatchDeps,
  resolution: CoachingResolutionV1,
  ctx: ResolutionContext,
): Promise<DispatchOutcome> {
  switch (resolution.action) {
    case 'modify_task': {
      const existing = await requireTask(deps, resolution.task_id);
      const { changes } = resolution;
      const patch: Parameters<TasksRepository['update']>[1] = {};
      if (changes.duration_minutes !== null) patch.estimatedDuration = changes.duration_minutes;
      if (changes.context_tags !== null) patch.contextTags = changes.context_tags;
      if (changes.energy !== null) patch.energyRequirement = userToInternalEnergy(changes.energy);
      if (changes.approach_notes !== null) {
        // No first-class "approach notes" column; append to description so the original detail is
        // preserved. REVIEW: a dedicated notes field may be cleaner (spec §3.4 lists approach_notes).
        patch.description = existing.description
          ? `${existing.description}\n\nApproach: ${changes.approach_notes}`
          : `Approach: ${changes.approach_notes}`;
      }
      const task = await deps.tasks.update(resolution.task_id, patch);
      return { action: 'modify_task', taskId: resolution.task_id, task };
    }

    case 'break_down_task':
      // Stub (D8): the coaching flow runs task_breakdown.v1 as its own staged call next.
      await requireTask(deps, resolution.task_id);
      return { action: 'break_down_task', taskId: resolution.task_id, staged: true };

    case 'eliminate_task': {
      await requireTask(deps, resolution.task_id);
      await deps.tasks.softDelete(resolution.task_id); // never hard-delete (history/FKs depend on the row)
      // R7 edge: eliminating a task that others depend_on (e.g. a subtask) must remove those
      // edges, or the dependent (e.g. the parent) is blocked forever by a task that will never
      // complete. softDelete is status='deleted', NOT a row delete, so ON DELETE CASCADE does not
      // fire — remove the edges explicitly. `blocker.status != 'completed'` (U1) would otherwise
      // keep counting a 'deleted' task as a live blocker.
      const dependents = await deps.dependencies.listDependents(resolution.task_id);
      for (const dependent of dependents) {
        await deps.dependencies.remove(dependent.taskId, resolution.task_id);
      }
      return { action: 'eliminate_task', taskId: resolution.task_id, reason: resolution.reason };
    }

    case 'defer_task': {
      await requireTask(deps, resolution.task_id);
      const until = resolution.until;
      if (until !== null && 'condition' in until) {
        // Condition-based defer ("when I hear back from X") is external-dependency modeling
        // (spec §8.1) — no due date to set. Clear next_due_at; the condition rides in the outcome.
        // REVIEW(task 13+): wiring the condition to a real external-dependency row is out of scope here.
        await deps.tasks.update(resolution.task_id, { nextDueAt: null });
        return {
          action: 'defer_task',
          taskId: resolution.task_id,
          deferredUntil: null,
          condition: until.condition,
        };
      }
      // null or a DueSpec variant (on_date/in_days/weekday) — resolve to an ISO date (or null).
      const deferredUntil = resolveDue(until as DueSpec, ctx.todayISO);
      await deps.tasks.update(resolution.task_id, { nextDueAt: deferredUntil });
      return { action: 'defer_task', taskId: resolution.task_id, deferredUntil };
    }

    case 'add_dependency':
      // Dependency-on-a-count-task already means "depends on N completions" for free (spec §4.2) —
      // nothing extra to encode. Circular adds throw CircularDependencyError from the repo.
      await deps.dependencies.add(resolution.task_id, resolution.depends_on_task_id);
      return {
        action: 'add_dependency',
        taskId: resolution.task_id,
        dependsOnTaskId: resolution.depends_on_task_id,
      };

    case 'add_missing_task':
      // Stub (D8): the coaching flow runs task_extraction.v1 as its own staged call to flesh it out.
      return { action: 'add_missing_task', title: resolution.title, staged: true };

    case 'no_change':
      return { action: 'no_change', reason: resolution.reason };
  }
}
