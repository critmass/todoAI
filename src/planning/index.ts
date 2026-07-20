// Barrel export for the session planner (task 11: spec §5.3, task 28 design §3/§4/§10).
// Deterministic — no LLM in v1 (the sanctioned seam is service.ts's PlanAdjustment hook).
// The plan is HIDDEN from the user (spec §2.2/§6.2): consumers walk it one item at a time.

export {
  plannedMinutes,
  isPlaceableInBlock,
  placementFloorMinutes,
  treatedAsOpenEnded,
} from './plannedMinutes';

export {
  planRequiredTools,
  firstWorkableWithTools,
  type AgendaItem,
  type AgendaTaskItem,
  type AgendaBreakItem,
  type BlockKind,
  type PlanOutcome,
  type SessionPlan,
} from './agenda';

export {
  planSession,
  replanRemaining,
  runSelectionBoundary,
  DEEP_FOCUS_OVERRUN_BUFFER,
  DEEP_FOCUS_BLOCK_FRACTION,
  DEEP_FOCUS_MIN_SESSION_MINUTES,
  DEEP_FOCUS_MAJOR_MIN_MINUTES,
  BREAK_MINUTES,
  LONG_STRETCH_BREAK_FIRST_MINUTES,
  EASIER_MAX_ITEM_MINUTES,
  DIFFICULTY_JITTER,
  type PlanRequest,
  type ReplanOptions,
  type SelectionBoundaryResult,
} from './planner';

export {
  loadSelectionBoundary,
  planSessionFromRepositories,
  replanRemainingFromRepositories,
  type PlanningRepositories,
  type PlanAdjustment,
} from './service';
