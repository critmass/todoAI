import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import type { Rng, SessionCheckIn } from '../../scoring/score';
import type { AgendaTaskItem, SessionPlan } from '../agenda';
import { firstWorkableWithTools, planRequiredTools } from '../agenda';
import {
  BREAK_MINUTES,
  EASIER_MAX_ITEM_MINUTES,
  planSession,
  replanRemaining,
  runSelectionBoundary,
  type PlanRequest,
  type SelectionBoundaryResult,
} from '../planner';

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

function boundaryOf(...items: TaskWithNeglect[]): SelectionBoundaryResult {
  return { eligible: items, capabilityRejects: [], dependencyRejects: [] };
}

function seededRng(seed: number): Rng {
  let state = seed + 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const CHECK_IN: SessionCheckIn = { energy: 'med', contexts: ['home', 'computer'], tools: [] };

function deepFocusRequest(minutes = 90): PlanRequest {
  return { sessionType: 'deep_focus', sessionMinutes: minutes, checkIn: CHECK_IN };
}

function taskItems(plan: SessionPlan): AgendaTaskItem[] {
  return plan.items.filter((item): item is AgendaTaskItem => item.kind === 'task');
}

describe('runSelectionBoundary (spec §5.3 — U1/U5 checklist item)', () => {
  it('runs BOTH hard pre-filters before anything is ranked, retaining both reject sets', () => {
    const ok = withNeglect(makeTask({ id: 1 }));
    const wrongContext = withNeglect(makeTask({ id: 2, contextTags: ['office'] }));
    const blocked = withNeglect(makeTask({ id: 3 }));
    const result = runSelectionBoundary(
      [ok, wrongContext, blocked],
      CHECK_IN,
      new Map([[3, [1]]]),
      new Set(),
    );
    expect(result.eligible.map((i) => i.task.id)).toEqual([1]);
    expect(result.capabilityRejects.map((r) => r.item.task.id)).toEqual([2]);
    expect(result.dependencyRejects.map((r) => r.item.task.id)).toEqual([3]);
  });

  it('wires the R7c hold: a parent pending breakdown_complete is held out with the flag set', () => {
    const parent = withNeglect(makeTask({ id: 10 }));
    const result = runSelectionBoundary([parent], CHECK_IN, new Map(), new Set([10]));
    expect(result.eligible).toEqual([]);
    expect(result.dependencyRejects).toHaveLength(1);
    expect(result.dependencyRejects[0].pendingBreakdownComplete).toBe(true);
  });

  it('a held parent never reaches a plan (the task-25 residual risk, closed)', () => {
    const parent = withNeglect(makeTask({ id: 10, estimatedDuration: 30 }));
    const other = withNeglect(makeTask({ id: 11, estimatedDuration: 20 }));
    const boundary = runSelectionBoundary([parent, other], CHECK_IN, new Map(), new Set([10]));
    const plan = planSession(boundary, deepFocusRequest(), NOW, seededRng(1));
    expect(taskItems(plan).map((i) => i.task.id)).not.toContain(10);
  });

  it('rejects are carried through onto the plan for §8.1 coaching and R4', () => {
    const wrongContext = withNeglect(makeTask({ id: 2, contextTags: ['office'] }));
    const boundary = runSelectionBoundary([wrongContext], CHECK_IN, new Map(), new Set());
    const plan = planSession(boundary, deepFocusRequest(), NOW, seededRng(1));
    expect(plan.outcome).toBe('no_eligible_tasks');
    expect(plan.capabilityRejects).toHaveLength(1);
    expect(plan.capabilityRejects[0].missingContexts).toEqual(['office']);
  });
});

describe('deep-focus allocation (§5.3.1 + task 28 step 0)', () => {
  it('reserves an end-of-session block with the 25% overrun buffer applied to countdown sizing', () => {
    // 90-minute session → 60-minute block → 45 plannable work minutes.
    const major = withNeglect(makeTask({ id: 1, estimatedDuration: 40, importance: 900 }));
    const plan = planSession(boundaryOf(major), deepFocusRequest(90), NOW, seededRng(3));
    const deep = taskItems(plan).filter((i) => i.deepFocus);
    expect(deep).toHaveLength(1);
    expect(deep[0].task.id).toBe(1);
    expect(deep[0].blockKind).toBe('countdown');
    expect(deep[0].plannedMinutes).toBe(40); // ≤ 45 work minutes — fits WITH the buffer
    // The deep-focus block sits at the END of the agenda.
    const last = plan.items[plan.items.length - 1];
    expect(last.kind).toBe('task');
    expect((last as AgendaTaskItem).deepFocus).toBe(true);
  });

  it('a floor task takes the whole block as an openBlock and is placed only when block ≥ floor', () => {
    const floor = withNeglect(
      makeTask({ id: 1, durationType: 'floor', estimatedDuration: 60, importance: 900 }),
    );
    // 90-minute session → 60-minute block → placeable, fills the block.
    const fits = planSession(boundaryOf(floor), deepFocusRequest(90), NOW, seededRng(3));
    const deep = taskItems(fits).filter((i) => i.deepFocus);
    expect(deep).toHaveLength(1);
    expect(deep[0].blockKind).toBe('openBlock');
    expect(deep[0].plannedMinutes).toBe(60); // the block boundary, gross

    // 60-minute session → 40-minute block < the 60-minute floor → NOT placeable anywhere.
    const tooShort = planSession(boundaryOf(floor), deepFocusRequest(60), NOW, seededRng(3));
    expect(taskItems(tooShort)).toHaveLength(0);
    expect(tooShort.outcome).toBe('nothing_fits');
    expect(tooShort.splitCandidate?.id).toBe(1); // offer to split, never shorten
  });

  it('step 0: the single most-recently-worked in-progress task claims the block first', () => {
    const older = withNeglect(
      makeTask({
        id: 1,
        workState: 'in_progress',
        estimatedDuration: 40,
        accumulatedMinutes: 5,
        lastWorkedAt: '2026-07-10 09:00:00',
      }),
    );
    const fresher = withNeglect(
      makeTask({
        id: 2,
        workState: 'in_progress',
        estimatedDuration: 40,
        accumulatedMinutes: 5,
        lastWorkedAt: '2026-07-14 21:00:00',
      }),
    );
    const plan = planSession(boundaryOf(older, fresher), deepFocusRequest(90), NOW, seededRng(5));
    const claims = taskItems(plan).filter((i) => i.resumeClaim);
    expect(claims).toHaveLength(1);
    expect(claims[0].task.id).toBe(2); // most recent last_worked_at wins
    expect(claims[0].deepFocus).toBe(true);
    expect(claims[0].blockKind).toBe('countdown'); // estimate-type, not blown → counts down
    expect(claims[0].plannedMinutes).toBe(35); // remaining = 40 − 5
  });

  it('quick sessions have no deep-focus block and make no resume claim', () => {
    const parked = withNeglect(
      makeTask({
        id: 1,
        workState: 'in_progress',
        estimatedDuration: 8,
        accumulatedMinutes: 2,
        lastWorkedAt: '2026-07-14 21:00:00',
      }),
    );
    const plan = planSession(
      boundaryOf(parked),
      { sessionType: 'quick', sessionMinutes: 10, checkIn: CHECK_IN },
      NOW,
      seededRng(7),
    );
    expect(taskItems(plan).some((i) => i.deepFocus)).toBe(false);
    expect(taskItems(plan).some((i) => i.resumeClaim)).toBe(false);
    // …but the parked task may still surface through the ordinary pipeline if it fits.
    expect(taskItems(plan).map((i) => i.task.id)).toEqual([1]);
  });

  it('a resume claim must have passed both hard filters (a blocked in-progress task cannot claim)', () => {
    const blockedParked = withNeglect(
      makeTask({
        id: 1,
        workState: 'in_progress',
        estimatedDuration: 40,
        lastWorkedAt: '2026-07-14 21:00:00',
      }),
    );
    const ordinary = withNeglect(makeTask({ id: 2, estimatedDuration: 40, importance: 900 }));
    const boundary = runSelectionBoundary(
      [blockedParked, ordinary],
      CHECK_IN,
      new Map([[1, [99]]]), // the parked task is dependency-blocked
      new Set(),
    );
    const plan = planSession(boundary, deepFocusRequest(90), NOW, seededRng(5));
    expect(taskItems(plan).some((i) => i.resumeClaim)).toBe(false);
    expect(taskItems(plan).map((i) => i.task.id)).not.toContain(1);
  });

  it('allocates at most two major tasks into the block, strict score order', () => {
    const big = withNeglect(makeTask({ id: 1, estimatedDuration: 25, importance: 900 }));
    const second = withNeglect(makeTask({ id: 2, estimatedDuration: 25, importance: 800 }));
    const third = withNeglect(makeTask({ id: 3, estimatedDuration: 25, importance: 700 }));
    // 120-minute session → 80-minute block → 60 work minutes: room for two 25s, never three.
    const plan = planSession(
      boundaryOf(big, second, third),
      deepFocusRequest(120),
      NOW,
      seededRng(11),
    );
    const deep = taskItems(plan).filter((i) => i.deepFocus);
    expect(deep.map((i) => i.task.id)).toEqual([1, 2]);
  });
});

describe('arrangement (§5.3.2–5.3.4)', () => {
  const lowHome = () =>
    withNeglect(makeTask({ id: 1, contextTags: ['home'], energyRequirement: 1, estimatedDuration: 10 }));
  const highHome = () =>
    withNeglect(makeTask({ id: 2, contextTags: ['home'], energyRequirement: 5, estimatedDuration: 10 }));
  const medComputer = () =>
    withNeglect(makeTask({ id: 3, contextTags: ['computer'], energyRequirement: 3, estimatedDuration: 10 }));

  it('groups by context with a break at each context switch, none inside the session for quick', () => {
    const plan = planSession(
      boundaryOf(lowHome(), highHome(), medComputer()),
      { sessionType: 'moderate', sessionMinutes: 40, checkIn: CHECK_IN },
      NOW,
      seededRng(13),
    );
    const kinds = plan.items.map((item) => item.kind);
    // Two context groups → exactly one break, between them.
    expect(kinds.filter((k) => k === 'break')).toHaveLength(1);
    const breakIndex = kinds.indexOf('break');
    const before = plan.items.slice(0, breakIndex).filter((i) => i.kind === 'task');
    const after = plan.items.slice(breakIndex + 1).filter((i) => i.kind === 'task');
    const groupOf = (items: typeof before) =>
      new Set(items.map((i) => (i as AgendaTaskItem).task.contextTags.join()));
    expect(groupOf(before).size).toBe(1);
    expect(groupOf(after).size).toBe(1);

    const quick = planSession(
      boundaryOf(lowHome()),
      { sessionType: 'quick', sessionMinutes: 10, checkIn: CHECK_IN },
      NOW,
      seededRng(13),
    );
    expect(quick.items.every((item) => item.kind === 'task')).toBe(true);
  });

  it('orders context groups as an ascending energy ramp (fork 3 lives here, not in scoring)', () => {
    // home group mean energy (1+5)/2 = 3; office group energy 5 → home leads, office follows.
    const office = withNeglect(
      makeTask({ id: 4, contextTags: ['office'], energyRequirement: 5, estimatedDuration: 10 }),
    );
    const checkIn: SessionCheckIn = { ...CHECK_IN, contexts: ['home', 'office'] };
    const plan = planSession(
      boundaryOf(lowHome(), highHome(), office),
      { sessionType: 'moderate', sessionMinutes: 45, checkIn },
      NOW,
      seededRng(17),
    );
    const items = taskItems(plan);
    const officeIndex = items.findIndex((i) => i.task.id === 4);
    expect(officeIndex).toBe(items.length - 1); // highest-energy group rides last, toward deep work
  });

  it('never places a break inside the deep-focus block (the block is the contiguous tail)', () => {
    const front = withNeglect(makeTask({ id: 1, estimatedDuration: 10, contextTags: ['home'] }));
    const claimA = withNeglect(
      makeTask({
        id: 2,
        workState: 'in_progress',
        estimatedDuration: 30,
        accumulatedMinutes: 5,
        lastWorkedAt: '2026-07-14 08:00:00',
      }),
    );
    const majorB = withNeglect(makeTask({ id: 3, estimatedDuration: 25, importance: 950 }));
    // 120-minute session → 80 block / 60 work: claim (25 remaining) + major (25) both fit.
    const plan = planSession(
      boundaryOf(front, claimA, majorB),
      deepFocusRequest(120),
      NOW,
      seededRng(19),
    );
    const firstDeepIndex = plan.items.findIndex(
      (item) => item.kind === 'task' && item.deepFocus,
    );
    expect(firstDeepIndex).toBeGreaterThan(0);
    const tail = plan.items.slice(firstDeepIndex);
    expect(tail.length).toBeGreaterThanOrEqual(2); // claim + second major
    expect(tail.every((item) => item.kind === 'task' && item.deepFocus)).toBe(true);
    // …and the item immediately before the block is the §5.3.4 boundary break.
    expect(plan.items[firstDeepIndex - 1].kind).toBe('break');
  });
});

describe('replanRemaining (§5.3.5, §8.2, task 28 §4.2 — three callers, one primitive)', () => {
  const pool = () => [
    withNeglect(makeTask({ id: 1, estimatedDuration: 20, energyRequirement: 1 })),
    withNeglect(makeTask({ id: 2, estimatedDuration: 40, energyRequirement: 5, importance: 900 })),
    withNeglect(
      makeTask({ id: 3, durationType: 'floor', estimatedDuration: 60, importance: 950 }),
    ),
  ];

  it('escape valve (easier): only short items, no open blocks, no deep-focus block', () => {
    const plan = replanRemaining(
      boundaryOf(...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      90,
      NOW,
      seededRng(23),
      { easier: true },
    );
    const items = taskItems(plan);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.plannedMinutes).toBeLessThanOrEqual(EASIER_MAX_ITEM_MINUTES);
      expect(item.blockKind).toBe('countdown');
      expect(item.deepFocus).toBe(false);
    }
  });

  it('a ≥50-minute preceding stretch places a break FIRST in the regenerated agenda', () => {
    const withBreak = replanRemaining(
      boundaryOf(...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      40,
      NOW,
      seededRng(29),
      { precededByStretchMinutes: 55 },
    );
    expect(withBreak.items[0]).toEqual({ kind: 'break', plannedMinutes: BREAK_MINUTES });

    const withoutBreak = replanRemaining(
      boundaryOf(...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      40,
      NOW,
      seededRng(29),
      { precededByStretchMinutes: 30 },
    );
    expect(withoutBreak.items[0].kind).toBe('task');
  });

  it('never makes a resume claim mid-session (a just-parked task is not immediately re-served as the claim)', () => {
    const parked = withNeglect(
      makeTask({
        id: 9,
        workState: 'in_progress',
        estimatedDuration: 40,
        accumulatedMinutes: 20,
        lastWorkedAt: '2026-07-15 10:00:00',
      }),
    );
    const plan = replanRemaining(
      boundaryOf(parked, ...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      90,
      NOW,
      seededRng(31),
    );
    expect(taskItems(plan).some((i) => i.resumeClaim)).toBe(false);
  });

  it('honors excludeTaskIds (tasks already served this session never re-enter the tail)', () => {
    const plan = replanRemaining(
      boundaryOf(...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      90,
      NOW,
      seededRng(37),
      { excludeTaskIds: new Set([2, 3]) },
    );
    expect(taskItems(plan).map((i) => i.task.id)).toEqual([1]);
  });

  it('zero remaining minutes returns an empty planned agenda (caller goes to summary)', () => {
    const plan = replanRemaining(
      boundaryOf(...pool()),
      { sessionType: 'deep_focus', checkIn: CHECK_IN },
      0,
      NOW,
      seededRng(41),
    );
    expect(plan.items).toEqual([]);
    expect(plan.outcome).toBe('planned');
  });
});

describe('edge outcomes (§8.1, §8.2)', () => {
  it('a 5-minute session where nothing fits offers to split rather than ending', () => {
    const big = withNeglect(makeTask({ id: 1, estimatedDuration: 30, importance: 900 }));
    const plan = planSession(
      boundaryOf(big),
      { sessionType: 'quick', sessionMinutes: 5, checkIn: CHECK_IN },
      NOW,
      seededRng(43),
    );
    expect(plan.outcome).toBe('nothing_fits');
    expect(plan.splitCandidate?.id).toBe(1);
  });

  it('a 5-minute session with a fitting task plans it — very short sessions are first-class', () => {
    const small = withNeglect(makeTask({ id: 1, estimatedDuration: 5 }));
    const plan = planSession(
      boundaryOf(small),
      { sessionType: 'quick', sessionMinutes: 5, checkIn: CHECK_IN },
      NOW,
      seededRng(47),
    );
    expect(plan.outcome).toBe('planned');
    expect(taskItems(plan).map((i) => i.task.id)).toEqual([1]);
  });

  it('an empty eligible pool reports no_eligible_tasks with rejects intact', () => {
    const plan = planSession(
      { eligible: [], capabilityRejects: [], dependencyRejects: [] },
      deepFocusRequest(),
      NOW,
      seededRng(53),
    );
    expect(plan.outcome).toBe('no_eligible_tasks');
    expect(plan.items).toEqual([]);
  });

  it('is deterministic for a fixed seed', () => {
    const tasks = [
      withNeglect(makeTask({ id: 1, estimatedDuration: 10, contextTags: ['home'] })),
      withNeglect(makeTask({ id: 2, estimatedDuration: 15, contextTags: ['computer'] })),
      withNeglect(makeTask({ id: 3, estimatedDuration: 25, importance: 900 })),
    ];
    const roll = () =>
      taskItems(
        planSession(boundaryOf(...tasks), deepFocusRequest(90), NOW, seededRng(61)),
      ).map((i) => i.task.id);
    expect(roll()).toEqual(roll());
  });
});

describe('tools checklist (§6.2)', () => {
  it('surfaces the union of required tools and finds the first workable non-deep-focus task', () => {
    const hammer = withNeglect(
      makeTask({ id: 1, estimatedDuration: 10, toolRequirements: ['hammer'] }),
    );
    const laptop = withNeglect(
      makeTask({ id: 2, estimatedDuration: 10, toolRequirements: ['laptop'] }),
    );
    const major = withNeglect(
      makeTask({ id: 3, estimatedDuration: 40, importance: 950, toolRequirements: ['laptop'] }),
    );
    const checkIn: SessionCheckIn = { ...CHECK_IN, tools: ['hammer', 'laptop'] };
    const plan = planSession(
      boundaryOf(hammer, laptop, major),
      { sessionType: 'deep_focus', sessionMinutes: 90, checkIn },
      NOW,
      seededRng(67),
    );
    expect(planRequiredTools(plan)).toEqual(['hammer', 'laptop']);

    // Only the hammer is actually present → the first workable NON-deep-focus task is the
    // hammer task (the §6.2 fallback's first half; the rebuild is a fresh plan call).
    const workable = firstWorkableWithTools(plan, ['hammer']);
    expect(workable?.task.id).toBe(1);
    expect(workable?.deepFocus).toBe(false);
  });
});
