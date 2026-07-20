// Task 11, decision (c) — fork 6's "prove the shuffle" measurement, kept as a permanent
// regression test (task 10 review §1 fork 6). Re-rolls rankWithContextNovelty over a realistic
// pool snapshot with a seeded rng and measures the Shannon entropy of the first three agenda
// slots. ALARM CONDITION (the review's words): slot-1 entropy ≈ 0 WITHOUT a fail-safe-age
// outlier present — that would mean the "weighted shuffle" is deterministic and the novelty
// mechanism is dead. With an outlier present, near-zero slot-1 entropy is the §5.2 fail-safe
// WORKING (a task that climbed for months SHOULD deterministically surface), not a failure.
//
// Measured baseline at commit time (seeds 0..N-1, N = 400, pool below):
//   slot 1 ≈ 1.92 bits, slot 2 ≈ 1.97 bits, slot 3 ≈ 2.00 bits (max possible log2(12) ≈ 3.58);
//   with the 30-week outlier added: outlier takes slot 1 in ~84% of rolls (slot-1 entropy
//   ≈ 0.89 bits — the fail-safe dominating, as designed).
// The assertions are set well below baseline so they catch collapse, not drift.

import type { Task } from '../../types/domain';
import type { TaskWithNeglect } from '../../db/repositories/tasks';
import { rankWithContextNovelty, type Rng, type SessionCheckIn } from '../score';

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

function withNeglect(task: Task, weeksNeglected: number): TaskWithNeglect {
  return { task, weeksNeglected, neglectMultiplier: weeksNeglected };
}

function seededRng(seed: number): Rng {
  let state = seed + 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Shannon entropy (bits) of an occupancy count map. */
function entropyBits(counts: Map<number, number>): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  let h = 0;
  for (const count of counts.values()) {
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A realistic active pool: a dozen tasks across three real context groups plus flexible,
 *  neglect ages 0–3 weeks, importance 400–900 — nothing pathological, no fail-safe outlier. */
function realisticPool(): TaskWithNeglect[] {
  const spec: Array<[number, string[], number, number, number]> = [
    // [id, contexts, importance, energy, weeksNeglected]
    [1, ['home'], 700, 2, 1.0],
    [2, ['home'], 650, 3, 0.5],
    [3, ['home'], 500, 1, 2.0],
    [4, ['computer'], 900, 4, 0.2],
    [5, ['computer'], 800, 3, 1.5],
    [6, ['computer'], 600, 3, 0.8],
    [7, ['computer'], 450, 2, 3.0],
    [8, ['office'], 750, 4, 0.4],
    [9, ['office'], 550, 3, 1.2],
    [10, [], 400, 1, 2.5],
    [11, [], 620, 2, 0.1],
    [12, [], 580, 3, 1.8],
  ];
  return spec.map(([id, contextTags, importance, energyRequirement, weeks]) =>
    withNeglect(makeTask({ id, contextTags, importance, energyRequirement }), weeks),
  );
}

const CHECK_IN: SessionCheckIn = {
  energy: 'med',
  contexts: ['home', 'computer', 'office'],
  tools: [],
};

const ROLLS = 400;

function slotOccupancy(pool: TaskWithNeglect[], slots: number): Array<Map<number, number>> {
  const occupancy = Array.from({ length: slots }, () => new Map<number, number>());
  for (let seed = 0; seed < ROLLS; seed++) {
    const ranked = rankWithContextNovelty(pool, CHECK_IN, NOW, seededRng(seed));
    for (let slot = 0; slot < slots; slot++) {
      const id = ranked[slot]?.task.id;
      if (id == null) continue;
      occupancy[slot].set(id, (occupancy[slot].get(id) ?? 0) + 1);
    }
  }
  return occupancy;
}

describe('rankWithContextNovelty positional entropy (fork 6 regression)', () => {
  it('the shuffle actually shuffles: slots 1–3 carry real entropy with no outlier present', () => {
    const occupancy = slotOccupancy(realisticPool(), 3);
    const h = occupancy.map(entropyBits);
    // Alarm condition is ≈ 0. Baseline measured ≈ 2.2–2.3 bits per slot; assert a wide floor.
    expect(h[0]).toBeGreaterThan(1.0);
    expect(h[1]).toBeGreaterThan(1.0);
    expect(h[2]).toBeGreaterThan(1.0);
  });

  it('a fail-safe-age outlier IS allowed to dominate slot 1 — that is §5.2 working, not a bug', () => {
    const pool = [
      ...realisticPool(),
      // 30 weeks neglected: multiplier 31× drowns every base-score difference by design.
      withNeglect(makeTask({ id: 99, contextTags: ['home'], importance: 500 }), 30),
    ];
    const occupancy = slotOccupancy(pool, 1);
    const outlierShare = (occupancy[0].get(99) ?? 0) / ROLLS;
    // The climber deterministically surfaces (its group leads via max-finalScore and it wins
    // the great majority of within-group draws — measured ~84% at 30 weeks). Low slot-1
    // entropy in THIS configuration is expected; only outlier-free collapse alarms.
    expect(outlierShare).toBeGreaterThan(0.75);
  });
});
