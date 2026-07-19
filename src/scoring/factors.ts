// Task 9 — Scoring factors (spec §5.1). Pure, deterministic, side-effect-free functions that
// each map one task/session signal to a normalized [0,1] factor value, plus the weighted sum
// that combines them. The uncapped neglect multiplier (§5.2) is applied SEPARATELY, downstream
// of this weighted sum (see ../scoring/score.ts) — it is NOT one of the summed weights (§5.1:
// "Neglect is not one of the summed weights").
//
// Design notes flagged for Fable's composition review (task 10) are marked `REVIEW(task10)`.
// Every factor returns a value in [0,1]; since the weights sum to 1.0 the weighted sum is also
// in [0,1], which keeps the neglect multiplier the sole source of unbounded growth.

import { userToInternalEnergy, type UserEnergy } from '../types/scales';

/** Default weights (spec §5.1). Fractions of 1.0, not percentages, so the weighted sum lands
 *  in [0,1] directly. These are the *seeded* weights; the numeric-learning loop (§5.4, task 17)
 *  tunes them later — scoring reads them as data, never hard-codes the numbers at call sites.
 *
 *  Task 10, R3: `contextFit` left this set — a task the user cannot physically do right now
 *  (wrong context, missing tool) is unrankable, not merely down-weighted, so context/tools are
 *  now a hard pre-filter at the selection boundary (see ./filter.ts) instead of a soft weight.
 *  The freed 15% redistributes evenly across the remaining four (25/20/20/20 + 15/4 each). */
export const FACTOR_WEIGHTS = {
  importance: 0.31,
  urgency: 0.23,
  energyMatch: 0.23,
  historicalSuccess: 0.23,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;

/** Internal-importance midpoint used when a task has no importance recorded — mirrors the
 *  extraction mapper's DEFAULT_IMPORTANCE_INTERNAL (500) so a null here scores as a neutral 0.5
 *  rather than zeroing the whole factor. */
export const DEFAULT_IMPORTANCE_INTERNAL = 500;

/** How many days out a due date stops contributing time-urgency. A task due today (or overdue)
 *  is maximally urgent; one due >= this many days out gets no *time* urgency (only its base
 *  sensitivity floor). REVIEW(task10): 14d is a reasoned starting horizon, not a measured one. */
export const URGENCY_HORIZON_DAYS = 14;

/** Smoothing strength for the cold-start prior on `historicalSuccessFactor` (spec §5.4 / task 10
 *  R6). `k` is the number of pseudo-observations the 0.5 prior is worth: the factor is
 *  `(rate·n + 0.5·k)/(n + k)`, so the first real observation moves the value by `1/(1+k)` off the
 *  prior instead of all the way to 0 or 1. k=2 lands the first skip at 0.33 and the first
 *  completion at 0.67, converging to the raw rate as n grows. This is the DEGENERATE form of
 *  §5.4's hierarchical shrinkage — task 17 replaces the prior's *source* (fixed 0.5 → a learned
 *  global/parent prior), NOT this formula, so the constant is named for 17 to reach. */
export const HISTORICAL_SUCCESS_PRIOR_K = 2;

/** The prior mean the k pseudo-observations above carry — a neutral 0.5 (neither reliably done nor
 *  reliably skipped). Task 17 later swaps this fixed value for a learned prior; the shape stays. */
export const HISTORICAL_SUCCESS_PRIOR_MEAN = 0.5;

/** The most that `urgency_level` (the optional base sensitivity, spec §4.1) can contribute on
 *  its own to a deadline-less task's urgency. Kept deliberately small: a task with no due date
 *  should lean on importance + the neglect fail-safe to surface, not on a manufactured urgency.
 *  REVIEW(task10): honors the spec's "plus an optional base sensitivity" language conservatively;
 *  the alternative (drop urgency_level from v1 entirely) is the other defensible call. */
export const BASE_SENSITIVITY_CEILING = 0.15;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Importance factor: full internal importance (1–1000) projected to [0,1] (spec §5.1 uses the
 * internal scale, never the 1–10 display projection). A null importance defaults to the neutral
 * midpoint rather than 0.
 */
export function importanceFactor(importance: number | null): number {
  const internal = importance == null ? DEFAULT_IMPORTANCE_INTERNAL : importance;
  return clamp01(internal / 1000);
}

/**
 * Urgency factor, DERIVED from `nextDueAt` at scoring time (spec §4.1: "Urgency is derived, not
 * stored static"), blended with the optional base sensitivity `urgencyLevel` (1–5).
 *
 * - Overdue or due today → 1.
 * - Due within the horizon → linear proximity ramp (closer = higher).
 * - Due beyond the horizon, or no due date at all → falls back to the base-sensitivity floor.
 *
 * `now` is injected (ms since epoch) so scoring is deterministic and testable — never reads the
 * wall clock itself. Dates are compared in UTC calendar-day terms, matching dueSpec.ts.
 */
export function urgencyFactor(
  nextDueAt: string | null,
  urgencyLevel: number,
  now: number,
): number {
  // Base sensitivity floor: urgency_level 1→0 … 5→BASE_SENSITIVITY_CEILING.
  const baseFloor = clamp01((urgencyLevel - 1) / 4) * BASE_SENSITIVITY_CEILING;

  if (nextDueAt == null) return baseFloor;

  const dueMs = Date.parse(nextDueAt);
  if (Number.isNaN(dueMs)) return baseFloor; // unparseable due date is treated as "no signal"

  const daysUntil = (dueMs - now) / MS_PER_DAY;
  if (daysUntil <= 0) return 1;

  const proximity = clamp01(1 - daysUntil / URGENCY_HORIZON_DAYS);
  return Math.max(proximity, baseFloor);
}

/**
 * Energy-match factor: how well the task's energy requirement fits the current session's
 * energy check-in (spec §5.1 "Energy match" / §6.2 low/med/high check-in). The check-in is a
 * user-facing low/med/high value, projected here through scales.ts to internal 1/3/5; the task
 * carries internal energy (1–5). Match falls off linearly with distance (max distance 4).
 *
 * REVIEW(task10): the distance is symmetric — a high-energy session doing a low-energy task is
 * penalized as much as the reverse. That's defensible (spend the energy you have on matching
 * work) but the asymmetric alternative (high energy can always "afford" low-energy tasks) is a
 * real design fork worth a second opinion.
 */
export function energyMatchFactor(
  sessionEnergy: UserEnergy,
  taskEnergyRequirement: number,
): number {
  const sessionInternal = userToInternalEnergy(sessionEnergy); // 1 | 3 | 5
  const distance = Math.abs(sessionInternal - taskEnergyRequirement);
  return clamp01(1 - distance / 4);
}

/**
 * Historical-success factor (spec §5.1 "Historical success rate"). `successRate` is
 * completion / (completion + skip) — but a task with *few attempts yet* has a rate dominated by
 * noise (one skip → 0.0, one completion → 1.0), which is ±0.115 of the base score decided by a
 * single event on the 23% weight. Task 10 R6 replaces the old hard `n≤0 → 0.5, else raw` branch
 * with Bayesian shrinkage toward a neutral prior:
 *
 *     (successRate·n + PRIOR_MEAN·k) / (n + k),   k = HISTORICAL_SUCCESS_PRIOR_K
 *
 * The old cold-start branch falls out of the same expression (n=0 → PRIOR_MEAN = 0.5), so it is
 * gone rather than kept alongside. First skip → 0.33, first completion → 0.67, converging to the
 * raw rate as evidence accumulates.
 *
 * REVIEW(task17): PRIOR_MEAN is a fixed 0.5 stand-in for §5.4's hierarchical prior; task 17
 * replaces the prior's *source* (a learned global/parent rate), not this formula.
 */
export function historicalSuccessFactor(successRate: number, attemptCount: number): number {
  const n = Math.max(0, attemptCount); // a negative count is meaningless; treat as no history
  const k = HISTORICAL_SUCCESS_PRIOR_K;
  const shrunk =
    (clamp01(successRate) * n + HISTORICAL_SUCCESS_PRIOR_MEAN * k) / (n + k);
  return clamp01(shrunk);
}

export interface FactorBreakdown {
  importance: number;
  urgency: number;
  energyMatch: number;
  historicalSuccess: number;
}

/**
 * The weighted sum of the four scored factors (spec §5.1, as revised by task 10 R3) — the
 * "base score" BEFORE the neglect multiplier is applied. In [0,1] because every factor is in
 * [0,1] and the weights sum to 1.0. Context/tool fit is no longer summed here — see
 * ./filter.ts's hard pre-filter (task 10, R3).
 */
export function weightedSum(factors: FactorBreakdown): number {
  return (
    FACTOR_WEIGHTS.importance * factors.importance +
    FACTOR_WEIGHTS.urgency * factors.urgency +
    FACTOR_WEIGHTS.energyMatch * factors.energyMatch +
    FACTOR_WEIGHTS.historicalSuccess * factors.historicalSuccess
  );
}
