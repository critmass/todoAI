// Task 24 — the task list and editor's brain. Reading the active pool, editing one task, and the
// two writes an edit implies (the task row, and the presence/absence/content of its recurrence
// row) — which is the part with a real trap in it.
//
// THE RECURRENCE UPSERT IS THE WHOLE POINT OF THIS FILE. `task_recurrence` is a separate, optional
// 1:1 table, so changing a task's recurrence kind is three different operations depending on where
// it started and where it ended up: create a row, update a row, or DELETE a row. The delete case
// is the one that matters — switching a repeating task back to "One-time" must remove the row, not
// write `{type:'unscheduled'}`, because those two have opposite completion semantics (constraint
// #7): a one-off closes on completion; an unscheduled task resets its neglect clock and stays
// active forever. Writing the wrong one turns "I finished this" into "I'll be asked again forever".

import type { DependenciesRepository } from '../../db/repositories/dependencies';
import type { RecurrenceRepository } from '../../db/repositories/recurrence';
import type { TasksRepository } from '../../db/repositories/tasks';
import type { Task } from '../../types/domain';
import type { TaskListRow } from '../screens/contracts';
import {
  describeRecurrence,
  draftFromTask,
  draftToWrite,
  emptyDraft,
  validateDraft,
  type DraftValidation,
  type TaskDraft,
} from './taskDraft';

export interface TaskLibraryDeps {
  tasks: Pick<TasksRepository, 'listActive' | 'getById' | 'create' | 'update' | 'softDelete'>;
  recurrence: Pick<RecurrenceRepository, 'getByTaskId' | 'create' | 'update' | 'remove'>;
  dependencies: Pick<DependenciesRepository, 'listDependents'>;
}

export interface TaskLibraryState {
  rows: TaskListRow[];
  draft: TaskDraft;
  validation: DraftValidation;
  /** False when other tasks depend on this one. */
  canDelete: boolean;
  saving: boolean;
  error: string | null;
}

type Listener = (state: TaskLibraryState) => void;

export function createTaskLibraryController(deps: TaskLibraryDeps) {
  let state: TaskLibraryState = {
    rows: [],
    draft: emptyDraft(),
    validation: { errors: {} },
    canDelete: false,
    saving: false,
    error: null,
  };
  const listeners = new Set<Listener>();

  function publish(patch: Partial<TaskLibraryState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  async function guard<T>(step: () => Promise<T>): Promise<T | undefined> {
    publish({ error: null });
    try {
      return await step();
    } catch (err) {
      publish({ error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /** Loads the list. One recurrence read per task: an N+1, consciously — a personal task list is
   *  tens of rows, and the alternative is a bespoke join that only this screen would use. */
  async function refresh(): Promise<void> {
    await guard(async () => {
      const tasks = await deps.tasks.listActive();
      const rows: TaskListRow[] = [];
      for (const task of tasks) {
        const recurrence = await deps.recurrence.getByTaskId(task.id);
        rows.push({ id: task.id, title: task.title, summary: summarize(task, recurrence) });
      }
      publish({ rows });
    });
  }

  function summarize(task: Task, recurrence: Awaited<ReturnType<TaskLibraryDeps['recurrence']['getByTaskId']>>): string {
    const parts = [describeRecurrence(recurrence, task), `${task.estimatedDuration} min`];
    if (task.workState === 'in_progress') parts.push('In progress');
    return parts.join(' · ');
  }

  async function open(taskId: number): Promise<void> {
    await guard(async () => {
      const task = await deps.tasks.getById(taskId);
      if (!task) throw new Error(`Task ${taskId} no longer exists.`);
      const recurrence = await deps.recurrence.getByTaskId(taskId);
      const dependents = await deps.dependencies.listDependents(taskId);
      const draft = draftFromTask(task, recurrence);
      publish({ draft, validation: validateDraft(draft), canDelete: dependents.length === 0 });
    });
  }

  function openNew(): void {
    const draft = emptyDraft();
    publish({ draft, validation: validateDraft(draft), canDelete: false, error: null });
  }

  function change(patch: Partial<TaskDraft>): void {
    const draft = { ...state.draft, ...patch };
    publish({ draft, validation: validateDraft(draft) });
  }

  /** Persists the draft. Returns true when it saved, so the screen knows whether to navigate. */
  async function save(): Promise<boolean> {
    if (Object.keys(state.validation.errors).length > 0) return false;
    publish({ saving: true });
    const result = await guard(async () => {
      const { taskWrite, recurrence } = draftToWrite(state.draft);
      const id = state.draft.id;
      const task = id == null ? await deps.tasks.create(taskWrite) : await deps.tasks.update(id, taskWrite);
      await upsertRecurrence(task.id, recurrence);
      return true;
    });
    publish({ saving: false });
    if (result) await refresh();
    return result === true;
  }

  /** The three-way upsert described at the top of this file. */
  async function upsertRecurrence(
    taskId: number,
    next: ReturnType<typeof draftToWrite>['recurrence'],
  ): Promise<void> {
    const existing = await deps.recurrence.getByTaskId(taskId);
    if (!next) {
      // Back to a true one-off: the row must GO. Writing `unscheduled` here instead would be the
      // constraint-#7 bug — silently converting a task that closes into one that never does.
      if (existing) await deps.recurrence.remove(taskId);
      return;
    }
    if (existing) await deps.recurrence.update(taskId, next);
    else await deps.recurrence.create(taskId, next);
  }

  /** Soft-delete only — history and foreign keys depend on the row surviving. */
  async function remove(): Promise<boolean> {
    const id = state.draft.id;
    if (id == null || !state.canDelete) return false;
    const result = await guard(async () => {
      await deps.tasks.softDelete(id);
      return true;
    });
    if (result) await refresh();
    return result === true;
  }

  return {
    getState: () => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    open,
    openNew,
    change,
    save,
    remove,
  };
}

export type TaskLibraryController = ReturnType<typeof createTaskLibraryController>;
