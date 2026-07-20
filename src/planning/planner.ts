// Task 11 — the deterministic session planner (spec §5.3, task 28 design §3/§4/§10). Pure logic
// over the scoring layer: no LLM (Jason's ruling — deterministic v1 with a seam, see
// ./service.ts), no persistence, injected `now` and `rng`.
//
// ── THE SELECTION BOUNDARY (spec §5.3, U1/U5 — review-checklist item, load-bearing) ──────────
// Order of operations, non-negotiable:
//
//   listActiveByNeglect()                    (caller — see ./service.ts)
//     → filterBySessionCapability()          context/tools, R3
//     → filterDependencyBlocked()            unresolved deps + R7c breakdown-confirmation holds
//     → scoreTasks() / rankWithContextNovelty()
//     → arrange into an agenda
//
// BOTH hard pre-filters run before EITHER ranker ever sees the pool — the rankers require a
// pre-filtered pool (their doc comments state it; nothing type-level enforces it, so this
// boundary is the enforcement). Both filters RETAIN their rejects and this module carries them
// through to the caller: spec §8.1's "no available tasks" coaching and R4's buried-task scan
// read them. `filterDependencyBlocked`'s THIRD argument (pendingBreakdownComplete) is wired
// here — this is what closes task 25's R7 hold seam: without it a parent whose last subtask
// just completed could be served before the user confirms it is actually done.

import type { TaskWithNeglect } from '../db/repositories/tasks';
import type { SessionType } from '../types/db';
import type { UserEnergy } from '../types/scales';
import {
  contextGroupKey,
  rankWithContextNovelty,
  scoreTasks,
  type Rng,
  type ScoredTask,
  type SessionCheckIn,
} from '../scoring/score';
import {
  filterBySessionCapability,
  filterDependencyBlocked,
  type DependencyReject,
  type FilterReject,
} from '../scoring/filter';
import { isPlaceableInBlock, plannedMinutes, treatedAsOpenEnded } from './plannedMinutes';
import type { AgendaItem, AgendaTaskItem, SessionPlan } from './agenda';

// ── Tunables (named constants, spec §5.3) ────────────────────────────────────────────────────

/** §5.3.1: fraction of a deep-focus block deliberately NOT planned as work, absorbing estimate
 *  overrun — a 60-minute block plans ~45 minutes of work. Applies to countdown sizing only; an
 *  open block has no estimate to overrun (see ./plannedMinutes.ts). */
export const DEEP_FOCUS_OVERRUN_BUFFER = 0.25;

/** Fraction of the session reserved (at the END, §5.3.1) for the deep-focus block. 2/3 so a
 *  90-minute session yields a 60-minute block — the smallest session that can host an
 *  "at least an hour" floor task. */
export const DEEP_FOCUS_BLOCK_FRACTION = 2 / 3;

/** Sessions shorter than this get no deep-focus block at all (and therefore no resume claim —
 *  task 28 design §3.3.4: you don't re-enter a three-hour project in a ten-minute session). */
export const DEEP_FOCUS_MIN_SESSION_MINUTES = 45;

/** What counts as a "major task" for deep-focus allocation (§5.3.1's "1–2 major tasks"):
 *  planned minutes at or above this, or any open-ended task. */
export const DEEP_FOCUS_MAJOR_MIN_MINUTES = 25;

/** Length of a natural break at a context switch (§5.3.4). Never inside a deep-focus block;
 *  quick sessions get none. */
export const BREAK_MINUTES = 5;

/** §5.3.4 / task 28 §4.2: a work stretch at or beyond this places a break FIRST in whatever
 *  agenda follows it (the break-first rule; holds regardless of the §4.3 guardrail ruling). */
export const LONG_STRETCH_BREAK_FIRST_MINUTES = 50;

/** Escape-valve "shorter estimates" (§5.3.5): easier replans only serve tasks whose planned
 *  minutes are at or under this. */
export const EASIER_MAX_ITEM_MINUTES = 25;

/** Randomness amplitude of the within-group difficulty gradient (±, on the internal 1–5 energy
 *  scale). Big enough that adjacent difficulties genuinely swap run-to-run (novelty is the
 *  point), small enough that the easy→hard slope survives. */
export const DIFFICULTY_JITTER = 1.5;

// ── The selection boundary ───────────────────────────────────────────────────────────────────

export interface SelectionBoundaryResult {
  /** Survived BOTH hard pre-filters — the only pool either ranker may see. */
  eligible: TaskWithNeglect[];
  capabilityRejects: FilterReject[];
  dependencyRejects: DependencyReject[];
}

/**
 * Runs the two hard pre-filters in their required order and retains both reject sets. The two
 * blocking signals are precomputed by the caller (repository reads — see ./service.ts):
 * `unresolvedBlockers` from dependencies.listUnresolvedBlockersForActiveTasks(), and
 * `pendingBreakdownComplete` from pendingBreakdownCompleteTaskIds(coaching) — the R7c hold,
 * wired here at last (task 25 report §2).
 */
export function runSelectionBoundary(
  pool: readonly TaskWithNeglect[],
  checkIn: SessionCheckIn,
  unresolvedBlockers: ReadonlyMap<number, readonly number[]>,
  pendingBreakdownComplete: ReadonlySet<number>,
): SelectionBoundaryResult {
  const capability = filterBySessionCapability(pool, checkIn);
  const dependency = filterDependencyBlocked(
    capability.eligible,
    unresolvedBlockers,
    pendingBreakdownComplete,
  );
  return {
    eligible: dependency.eligible,
    capabilityRejects: capability.rejected,
    dependencyRejects: dependency.rejected,
  };
}

// ── Requests and options ─────────────────────────────────────────────────────────────────────

export interface PlanRequest {
  sessionType: SessionType;
  /** Total wall minutes to plan (Quick ≤10 / Moderate ≤45 / Deep Focus ≥60 — supplied by the
   *  session-start flow; the planner does not derive it from the type). */
  sessionMinutes: number;
  checkIn: SessionCheckIn;
}

export interface ReplanOptions {
  /** Escape valve (§5.3.5): lower effective energy one step, only short items
   *  (≤ EASIER_MAX_ITEM_MINUTES), no deep-focus block. Contexts stay the session's own —
   *  "same-or-easier" means no NEW context is ever required. */
  easier?: boolean;
  /** Minutes of the work stretch that just ended (extend/break-overrun callers). At or beyond
   *  LONG_STRETCH_BREAK_FIRST_MINUTES the regenerated agenda opens with a break. */
  precededByStretchMinutes?: number;
  /** Tasks already served this session (completed/parked/skipped) — never re-planned into the
   *  tail. Completed one-offs leave the active pool on their own; this covers the rest. */
  excludeTaskIds?: ReadonlySet<number>;
}

interface BuildFlags {
  allowResumeClaim: boolean;
  allowDeepFocus: boolean;
  easier: boolean;
  breakFirst: boolean;
  excludeTaskIds: ReadonlySet<number>;
}

// ── Public entry points ──────────────────────────────────────────────────────────────────────

/**
 * Plans a fresh session: selection boundary output in, hidden ordered agenda out (spec §5.3).
 * Deterministic given (`now`, `rng`) — no LLM call, no wall-clock read, no persistence.
 */
export function planSession(
  boundary: SelectionBoundaryResult,
  request: PlanRequest,
  now: number,
  rng: Rng = Math.random,
): SessionPlan {
  return buildAgenda(boundary, request, now, rng, {
    allowResumeClaim: true,
    allowDeepFocus: true,
    easier: false,
    breakFirst: false,
    excludeTaskIds: new Set<number>(),
  });
}

/**
 * Regenerates the REMAINING agenda for whatever session time is left — never shifts or shrinks
 * the old tail (task 28 design §4.2: a shifted tail is stale, and the plan is hidden anyway).
 * Three callers share this primitive (§5.3.5, §8.2, task 28 §4.2):
 *   1. the escape valve (`easier: true`) — does not end the session, replans what remains;
 *   2. break overrun — a long break re-plans the remaining time, no guilt;
 *   3. extend — when an extended stretch ends, the tail is regenerated (pass
 *      `precededByStretchMinutes` so a ≥50-minute stretch gets its break first).
 * No resume claim on replans: first refusal on the deep-focus block is a session-START
 * affordance; mid-session, a just-parked task must not be immediately re-served.
 * `remainingMinutes ≤ 0` returns an empty planned agenda (caller goes to summary).
 */
export function replanRemaining(
  boundary: SelectionBoundaryResult,
  request: Omit<PlanRequest, 'sessionMinutes'>,
  remainingMinutes: number,
  now: number,
  rng: Rng = Math.random,
  options: ReplanOptions = {},
): SessionPlan {
  const easier = options.easier === true;
  return buildAgenda(
    boundary,
    { ...request, sessionMinutes: Math.max(0, remainingMinutes) },
    now,
    rng,
    {
      allowResumeClaim: false,
      allowDeepFocus: !easier,
      easier,
      breakFirst:
        (options.precededByStretchMinutes ?? 0) >= LONG_STRETCH_BREAK_FIRST_MINUTES &&
        remainingMinutes > 0,
      excludeTaskIds: options.excludeTaskIds ?? new Set<number>(),
    },
  );
}

// ── The core ─────────────────────────────────────────────────────────────────────────────────

function lowerEnergy(energy: UserEnergy): UserEnergy {
  if (energy === 'high') return 'med';
  return 'low';
}

function buildAgenda(
  boundary: SelectionBoundaryResult,
  request: PlanRequest,
  now: number,
  rng: Rng,
  flags: BuildFlags,
): SessionPlan {
  const { sessionType, sessionMinutes } = request;
  const checkIn: SessionCheckIn = flags.easier
    ? { ...request.checkIn, energy: lowerEnergy(request.checkIn.energy) }
    : request.checkIn;

  const base = {
    sessionType,
    sessionMinutes,
    capabilityRejects: boundary.capabilityRejects,
    dependencyRejects: boundary.dependencyRejects,
  };

  let pool = boundary.eligible.filter((item) => !flags.excludeTaskIds.has(item.task.id));
  if (flags.easier) {
    // "Shorter estimates": open-ended tasks are the opposite of easier, and long estimates are
    // out. sizing arg is irrelevant for the non-open-ended tasks that survive.
    pool = pool.filter(
      (item) =>
        !treatedAsOpenEnded(item.task) && plannedMinutes(item.task, 0) <= EASIER_MAX_ITEM_MINUTES,
    );
  }

  if (pool.length === 0) {
    return {
      ...base,
      items: [],
      outcome: 'no_eligible_tasks',
      splitCandidate: null,
    };
  }
  if (sessionMinutes <= 0) {
    return { ...base, items: [], outcome: 'planned', splitCandidate: null };
  }

  // ── §5.3.1 deep-focus allocation (end-of-session block, 25% overrun buffer) ────────────────
  const wantDeepBlock =
    flags.allowDeepFocus && sessionMinutes >= DEEP_FOCUS_MIN_SESSION_MINUTES;
  let blockMinutes = wantDeepBlock
    ? Math.round(sessionMinutes * DEEP_FOCUS_BLOCK_FRACTION)
    : 0;
  const workMinutes = Math.floor(blockMinutes * (1 - DEEP_FOCUS_OVERRUN_BUFFER));

  const deepItems: AgendaTaskItem[] = [];
  const taken = new Set<number>();

  if (blockMinutes > 0) {
    // Step 0 — the single-resume claim (task 28 design §3.3): at most ONE in-progress task, the
    // one with the most recent last_worked_at (continuity decays with time away; older parked
    // tasks are championed by their growing neglect multiplier through the ordinary shuffle),
    // takes first refusal on the deep-focus block. Everything else flows through the untouched
    // novelty pipeline below.
    if (flags.allowResumeClaim) {
      const candidates = pool.filter(
        (item) =>
          item.task.workState === 'in_progress' &&
          isPlaceableInBlock(item.task, blockMinutes, workMinutes),
      );
      candidates.sort((a, b) =>
        (b.task.lastWorkedAt ?? '').localeCompare(a.task.lastWorkedAt ?? ''),
      );
      const claim = candidates[0];
      if (claim) {
        deepItems.push(deepFocusItem(claim, blockMinutes, workMinutes, true));
        taken.add(claim.task.id);
      }
    }

    // Ordinary allocation: fill up to 2 major tasks total by STRICT score order (the deep block
    // is the session's centrepiece — deterministic best-first here; novelty lives in the front
    // section's shuffle). An open block owns the whole block, so it must be the first (and only)
    // deep item; once a countdown item is placed, only countdown items follow.
    const blockOwned = deepItems.some((item) => item.blockKind === 'openBlock');
    if (!blockOwned) {
      let workRemaining =
        workMinutes - deepItems.reduce((sum, item) => sum + item.plannedMinutes, 0);
      const ranked = scoreTasks(
        pool.filter((item) => !taken.has(item.task.id)),
        checkIn,
        now,
      );
      for (const scored of ranked) {
        if (deepItems.length >= 2) break;
        const { task } = scored;
        const openEnded = treatedAsOpenEnded(task);
        if (openEnded && deepItems.length > 0) continue; // an open block must own its block
        if (!isPlaceableInBlock(task, blockMinutes, workRemaining)) continue;
        const minutes = plannedMinutes(task, workRemaining);
        const major = openEnded || minutes >= DEEP_FOCUS_MAJOR_MIN_MINUTES;
        if (!major) continue;
        deepItems.push(deepFocusItem({ task }, blockMinutes, workRemaining, false));
        taken.add(task.id);
        if (openEnded) break;
        workRemaining -= minutes;
      }
    }

    // Nothing major to anchor it → dissolve the block into the front section.
    if (deepItems.length === 0) blockMinutes = 0;
  }

  // ── Front section: novelty selection, then arrangement (§5.3.2–5.3.4) ──────────────────────
  const frontGross = sessionMinutes - blockMinutes;
  // Open-ended tasks live ONLY in the deep-focus block: an open block runs to its boundary by
  // design, and a mid-ramp open block would swallow the arrangement around it. (Findings §2.)
  const frontPool = pool.filter(
    (item) => !taken.has(item.task.id) && !treatedAsOpenEnded(item.task),
  );
  const noveltyOrder = rankWithContextNovelty(frontPool, checkIn, now, rng);

  const allowBreaks = sessionType !== 'quick';
  const breakFirstCost = flags.breakFirst ? BREAK_MINUTES : 0;
  const chosen: ScoredTask[] = [];
  for (const scored of noveltyOrder) {
    const tentative = [...chosen, scored];
    const workCost = tentative.reduce((sum, s) => sum + plannedMinutes(s.task, 0), 0);
    const groups = new Set(tentative.map((s) => contextGroupKey(s.task))).size;
    const switchBreaks = allowBreaks ? (groups - 1) * BREAK_MINUTES : 0;
    const preDeepBreak = allowBreaks && blockMinutes > 0 ? BREAK_MINUTES : 0;
    if (workCost + switchBreaks + preDeepBreak + breakFirstCost <= frontGross) {
      chosen.push(scored);
    }
  }

  // Arrangement: group by context; groups ascend by mean energy requirement — the §5.3.3
  // progressive energy ramp toward the deep-focus block (fork 3's "high energy can afford easy
  // tasks" lives HERE: low-energy tasks are in the ranked pool by design and fill the ramp's
  // front; scoring's energy factor stays symmetric). Within a group, a difficulty gradient with
  // real randomness — easier front, harder back (§5.3.2).
  const groupMap = new Map<string, ScoredTask[]>();
  for (const scored of chosen) {
    const key = contextGroupKey(scored.task);
    const group = groupMap.get(key);
    if (group) group.push(scored);
    else groupMap.set(key, [scored]);
  }
  const groups = [...groupMap.values()];
  const meanEnergy = (group: ScoredTask[]): number =>
    group.reduce((sum, s) => sum + s.task.energyRequirement, 0) / group.length;
  const maxScore = (group: ScoredTask[]): number =>
    Math.max(...group.map((s) => s.finalScore));
  groups.sort((a, b) => meanEnergy(a) - meanEnergy(b) || maxScore(b) - maxScore(a));
  for (const group of groups) {
    const jittered = group.map((scored) => ({
      scored,
      key: scored.task.energyRequirement + (rng() * 2 - 1) * DIFFICULTY_JITTER,
    }));
    jittered.sort((a, b) => a.key - b.key);
    group.length = 0;
    group.push(...jittered.map((entry) => entry.scored));
  }

  // ── Emit the agenda ────────────────────────────────────────────────────────────────────────
  const items: AgendaItem[] = [];
  if (flags.breakFirst) items.push({ kind: 'break', plannedMinutes: BREAK_MINUTES });
  groups.forEach((group, index) => {
    if (index > 0 && allowBreaks) items.push({ kind: 'break', plannedMinutes: BREAK_MINUTES });
    for (const scored of group) {
      items.push({
        kind: 'task',
        task: scored.task,
        blockKind: 'countdown',
        plannedMinutes: plannedMinutes(scored.task, 0),
        deepFocus: false,
        resumeClaim: false,
      });
    }
  });
  if (deepItems.length > 0) {
    if (groups.length > 0 && allowBreaks) {
      items.push({ kind: 'break', plannedMinutes: BREAK_MINUTES }); // before, never inside (§5.3.4)
    }
    items.push(...deepItems);
  }

  if (items.every((item) => item.kind !== 'task')) {
    // Eligible tasks exist but none fit the time — a 5-minute session is first-class (§8.2):
    // offer to SPLIT the strongest candidate (via breakdown) rather than ending the session.
    const strongest = scoreTasks(pool, checkIn, now)[0];
    return {
      ...base,
      items: [],
      outcome: 'nothing_fits',
      splitCandidate: strongest ? strongest.task : null,
    };
  }

  return { ...base, items, outcome: 'planned', splitCandidate: null };
}

function deepFocusItem(
  item: Pick<TaskWithNeglect, 'task'>,
  blockMinutes: number,
  workMinutes: number,
  resumeClaim: boolean,
): AgendaTaskItem {
  const openEnded = treatedAsOpenEnded(item.task);
  return {
    kind: 'task',
    task: item.task,
    blockKind: openEnded ? 'openBlock' : 'countdown',
    // An open block's boundary is the block's GROSS minutes (no estimate to buffer); a countdown
    // item plans its (buffered-capacity-checked) remaining estimate.
    plannedMinutes: openEnded ? blockMinutes : plannedMinutes(item.task, workMinutes),
    deepFocus: true,
    resumeClaim,
  };
}
