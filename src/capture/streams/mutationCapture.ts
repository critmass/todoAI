// Task 41 — the `mutation` and `mutationtext` streams, as a repository wrapper.
//
// WHERE THE ACTOR COMES FROM, AND WHY NO CALL SITE IS TOLD (design §5.5). `appServices.ts` is the
// single composition point for the dependency graph, and the wiring is where the knowledge already
// lives. Rather than threading an actor through every repository call — capture diffusing into the
// code it instruments, which brief §4 forbids — the repository set is wrapped PER CONSUMER BUNDLE.
// Removing this stream is deleting this file and unwrapping a handful of expressions in one file.
//
// `tasks.update(id, patch)` does not read the prior row (`tasks.ts:190`), so `before` requires a
// `getById` first. THAT READ LIVES HERE, NOT IN THE REPOSITORY — one extra indexed primary-key read
// per mutation, and zero lines added to `src/db/`.
//
// 🔴 ON `planner`, WHICH IS A SENTINEL WHOSE EXPECTED COUNT IS ZERO (amendment §3). Its emptiness
// is its value: `src/planning/`'s `PlanAdjustment` contract is stated but unenforced (orientation
// §3 — nothing validates a hostile adjuster, and a consumer must never resurrect a filtered task),
// so a `planner` row in this stream is direct evidence of that contract being violated, from a log
// that was going to be written anyway. The default below is therefore NOT a convenience: every
// enumerated writer names its actor explicitly at the wiring point, and reaching this default means
// a repository was wired through a bundle that named nobody. A `planner` row is always a fact about
// the code, never a shrug.

import type { Repositories } from '../../db';
import type { Task } from '../../types/domain';
import type { MutationActor, MutationEvent, MutationSurface } from '../events';
import { lastSeq, record } from '../record';

/** Task fields whose values are free text the user typed. They go to `mutationtext` with a
 *  `textRef` and lengths left behind on the structured record — which is exactly what lets the
 *  REST of `mutation` survive open beta rather than being dropped with the prose (design §5.5). */
const TEXT_FIELDS = new Set(['title', 'description']);

type Scalar = string | number | boolean | null;

function scalarise(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

function emit(
  base: { actor: MutationActor; surface: MutationSurface },
  type: MutationEvent['type'],
  entityId: number,
  field: string,
  before: unknown,
  after: unknown,
): void {
  if (TEXT_FIELDS.has(field)) {
    const beforeText = typeof before === 'string' ? before : null;
    const afterText = typeof after === 'string' ? after : null;
    record({
      stream: 'mutationtext',
      type: 'value',
      entityId,
      field,
      before: beforeText,
      after: afterText,
    });
    // `lastSeq()` is the seq just assigned to the mutationtext record above. Safe because JS is
    // single-threaded and record() is synchronous end to end — nothing can interleave here.
    const textRef = lastSeq();
    record({
      stream: 'mutation',
      type,
      entityId,
      field,
      before: null,
      after: null,
      textRef,
      beforeLen: beforeText?.length ?? 0,
      afterLen: afterText?.length ?? 0,
      actor: base.actor,
      surface: base.surface,
    });
    return;
  }
  record({
    stream: 'mutation',
    type,
    entityId,
    field,
    before: scalarise(before),
    after: scalarise(after),
    actor: base.actor,
    surface: base.surface,
  });
}

function diffTask(
  base: { actor: MutationActor; surface: MutationSurface },
  before: Task | undefined,
  after: Task,
): void {
  const keys = new Set([...Object.keys(after), ...Object.keys(before ?? {})]);
  for (const key of keys) {
    if (key === 'updatedAt') continue; // moves on every write; noise, not signal.
    const previous = (before as Record<string, unknown> | undefined)?.[key];
    const next = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    emit(base, 'task', after.id, key, previous, next);
  }
}

/**
 * Wraps a repository set so that every write it carries is recorded, attributed to `actor` through
 * `surface`.
 *
 * Both parameters default to the `planner` sentinel ON PURPOSE — see the header. Do not "fix" a
 * `planner` row by widening the defaults; find the bundle that was wired without an attribution.
 */
export function withMutationCapture(
  repos: Repositories,
  actor: MutationActor = 'planner',
  surface: MutationSurface = 'unattributed',
): Repositories {
  const base = { actor, surface };
  const { tasks, recurrence, dependencies } = repos;

  const capturedTasks: Repositories['tasks'] = {
    ...tasks,
    async create(input) {
      const created = await tasks.create(input);
      emit(base, 'create', created.id, 'title', null, created.title);
      for (const [key, value] of Object.entries(created)) {
        if (key === 'id' || key === 'title' || key === 'createdAt' || key === 'updatedAt') continue;
        emit(base, 'create', created.id, key, null, value);
      }
      return created;
    },
    async update(id, patch) {
      const before = await tasks.getById(id);
      const after = await tasks.update(id, patch);
      diffTask(base, before, after);
      return after;
    },
    async softDelete(id) {
      const before = await tasks.getById(id);
      await tasks.softDelete(id);
      emit(base, 'delete', id, 'status', before?.status ?? null, 'deleted');
    },
    async recordUnscheduledCompletion(id) {
      const before = await tasks.getById(id);
      const after = await tasks.recordUnscheduledCompletion(id);
      diffTask(base, before, after);
      return after;
    },
    async recordProgressEpisode(id, minutes) {
      const before = await tasks.getById(id);
      const after = await tasks.recordProgressEpisode(id, minutes);
      diffTask(base, before, after);
      return after;
    },
    async recordSkipEpisode(id, reason) {
      const before = await tasks.getById(id);
      const after = await tasks.recordSkipEpisode(id, reason);
      diffTask(base, before, after);
      return after;
    },
    // Task 17 Phase A. Enumerated here for the same reason as its sibling above: a new repository
    // write reaches the database through the `...tasks` spread whether or not it is wrapped, so an
    // unwrapped one is silently absent from the stream. `completion_count`/`success_rate` are the
    // pair task 17 makes load-bearing — capturing the skip half and not the completion half would
    // be worse than capturing neither.
    async recordHistoricalCompletion(id) {
      const before = await tasks.getById(id);
      const after = await tasks.recordHistoricalCompletion(id);
      diffTask(base, before, after);
      return after;
    },
  };

  const capturedRecurrence: Repositories['recurrence'] = {
    ...recurrence,
    async create(taskId, rule) {
      const created = await recurrence.create(taskId, rule);
      emit(base, 'recurrence', taskId, 'recurrence', null, rule);
      return created;
    },
    async update(taskId, rule) {
      const before = await recurrence.getByTaskId(taskId);
      const updated = await recurrence.update(taskId, rule);
      emit(base, 'recurrence', taskId, 'recurrence', before, rule);
      return updated;
    },
    async remove(taskId) {
      const before = await recurrence.getByTaskId(taskId);
      await recurrence.remove(taskId);
      emit(base, 'recurrence', taskId, 'recurrence', before, null);
    },
    async setResetDate(taskId, resetDate) {
      const before = await recurrence.getEntityByTaskId(taskId);
      const updated = await recurrence.setResetDate(taskId, resetDate);
      emit(base, 'recurrence', taskId, 'resetDate', before?.resetDate ?? null, resetDate);
      return updated;
    },
    async rollPeriod(taskId, next) {
      const before = await recurrence.getEntityByTaskId(taskId);
      const updated = await recurrence.rollPeriod(taskId, next);
      emit(base, 'recurrence', taskId, 'resetDate', before?.resetDate ?? null, next.resetDate);
      emit(base, 'recurrence', taskId, 'lastPeriodShortfall', null, next.shortfall);
      return updated;
    },
  };

  const capturedDependencies: Repositories['dependencies'] = {
    ...dependencies,
    async add(taskId, dependsOnTaskId) {
      const added = await dependencies.add(taskId, dependsOnTaskId);
      emit(base, 'dependency', taskId, 'dependsOn', null, dependsOnTaskId);
      return added;
    },
    async remove(taskId, dependsOnTaskId) {
      await dependencies.remove(taskId, dependsOnTaskId);
      emit(base, 'dependency', taskId, 'dependsOn', dependsOnTaskId, null);
    },
  };

  return {
    ...repos,
    tasks: capturedTasks,
    recurrence: capturedRecurrence,
    dependencies: capturedDependencies,
  };
}
