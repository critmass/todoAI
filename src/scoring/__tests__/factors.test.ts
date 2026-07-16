import {
  BASE_SENSITIVITY_CEILING,
  DEFAULT_IMPORTANCE_INTERNAL,
  FACTOR_WEIGHTS,
  URGENCY_HORIZON_DAYS,
  contextFitFactor,
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

  it('matches the spec §5.1 default weights', () => {
    expect(FACTOR_WEIGHTS).toEqual({
      importance: 0.25,
      urgency: 0.2,
      energyMatch: 0.2,
      contextFit: 0.15,
      historicalSuccess: 0.2,
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

describe('contextFitFactor', () => {
  it('is 1 for a context-flexible task (no tags)', () => {
    expect(contextFitFactor(['home'], [])).toBe(1);
    expect(contextFitFactor([], [])).toBe(1);
  });

  it('is the fraction of the task tags available this session', () => {
    expect(contextFitFactor(['computer'], ['computer'])).toBe(1);
    expect(contextFitFactor(['computer'], ['computer', 'quiet'])).toBe(0.5);
    expect(contextFitFactor(['home'], ['computer', 'quiet'])).toBe(0);
  });

  it('does not exceed 1 when the session offers more than the task needs', () => {
    expect(contextFitFactor(['home', 'computer', 'quiet'], ['home'])).toBe(1);
  });

  it('matches tags exactly (case-sensitive)', () => {
    expect(contextFitFactor(['Home'], ['home'])).toBe(0);
  });
});

describe('historicalSuccessFactor', () => {
  it('returns a neutral prior for a task with no attempts (cold start)', () => {
    expect(historicalSuccessFactor(0, 0)).toBe(0.5);
  });

  it('returns the recorded rate once there is history', () => {
    expect(historicalSuccessFactor(0.8, 5)).toBeCloseTo(0.8);
    expect(historicalSuccessFactor(0, 3)).toBe(0); // genuinely failing task
  });

  it('clamps to [0,1]', () => {
    expect(historicalSuccessFactor(1.5, 2)).toBe(1);
    expect(historicalSuccessFactor(-0.2, 2)).toBe(0);
  });
});

describe('weightedSum', () => {
  it('is the dot product of factors and weights', () => {
    const factors: FactorBreakdown = {
      importance: 1,
      urgency: 1,
      energyMatch: 1,
      contextFit: 1,
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
        contextFit: 0,
        historicalSuccess: 0,
      }),
    ).toBe(0);
  });

  it('weights importance at 25% and context fit at 15%', () => {
    const onlyImportance: FactorBreakdown = {
      importance: 1,
      urgency: 0,
      energyMatch: 0,
      contextFit: 0,
      historicalSuccess: 0,
    };
    const onlyContext: FactorBreakdown = {
      importance: 0,
      urgency: 0,
      energyMatch: 0,
      contextFit: 1,
      historicalSuccess: 0,
    };
    expect(weightedSum(onlyImportance)).toBeCloseTo(0.25);
    expect(weightedSum(onlyContext)).toBeCloseTo(0.15);
  });
});
