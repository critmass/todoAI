// Task 13 — the durable home for LIVE timer state (migration 005). Everything here exists so
// that spec §8.2's "on crash the timer keeps running against the stored end-time" and task 28
// design §1.4's relaunch recovery are true statements about the database, not about a variable
// in memory. Three tables, three lifetimes:
//
//   session_runtime         one row per RUNNING session — the movable planned end.
//   active_episode          zero or one row, ever — the OPEN episode and its pause ledger.
//                           A row that outlives the process IS the crash signal.
//   session_task_extension  the `+5` ledger, keyed (session, task) — outlives the episodes it
//                           spans, because the repeated_extension trigger's grain is the task
//                           within the session, not the episode.
//
// All *AtMs values are epoch MILLISECONDS (see 005_session_runtime.sql for why). This repository
// never reads a clock: every timestamp is supplied by the caller, which is what makes every
// timer path in src/execution/ testable headless with an injected `now`.

import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  activeEpisodeRowToDomain,
  sessionRuntimeRowToDomain,
  sessionTaskExtensionRowToDomain,
  type ActiveEpisode,
  type SessionRuntime,
  type SessionTaskExtension,
} from '../../types/domain';
import type {
  ActiveEpisodeRow,
  EpisodeBlockKind,
  SessionRuntimeRow,
  SessionTaskExtensionRow,
} from '../../types/db';

export interface OpenEpisodeInput {
  sessionId: string;
  taskId: number;
  blockKind: EpisodeBlockKind;
  plannedMinutes: number;
  startedAtMs: number;
  blockEndAtMs: number;
}

/** The mutable fields of the open episode. `plannedMinutes`, `startedAtMs`, `taskId` and
 *  `sessionId` are deliberately absent — an episode's identity and its original block size never
 *  change; that immutability is what the guardrail's 2x test rests on. */
export interface ActiveEpisodePatch {
  blockEndAtMs?: number;
  pausedAtMs?: number | null;
  pausedMs?: number;
  pauseCount?: number;
  hyperfocusQuanta?: number;
  longExtendEnqueued?: boolean;
}

export function createRuntimeRepository(db: SqliteConnection) {
  // ── session_runtime ────────────────────────────────────────────────────────────────────────

  async function getSessionRuntime(sessionId: string): Promise<SessionRuntime | undefined> {
    const result = await db.execute('SELECT * FROM session_runtime WHERE session_id = ?', [
      sessionId,
    ]);
    const row = result.rows[0] as unknown as SessionRuntimeRow | undefined;
    return row ? sessionRuntimeRowToDomain(row) : undefined;
  }

  /** Opens the session's runtime row with its start and its first planned end. */
  async function startSession(
    sessionId: string,
    startedAtMs: number,
    plannedEndAtMs: number,
  ): Promise<SessionRuntime> {
    await db.execute(
      `INSERT INTO session_runtime (session_id, started_at_ms, planned_end_at_ms, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id)
         DO UPDATE SET started_at_ms = excluded.started_at_ms,
                       planned_end_at_ms = excluded.planned_end_at_ms,
                       updated_at = CURRENT_TIMESTAMP`,
      [sessionId, startedAtMs, plannedEndAtMs],
    );
    const runtime = await getSessionRuntime(sessionId);
    if (!runtime) {
      throw new NotFoundError('session_runtime', sessionId);
    }
    return runtime;
  }

  /** Moves the session's planned end - every extension that crosses it lands here (task 28 design
   *  §4.1.2 / amendment §1). The start is never touched. */
  async function setSessionEnd(sessionId: string, plannedEndAtMs: number): Promise<SessionRuntime> {
    await db.execute(
      'UPDATE session_runtime SET planned_end_at_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
      [plannedEndAtMs, sessionId],
    );
    const runtime = await getSessionRuntime(sessionId);
    if (!runtime) {
      throw new NotFoundError('session_runtime', sessionId);
    }
    return runtime;
  }

  /** Tears down every runtime trace of a finished session: its movable end, any open episode
   *  belonging to it, and its `+5` ledger. Idempotent, so a caller can always be sure the next
   *  launch sees no phantom crash signal. */
  async function clearSessionRuntime(sessionId: string): Promise<void> {
    await db.execute('DELETE FROM active_episode WHERE session_id = ?', [sessionId]);
    await db.execute('DELETE FROM session_task_extension WHERE session_id = ?', [sessionId]);
    await db.execute('DELETE FROM session_runtime WHERE session_id = ?', [sessionId]);
  }

  // ── active_episode ─────────────────────────────────────────────────────────────────────────

  async function getActiveEpisode(): Promise<ActiveEpisode | undefined> {
    const result = await db.execute('SELECT * FROM active_episode WHERE id = 1');
    const row = result.rows[0] as unknown as ActiveEpisodeRow | undefined;
    return row ? activeEpisodeRowToDomain(row) : undefined;
  }

  /** Opens an episode, replacing any existing one. The delete is not defensive tidying: the table
   *  is a singleton by CHECK, so an INSERT over a stale row would simply fail, and a stale row can
   *  only mean a close path was missed. Replacing it keeps the app usable; the misses are caught
   *  by the recovery path at launch, not here. */
  async function openEpisode(input: OpenEpisodeInput): Promise<ActiveEpisode> {
    await db.execute('DELETE FROM active_episode');
    await db.execute(
      `INSERT INTO active_episode
         (id, session_id, task_id, block_kind, planned_minutes, started_at_ms, block_end_at_ms)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.taskId,
        input.blockKind,
        input.plannedMinutes,
        input.startedAtMs,
        input.blockEndAtMs,
      ],
    );
    const episode = await getActiveEpisode();
    if (!episode) {
      throw new NotFoundError('active_episode', 1);
    }
    return episode;
  }

  async function updateActiveEpisode(patch: ActiveEpisodePatch): Promise<ActiveEpisode> {
    const columns: string[] = [];
    const values: Array<number | null> = [];
    if (patch.blockEndAtMs !== undefined) {
      columns.push('block_end_at_ms = ?');
      values.push(patch.blockEndAtMs);
    }
    if (patch.pausedAtMs !== undefined) {
      columns.push('paused_at_ms = ?');
      values.push(patch.pausedAtMs);
    }
    if (patch.pausedMs !== undefined) {
      columns.push('paused_ms = ?');
      values.push(patch.pausedMs);
    }
    if (patch.pauseCount !== undefined) {
      columns.push('pause_count = ?');
      values.push(patch.pauseCount);
    }
    if (patch.hyperfocusQuanta !== undefined) {
      columns.push('hyperfocus_quanta = ?');
      values.push(patch.hyperfocusQuanta);
    }
    if (patch.longExtendEnqueued !== undefined) {
      columns.push('long_extend_enqueued = ?');
      values.push(patch.longExtendEnqueued ? 1 : 0);
    }
    if (columns.length > 0) {
      await db.execute(`UPDATE active_episode SET ${columns.join(', ')} WHERE id = 1`, values);
    }
    const episode = await getActiveEpisode();
    if (!episode) {
      throw new NotFoundError('active_episode', 1);
    }
    return episode;
  }

  /** Closes the open episode by removing the row. Every outcome path — completed, progress,
   *  skipped, abandoned — ends here; the durable record of what happened is the interaction row,
   *  not this table. */
  async function closeEpisode(): Promise<void> {
    await db.execute('DELETE FROM active_episode');
  }

  // ── session_task_extension (the `+5` ledger) ───────────────────────────────────────────────

  async function getExtensionLedger(
    sessionId: string,
    taskId: number,
  ): Promise<SessionTaskExtension | undefined> {
    const result = await db.execute(
      'SELECT * FROM session_task_extension WHERE session_id = ? AND task_id = ?',
      [sessionId, taskId],
    );
    const row = result.rows[0] as unknown as SessionTaskExtensionRow | undefined;
    return row ? sessionTaskExtensionRowToDomain(row) : undefined;
  }

  /** Records one `+5` press against (session, task) and returns the running ledger. */
  async function recordShortExtension(
    sessionId: string,
    taskId: number,
    minutes: number,
  ): Promise<SessionTaskExtension> {
    await db.execute(
      `INSERT INTO session_task_extension (session_id, task_id, presses, minutes)
            VALUES (?, ?, 1, ?)
       ON CONFLICT (session_id, task_id)
         DO UPDATE SET presses = presses + 1,
                       minutes = minutes + excluded.minutes`,
      [sessionId, taskId, minutes],
    );
    const ledger = await getExtensionLedger(sessionId, taskId);
    if (!ledger) {
      throw new NotFoundError('session_task_extension', `${sessionId}:${taskId}`);
    }
    return ledger;
  }

  /** Marks the `repeated_extension` conversation as already queued for this (session, task), so a
   *  task served twice in one session enqueues one row, not two (task 28 amendment §3). */
  async function markExtensionCoachingEnqueued(sessionId: string, taskId: number): Promise<void> {
    await db.execute(
      'UPDATE session_task_extension SET coaching_enqueued = 1 WHERE session_id = ? AND task_id = ?',
      [sessionId, taskId],
    );
  }

  return {
    getSessionRuntime,
    startSession,
    setSessionEnd,
    clearSessionRuntime,
    getActiveEpisode,
    openEpisode,
    updateActiveEpisode,
    closeEpisode,
    getExtensionLedger,
    recordShortExtension,
    markExtensionCoachingEnqueued,
  };
}

export type RuntimeRepository = ReturnType<typeof createRuntimeRepository>;
