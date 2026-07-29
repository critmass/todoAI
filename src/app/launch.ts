// Task 24 — what happens when the app opens (spec §6.1), and the one ordering rule that is not
// negotiable:
//
//   `recoverOpenEpisode` RUNS FIRST. ALWAYS. BEFORE ANYTHING ELSE.
//
// Not before the dashboard — before the coaching queue, before any other read, before any screen
// is chosen. An `active_episode` row that outlived the process IS the crash signal (task 13 §2),
// and anything that runs ahead of the recovery can only make decisions against state that has not
// been reconciled yet. Task 13 exists because of the bug that ordering prevents; running the
// recovery late reintroduces it.

import type { CoachingPriorityQueueEntry } from '../types/domain';
import type { CoachingRepository } from '../db/repositories/coaching';
import {
  recoverOpenEpisode,
  type EpisodeServiceDeps,
  type RecoveryDirective,
} from '../execution';

export type LaunchOutcome =
  /** An episode survived a process death. The engine has already closed it as abandoned, credited
   *  the time and left the task active and parked; the directive says which screen to open. */
  | {
      kind: 'recovered';
      sessionId: string;
      directive: RecoveryDirective;
      creditedMinutes: number;
    }
  /** Coaching is waiting and takes priority over the dashboard (spec §6.1). */
  | { kind: 'coaching'; entry: CoachingPriorityQueueEntry }
  | { kind: 'dashboard' };

export interface LaunchDeps {
  episode: EpisodeServiceDeps;
  coaching: Pick<CoachingRepository, 'priorityQueue'>;
  now: () => number;
}

/**
 * Coaching that should interrupt an APP OPEN. `next_start` entries are deliberately excluded —
 * that tier means "the next time a work session starts", which is a different seam and is drained
 * by `pendingAtSessionStart` below. Getting this wrong would put a light post-skip follow-up in
 * front of someone who just opened the app to add a task.
 */
export function pendingAtAppOpen(
  queue: readonly CoachingPriorityQueueEntry[],
): CoachingPriorityQueueEntry | null {
  return queue.find((entry) => entry.urgency === 'immediate' || entry.urgency === 'next_open') ?? null;
}

/** Coaching that should be offered as a work session begins. */
export function pendingAtSessionStart(
  queue: readonly CoachingPriorityQueueEntry[],
): CoachingPriorityQueueEntry | null {
  return (
    queue.find((entry) => entry.urgency === 'immediate' || entry.urgency === 'next_start') ?? null
  );
}

export async function runLaunchSequence(deps: LaunchDeps): Promise<LaunchOutcome> {
  const now = deps.now();

  // ── FIRST. Always. ────────────────────────────────────────────────────────────────────────
  const recovery = await recoverOpenEpisode(deps.episode, now);
  if (recovery.recovered && recovery.sessionId && recovery.directive) {
    return {
      kind: 'recovered',
      sessionId: recovery.sessionId,
      directive: recovery.directive,
      creditedMinutes: recovery.creditedMinutes ?? 0,
    };
  }

  // The queue is ordered urgency-first, oldest-first by the view itself — take its word for it.
  const entry = pendingAtAppOpen(await deps.coaching.priorityQueue());
  if (entry) return { kind: 'coaching', entry };

  return { kind: 'dashboard' };
}

// ── NOT IMPLEMENTED, AND WHY ────────────────────────────────────────────────────────────────
//
// Spec §6.1's first branch — "5+ days since last open → re-orientation coaching" — is NOT wired.
// The `app_reorientation` trigger exists, the prompt for it exists, and this function already
// drains anything that enqueues it, so the conversation is one writer away from working. What is
// missing is the writer's input: a durable "last opened" watermark. There is nowhere truthful to
// put one today — `sessions.started_at` answers "when did you last WORK", which is a different
// question (someone can open the app daily and start no sessions for a week), and inferring it
// from interactions has the same flaw. Its natural home is task 26's `learning_state (key, value)`
// table, which does not exist yet. Pinned there rather than guessed at here.
