// Task 41 — the `planning` stream.
//
// TASK IDS ONLY, NEVER TITLES. That is what keeps this stream genuinely structured and lets it
// survive open beta (design §5.7) — a reject set annotated with task titles would be free text
// wearing a structured label, which is exactly the silent expiry task 42's brief warns about.
//
// ⚠ ONE THING HERE IS NOT FREE, AND IT IS FLAGGED RATHER THAN BURIED. Brief §6 says
// `runSelectionBoundary` "already returns eligible, capabilityRejects and dependencyRejects — it
// just never persists them", and that is true — but `eligible` is `TaskWithNeglect[]`, which
// carries the neglect read and NOT the four per-factor scores brief §2 asks for. Those are
// computed later, inside `planSession`, and `SessionPlan` does not surface them.
//
// So there were three options and none of them is free:
//   (a) widen `SessionPlan` to carry `ScoredTask[]` — changing a product type for capture's
//       benefit, which is the diffusion brief §4 forbids;
//   (b) record the boundary without factors — a permanent hole in a one-shot collection window,
//       in exactly the data tasks 17 and 31 want;
//   (c) call `scoreTasks` here, on the boundary's own output.
//
// (c) is taken. `scoreTasks` is PURE and DETERMINISTIC — it takes no rng (the novelty jitter is a
// separate opt-in pass) and injects `now` — so on the same pool, check-in and clock it returns
// exactly the numbers the ranker went on to use. This is a second INVOCATION of the one scorer,
// not a second scorer: nothing is re-derived or re-implemented here, and if `scoreTasks` changes,
// this changes with it. The cost accepted is one extra pass over an already-filtered pool at the
// selection boundary, which happens once per plan or replan.

import { scoreTasks, type SessionCheckIn } from '../../scoring/score';
import type { SelectionBoundaryResult } from '../../planning/planner';
import type { SessionPlan } from '../../planning/agenda';
import type { SessionType } from '../../types/db';
import { record } from '../record';

export function recordSelectionBoundary(
  boundary: SelectionBoundaryResult,
  checkIn: SessionCheckIn,
  sessionType: SessionType,
  now: number,
): void {
  const scored = scoreTasks(boundary.eligible, checkIn, now);
  record({
    stream: 'planning',
    type: 'selection_boundary',
    poolSize:
      boundary.eligible.length +
      boundary.capabilityRejects.length +
      boundary.dependencyRejects.length,
    eligible: scored.map((item) => ({
      taskId: item.task.id,
      factors: {
        ...item.factors,
        baseScore: item.baseScore,
        // Uncapped by design (constraint #5) — recorded raw so a future analysis can see the
        // fail-safe actually working rather than a clamped number.
        neglectMultiplier: item.neglectMultiplier,
      },
      score: item.finalScore,
    })),
    // The reject reasons are reduced to structural labels plus the missing entries, which are
    // context/tool NAMES the user chose. Those are a vocabulary, not prose, and the stream stays
    // structured — but they are the one field here a future reviewer should look at twice.
    capabilityRejects: boundary.capabilityRejects.map((reject) => ({
      taskId: reject.item.task.id,
      reason: [
        reject.missingContexts.length > 0 ? `missingContexts:${reject.missingContexts.join('|')}` : '',
        reject.missingTools.length > 0 ? `missingTools:${reject.missingTools.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    })),
    dependencyRejects: boundary.dependencyRejects.map((reject) => ({
      taskId: reject.item.task.id,
      blockedBy: [...reject.blockedBy],
      reason: reject.pendingBreakdownComplete ? 'pending_breakdown_complete' : 'dependency_blocked',
    })),
    checkIn: {
      sessionType,
      energy: checkIn.energy,
      contexts: [...checkIn.contexts],
      tools: [...checkIn.tools],
    },
  });
}

export function recordPlan(
  type: 'plan' | 'replan',
  plan: SessionPlan,
  replanReason?: string,
): void {
  record({
    stream: 'planning',
    type,
    agenda: plan.items.map((item) => ({
      taskId: item.kind === 'task' ? item.task.id : undefined,
      kind: item.kind,
      plannedMinutes: item.plannedMinutes,
      deepFocus: item.kind === 'task' ? item.deepFocus : undefined,
    })),
    outcome: plan.outcome,
    replanReason,
  });
}
