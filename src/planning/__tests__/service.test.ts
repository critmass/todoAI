import type { Task, CoachingPriorityQueueEntry } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import type { SessionCheckIn } from '../../scoring/score';
import type { AgendaTaskItem, SessionPlan } from '../agenda';
import {
  planSessionFromRepositories,
  replanRemainingFromRepositories,
  type PlanningRepositories,
} from '../service';

const NOW = Date.UTC(2026, 6, 15);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'A task',
    description: null,
    importance: 500,
    urgencyLevel: 3,
    nextDueAt: null,
    estimatedDuration: 30,
    durationSource: 'model_guess',
    actualDurationHistory: [],
    averageActualDuration: null,
    energyRequirement: 3,
    averageEnergyCost: 0,
    contextTags: [],
    toolRequirements: [],
    status: 'active',
    parentTaskId: null,
    createdAt: null,
    updatedAt: null,
    completionCount: 0,
    skipCount: 0,
    skipReasons: [],
    lastCompletedAt: null,
    successRate: 0,
    durationType: 'estimate',
    workState: 'none',
    accumulatedMinutes: 0,
    lastWorkedAt: null,
    ...overrides,
  };
}

function withNeglect(task: Task, weeksNeglected = 0): TaskWithNeglect {
  return { task, weeksNeglected, neglectMultiplier: weeksNeglected, missedQuota: null };
}

function breakdownCompleteRow(parentId: number): CoachingPriorityQueueEntry {
  return {
    id: 1,
    triggerType: 'breakdown_complete',
    urgency: 'immediate',
    triggerData: { parentTaskId: parentId },
    status: 'pending',
    createdAt: '2026-07-15 09:00:00',
    relatedTaskIds: [parentId],
    relatedSessionIds: [],
    relatedExternalDependencyIds: [],
  };
}

function fakeRepos(
  pool: TaskWithNeglect[],
  blockers: Map<number, number[]> = new Map(),
  queue: CoachingPriorityQueueEntry[] = [],
): PlanningRepositories {
  return {
    tasks: { listActiveByNeglect: async () => pool },
    dependencies: { listUnresolvedBlockersForActiveTasks: async () => blockers },
    coaching: { priorityQueue: async () => queue },
  };
}

const CHECK_IN: SessionCheckIn = { energy: 'med', contexts: ['home'], tools: [] };
const REQUEST = { sessionType: 'deep_focus' as const, sessionMinutes: 90, checkIn: CHECK_IN };

function taskIds(plan: SessionPlan): number[] {
  return plan.items
    .filter((item): item is AgendaTaskItem => item.kind === 'task')
    .map((item) => item.task.id);
}

describe('planSessionFromRepositories — the wired selection boundary', () => {
  it('reads pool + blockers + pending holds and plans over the doubly-filtered pool', async () => {
    const parent = withNeglect(makeTask({ id: 10, estimatedDuration: 20 }));
    const blocked = withNeglect(makeTask({ id: 11, estimatedDuration: 20 }));
    const free = withNeglect(makeTask({ id: 12, estimatedDuration: 20 }));
    const repos = fakeRepos(
      [parent, blocked, free],
      new Map([[11, [12]]]),
      [breakdownCompleteRow(10)], // R7c: parent awaiting its check-off conversation
    );
    const plan = await planSessionFromRepositories(repos, REQUEST, NOW, () => 0.5);
    // The held parent (R7c) and the dependency-blocked task both stay out of the agenda —
    // this is the end-to-end closure of task 25's "capability built, nothing calls it" seam.
    expect(taskIds(plan)).toEqual([12]);
    expect(plan.dependencyRejects.map((r) => r.item.task.id).sort()).toEqual([10, 11]);
    expect(
      plan.dependencyRejects.find((r) => r.item.task.id === 10)?.pendingBreakdownComplete,
    ).toBe(true);
  });

  it('applies the optional PlanAdjustment hook (the deterministic-v1 LLM seam) to the finished plan', async () => {
    const repos = fakeRepos([withNeglect(makeTask({ id: 1, estimatedDuration: 20 }))]);
    const plan = await planSessionFromRepositories(repos, REQUEST, NOW, () => 0.5, (p) => ({
      ...p,
      sessionMinutes: 999, // a marker: the hook saw and replaced the plan
    }));
    expect(plan.sessionMinutes).toBe(999);
  });
});

describe('replanRemainingFromRepositories', () => {
  it('re-reads live state and excludes already-served tasks', async () => {
    const done = withNeglect(makeTask({ id: 1, estimatedDuration: 10 }));
    const next = withNeglect(makeTask({ id: 2, estimatedDuration: 10 }));
    const repos = fakeRepos([done, next]);
    const plan = await replanRemainingFromRepositories(
      repos,
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      30,
      NOW,
      () => 0.5,
      { excludeTaskIds: new Set([1]) },
    );
    expect(taskIds(plan)).toEqual([2]);
  });
});
