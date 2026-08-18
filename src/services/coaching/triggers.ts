// Task 12 — the three coaching triggers (spec §7.2) mapped onto coaching_queue's urgency tiers,
// plus enqueueing. The three spec-pinned triggers:
//   • any single skip          → 'task_skipped'          → urgency 'next_start' (non-blocking follow-up)
//   • 3 skips within a session  → 'session_recalibration' → urgency 'immediate'  (stop, recalibrate now)
//   • app unopened 5+ days      → 'app_reorientation'     → urgency 'next_open'  (re-orient before dashboard)
// Enqueue is the whole job here; running the conversation + resolution is the dispatcher's.

import type { CoachingRepository } from '../../db/repositories/coaching';
import type { CoachingQueueEntry } from '../../types/domain';
import type { CoachingTrigger, CoachingUrgency } from '../../types/db';
import { record } from '../../capture';

/**
 * Urgency tier for a coaching trigger. The three original §7.2 triggers are spec-pinned; R4 and
 * R7 (migration 002) add a fourth and fifth row (task10_fable_review_report.md R4;
 * postreview_scoring_task_25.md R7); the rest get reasonable defaults documented here and
 * flagged for review:
 *   session_ended_early / task_ended_early → next_start (a gentle follow-up, like a skip)
 *   repeated_failures                      → immediate  (a stronger recalibration signal)
 *   pattern_detected                       → next_open  (surfaced on next open, not mid-flow)
 *   buried_task (R4)                       → next_open  (the scan runs "at app open"; the
 *                                             due-soon variant can override via `urgency` at
 *                                             enqueue time - task 19 is the actual caller)
 *   breakdown_complete (R7)                → immediate  (spec-pinned: "fires with
 *                                             urgency = 'immediate'" - task 25 is the caller)
 */
export function urgencyForTrigger(trigger: CoachingTrigger): CoachingUrgency {
  switch (trigger) {
    case 'task_skipped':
      return 'next_start';
    case 'session_recalibration':
      return 'immediate';
    case 'app_reorientation':
      return 'next_open';
    case 'session_ended_early':
    case 'task_ended_early':
      return 'next_start';
    case 'repeated_failures':
      return 'immediate';
    case 'pattern_detected':
      return 'next_open';
    case 'buried_task':
      return 'next_open';
    case 'breakdown_complete':
      return 'immediate';
  }
}

export interface EnqueueCoachingInput {
  trigger: CoachingTrigger;
  /** Freeform trigger context persisted on the queue row (e.g. { skipCount: 3 }). */
  triggerData?: Record<string, unknown>;
  /** Tasks this coaching is about — linked via coaching_tasks. */
  relatedTaskIds?: number[];
  /** Sessions this coaching is about — linked via coaching_sessions. */
  relatedSessionIds?: string[];
  /** Override the default urgency for this trigger (rare; the mapping above is the norm). */
  urgency?: CoachingUrgency;
}

/**
 * Enqueues a coaching trigger at its urgency tier and links any related tasks/sessions. Returns
 * the created queue entry. The queue is drained by the app-launch/session flow (spec §6.1/§6.2),
 * ordered urgency-first via the coaching_priority_queue view.
 */
export async function enqueueCoachingTrigger(
  coaching: Pick<CoachingRepository, 'create' | 'linkTask' | 'linkSession'>,
  input: EnqueueCoachingInput,
): Promise<CoachingQueueEntry> {
  const entry = await coaching.create({
    triggerType: input.trigger,
    urgency: input.urgency ?? urgencyForTrigger(input.trigger),
    triggerData: input.triggerData,
  });

  // TASK 41 — the `coaching` stream's `enqueued` record. Here rather than at the four callers
  // because this is the single place a queue row is created, so a new trigger cannot be added
  // without appearing in the log. `trigger_data.kind` is recorded separately from the trigger TYPE
  // (constraint #12: `repeated_extension` and `long_extend` are data on `pattern_detected`, not
  // trigger types of their own).
  record({
    stream: 'coaching',
    type: 'enqueued',
    trigger: entry.triggerType,
    triggerKind: typeof input.triggerData?.kind === 'string' ? input.triggerData.kind : undefined,
    queueEntryId: entry.id,
    urgency: entry.urgency,
    candidateTaskIds: input.relatedTaskIds,
  });

  for (const taskId of input.relatedTaskIds ?? []) {
    await coaching.linkTask(entry.id, taskId);
  }
  for (const sessionId of input.relatedSessionIds ?? []) {
    await coaching.linkSession(entry.id, sessionId);
  }

  return entry;
}
