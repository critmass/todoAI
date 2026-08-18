// Task 13 — the episode lifecycle: the runtime state machine that sits between task 11's plan and
// task 24's screens. Task 24 renders; this owns the state, the clock arithmetic (delegated to the
// pure ./timer.ts) and the durable record. THERE IS NO UI HERE, and every entry point takes an
// injected `now` (epoch ms) rather than reading a clock.
//
// AN EPISODE is one serving of one task inside a session. It opens when the user starts a task and
// closes with exactly ONE outcome — `completed`, `progress` (parked), `skipped`, or `abandoned`
// (task 28 design §1.1). Those four are not shades of each other:
//
//   completed  → completeTask(), which picks the recurrence primitive (constraint #7) and folds
//                accumulated + this episode into ONE actual_duration_history entry.
//   progress   → tasks.recordProgressEpisode(). NEVER a skip: no skip_count, no coaching, no
//                contribution to the 3-skip recalibration. Structurally, not by a policy check.
//   skipped    → tasks.recordSkipEpisode() + the §7.2 skip coaching. Retains accumulated time.
//   abandoned  → the relaunch recovery path only (§1.4). Credits the time, writes NO SKIP, and
//                never abandons the TASK — only the episode.
//
// WHO OWNS THE `sessions` ROW (the 13/24 boundary, stated because both tasks could claim it):
// task 24 CREATES the row at session start — it owns the check-in data (type, planned duration,
// energy start) and nothing here can supply it. Every write AFTER that is this module's: the
// per-episode counters (tasks_completed / tasks_skipped / tasks_progressed), the `extended` flag,
// and the terminal close. All of those depend on runtime state that only this module holds, and
// splitting them would put two owners on one row.
//
// SCOPE LINE — NO RECURRENCE PERIOD LOGIC LIVES HERE. Advancing next_due_at, rolling reset_date at
// a period boundary and the missed-quota importance boost are TASK 36's (ruled 2026-07-20), even
// though taskCompletion.ts's header still points at task 13 for them. Nothing in this file reads
// or writes task_recurrence except through completeTask's existing dispatch.

import type { TasksRepository } from '../db/repositories/tasks';
import type { RecurrenceRepository } from '../db/repositories/recurrence';
import type { InteractionsRepository } from '../db/repositories/interactions';
import type { SessionsRepository } from '../db/repositories/sessions';
import type { CoachingRepository } from '../db/repositories/coaching';
import type { RuntimeRepository } from '../db/repositories/runtime';
import type { ActiveEpisode, SessionRuntime, Task } from '../types/domain';
import type { CoachingTrigger, EpisodeBlockKind, SessionOrigin } from '../types/db';
// TASK 41 — the `episode` stream and the ambient correlation frame (design §11). This module is
// brief §6's named surface for it: ten exported entry points, every one of them already the single
// place its transition happens. Recording here rather than in `sessionController` also keeps
// `src/app/` untouched for task 44, and picks up `recoverOpenEpisode`, which the controller never
// calls.
import { captureContext, record } from '../capture';
import type { AgendaTaskItem } from '../planning/agenda';
import { completeTask, type CompletionResult } from '../services/taskCompletion';
import { enqueueCoachingTrigger } from '../services/coaching/triggers';
import { NoActiveEpisodeError, NoSessionRuntimeError, ParkGateError } from './errors';
import {
  EXTEND_QUANTUM_MINUTES,
  GUARDRAIL_LONG_EXTEND_COACHING,
  SHORT_EXTENSION_MINUTES,
} from './constants';
import {
  MS_PER_MINUTE,
  hyperfocusExtensionEnd,
  longExtendThresholdCrossed,
  minutesFromMs,
  pauseCoachingDue,
  pauseRatio,
  recoveryCreditMs,
  repeatedExtensionArm,
  selfCareNudgeDue,
  shortExtensionEnd,
  timerSnapshot,
  workedMs,
  type TimerFace,
  type TimerSnapshot,
} from './timer';

/**
 * The alarm hook. When a task timer expires the app takes focus like an alarm (spec §6.2 /
 * brief §1.5) — this module owns WHEN, task 24 owns the presentation and the platform call. It is
 * optional so every path here stays headless-testable; a test passes nothing, or a recorder.
 */
export interface EpisodeExpiryScheduler {
  /** Schedule (or re-schedule) the expiry alarm for the open episode's block end. */
  schedule(atMs: number): void | Promise<void>;
  /** Cancel any scheduled alarm — the episode closed, or paused. */
  cancel(): void | Promise<void>;
}

export interface EpisodeServiceDeps {
  tasks: Pick<
    TasksRepository,
    'getById' | 'update' | 'recordUnscheduledCompletion' | 'recordProgressEpisode' | 'recordSkipEpisode'
  >;
  recurrence: Pick<
    RecurrenceRepository,
    'getByTaskId' | 'incrementCountProgress' | 'incrementPeriodProgress'
  >;
  interactions: Pick<InteractionsRepository, 'create' | 'linkTask' | 'listTaskIdsBySession'>;
  sessions: Pick<SessionsRepository, 'getById' | 'update'>;
  coaching: Pick<CoachingRepository, 'create' | 'linkTask' | 'linkSession' | 'priorityQueue'>;
  runtime: RuntimeRepository;
  scheduler?: EpisodeExpiryScheduler;
}

// ── What a close hands back ────────────────────────────────────────────────────────────────────

/** What the caller should do with the REST of the agenda once an episode closes. The rule is task
 *  28 design §4.2's: a hyperfocus stretch invalidates the tail (energy and context have moved on),
 *  so it is REGENERATED, never shifted or shrunk; anything shorter leaves the tail alone. */
export type TailDirective =
  | { kind: 'continue' }
  | {
      kind: 'regenerate';
      remainingMinutes: number;
      /** Fed to replanRemaining so task 11's break-first rule fires on a long stretch. Do not
       *  re-derive the 50-minute threshold here — the planner owns it. */
      precededByStretchMinutes: number;
      easier: boolean;
      /** Tasks already served this session — never re-planned into the tail. */
      excludeTaskIds: number[];
    }
  | { kind: 'summary' };

export interface CoachingEnqueued {
  trigger: CoachingTrigger;
  /** `trigger_data.kind` for the `pattern_detected` rows — `repeated_extension`, `long_extend`,
   *  `high_pause_ratio`, `session_lapsed`. These are DATA on an existing trigger type, never new
   *  trigger types: no migration adds them (constraint #12). */
  kind?: string;
}

export type EpisodeOutcome = 'completed' | 'progress' | 'skipped' | 'abandoned';

export interface EpisodeCloseResult {
  outcome: EpisodeOutcome;
  taskId: number;
  sessionId: string;
  episodeMinutes: number;
  interactionId: number;
  tail: TailDirective;
  coaching: CoachingEnqueued[];
  /** Present only for `completed` — the recurrence-typed outcome completeTask chose. */
  completion?: CompletionResult;
}

// ── Session runtime ────────────────────────────────────────────────────────────────────────────

/** Records the session's movable planned end. Task 24 calls this immediately after creating the
 *  `sessions` row; from here on the end-time is this module's. */
export async function startSessionRuntime(
  deps: EpisodeServiceDeps,
  input: { sessionId: string; startedAtMs: number; plannedMinutes: number; origin?: SessionOrigin },
): Promise<SessionRuntime> {
  const runtime = await deps.runtime.startSession(
    input.sessionId,
    input.startedAtMs,
    input.startedAtMs + input.plannedMinutes * MS_PER_MINUTE,
  );
  // The frame is ambient because `chatController` has no sessionId and threading one in would mean
  // changing its signature, App.tsx's wiring and its whole suite to carry data it has no other use
  // for. Safe structurally, not hopefully: one session at a time, `active_episode` is a singleton
  // by DB CHECK, and JS is single-threaded.
  //
  // TASK 44 — the one line the brief authorized in this "not yours" file: `sessions.origin`
  // (migration 007) now exists, and `sessionController.startSession`/`startQuickStartSession` pass
  // it through. `origin` stays optional here (not required) so every OTHER caller of
  // startSessionRuntime — none exist today outside sessionController, but the type shouldn't
  // assume that — degrades to "no origin recorded" rather than a compile error.
  captureContext.setSession(input.sessionId, input.origin);
  record({
    stream: 'episode',
    type: 'session_start',
    plannedMinutes: input.plannedMinutes,
  });
  return runtime;
}

/** Epoch ms → the 'YYYY-MM-DD HH:MM:SS' UTC form SQLite's CURRENT_TIMESTAMP produces. The runtime
 *  tables store raw epoch ms, but `sessions.completed_at` is an ordinary DATETIME column read by
 *  date functions, so a value written there must match the format its siblings use. */
function sqliteTimestamp(atMs: number): string {
  return new Date(atMs).toISOString().replace('T', ' ').slice(0, 19);
}

async function requireSessionRuntime(
  deps: EpisodeServiceDeps,
  sessionId: string,
): Promise<SessionRuntime> {
  const runtime = await deps.runtime.getSessionRuntime(sessionId);
  if (!runtime) throw new NoSessionRuntimeError(sessionId);
  return runtime;
}

/** Closes the session: writes the terminal `sessions` fields and tears down every runtime row, so
 *  the next launch finds no phantom crash signal. `status` is the caller's call — a user-ended
 *  session is 'completed', a lapse or a crash-past-the-end is 'abandoned' (session status and task
 *  work_state are orthogonal; abandoning a session never abandons a task). */
export async function closeSession(
  deps: EpisodeServiceDeps,
  input: { sessionId: string; now: number; status: 'completed' | 'abandoned' },
): Promise<void> {
  const runtime = await deps.runtime.getSessionRuntime(input.sessionId);
  const session = await deps.sessions.getById(input.sessionId);
  if (session) {
    await deps.sessions.update(input.sessionId, {
      status: input.status,
      actualDuration: runtime
        ? minutesFromMs(input.now - runtime.startedAtMs)
        : session.actualDuration,
      completedAt: sqliteTimestamp(input.now),
    });
  }
  await deps.runtime.clearSessionRuntime(input.sessionId);
  await deps.scheduler?.cancel();
  record({
    stream: 'episode',
    type: 'session_close',
    sessionStatus: input.status,
    actualMinutes: runtime ? minutesFromMs(input.now - runtime.startedAtMs) : undefined,
  });
  captureContext.clearSession();
}

// ── Opening, pausing, reading the timer ────────────────────────────────────────────────────────

export interface StartEpisodeInput {
  sessionId: string;
  /** The agenda item being served — task 11's own vocabulary, so `blockKind` and `plannedMinutes`
   *  arrive already decided by the planner rather than re-derived here. */
  item: AgendaTaskItem;
  now: number;
  /** Resuming into a block that is already running (the recovery path): keeps the ORIGINAL block
   *  end rather than starting a fresh one from `now`. */
  blockEndAtMs?: number;
}

export async function startEpisode(
  deps: EpisodeServiceDeps,
  input: StartEpisodeInput,
): Promise<ActiveEpisode> {
  const blockEndAtMs =
    input.blockEndAtMs ?? input.now + input.item.plannedMinutes * MS_PER_MINUTE;
  const episode = await deps.runtime.openEpisode({
    sessionId: input.sessionId,
    taskId: input.item.task.id,
    blockKind: input.item.blockKind,
    plannedMinutes: input.item.plannedMinutes,
    startedAtMs: input.now,
    blockEndAtMs,
  });
  await deps.scheduler?.schedule(blockEndAtMs);
  // Deterministic episode id (design §3.3): `recoverOpenEpisode` re-reads the same
  // `active_episode` row after a crash and derives the SAME id, so post-crash records join to the
  // pre-crash ones. A random id would make the crash a permanent seam in the timeline — in the one
  // case the whole facility exists to illuminate.
  captureContext.setEpisode({
    sessionId: input.sessionId,
    taskId: input.item.task.id,
    startedAtMs: episode.startedAtMs,
  });
  record({
    stream: 'episode',
    type: 'start',
    blockKind: input.item.blockKind,
    plannedMinutes: input.item.plannedMinutes,
  });
  return episode;
}

async function requireEpisode(
  deps: EpisodeServiceDeps,
  operation: string,
): Promise<ActiveEpisode> {
  const episode = await deps.runtime.getActiveEpisode();
  if (!episode) throw new NoActiveEpisodeError(operation);
  return episode;
}

/** Pauses the episode. Backgrounding is NOT this — backgrounding is normal and touches nothing
 *  (design §1.2 / spec §8.2); only an explicit pause stops the timer. */
export async function pauseEpisode(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<ActiveEpisode> {
  const episode = await requireEpisode(deps, 'pauseEpisode');
  if (episode.pausedAtMs != null) return episode; // idempotent
  const paused = await deps.runtime.updateActiveEpisode({
    pausedAtMs: now,
    pauseCount: episode.pauseCount + 1,
  });
  await deps.scheduler?.cancel();
  record({ stream: 'episode', type: 'pause', pauseCount: paused.pauseCount });
  return paused;
}

/**
 * Resumes the episode. THE BLOCK END MOVES OUT BY THE PAUSE DURATION — an interruption must not
 * eat the block — and the new end-time is persisted here and now. This is the "persist at task
 * start and after pause only" rule of spec §8.2 doing its actual job: the end-time IS the timer,
 * so it has to be durable before the next crash, and nothing needs to be written per tick.
 */
export async function resumeEpisode(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<ActiveEpisode> {
  const episode = await requireEpisode(deps, 'resumeEpisode');
  if (episode.pausedAtMs == null) return episode; // idempotent
  const pauseDuration = Math.max(0, now - episode.pausedAtMs);
  const resumed = await deps.runtime.updateActiveEpisode({
    pausedAtMs: null,
    pausedMs: episode.pausedMs + pauseDuration,
    blockEndAtMs: episode.blockEndAtMs + pauseDuration,
  });
  await deps.scheduler?.schedule(resumed.blockEndAtMs);
  record({ stream: 'episode', type: 'resume', pausedMs: resumed.pausedMs });
  return resumed;
}

/** The current timer reading, or null when no episode is open. */
export async function currentTimer(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<TimerSnapshot | null> {
  const episode = await deps.runtime.getActiveEpisode();
  return episode ? timerSnapshot(episode, now) : null;
}

// ── The five-option end-of-block prompt (state side; task 24 owns surface and microcopy) ───────

export type EndOfBlockOption =
  | 'done'
  | 'short_extension'
  | 'keep_going'
  | 'park'
  | 'easier'
  | 'skip';

export interface EndOfBlockPrompt {
  taskId: number;
  face: TimerFace;
  workedMinutes: number;
  hyperfocusQuanta: number;
  /** Done · +5 minutes · Keep going · Pause for later · Something easier. `park` is replaced by
   *  `skip` before the 60-second gate — at a real block boundary that never happens, but the
   *  gate is evaluated rather than assumed. */
  options: EndOfBlockOption[];
  /** The one-line self-care check, every second consecutive hyperfocus quantum. One tap still
   *  continues; never blocking; NEVER shown for a chain of `+5` presses. */
  selfCareNudge: boolean;
}

/** The prompt to raise when the block boundary is reached, or null if it hasn't been (or no
 *  episode is open). Reaching an openBlock's boundary raises this rather than ending anything. */
export async function endOfBlockPrompt(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<EndOfBlockPrompt | null> {
  const episode = await deps.runtime.getActiveEpisode();
  if (!episode) return null;
  const snapshot = timerSnapshot(episode, now);
  if (!snapshot.boundaryReached) return null;
  return {
    taskId: episode.taskId,
    face: snapshot.face,
    workedMinutes: minutesFromMs(snapshot.workedMs),
    hyperfocusQuanta: episode.hyperfocusQuanta,
    options: [
      'done',
      'short_extension',
      'keep_going',
      snapshot.parkAvailable ? 'park' : 'skip',
      'easier',
    ],
    selfCareNudge: selfCareNudgeDue(episode.hyperfocusQuanta),
  };
}

// ── The two extension paths (task 28 amendment §1) ─────────────────────────────────────────────
// NEITHER TAKES `now`, and that is the timestamp model showing through rather than an oversight:
// an extension moves the STORED END-TIME, relative to itself. Pressing "+5" ten seconds after the
// boundary and pressing it two minutes after both add exactly five minutes to the block. If these
// extended from `now` instead, the time spent reading the prompt would silently be swallowed.

export interface ExtensionResult {
  episode: ActiveEpisode;
  /** The session's planned end had to move to accommodate the new block end. */
  sessionEndMoved: boolean;
  /** `sessions.extended` was set. HYPERFOCUS ONLY — that flag means the session ran long on
   *  hyperfocus, which a `+5` is definitionally not. */
  sessionExtended: boolean;
  coaching: CoachingEnqueued[];
}

async function moveSessionEndIfCrossed(
  deps: EpisodeServiceDeps,
  sessionId: string,
  blockEndAtMs: number,
): Promise<boolean> {
  const runtime = await requireSessionRuntime(deps, sessionId);
  if (blockEndAtMs <= runtime.plannedEndAtMs) return false;
  await deps.runtime.setSessionEnd(sessionId, blockEndAtMs);
  return true;
}

/**
 * `+5 minutes` — "I'm almost done."
 *
 * Flat five on every block size. The timer face does not change: a countdown stays a countdown.
 * The tail SHIFTS rather than regenerating — five minutes does not invalidate an energy ramp — so
 * this returns no tail directive and the session end moves only if the new block end actually
 * passes it (otherwise the five minutes are absorbed by the slack ahead). `sessions.extended` is
 * NOT set.
 *
 * NO CAP, NO NUDGE, NO PROMOTION TO HYPERFOCUS, EVER. Ruled, and the reasoning binds: not knowing
 * how much longer something will take is the executive-function symptom this app exists to absorb,
 * not a behavior to correct. Any future "are you sure?" on this path is a bug against the ruling.
 * The entire response to repeated use is a conversation later, at task close (§3 of the amendment).
 */
export async function applyShortExtension(
  deps: EpisodeServiceDeps,
): Promise<ExtensionResult> {
  const episode = await requireEpisode(deps, 'applyShortExtension');
  const blockEndAtMs = shortExtensionEnd(episode.blockEndAtMs);
  const updated = await deps.runtime.updateActiveEpisode({ blockEndAtMs });
  await deps.runtime.recordShortExtension(
    episode.sessionId,
    episode.taskId,
    SHORT_EXTENSION_MINUTES,
  );
  const sessionEndMoved = await moveSessionEndIfCrossed(deps, episode.sessionId, blockEndAtMs);
  await deps.scheduler?.schedule(blockEndAtMs);
  record({ stream: 'episode', type: 'extend_short' });
  return { episode: updated, sessionEndMoved, sessionExtended: false, coaching: [] };
}

/**
 * `Keep going` — hyperfocus.
 *
 * Block end +25, chainable. Crossing the session's planned end MOVES the session end and sets
 * `sessions.extended`. The face switches to count-up for the stretch. When the stretch finally
 * ends the tail is REGENERATED (handled at close, not here). This is the only path the §4.3
 * guardrail governs.
 */
export async function applyHyperfocusExtension(
  deps: EpisodeServiceDeps,
): Promise<ExtensionResult> {
  const episode = await requireEpisode(deps, 'applyHyperfocusExtension');
  const blockEndAtMs = hyperfocusExtensionEnd(episode.blockEndAtMs);
  const hyperfocusQuanta = episode.hyperfocusQuanta + 1;
  let updated = await deps.runtime.updateActiveEpisode({ blockEndAtMs, hyperfocusQuanta });

  const sessionEndMoved = await moveSessionEndIfCrossed(deps, episode.sessionId, blockEndAtMs);
  let sessionExtended = false;
  if (sessionEndMoved) {
    // The user is declaring they have the time; the app does not argue. The flag records that the
    // session ran long on hyperfocus, which is exactly what it means.
    await deps.sessions.update(episode.sessionId, { extended: true });
    sessionExtended = true;
  }

  const coaching: CoachingEnqueued[] = [];
  if (
    GUARDRAIL_LONG_EXTEND_COACHING &&
    !episode.longExtendEnqueued &&
    longExtendThresholdCrossed(episode.plannedMinutes, hyperfocusQuanta)
  ) {
    // Queued for the NEXT session, never surfaced mid-flow: the nudge is in the flow, the
    // coaching is at the seam, and nothing ever stops the user.
    await enqueueCoachingTrigger(deps.coaching, {
      trigger: 'pattern_detected',
      urgency: 'next_start',
      triggerData: {
        kind: 'long_extend',
        quanta: hyperfocusQuanta,
        quantumMinutes: EXTEND_QUANTUM_MINUTES,
        originalBlockMinutes: episode.plannedMinutes,
      },
      relatedTaskIds: [episode.taskId],
      relatedSessionIds: [episode.sessionId],
    });
    updated = await deps.runtime.updateActiveEpisode({ longExtendEnqueued: true });
    coaching.push({ trigger: 'pattern_detected', kind: 'long_extend' });
  }

  await deps.scheduler?.schedule(blockEndAtMs);
  record({
    stream: 'episode',
    type: 'extend_hyperfocus',
    hyperfocusQuanta,
    coachingEnqueued: coaching,
  });
  return { episode: updated, sessionEndMoved, sessionExtended, coaching };
}

// ── Closing an episode ─────────────────────────────────────────────────────────────────────────

async function tailDirectiveFor(
  deps: EpisodeServiceDeps,
  episode: ActiveEpisode,
  now: number,
  episodeMinutes: number,
  easier: boolean,
): Promise<TailDirective> {
  const runtime = await deps.runtime.getSessionRuntime(episode.sessionId);
  const remainingMinutes = runtime ? minutesFromMs(Math.max(0, runtime.plannedEndAtMs - now)) : 0;
  if (remainingMinutes <= 0) return { kind: 'summary' };
  // A hyperfocus stretch invalidates the tail; a plain block (or a `+5`) does not.
  if (!easier && episode.hyperfocusQuanta === 0) return { kind: 'continue' };
  return {
    kind: 'regenerate',
    remainingMinutes,
    precededByStretchMinutes: episode.hyperfocusQuanta > 0 ? episodeMinutes : 0,
    easier,
    excludeTaskIds: await deps.interactions.listTaskIdsBySession(episode.sessionId),
  };
}

/** Enqueues the >20%-paused conversation (spec §8.2) if this episode earned it. */
async function maybeEnqueuePauseCoaching(
  deps: EpisodeServiceDeps,
  episode: ActiveEpisode,
  now: number,
): Promise<CoachingEnqueued[]> {
  if (!pauseCoachingDue(episode, now)) return [];
  await enqueueCoachingTrigger(deps.coaching, {
    trigger: 'pattern_detected',
    urgency: 'next_start',
    triggerData: {
      kind: 'high_pause_ratio',
      pauseRatio: Number(pauseRatio(episode, now).toFixed(3)),
      pauseCount: episode.pauseCount,
    },
    relatedTaskIds: [episode.taskId],
    relatedSessionIds: [episode.sessionId],
  });
  return [{ trigger: 'pattern_detected', kind: 'high_pause_ratio' }];
}

/**
 * Enqueues the `repeated_extension` conversation AT TASK CLOSE (never at press): the useful
 * conversation needs the real total — "that was 25 minutes, not 10 — should we call it 25 going
 * forward?" — and that number does not exist until the task ends. ONE ROW PER TASK PER SESSION,
 * deduplicated by the ledger's own flag.
 *
 * Not a skip, not a failure, not a nudge. The system misjudged the task, not the user; the
 * resolution is the existing `modify_task(duration)` tool.
 */
async function maybeEnqueueRepeatedExtension(
  deps: EpisodeServiceDeps,
  episode: ActiveEpisode,
  task: Task,
): Promise<CoachingEnqueued[]> {
  const ledger = await deps.runtime.getExtensionLedger(episode.sessionId, episode.taskId);
  if (!ledger || ledger.coachingEnqueued) return [];
  const arm = repeatedExtensionArm(ledger, task);
  if (arm == null) return [];
  await enqueueCoachingTrigger(deps.coaching, {
    trigger: 'pattern_detected',
    urgency: 'next_start',
    triggerData: {
      kind: 'repeated_extension',
      arm,
      presses: ledger.presses,
      cumulativeMinutes: ledger.minutes,
      estimatedDuration: task.estimatedDuration,
    },
    relatedTaskIds: [episode.taskId],
    relatedSessionIds: [episode.sessionId],
  });
  await deps.runtime.markExtensionCoachingEnqueued(episode.sessionId, episode.taskId);
  return [{ trigger: 'pattern_detected', kind: 'repeated_extension' }];
}

async function writeEpisodeInteraction(
  deps: EpisodeServiceDeps,
  episode: ActiveEpisode,
  outcome: EpisodeOutcome,
  episodeMinutes: number,
  notes?: string,
): Promise<number> {
  const interactionType =
    outcome === 'completed' ? 'task_completion' : outcome === 'skipped' ? 'task_skip' : 'task_progress';
  // EpisodeOutcome's four values are exactly four of CompletionStatus's five, by design — the
  // vocabulary is fixed by task 28 design §1.1 and this is the one place the two meet.
  const row = await deps.interactions.create({
    interactionType,
    sessionId: episode.sessionId,
    completionStatus: outcome,
    durationMinutes: episodeMinutes,
    notes,
  });
  await deps.interactions.linkTask(row.id, episode.taskId);
  return row.id;
}

/** Increments one of the session's three episode counters. THREE SEPARATE COLUMNS, never one
 *  column with a kind: parked tasks count in `tasks_progressed`, and there is no arithmetic
 *  anywhere that could let a park land in `tasks_skipped` (design §1.5). */
async function bumpSessionCounter(
  deps: EpisodeServiceDeps,
  sessionId: string,
  field: 'tasksCompleted' | 'tasksSkipped' | 'tasksProgressed',
): Promise<number> {
  const session = await deps.sessions.getById(sessionId);
  if (!session) return 0;
  const next = session[field] + 1;
  await deps.sessions.update(
    sessionId,
    field === 'tasksCompleted'
      ? { tasksCompleted: next }
      : field === 'tasksSkipped'
        ? { tasksSkipped: next }
        : { tasksProgressed: next },
  );
  return next;
}

/**
 * Removes the open-episode row BEFORE the outcome writes, deliberately.
 *
 * A crash between the two orderings has to lose something either way, and the two losses are not
 * equivalent. Closing last would leave a row for the recovery path to find after the outcome had
 * already been written — crediting the same minutes twice and, after a completion, re-marking a
 * completed task `in_progress`. That is silent corruption of the single actual_duration_history
 * entry the whole fold exists to protect. Closing first can only lose one episode's bookkeeping in
 * the millisecond window, which the user resolves by simply doing it again.
 */
async function detachEpisode(deps: EpisodeServiceDeps): Promise<void> {
  await deps.runtime.closeEpisode();
  await deps.scheduler?.cancel();
}

/**
 * TASK 41 — one place the four dispositions and the recovery are recorded, so a new outcome cannot
 * be added without appearing in the `episode` stream. `origin` is now set on the ambient capture
 * frame at session start (startSessionRuntime — task 44), but `record()` does not fold frame
 * fields into the envelope automatically (only sessionId/episodeId/taskId are) — stamping `origin`
 * onto the PAYLOAD of each `episode`/`lifecycle` event is a `src/capture/` change task 44's brief
 * explicitly does not authorize (only the one `captureContext.setSession` argument is in scope
 * here). `captureContext.current().origin` is available to any future capture change that does
 * this; recorded as residue for task 41/42's owner rather than done here.
 */
function recordEpisodeClose(
  type: 'complete' | 'park' | 'skip' | 'escape' | 'recover',
  result: {
    episodeMinutes: number;
    interactionId?: number;
    outcome?: EpisodeOutcome;
    tail?: TailDirective;
    coaching: CoachingEnqueued[];
  },
  extra: { reason?: string; recoveryDirective?: string; creditMinutes?: number } = {},
): void {
  record({
    stream: 'episode',
    type,
    actualMinutes: result.episodeMinutes,
    outcome: result.outcome,
    tail: result.tail?.kind,
    interactionId: result.interactionId,
    coachingEnqueued: result.coaching,
    ...extra,
  });
  captureContext.clearEpisode();
}

/** `Done` — the completion path. The fold is already built: pass the episode minutes and let
 *  completeTask pick the primitive (constraint #7). Never re-derive the fold, never touch
 *  actual_duration_history here. */
export async function completeEpisode(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<EpisodeCloseResult> {
  const episode = await requireEpisode(deps, 'completeEpisode');
  const episodeMinutes = minutesFromMs(workedMs(episode, now));
  const task = await deps.tasks.getById(episode.taskId);

  await detachEpisode(deps);

  const completion = await completeTask(deps, episode.taskId, { episodeMinutes });
  const interactionId = await writeEpisodeInteraction(deps, episode, 'completed', episodeMinutes);
  await bumpSessionCounter(deps, episode.sessionId, 'tasksCompleted');

  const coaching = [
    ...(await maybeEnqueuePauseCoaching(deps, episode, now)),
    ...(task ? await maybeEnqueueRepeatedExtension(deps, episode, task) : []),
  ];

  const result: EpisodeCloseResult = {
    outcome: 'completed',
    taskId: episode.taskId,
    sessionId: episode.sessionId,
    episodeMinutes,
    interactionId,
    tail: await tailDirectiveFor(deps, episode, now, episodeMinutes, false),
    coaching,
    completion,
  };
  recordEpisodeClose('complete', result);
  return result;
}

/**
 * `Pause for later` — the park path.
 *
 * Gated by the 60-second rule and nothing else. A bail inside the first minute is a skip, so this
 * REFUSES rather than quietly downgrading — the two outcomes carry different semantics and the
 * caller must pick one deliberately.
 *
 * Parking writes no skip_count, enqueues no skip coaching, and cannot feed the 3-skip
 * recalibration. That is structural: it goes through recordProgressEpisode and tasks_progressed,
 * which are different columns reached by different code, not through a policy check that a
 * refactor could drop.
 */
export async function parkEpisode(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<EpisodeCloseResult> {
  const episode = await requireEpisode(deps, 'parkEpisode');
  const worked = workedMs(episode, now);
  const snapshot = timerSnapshot(episode, now);
  if (!snapshot.parkAvailable) throw new ParkGateError(worked);
  const episodeMinutes = minutesFromMs(worked);
  const task = await deps.tasks.getById(episode.taskId);

  await detachEpisode(deps);

  await deps.tasks.recordProgressEpisode(episode.taskId, episodeMinutes);
  const interactionId = await writeEpisodeInteraction(deps, episode, 'progress', episodeMinutes);
  await bumpSessionCounter(deps, episode.sessionId, 'tasksProgressed');

  const coaching = [
    ...(await maybeEnqueuePauseCoaching(deps, episode, now)),
    ...(task ? await maybeEnqueueRepeatedExtension(deps, episode, task) : []),
  ];

  const result: EpisodeCloseResult = {
    outcome: 'progress',
    taskId: episode.taskId,
    sessionId: episode.sessionId,
    episodeMinutes,
    interactionId,
    tail: await tailDirectiveFor(deps, episode, now, episodeMinutes, false),
    coaching,
  };
  recordEpisodeClose('park', result);
  return result;
}

/**
 * The skip path — the user was served this task and declined it. Normal §7.2 semantics, unchanged:
 * `skip_count` up, a `task_skipped` follow-up queued for next start, and the third skip within one
 * session firing an immediate `session_recalibration`. Accumulated time is RETAINED (design §1.3):
 * declining a task now says nothing about the work already in it.
 */
export async function skipEpisode(
  deps: EpisodeServiceDeps,
  now: number,
  opts?: { reason?: string },
): Promise<EpisodeCloseResult> {
  const episode = await requireEpisode(deps, 'skipEpisode');
  const episodeMinutes = minutesFromMs(workedMs(episode, now));
  const task = await deps.tasks.getById(episode.taskId);

  await detachEpisode(deps);

  await deps.tasks.recordSkipEpisode(episode.taskId, opts?.reason);
  const interactionId = await writeEpisodeInteraction(deps, episode, 'skipped', episodeMinutes);
  const skipsThisSession = await bumpSessionCounter(deps, episode.sessionId, 'tasksSkipped');

  const coaching: CoachingEnqueued[] = [];
  await enqueueCoachingTrigger(deps.coaching, {
    trigger: 'task_skipped',
    triggerData: opts?.reason ? { reason: opts.reason } : undefined,
    relatedTaskIds: [episode.taskId],
    relatedSessionIds: [episode.sessionId],
  });
  coaching.push({ trigger: 'task_skipped' });

  if (skipsThisSession === 3) {
    // Fires once, at the third skip: the app has misjudged current capacity, so stop serving
    // tasks and talk about what the user can take on right now (spec §7.2).
    await enqueueCoachingTrigger(deps.coaching, {
      trigger: 'session_recalibration',
      triggerData: { skipCount: skipsThisSession },
      relatedSessionIds: [episode.sessionId],
    });
    coaching.push({ trigger: 'session_recalibration' });
  }

  coaching.push(...(await maybeEnqueuePauseCoaching(deps, episode, now)));
  if (task) coaching.push(...(await maybeEnqueueRepeatedExtension(deps, episode, task)));

  const result: EpisodeCloseResult = {
    outcome: 'skipped',
    taskId: episode.taskId,
    sessionId: episode.sessionId,
    episodeMinutes,
    interactionId,
    tail: await tailDirectiveFor(deps, episode, now, episodeMinutes, false),
    coaching,
  };
  recordEpisodeClose('skip', result, opts?.reason ? { reason: opts.reason } : {});
  return result;
}

/**
 * `Something easier` — the escape valve. The session CONTINUES; only the tail is replanned, and
 * completed work is never re-planned back in.
 *
 * The current episode still has to close, and its outcome follows the same 60-second rule as
 * everywhere else: past the gate the user did real work and it is a PARK; inside the first minute
 * it is a skip. Escaping from a task is never allowed to invent a third disposition.
 */
export async function escapeToEasier(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<EpisodeCloseResult> {
  const episode = await requireEpisode(deps, 'escapeToEasier');
  const snapshot = timerSnapshot(episode, now);
  const closed = snapshot.parkAvailable
    ? await parkEpisode(deps, now)
    : await skipEpisode(deps, now);

  const tail = await tailDirectiveFor(deps, episode, now, closed.episodeMinutes, true);
  await deps.sessions.update(episode.sessionId, { escapeValveUsed: true });
  const result: EpisodeCloseResult = { ...closed, tail };
  // A SECOND record on purpose. The escape valve routes through park or skip, each of which has
  // already recorded its own close — and constraint #11 makes that distinction load-bearing, so
  // collapsing the two into one row would erase which primitive actually ran. This row says the
  // tail was replanned and `escape_valve_used` was set; its `interactionId` matches the row above.
  recordEpisodeClose('escape', result);
  return result;
}

// ── Crash / relaunch recovery (design §1.4) — the part that must be right ──────────────────────

export type RecoveryDirective =
  /** Block time and session time both remain: re-open the SAME block on the same task. */
  | {
      kind: 'resume_block';
      taskId: number;
      blockEndAtMs: number;
      blockKind: EpisodeBlockKind;
      plannedMinutes: number;
    }
  /** The block expired while the app was dead: open to the end-of-block prompt for that task. */
  | { kind: 'block_expired'; taskId: number }
  /** The session's own end passed too: there is nothing to return to but the summary. */
  | { kind: 'session_over'; taskId: number };

export interface RecoveryResult {
  recovered: boolean;
  taskId?: number;
  sessionId?: string;
  /** Minutes credited to accumulated_minutes: elapsed − known pause time, bounded by the block
   *  end (see timer.ts's recoveryCreditMs for why the bound belongs there). */
  creditedMinutes?: number;
  interactionId?: number;
  directive?: RecoveryDirective;
  coaching: CoachingEnqueued[];
}

/**
 * Runs at launch. If an open episode survived the process, close it as `abandoned`, credit
 * elapsed-minus-pauses to `accumulated_minutes`, set `work_state='in_progress'` — AND WRITE NO
 * SKIP. No `skip_count`, no `task_skipped` row, no contribution to the 3-skip recalibration
 * counter. A crash must never read as user failure.
 *
 * The app never abandons a TASK by inference. Only this episode is abandoned; the task keeps its
 * work and stays `status='active'`, and the only thing that ever writes off an in-progress stretch
 * is an explicit user disposition through coaching.
 *
 * Design §1.1 and §1.4 both describe this moment and are easy to read as contradicting each other
 * — one says the app resumes, the other says the episode is abandoned. They compose: the EPISODE
 * RECORD closes as abandoned (so nothing is lost and no skip is written) and the app then opens to
 * the right screen for the TASK, which is a fresh episode on the same block if time remains. The
 * returned directive is that routing decision; task 24 renders it.
 */
export async function recoverOpenEpisode(
  deps: EpisodeServiceDeps,
  now: number,
): Promise<RecoveryResult> {
  const episode = await deps.runtime.getActiveEpisode();
  if (!episode) return { recovered: false, coaching: [] };

  const creditedMinutes = minutesFromMs(recoveryCreditMs(episode, now));

  await detachEpisode(deps);

  await deps.tasks.recordProgressEpisode(episode.taskId, creditedMinutes);
  const interactionId = await writeEpisodeInteraction(
    deps,
    episode,
    'abandoned',
    creditedMinutes,
    'Episode closed by relaunch recovery — no user decision was recorded.',
  );

  const runtime = await deps.runtime.getSessionRuntime(episode.sessionId);
  const sessionOver = runtime == null || now >= runtime.plannedEndAtMs;

  let directive: RecoveryDirective;
  if (sessionOver) {
    // The session ended without a user decision while the app was dead. Session status and task
    // work_state are orthogonal: abandoning the session says nothing about the task, which keeps
    // its credited work and stays active.
    await closeSession(deps, { sessionId: episode.sessionId, now, status: 'abandoned' });
    directive = { kind: 'session_over', taskId: episode.taskId };
  } else if (now >= episode.blockEndAtMs) {
    directive = { kind: 'block_expired', taskId: episode.taskId };
  } else {
    directive = {
      kind: 'resume_block',
      taskId: episode.taskId,
      blockEndAtMs: episode.blockEndAtMs,
      blockKind: episode.blockKind,
      plannedMinutes: episode.plannedMinutes,
    };
  }

  // The recovered episode derives the SAME `episodeId` as the pre-crash one, which is what makes
  // design §14.2's device check ("the second run's crash_recovery record derives the same
  // episodeId as the first run's episode.start") answerable at all.
  captureContext.setEpisode({
    sessionId: episode.sessionId,
    taskId: episode.taskId,
    startedAtMs: episode.startedAtMs,
  });
  recordEpisodeClose(
    'recover',
    { episodeMinutes: creditedMinutes, interactionId, outcome: 'abandoned', coaching: [] },
    { recoveryDirective: directive.kind, creditMinutes: creditedMinutes },
  );
  record({ stream: 'lifecycle', type: 'crash_recovery', deltaMs: now - episode.startedAtMs });

  return {
    recovered: true,
    taskId: episode.taskId,
    sessionId: episode.sessionId,
    creditedMinutes,
    interactionId,
    directive,
    // Deliberately empty: a crash queues nothing. Not a skip, not a pause pattern, not a failure.
    coaching: [],
  };
}

// ── Session lapse (brief §1.5) ─────────────────────────────────────────────────────────────────

export interface SessionLapseResult {
  lapsed: boolean;
  coaching: CoachingEnqueued[];
}

/**
 * The session timer ran out while the app was waiting on a prompt. Return to the dashboard (task
 * 24's move) and queue a conversation for next start.
 *
 * `pattern_detected` + `trigger_data.kind`, not `session_ended_early`: the user did not end this
 * session early, it lapsed while they were deciding, and mislabelling it would put a false
 * "ended early" in front of the coach. This follows the same house pattern the extend amendment
 * set for `repeated_extension` and `long_extend` — data on an existing trigger type, no migration.
 * Deduplicated per session, so a caller may poll it.
 */
export async function checkSessionLapse(
  deps: EpisodeServiceDeps,
  input: { sessionId: string; now: number },
): Promise<SessionLapseResult> {
  const runtime = await deps.runtime.getSessionRuntime(input.sessionId);
  if (!runtime || input.now < runtime.plannedEndAtMs) return { lapsed: false, coaching: [] };

  const pending = await deps.coaching.priorityQueue();
  const already = pending.some(
    (entry) =>
      entry.triggerType === 'pattern_detected' &&
      entry.triggerData?.kind === 'session_lapsed' &&
      entry.relatedSessionIds.includes(input.sessionId),
  );
  if (already) return { lapsed: true, coaching: [] };

  await enqueueCoachingTrigger(deps.coaching, {
    trigger: 'pattern_detected',
    urgency: 'next_start',
    triggerData: { kind: 'session_lapsed' },
    relatedSessionIds: [input.sessionId],
  });
  const coaching: CoachingEnqueued[] = [{ trigger: 'pattern_detected', kind: 'session_lapsed' }];
  record({ stream: 'episode', type: 'session_lapse', lapsed: true, coachingEnqueued: coaching });
  return { lapsed: true, coaching };
}
