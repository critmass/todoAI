import type { Task } from '../../types/domain';
import {
  isPlaceableInBlock,
  placementFloorMinutes,
  plannedMinutes,
  treatedAsOpenEnded,
} from '../plannedMinutes';

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

// Each row of task 28 design §3.2, in order.
describe('plannedMinutes (design §3.2)', () => {
  it('floor-type fills its block', () => {
    const task = makeTask({ durationType: 'floor', estimatedDuration: 60 });
    expect(plannedMinutes(task, 80)).toBe(80);
  });

  it('estimate-type not started plans its estimate', () => {
    expect(plannedMinutes(makeTask({ estimatedDuration: 30 }), 100)).toBe(30);
  });

  it('estimate-type in progress plans the remaining minutes', () => {
    const task = makeTask({
      estimatedDuration: 30,
      workState: 'in_progress',
      accumulatedMinutes: 10,
    });
    expect(plannedMinutes(task, 100)).toBe(20);
  });

  it('a blown estimate (accumulated ≥ estimate) fills its block like a floor', () => {
    const task = makeTask({
      estimatedDuration: 30,
      workState: 'in_progress',
      accumulatedMinutes: 35,
    });
    expect(treatedAsOpenEnded(task)).toBe(true);
    expect(plannedMinutes(task, 50)).toBe(50);
  });
});

describe('placement floor (design §3.2)', () => {
  it('a floor-typed task is only placeable in a block ≥ its floor (gross minutes)', () => {
    const task = makeTask({ durationType: 'floor', estimatedDuration: 60 });
    expect(placementFloorMinutes(task)).toBe(60);
    // The floor compares against GROSS block minutes: a 60-minute block genuinely offers 60
    // minutes of open-ended work (the overrun buffer only exists for estimates).
    expect(isPlaceableInBlock(task, 60, 45)).toBe(true);
    expect(isPlaceableInBlock(task, 40, 30)).toBe(false);
  });

  it('a blown estimate carries a placement floor at its original estimate', () => {
    const task = makeTask({
      estimatedDuration: 30,
      workState: 'in_progress',
      accumulatedMinutes: 30,
    });
    expect(placementFloorMinutes(task)).toBe(30);
    expect(isPlaceableInBlock(task, 30, 22)).toBe(true);
    expect(isPlaceableInBlock(task, 20, 15)).toBe(false);
  });

  it('an estimate-typed task has no floor and fits by its planned minutes vs work minutes', () => {
    const task = makeTask({ estimatedDuration: 30 });
    expect(placementFloorMinutes(task)).toBeNull();
    expect(isPlaceableInBlock(task, 60, 45)).toBe(true);
    expect(isPlaceableInBlock(task, 60, 20)).toBe(false); // 30 > 20 of plannable work
  });

  it('an in-progress remainder never sizes below one minute', () => {
    const task = makeTask({
      estimatedDuration: 30,
      workState: 'in_progress',
      accumulatedMinutes: 29.5,
    });
    expect(plannedMinutes(task, 100)).toBe(1);
  });
});
