// Task 10, R3 — the context/tool hard pre-filter (spec §5.1 fork 4, resolved: filter, not
// weight). A task whose context_tags aren't satisfied by the current session, or whose
// tool_requirements aren't all present, is unrankable right now — not merely down-weighted —
// so this runs at the selection boundary BEFORE scoring, not as one of the summed factors (see
// ./factors.ts's FACTOR_WEIGHTS, which no longer carries contextFit).
//
// The filter RETAINS its rejects rather than discarding them: R4 (a separate, later trigger —
// out of scope here) scans the filtered-out set at app open to catch tasks buried out of
// context/tool reach. Callers that just want a scoreable pool can ignore `.rejected`; callers
// building the buried-task scan need it. An empty `.eligible` pool is the caller's cue to route
// to the existing §8.1 "no available tasks" coaching path — that dispatch is task 11 territory,
// not built here.

import type { TaskWithNeglect } from '../db/repositories/tasks';
import type { SessionCheckIn } from './score';

/** A task dropped by the hard filter, with enough detail for R4's later coaching conversation
 *  to distinguish "wrong context" from "missing tool" (and which ones). */
export interface FilterReject {
  item: TaskWithNeglect;
  /** Context tags the task requires that this session doesn't have. Non-empty iff context-blocked. */
  missingContexts: readonly string[];
  /** Tools the task requires that this session doesn't have. Non-empty iff tool-blocked. */
  missingTools: readonly string[];
}

export interface FilterResult {
  /** The pool that passed the hard filter — safe to hand to scoreTasks/rankWithContextNovelty. */
  eligible: TaskWithNeglect[];
  /** Everything dropped, retained (not discarded) so a later trigger can read it. */
  rejected: FilterReject[];
}

function missingEntries(required: readonly string[], available: readonly string[]): string[] {
  if (required.length === 0) return []; // no requirement → nothing missing (flexible)
  const have = new Set(available);
  return required.filter((entry) => !have.has(entry));
}

/**
 * Partitions a neglect-annotated pool into what the current session can actually attempt vs.
 * what it can't, by exact tag match against `checkIn.contexts` / `checkIn.tools` (mirrors the
 * extraction vocabulary's normalized tags — case-sensitive, same as the former contextFitFactor).
 * A task with no context_tags and no tool_requirements always passes (context/tool-flexible).
 */
export function filterBySessionCapability(
  items: readonly TaskWithNeglect[],
  checkIn: SessionCheckIn,
): FilterResult {
  const eligible: TaskWithNeglect[] = [];
  const rejected: FilterReject[] = [];

  for (const item of items) {
    const missingContexts = missingEntries(item.task.contextTags, checkIn.contexts);
    const missingTools = missingEntries(item.task.toolRequirements, checkIn.tools);
    if (missingContexts.length === 0 && missingTools.length === 0) {
      eligible.push(item);
    } else {
      rejected.push({ item, missingContexts, missingTools });
    }
  }

  return { eligible, rejected };
}
