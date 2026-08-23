import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import {
  neglectCurve,
  rankWithContextNovelty,
  scoreTask,
  scoreTasks,
  type Rng,
  type SessionCheckIn,
} from '../score';
import { historicalSuccessFactor } from '../factors';

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

// neglectMultiplier mirrors the real repo (task 10, R1: linear, uncapped) — scoreTask now
// derives the actual multiplier from weeksNeglected via neglectCurve, not this field.
function withNeglect(task: Task, weeksNeglected: number): TaskWithNeglect {
  return { task, weeksNeglected, neglectMultiplier: weeksNeglected, missedQuota: null };
}

const CHECK_IN: SessionCheckIn = { energy: 'med', contexts: ['home', 'computer'], tools: [] };

describe('scoreTask', () => {
  it('wires task fields through the factor functions and composes the final score', () => {
    const task = makeTask({
      importance: 1000,
      energyRequirement: 3, // matches 'med' → energyMatch 1
      nextDueAt: '2026-07-15', // due today → urgency 1
      successRate: 1,
      // Enough completions that R6's k=2 shrinkage toward 0.5 is negligible (401/402 ≈ 0.9975):
      // this test asserts the all-factors-maxed composition, not the cold-start behaviour.
      completionCount: 400,
    });
    const scored = scoreTask(withNeglect(task, 0), CHECK_IN, NOW);
    expect(scored.factors.importance).toBeCloseTo(1);
    expect(scored.factors.urgency).toBe(1);
    expect(scored.factors.energyMatch).toBe(1);
    expect(scored.factors.historicalSuccess).toBeCloseTo(1);
    expect(scored.baseScore).toBeCloseTo(1);
    // weeksNeglected 0 → neglectCurve(0) = 1 → finalScore == baseScore (fresh task on merit)
    expect(scored.finalScore).toBeCloseTo(1 * neglectCurve(0));
  });

  // Task 55 / W2 (test-audit task 53). `scoreTask` passes `completionCount + skipCount` as the
  // R6 evidence count `n`. Nothing pinned that WIRING: every scoring/planning fixture in the repo
  // hard-codes `skipCount: 0`, so dropping `+ task.skipCount` from score.ts passed 973/973. This
  // test is the guard — it is the only fixture in src/scoring or src/planning with a nonzero
  // skipCount, and it fails on exactly that mutation.
  it('counts skips as evidence too — n is completionCount + skipCount, not completions alone (task 55 / W2)', () => {
    // A task attempted ten times: done twice, declined eight times. successRate is the writer's
    // invariant C/(C+S) = 2/10 (tasks.recordHistoricalCompletion / recordSkipEpisode, task 17).
    const task = makeTask({ completionCount: 2, skipCount: 8, successRate: 0.2 });
    const scored = scoreTask(withNeglect(task, 0), CHECK_IN, NOW);

    // n = 10, the full attempt count.
    expect(scored.factors.historicalSuccess).toBeCloseTo(historicalSuccessFactor(0.2, 10), 10);
    // Literal pin of the same value, so the assertion cannot move with the formula:
    // (0.2·10 + 0.5·2)/(10 + 2) = 3/12 = 0.25.
    expect(scored.factors.historicalSuccess).toBeCloseTo(0.25, 10);
    // And explicitly NOT the completions-only count the dropped-skipCount mutation produces:
    // (0.2·2 + 0.5·2)/(2 + 2) = 1.4/4 = 0.35.
    expect(scored.factors.historicalSuccess).not.toBeCloseTo(historicalSuccessFactor(0.2, 2), 5);
    expect(historicalSuccessFactor(0.2, 2)).toBeCloseTo(0.35, 10);
  });

  it('applies neglect as a floor of 1, never zeroing a fresh task', () => {
    const task = makeTask({ importance: 800 });
    const scored = scoreTask(withNeglect(task, 0), CHECK_IN, NOW);
    // A brand-new (weeksNeglected 0) task keeps its full weighted-sum score.
    expect(scored.finalScore).toBeCloseTo(scored.baseScore);
    expect(scored.finalScore).toBeGreaterThan(0);
  });

  it('final score is baseScore × neglectCurve(weeksNeglected), linear (task 10, R1)', () => {
    const task = makeTask({ importance: 400 });
    const scored = scoreTask(withNeglect(task, 9), CHECK_IN, NOW);
    expect(scored.finalScore).toBeCloseTo(scored.baseScore * 10);
    expect(scored.neglectMultiplier).toBeCloseTo(10);
  });

  it('neglectCurve is linear and unbounded (task 10, R1 — the swappable seam)', () => {
    expect(neglectCurve(0)).toBe(1);
    expect(neglectCurve(1)).toBe(2);
    expect(neglectCurve(10)).toBe(11);
    expect(neglectCurve(1_000_000)).toBe(1_000_001);
    // Linear, not squared: doubling weeks roughly doubles the curve value at scale, never
    // collapsing to a knee — the pathology R1 fixed (worst-vs-best crossover at ~2 weeks).
    expect(neglectCurve(20) - neglectCurve(10)).toBeCloseTo(neglectCurve(10) - neglectCurve(0));
  });
});

describe('uncapped neglect fail-safe (§5.2)', () => {
  it('lifts a long-ignored low-value task above a fresh high-value one', () => {
    const important = makeTask({ id: 1, importance: 1000, contextTags: ['home'] });
    const neglected = makeTask({ id: 2, importance: 100, contextTags: ['home'] });

    // Fresh important task vs a barely-important task neglected for many weeks.
    const fresh = withNeglect(important, 0);
    const stale = withNeglect(neglected, 20); // 20 weeks → neglectCurve(20) = 21 (linear)

    const ranked = scoreTasks([fresh, stale], CHECK_IN, NOW);
    expect(ranked[0].task.id).toBe(2); // neglect forces the ignored task to the top
  });

  it('grows without any upper bound — the multiplier is never capped', () => {
    const task = makeTask({ importance: 500 });
    const base = scoreTask(withNeglect(task, 0), CHECK_IN, NOW).baseScore;
    const modest = scoreTask(withNeglect(task, 100), CHECK_IN, NOW).finalScore;
    const extreme = scoreTask(withNeglect(task, 1_000_000), CHECK_IN, NOW).finalScore;
    expect(modest).toBeCloseTo(base * 101);
    expect(extreme).toBeCloseTo(base * 1_000_001);
    // No clamp anywhere: the extreme score dwarfs the modest one proportionally.
    expect(extreme / modest).toBeCloseTo(1_000_001 / 101);
  });
});

describe('scoreTasks ordering', () => {
  it('ranks by finalScore descending', () => {
    const a = withNeglect(makeTask({ id: 1, importance: 200 }), 0);
    const b = withNeglect(makeTask({ id: 2, importance: 900 }), 0);
    const c = withNeglect(makeTask({ id: 3, importance: 500 }), 0);
    const ranked = scoreTasks([a, b, c], CHECK_IN, NOW);
    expect(ranked.map((s) => s.task.id)).toEqual([2, 3, 1]);
  });

  it('breaks ties by ascending task id for a stable order', () => {
    const a = withNeglect(makeTask({ id: 7, importance: 500 }), 0);
    const b = withNeglect(makeTask({ id: 3, importance: 500 }), 0);
    const ranked = scoreTasks([a, b], CHECK_IN, NOW);
    expect(ranked.map((s) => s.task.id)).toEqual([3, 7]);
  });
});

describe('rankWithContextNovelty', () => {
  // A deterministic rng that replays a fixed sequence, looping.
  function seqRng(values: number[]): Rng {
    let i = 0;
    return () => values[i++ % values.length];
  }

  it('orders context groups by their strongest task, shuffling within', () => {
    const homeStrong = withNeglect(makeTask({ id: 1, importance: 1000, contextTags: ['home'] }), 0);
    const homeWeak = withNeglect(makeTask({ id: 2, importance: 300, contextTags: ['home'] }), 0);
    const office = withNeglect(makeTask({ id: 3, importance: 900, contextTags: ['office'] }), 0);

    // rng → 0 makes weightedShuffle always take the first remaining task (threshold 0), so the
    // in-group order is preserved and the assertion is about group ordering only.
    const ranked = rankWithContextNovelty(
      [homeWeak, homeStrong, office],
      { energy: 'med', contexts: ['home', 'office'], tools: [] },
      NOW,
      seqRng([0]),
    );
    // 'home' group has the strongest task (importance 1000) → leads; 'office' group follows.
    const ids = ranked.map((s) => s.task.id);
    expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(3));
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3));
    expect(new Set(ids)).toEqual(new Set([1, 2, 3]));
  });

  it('is a permutation of the input (nothing dropped or duplicated)', () => {
    const items = [
      withNeglect(makeTask({ id: 1, contextTags: ['home'] }), 5),
      withNeglect(makeTask({ id: 2, contextTags: ['office'] }), 2),
      withNeglect(makeTask({ id: 3, contextTags: [] }), 0),
      withNeglect(makeTask({ id: 4, contextTags: ['home'] }), 1),
    ];
    const ranked = rankWithContextNovelty(items, CHECK_IN, NOW, seqRng([0.1, 0.9, 0.5, 0.3]));
    expect(ranked.map((s) => s.task.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('weighted shuffle can reorder within a group given different randomness', () => {
    const g1 = withNeglect(makeTask({ id: 1, importance: 600, contextTags: ['home'] }), 0);
    const g2 = withNeglect(makeTask({ id: 2, importance: 500, contextTags: ['home'] }), 0);
    const g3 = withNeglect(makeTask({ id: 3, importance: 400, contextTags: ['home'] }), 0);
    // rng → just under 1 makes each draw pick the LAST remaining task, reversing the group.
    const ranked = rankWithContextNovelty([g1, g2, g3], CHECK_IN, NOW, seqRng([0.999999]));
    expect(ranked.map((s) => s.task.id)).toEqual([3, 2, 1]);
  });
});
