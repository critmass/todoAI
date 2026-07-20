import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import { filterBySessionCapability, filterDependencyBlocked } from '../filter';
import { rankWithContextNovelty, scoreTasks, type SessionCheckIn } from '../score';

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
  return { task, weeksNeglected, neglectMultiplier: weeksNeglected };
}

const NOW = Date.UTC(2026, 6, 15);

describe('filterBySessionCapability', () => {
  it('passes a task with no context/tool requirements (flexible)', () => {
    const item = withNeglect(makeTask());
    const { eligible, rejected } = filterBySessionCapability([item], {
      energy: 'med',
      contexts: [],
      tools: [],
    });
    expect(eligible).toEqual([item]);
    expect(rejected).toEqual([]);
  });

  it('drops a task whose context is unavailable this session', () => {
    const item = withNeglect(makeTask({ contextTags: ['office'] }));
    const { eligible, rejected } = filterBySessionCapability([item], {
      energy: 'med',
      contexts: ['home'],
      tools: [],
    });
    expect(eligible).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].missingContexts).toEqual(['office']);
    expect(rejected[0].missingTools).toEqual([]);
  });

  it('drops a task missing a required tool', () => {
    const item = withNeglect(makeTask({ toolRequirements: ['drill'] }));
    const { eligible, rejected } = filterBySessionCapability([item], {
      energy: 'med',
      contexts: [],
      tools: ['laptop'],
    });
    expect(eligible).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].missingTools).toEqual(['drill']);
  });

  it('requires ALL of a task\'s context tags and tools to be present, not just some', () => {
    const item = withNeglect(makeTask({ contextTags: ['office', 'quiet'], toolRequirements: [] }));
    const { eligible, rejected } = filterBySessionCapability([item], {
      energy: 'med',
      contexts: ['office'], // has 'office' but not 'quiet'
      tools: [],
    });
    expect(eligible).toEqual([]);
    expect(rejected[0].missingContexts).toEqual(['quiet']);
  });

  it('retains rejects rather than discarding them (for a later trigger to read)', () => {
    const doable = withNeglect(makeTask({ id: 1 }));
    const impossible = withNeglect(makeTask({ id: 2, contextTags: ['office'] }));
    const { eligible, rejected } = filterBySessionCapability([doable, impossible], {
      energy: 'med',
      contexts: ['home'],
      tools: [],
    });
    expect(eligible.map((i) => i.task.id)).toEqual([1]);
    expect(rejected.map((r) => r.item.task.id)).toEqual([2]);
  });

  it('an impossible task no longer ranks once filtered out before scoring', () => {
    const checkIn: SessionCheckIn = { energy: 'med', contexts: ['home'], tools: [] };
    // Office task is neglected for 20 weeks (would otherwise dominate by the §5.2 fail-safe);
    // home task is fresh and merely decent. The office task must never appear in a home session.
    const officeTask = withNeglect(
      makeTask({ id: 1, importance: 1000, contextTags: ['office'] }),
      20,
    );
    const homeTask = withNeglect(makeTask({ id: 2, importance: 300, contextTags: ['home'] }), 0);

    const { eligible } = filterBySessionCapability([officeTask, homeTask], checkIn);
    const ranked = scoreTasks(eligible, checkIn, NOW);

    expect(ranked.map((s) => s.task.id)).toEqual([2]);
  });
});

describe('filterDependencyBlocked (task 10 U1 — dependency-blocked pre-filter)', () => {
  it('passes a task with no unresolved blockers and no pending confirmation', () => {
    const item = withNeglect(makeTask({ id: 1 }));
    const { eligible, rejected } = filterDependencyBlocked([item], new Map());
    expect(eligible).toEqual([item]);
    expect(rejected).toEqual([]);
  });

  it('holds a blocked subtask out of the pool but lets the unblocked head through', () => {
    const head = withNeglect(makeTask({ id: 1 }));
    const blocked = withNeglect(makeTask({ id: 2 }));
    // task 2 depends on task 1, which is not yet complete
    const blockers = new Map<number, number[]>([[2, [1]]]);

    const { eligible, rejected } = filterDependencyBlocked([head, blocked], blockers);
    expect(eligible.map((i) => i.task.id)).toEqual([1]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].item.task.id).toBe(2);
    expect(rejected[0].blockedBy).toEqual([1]);
    expect(rejected[0].pendingBreakdownComplete).toBe(false);
  });

  it('carries the correct (multiple) blocker ids on a reject', () => {
    const blocked = withNeglect(makeTask({ id: 3 }));
    const blockers = new Map<number, number[]>([[3, [1, 2]]]);
    const { rejected } = filterDependencyBlocked([blocked], blockers);
    expect(rejected[0].blockedBy).toEqual([1, 2]);
  });

  it('holds a parent pending a breakdown_complete confirmation, even with no live blockers (R7c)', () => {
    const parent = withNeglect(makeTask({ id: 10 }));
    const { eligible, rejected } = filterDependencyBlocked(
      [parent],
      new Map(), // all its subtasks completed → no live dependency blockers
      new Set([10]), // but the check-off conversation is still pending
    );
    expect(eligible).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].pendingBreakdownComplete).toBe(true);
    expect(rejected[0].blockedBy).toEqual([]);
  });

  it('retains rejects (both signals) rather than discarding them', () => {
    const ok = withNeglect(makeTask({ id: 1 }));
    const dep = withNeglect(makeTask({ id: 2 }));
    const held = withNeglect(makeTask({ id: 3 }));
    const { eligible, rejected } = filterDependencyBlocked(
      [ok, dep, held],
      new Map([[2, [1]]]),
      new Set([3]),
    );
    expect(eligible.map((i) => i.task.id)).toEqual([1]);
    expect(rejected.map((r) => r.item.task.id).sort()).toEqual([2, 3]);
  });

  it('a chain re-ranked N times under the novelty ranker never inverts (only the head is ever in the pool)', () => {
    const checkIn: SessionCheckIn = { energy: 'med', contexts: [], tools: [] };
    // A three-step ordered chain: 1 → 2 → 3, all sharing a context group and near-equal scores
    // (the exact case that fools weightedShuffle). Only the head (1) is unblocked.
    const s1 = withNeglect(makeTask({ id: 1, importance: 503 }));
    const s2 = withNeglect(makeTask({ id: 2, importance: 502 }));
    const s3 = withNeglect(makeTask({ id: 3, importance: 501 }));
    const blockers = new Map<number, number[]>([
      [2, [1]],
      [3, [2]],
    ]);

    for (let seed = 0; seed < 50; seed++) {
      const { eligible } = filterDependencyBlocked([s1, s2, s3], blockers);
      // deterministic pseudo-rng seeded off the iteration so the shuffle actually varies
      let state = seed + 1;
      const rng = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const ranked = rankWithContextNovelty(eligible, checkIn, NOW, rng);
      // Only step 1 is ever eligible, so a chain can never be served out of order.
      expect(ranked.map((s) => s.task.id)).toEqual([1]);
    }
  });
});
