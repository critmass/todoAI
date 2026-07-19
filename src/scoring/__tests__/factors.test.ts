import {
  BASE_SENSITIVITY_CEILING,
  DEFAULT_IMPORTANCE_INTERNAL,
  FACTOR_WEIGHTS,
  HISTORICAL_SUCCESS_PRIOR_K,
  URGENCY_HORIZON_DAYS,
  energyMatchFactor,
  historicalSuccessFactor,
  importanceFactor,
  urgencyFactor,
  weightedSum,
  type FactorBreakdown,
} from '../factors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 15); // 2026-07-15, matches the project's "today"

describe('FACTOR_WEIGHTS', () => {
  it('sums to exactly 1.0 (weighted sum lands in [0,1])', () => {
    const total = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 10);
  });

  it('matches the task 10 (R3) revised weights — context/tool filtered out, not weighted', () => {
    expect(FACTOR_WEIGHTS).toEqual({
      importance: 0.31,
      urgency: 0.23,
      energyMatch: 0.23,
      historicalSuccess: 0.23,
    });
  });
});

describe('importanceFactor', () => {
  it('projects full internal importance (1-1000) to [0,1]', () => {
    expect(importanceFactor(700)).toBeCloseTo(0.7);
    expect(importanceFactor(1000)).toBe(1);
    expect(importanceFactor(1)).toBeCloseTo(0.001);
  });

  it('defaults null to the neutral internal midpoint, not 0', () => {
    expect(importanceFactor(null)).toBeCloseTo(DEFAULT_IMPORTANCE_INTERNAL / 1000);
    expect(importanceFactor(null)).toBeCloseTo(0.5);
  });

  it('clamps out-of-range values', () => {
    expect(importanceFactor(5000)).toBe(1);
    expect(importanceFactor(-100)).toBe(0);
  });
});

describe('urgencyFactor', () => {
  it('is 1 for an overdue task', () => {
    const yesterday = new Date(NOW - MS_PER_DAY).toISOString();
    expect(urgencyFactor(yesterday, 3, NOW)).toBe(1);
  });

  it('is 1 for a task due today', () => {
    expect(urgencyFactor(new Date(NOW).toISOString(), 3, NOW)).toBe(1);
  });

  it('ramps linearly within the horizon (closer = higher)', () => {
    const halfHorizon = new Date(NOW + (URGENCY_HORIZON_DAYS / 2) * MS_PER_DAY).toISOString();
    // due at half the horizon → proximity ~0.5 (well above the base-3 floor)
    expect(urgencyFactor(halfHorizon, 1, NOW)).toBeCloseTo(0.5, 5);
  });

  it('falls to the base-sensitivity floor beyond the horizon', () => {
    const farOut = new Date(NOW + (URGENCY_HORIZON_DAYS + 30) * MS_PER_DAY).toISOString();
    expect(urgencyFactor(farOut, 1, NOW)).toBe(0); // level 1 → floor 0
    expect(urgencyFactor(farOut, 5, NOW)).toBeCloseTo(BASE_SENSITIVITY_CEILING); // level 5 → max floor
  });

  it('uses only the base floor when there is no due date', () => {
    expect(urgencyFactor(null, 1, NOW)).toBe(0);
    expect(urgencyFactor(null, 3, NOW)).toBeCloseTo(0.5 * BASE_SENSITIVITY_CEILING);
    expect(urgencyFactor(null, 5, NOW)).toBeCloseTo(BASE_SENSITIVITY_CEILING);
  });

  it('accepts a bare YYYY-MM-DD due date', () => {
    expect(urgencyFactor('2026-07-15', 3, NOW)).toBe(1); // today
  });

  it('treats an unparseable due date as no time-signal (base floor only)', () => {
    expect(urgencyFactor('not-a-date', 1, NOW)).toBe(0);
  });
});

describe('energyMatchFactor', () => {
  it('is 1 for an exact match', () => {
    expect(energyMatchFactor('low', 1)).toBe(1);
    expect(energyMatchFactor('med', 3)).toBe(1);
    expect(energyMatchFactor('high', 5)).toBe(1);
  });

  it('falls off linearly with distance (max distance 4)', () => {
    expect(energyMatchFactor('high', 1)).toBe(0); // |5-1|/4 = 1
    expect(energyMatchFactor('high', 3)).toBeCloseTo(0.5); // |5-3|/4 = 0.5
    expect(energyMatchFactor('low', 3)).toBeCloseTo(0.5); // |1-3|/4 = 0.5
  });

  it('handles the app-assigned internal 2/4 energy levels', () => {
    expect(energyMatchFactor('low', 2)).toBeCloseTo(0.75); // |1-2|/4
    expect(energyMatchFactor('high', 4)).toBeCloseTo(0.75); // |5-4|/4
  });
});

describe('historicalSuccessFactor (task 10 R6 — smoothed cold-start)', () => {
  it('returns the neutral prior for a task with no attempts (cold start falls out of the formula)', () => {
    // (0·0 + 0.5·2)/(0+2) = 0.5 — the old n≤0 branch is now the k=2 case, not a special case.
    expect(historicalSuccessFactor(0, 0)).toBe(0.5);
  });

  it('lands the first skip at 0.33 and the first completion at 0.67, not 0.0 / 1.0', () => {
    // one skip: rate 0, n 1 → (0·1 + 0.5·2)/(1+2) = 1/3
    expect(historicalSuccessFactor(0, 1)).toBeCloseTo(1 / 3, 5);
    // one completion: rate 1, n 1 → (1·1 + 0.5·2)/(1+2) = 2/3
    expect(historicalSuccessFactor(1, 1)).toBeCloseTo(2 / 3, 5);
  });

  it('converges toward the raw rate as evidence accumulates', () => {
    // rate 0.8 pulled toward 0.5 by k=2 pseudo-obs, less and less as n grows.
    expect(historicalSuccessFactor(0.8, 5)).toBeCloseTo((0.8 * 5 + 1) / 7, 5); // ≈0.714
    expect(historicalSuccessFactor(0.8, 100)).toBeCloseTo((0.8 * 100 + 1) / 102, 5); // ≈0.794
    // large n: within a hair of the raw rate
    expect(historicalSuccessFactor(0.8, 10000)).toBeCloseTo(0.8, 3);
  });

  it('a genuinely failing task is pulled off 0 by the prior but stays low', () => {
    // rate 0, n 3 → (0·3 + 1)/(3+2) = 0.2 (was 0.0 pre-R6)
    expect(historicalSuccessFactor(0, 3)).toBeCloseTo(0.2, 5);
    expect(historicalSuccessFactor(0, 3)).toBeGreaterThan(0);
    expect(historicalSuccessFactor(0, 3)).toBeLessThan(0.5);
  });

  it('exposes k as a named constant (task 17 reaches it to swap the prior source)', () => {
    expect(HISTORICAL_SUCCESS_PRIOR_K).toBe(2);
  });

  it('clamps an out-of-range rate before shrinking, so the result stays in [0,1]', () => {
    // rate clamps to 1 first: (1·2 + 1)/(2+2) = 0.75
    expect(historicalSuccessFactor(1.5, 2)).toBeCloseTo(0.75, 5);
    // rate clamps to 0 first: (0·2 + 1)/(2+2) = 0.25
    expect(historicalSuccessFactor(-0.2, 2)).toBeCloseTo(0.25, 5);
    // a negative attempt count is treated as no history → the pure prior
    expect(historicalSuccessFactor(0.9, -5)).toBe(0.5);
  });
});

describe('weightedSum', () => {
  it('is the dot product of factors and weights', () => {
    const factors: FactorBreakdown = {
      importance: 1,
      urgency: 1,
      energyMatch: 1,
      historicalSuccess: 1,
    };
    expect(weightedSum(factors)).toBeCloseTo(1.0);
  });

  it('is 0 when all factors are 0', () => {
    expect(
      weightedSum({
        importance: 0,
        urgency: 0,
        energyMatch: 0,
        historicalSuccess: 0,
      }),
    ).toBe(0);
  });

  it('weights importance at 31% and the other three at 23% each (task 10, R3)', () => {
    const onlyImportance: FactorBreakdown = {
      importance: 1,
      urgency: 0,
      energyMatch: 0,
      historicalSuccess: 0,
    };
    const onlyHistorical: FactorBreakdown = {
      importance: 0,
      urgency: 0,
      energyMatch: 0,
      historicalSuccess: 1,
    };
    expect(weightedSum(onlyImportance)).toBeCloseTo(0.31);
    expect(weightedSum(onlyHistorical)).toBeCloseTo(0.23);
  });
});
