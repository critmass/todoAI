import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import { filterBySessionCapability } from '../filter';
import { scoreTasks, type SessionCheckIn } from '../score';

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
