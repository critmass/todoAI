import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import type { SessionCheckIn } from '../../scoring/score';
import type { PlanningRepositories } from '../../planning/service';
import type { AgendaTaskItem, SessionPlan } from '../../planning/agenda';
import { BREAK_MINUTES } from '../../planning/planner';
import { runTailDirective } from '../tail';
import type { TailDirective } from '../episodeService';

const NOW = Date.UTC(2026, 6, 26, 9, 0, 0);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'A task',
    description: null,
    importance: 500,
    urgencyLevel: 3,
    nextDueAt: null,
    estimatedDuration: 20,
    durationSource: 'model_guess',
    actualDurationHistory: [],
    averageActualDuration: null,
    energyRequirement: 3,
    averageEnergyCost: 0,
    contextTags: ['home'],
    toolRequirements: [],
    status: 'active',
    parentTaskId: null,
    createdAt: '2026-07-01 09:00:00',
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

function repos(pool: Task[]): PlanningRepositories {
  const withNeglect: TaskWithNeglect[] = pool.map((task) => ({
    task,
    weeksNeglected: 0,
    neglectMultiplier: 0,
  }));
  return {
    tasks: { listActiveByNeglect: async () => withNeglect },
    dependencies: { listUnresolvedBlockersForActiveTasks: async () => new Map() },
    coaching: { priorityQueue: async () => [] },
  };
}

const CHECK_IN: SessionCheckIn = { energy: 'med', contexts: ['home'], tools: [] };
const REQUEST = { sessionType: 'moderate' as const, checkIn: CHECK_IN };

function taskIds(plan: SessionPlan): number[] {
  return plan.items
    .filter((i): i is AgendaTaskItem => i.kind === 'task')
    .map((i) => i.task.id);
}

function regenerate(overrides: Partial<Extract<TailDirective, { kind: 'regenerate' }>> = {}): TailDirective {
  return {
    kind: 'regenerate',
    remainingMinutes: 40,
    precededByStretchMinutes: 0,
    easier: false,
    excludeTaskIds: [],
    ...overrides,
  };
}

describe('runTailDirective', () => {
  it('replans nothing for continue or summary — the existing tail simply stands', async () => {
    const r = repos([makeTask()]);
    expect(await runTailDirective(r, REQUEST, { kind: 'continue' }, NOW)).toBeNull();
    expect(await runTailDirective(r, REQUEST, { kind: 'summary' }, NOW)).toBeNull();
  });

  it('regenerates the tail for the time that actually remains', async () => {
    const plan = await runTailDirective(
      repos([makeTask({ id: 1 }), makeTask({ id: 2 })]),
      REQUEST,
      regenerate(),
      NOW,
      () => 0.5,
    );
    expect(plan?.sessionMinutes).toBe(40);
    expect(taskIds(plan as SessionPlan).length).toBeGreaterThan(0);
  });

  it('never re-plans a task already served this session', async () => {
    const plan = await runTailDirective(
      repos([makeTask({ id: 1 }), makeTask({ id: 2 })]),
      REQUEST,
      regenerate({ excludeTaskIds: [1] }),
      NOW,
      () => 0.5,
    );
    expect(taskIds(plan as SessionPlan)).toEqual([2]);
  });

  it('opens with a break after a long stretch — task 11 owns the threshold, this just passes it', async () => {
    const plan = await runTailDirective(
      repos([makeTask({ id: 1 })]),
      REQUEST,
      regenerate({ precededByStretchMinutes: 55 }),
      NOW,
      () => 0.5,
    );
    expect(plan?.items[0]).toEqual({ kind: 'break', plannedMinutes: BREAK_MINUTES });
  });

  it('passes the escape valve through as an easier replan', async () => {
    // EASIER_MAX_ITEM_MINUTES is 25, so the 40-minute task is out of an easier tail by construction.
    const plan = await runTailDirective(
      repos([makeTask({ id: 1, estimatedDuration: 40 }), makeTask({ id: 2, estimatedDuration: 15 })]),
      REQUEST,
      regenerate({ easier: true }),
      NOW,
      () => 0.5,
    );
    expect(taskIds(plan as SessionPlan)).toEqual([2]);
  });
});
