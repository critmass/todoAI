// Barrel export for the scoring layer (task 9: spec §5.1–5.2). Pure logic over the data layer —
// no LLM, no persistence. See ./factors.ts (per-factor math + weighted sum) and ./score.ts
// (final score with the uncapped-neglect floor, plus ranking).
export {
  FACTOR_WEIGHTS,
  DEFAULT_IMPORTANCE_INTERNAL,
  URGENCY_HORIZON_DAYS,
  BASE_SENSITIVITY_CEILING,
  importanceFactor,
  urgencyFactor,
  energyMatchFactor,
  contextFitFactor,
  historicalSuccessFactor,
  weightedSum,
  type FactorName,
  type FactorBreakdown,
} from './factors';

export {
  neglectCurve,
  scoreTask,
  scoreTasks,
  rankWithContextNovelty,
  type SessionCheckIn,
  type ScoredTask,
  type Rng,
} from './score';
