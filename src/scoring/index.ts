// Barrel export for the scoring layer (task 9: spec §5.1–5.2). Pure logic over the data layer —
// no LLM, no persistence. See ./factors.ts (per-factor math + weighted sum), ./score.ts (final
// score with the uncapped-neglect curve, plus ranking), and ./filter.ts (the context/tool hard
// pre-filter, task 10 R3).
export {
  FACTOR_WEIGHTS,
  DEFAULT_IMPORTANCE_INTERNAL,
  URGENCY_HORIZON_DAYS,
  BASE_SENSITIVITY_CEILING,
  importanceFactor,
  urgencyFactor,
  energyMatchFactor,
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

export { filterBySessionCapability, type FilterReject, type FilterResult } from './filter';
