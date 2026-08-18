// Task 41 — the ambient correlation frame (design §3.3, §11).
//
// WHY AMBIENT AND NOT THREADED PARAMETERS. `chatController` has no `sessionId` and no episode —
// its deps are `{model, tasks, recurrence, coaching, dispatch, now}`. Threading correlation ids
// into it means changing its constructor signature, `App.tsx`'s wiring and its whole test suite,
// to carry data it has no other use for. That is capture diffusing into the code it instruments,
// which brief §4 forbids.
//
// The ambient value is safe here for a STRUCTURAL reason, not a hopeful one: there is exactly one
// active session, and by database CHECK exactly one `active_episode` (id = 1), and JS is
// single-threaded. The frame cannot be ambiguous because the app cannot have two.
//
// (This is one of the four builder calls the amendment §8 marks PROVISIONAL, not canon.)

/** Session origin. Written by task 44 (`sessions.origin`, migration 007, ruled 2026-08-07);
 *  nothing in the tree supplies it today, so it stays undefined and capture records no origin
 *  rather than a guessed one. */
export type SessionOrigin = 'planned' | 'quickstart';

export interface CaptureFrame {
  sessionId: string | null;
  episodeId: string | null;
  taskId: number | null;
  origin?: SessionOrigin;
}

const frame: CaptureFrame = { sessionId: null, episodeId: null, taskId: null };

/**
 * The episode identity, DETERMINISTIC rather than minted-random, and that is load-bearing.
 *
 * There is no episode id in the database — `active_episode` is a singleton by CHECK (id = 1) and
 * an episode's durable identity only appears at close, as an `interactions` row. At launch,
 * `recoverOpenEpisode` re-reads the same `active_episode` row after a crash, so the recovered
 * episode DERIVES THE SAME id and the post-crash records join to the pre-crash ones. A random id
 * would make the crash a permanent seam in the timeline — in the one case the whole facility
 * exists to illuminate.
 */
export function episodeIdOf(
  sessionId: string | null,
  taskId: number | null,
  startedAtMs: number,
): string {
  return `${sessionId ?? 'no_session'}#${taskId ?? 'no_task'}@${startedAtMs}`;
}

export const captureContext = {
  setSession(sessionId: string, origin?: SessionOrigin): void {
    frame.sessionId = sessionId;
    frame.origin = origin;
  },
  clearSession(): void {
    frame.sessionId = null;
    frame.origin = undefined;
    frame.episodeId = null;
    frame.taskId = null;
  },
  setEpisode(input: { sessionId?: string | null; taskId: number | null; startedAtMs: number }): void {
    if (input.sessionId) frame.sessionId = input.sessionId;
    frame.taskId = input.taskId;
    frame.episodeId = episodeIdOf(frame.sessionId, input.taskId, input.startedAtMs);
  },
  clearEpisode(): void {
    frame.episodeId = null;
    frame.taskId = null;
  },
  current(): Readonly<CaptureFrame> {
    return frame;
  },
  /** Tests only — the frame is process-global by design. */
  reset(): void {
    frame.sessionId = null;
    frame.episodeId = null;
    frame.taskId = null;
    frame.origin = undefined;
  },
};
