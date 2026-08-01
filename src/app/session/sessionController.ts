// Task 24 — the session controller: the one place the product surface talks to task 13's episode
// engine and task 11's planner. It is a RENDERING LAYER's brain, not a second engine.
//
// WHAT LIVES HERE: the flow (check-in → hidden plan → tools check → block → the five options →
// tail → summary), the `sessions` row's creation, and the routing decisions each engine call
// hands back. WHAT DOES NOT: any timer arithmetic, any scoring, any planning, any completion
// fold. Every one of those already exists and is confirmed on-device; re-deriving one here would
// be the bug this task is most likely to introduce.
//
// FOUR CONSTRAINTS BIND EVERY LINE BELOW:
//   #11 a park is not a skip — `park` and `skip` are separate calls into separate primitives, and
//       nothing here ever downgrades one into the other.
//   #12 extend is TWO affordances — `+5` (flat, uncapped, no face change, NO nag ever) and
//       `Keep going` (hyperfocus). They are two methods; merging or capping them is a bug.
//   #13 the expiry alarm is a platform primitive, injected as EpisodeExpiryScheduler. Nothing in
//       this file schedules anything; the engine decides WHEN and the scheduler does it.
//   #14 the `sessions` row is BORN 'abandoned', so a crash leaves the truthful status behind.
//
// AND THE ONE THAT IS EASIEST TO GET WRONG: backgrounding is NOT a pause. `onForeground` below
// refreshes the view and re-reads the boundary; it never calls pauseEpisode.

import type { Rng, SessionCheckIn } from '../../scoring/score';
import type { TasksRepository } from '../../db/repositories/tasks';
import type { PlanningRepositories } from '../../planning/service';
import { planSessionFromRepositories, replanRemainingFromRepositories } from '../../planning/service';
import type { AgendaTaskItem, SessionPlan } from '../../planning/agenda';
import { firstWorkableWithTools } from '../../planning/agenda';
import type { PlanRequest } from '../../planning/planner';
import type { SessionsRepository } from '../../db/repositories/sessions';
import type { Session, Task } from '../../types/domain';
import type { SessionType } from '../../types/db';
import { userToInternalEnergy, type UserEnergy } from '../../types/scales';
import {
  MS_PER_MINUTE,
  applyHyperfocusExtension,
  applyShortExtension,
  checkSessionLapse,
  closeSession,
  completeEpisode,
  currentTimer,
  endOfBlockPrompt,
  escapeToEasier,
  minutesFromMs,
  parkEpisode,
  pauseEpisode,
  resumeEpisode,
  runTailDirective,
  selfCareNudgeDue,
  skipEpisode,
  startEpisode,
  startSessionRuntime,
  type CoachingEnqueued,
  type EpisodeCloseResult,
  type EpisodeServiceDeps,
  type RecoveryDirective,
  type TailDirective,
} from '../../execution';
import { BREAK_MINUTES } from '../../planning/planner';
import { urgencyForTrigger } from '../../services/coaching/triggers';
import { advanceRecurrence, sweepDateFrom, type RecurrenceSweepDeps } from '../../services/recurrence';
import type { SessionPhase, SessionSummary } from './types';

export interface SessionControllerDeps {
  /** Task 13's dependency bundle, including the injected expiry scheduler (constraint #13). */
  episode: EpisodeServiceDeps;
  /** Task 11's three planning reads. */
  planning: PlanningRepositories;
  /** The active pool, used only to derive the check-in's context/tool vocabulary. */
  catalog: Pick<TasksRepository, 'listActive'>;
  /** Task 36's period sweep. Session start is its second seam (the first is app open) — the app can
   *  sit open for days, and the plan must be built against today's due dates, not the ones that
   *  were current when the process started. */
  recurrence: RecurrenceSweepDeps;
  sessions: Pick<SessionsRepository, 'create' | 'getById' | 'update'>;
  /** Injected clock — the whole engine below it takes `now` as an argument, and so does this. */
  now: () => number;
  rng?: Rng;
  newSessionId?: () => string;
}

/** What the check-in has gathered so far, plus the identity of the running session once started. */
interface SessionState {
  sessionId: string | null;
  sessionType: SessionType;
  plannedMinutes: number;
  energy: UserEnergy | null;
  contexts: string[];
  /** Optimistic at planning time (see `plan()`); narrowed by the per-task tools check. */
  tools: string[];
  plan: SessionPlan | null;
  cursor: number;
  /** Coaching queued by the engine during this session — read for the summary's estimate note. */
  coaching: Array<CoachingEnqueued & { taskId?: number }>;
  lapsed: boolean;
}

export interface SessionControllerState {
  phase: SessionPhase;
  /** The active session's id, or null before check-in completes. */
  sessionId: string | null;
  /** The energy the session was started with — reused when a recovered session re-checks in. */
  energy: UserEnergy | null;
  /** Context vocabulary for the check-in, derived from the active pool (never a hardcoded list). */
  knownContexts: string[];
  busy: boolean;
  error: string | null;
}

type Listener = (state: SessionControllerState) => void;

function emptyState(): SessionState {
  return {
    sessionId: null,
    sessionType: 'moderate',
    plannedMinutes: 30,
    energy: null,
    contexts: [],
    tools: [],
    plan: null,
    cursor: 0,
    coaching: [],
    lapsed: false,
  };
}

/** mm:ss (or h:mm:ss past an hour) for the dominant timer face. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function createSessionController(deps: SessionControllerDeps) {
  let session = emptyState();
  let view: SessionControllerState = {
    phase: { kind: 'check_in_energy' },
    sessionId: null,
    energy: null,
    knownContexts: [],
    busy: false,
    error: null,
  };
  const listeners = new Set<Listener>();

  const rng = deps.rng;
  const nextSessionId = deps.newSessionId ?? (() => `s-${deps.now()}-${Math.floor(Math.random() * 1e6)}`);

  function publish(patch: Partial<SessionControllerState>): void {
    view = { ...view, ...patch };
    for (const listener of listeners) listener(view);
  }

  function setPhase(phase: SessionPhase): void {
    publish({ phase, sessionId: session.sessionId, energy: session.energy, error: null });
  }

  /** Wraps an async step so a repository failure lands as a message on screen rather than an
   *  unhandled rejection — a session that half-started is worse than one that says what broke.
   *
   *  It also LOGS. Phase B had a disposition fail silently: the error went into state, no session
   *  screen renders that state, and the flow moved on as if it had worked — which on a device looks
   *  exactly like a button that does nothing. Surfacing errors on the screens themselves is beta
   *  work; making them reachable from `adb logcat` is not optional. */
  async function guard<T>(step: () => Promise<T>): Promise<T | undefined> {
    publish({ busy: true, error: null });
    try {
      return await step();
    } catch (err) {
      console.warn('[todoAI] session step failed:', err);
      publish({ error: err instanceof Error ? err.message : String(err) });
      return undefined;
    } finally {
      publish({ busy: false });
    }
  }

  function checkIn(): SessionCheckIn {
    return { energy: session.energy ?? 'med', contexts: session.contexts, tools: session.tools };
  }

  function planRequest(): Omit<PlanRequest, 'sessionMinutes'> {
    return { sessionType: session.sessionType, checkIn: checkIn() };
  }

  function requireSessionId(): string {
    if (!session.sessionId) throw new Error('sessionController: no session is running');
    return session.sessionId;
  }

  // ── Check-in ─────────────────────────────────────────────────────────────────────────────

  /** Opens a fresh check-in. The context vocabulary is derived from the ACTIVE POOL rather than
   *  hardcoded, so it always offers exactly the contexts the user's own tasks are tagged with. */
  async function begin(): Promise<void> {
    session = emptyState();
    // Task 36's period sweep — session start is its second seam (app open is the first). It runs
    // before anything here reads the pool, and long before planning (which happens at
    // `setContexts`), so the agenda is built against today's due dates rather than the ones that
    // were current when the process started. Its own `guard` on purpose: a failed sweep must not
    // cost the user their session — the check-in proceeds on yesterday's dates, exactly as it did
    // before this engine existed, and `guard` logs the failure the way every other step does.
    await guard(() => advanceRecurrence(deps.recurrence, sweepDateFrom(deps.now())));
    await guard(async () => {
      const active = await deps.catalog.listActive();
      const counts = new Map<string, number>();
      for (const task of active) {
        for (const tag of task.contextTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const knownContexts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag);
      publish({ knownContexts });
    });
    setPhase({ kind: 'check_in_energy' });
  }

  /** Spec §6.2's energy check-in. Stored through `scales.ts` when the row is created — a raw
   *  user-facing value never reaches `sessions.user_energy_start` (constraint #6). */
  function setEnergy(energy: UserEnergy): void {
    session.energy = energy;
    setPhase({ kind: 'check_in_duration' });
  }

  function setDuration(minutes: number, sessionType: SessionType): void {
    session.plannedMinutes = minutes;
    session.sessionType = sessionType;
    setPhase({ kind: 'check_in_context', resuming: false });
  }

  /** The last check-in step. On a fresh check-in this CREATES the session; on a recovered one it
   *  only refreshes the context and replans the remainder. */
  async function setContexts(contexts: string[]): Promise<void> {
    session.contexts = contexts;
    if (session.sessionId) {
      await replanRemainder();
      return;
    }
    await startSession();
  }

  // ── Starting the session (the 13/24 boundary) ────────────────────────────────────────────

  /**
   * Creates the `sessions` row and hands the clock to task 13.
   *
   * The row is born **'abandoned'** (constraint #14): `sessions.status` has no in-progress value,
   * so a running session must carry a terminal one, and 'abandoned' is the truthful thing to find
   * after a crash. `closeSession` overwrites it on a clean end. Task 24 writes this row once, at
   * creation; every write after it is task 13's.
   */
  async function startSession(): Promise<void> {
    await guard(async () => {
      const startedAtMs = deps.now();
      const sessionId = nextSessionId();
      await deps.sessions.create(sessionId, {
        sessionType: session.sessionType,
        plannedDuration: session.plannedMinutes,
        status: 'abandoned',
        userEnergyStart: userToInternalEnergy(session.energy ?? 'med'),
      });
      session.sessionId = sessionId;
      await startSessionRuntime(deps.episode, {
        sessionId,
        startedAtMs,
        plannedMinutes: session.plannedMinutes,
      });
      setPhase({ kind: 'planning' });
      // Tools are assumed present at planning time and CONFIRMED per task (spec §6.2's order:
      // plan first, tools checklist second). Planning with an empty tool set would hard-filter
      // out every task that needs anything at all, which is the opposite of the intent.
      session.tools = await knownTools();
      const plan = await planSessionFromRepositories(
        deps.planning,
        { ...planRequest(), sessionMinutes: session.plannedMinutes },
        startedAtMs,
        rng,
      );
      await adoptPlan(plan);
    });
  }

  /** Every tool any active task requires — the optimistic set the plan is built against. */
  async function knownTools(): Promise<string[]> {
    const active = await deps.catalog.listActive();
    return [...new Set(active.flatMap((task) => task.toolRequirements))].sort();
  }

  async function adoptPlan(plan: SessionPlan): Promise<void> {
    session.plan = plan;
    session.cursor = 0;
    if (plan.outcome !== 'planned' || !plan.items.some((item) => item.kind === 'task')) {
      setPhase({
        kind: 'plan_empty',
        outcome: plan.outcome === 'planned' ? 'no_eligible_tasks' : plan.outcome,
        splitCandidate: plan.splitCandidate,
      });
      return;
    }
    await serveFrom(0);
  }

  // ── Walking the hidden agenda ────────────────────────────────────────────────────────────

  /** Serves the item at `index`, or ends the session when the agenda is exhausted. The agenda
   *  itself is never rendered — one task at a time is the whole contract (spec §2.2). */
  async function serveFrom(index: number): Promise<void> {
    const plan = session.plan;
    if (!plan) {
      await finish();
      return;
    }
    for (let i = index; i < plan.items.length; i++) {
      const item = plan.items[i];
      session.cursor = i;
      if (item.kind === 'break') {
        setPhase({
          kind: 'break',
          minutes: item.plannedMinutes,
          endsAtMs: deps.now() + item.plannedMinutes * MS_PER_MINUTE,
        });
        return;
      }
      setPhase(
        item.task.toolRequirements.length > 0
          ? { kind: 'tools', item }
          : { kind: 'work', item, episodeOpen: false },
      );
      return;
    }
    await finish();
  }

  /** Spec §6.2's missing-tools fallback. NOT a skip: no episode has opened, so there is nothing
   *  to decline — the app simply misjudged what the user has to hand, and re-plans around it. */
  async function toolsMissing(item: AgendaTaskItem): Promise<void> {
    await guard(async () => {
      const present = session.tools.filter((tool) => !item.task.toolRequirements.includes(tool));
      session.tools = present;
      const plan = session.plan;
      const workable = plan ? firstWorkableWithTools(plan, present) : null;
      const remaining = await remainingMinutes();
      const replanned = await replanRemainingFromRepositories(
        deps.planning,
        planRequest(),
        remaining,
        deps.now(),
        rng,
        { excludeTaskIds: new Set(await servedTaskIds()) },
      );
      if (replanned.outcome === 'planned' && replanned.items.some((i) => i.kind === 'task')) {
        await adoptPlan(replanned);
        return;
      }
      // The rebuild found nothing, but §6.2's first half may still have: offer that one task.
      if (workable) {
        setPhase({ kind: 'work', item: workable, episodeOpen: false });
        return;
      }
      await finish();
    });
  }

  function toolsConfirmed(item: AgendaTaskItem): void {
    setPhase({ kind: 'work', item, episodeOpen: false });
  }

  async function servedTaskIds(): Promise<number[]> {
    const sessionId = session.sessionId;
    if (!sessionId) return [];
    return deps.episode.interactions.listTaskIdsBySession(sessionId);
  }

  async function remainingMinutes(): Promise<number> {
    const sessionId = session.sessionId;
    if (!sessionId) return 0;
    const runtime = await deps.episode.runtime.getSessionRuntime(sessionId);
    if (!runtime) return 0;
    return minutesFromMs(Math.max(0, runtime.plannedEndAtMs - deps.now()));
  }

  // ── The block ────────────────────────────────────────────────────────────────────────────

  /** Opens the episode. Until this is pressed nothing durable exists for the task, so backing out
   *  of a task the user never started costs them nothing and records nothing. */
  async function beginBlock(item: AgendaTaskItem): Promise<void> {
    await guard(async () => {
      await startEpisode(deps.episode, {
        sessionId: requireSessionId(),
        item,
        now: deps.now(),
      });
      setPhase({ kind: 'work', item, episodeOpen: true });
    });
  }

  /** Re-opens the SAME block after a crash (recovery's `resume_block`): the original end-time is
   *  preserved, so the minutes that passed while the process was dead are not handed back. */
  async function resumeBlock(item: AgendaTaskItem, blockEndAtMs: number): Promise<void> {
    await guard(async () => {
      await startEpisode(deps.episode, {
        sessionId: requireSessionId(),
        item,
        now: deps.now(),
        blockEndAtMs,
      });
      setPhase({ kind: 'work', item, episodeOpen: true });
    });
  }

  /** Explicit user pause ONLY. Backgrounding must never reach this (task 13 report §8). */
  async function pause(): Promise<void> {
    await guard(() => pauseEpisode(deps.episode, deps.now()));
    publish({});
  }

  async function resume(): Promise<void> {
    await guard(() => resumeEpisode(deps.episode, deps.now()));
    publish({});
  }

  /**
   * Raises the five-option prompt.
   *
   * At a real boundary the engine supplies it (`endOfBlockPrompt`). When the user ends a block
   * EARLY the engine correctly returns null — the boundary hasn't been reached — so the same
   * shape is assembled here, minus the two extend options: "+5 minutes" and "Keep going" are
   * answers to "the block ran out and I need more", which is not what "I'm at a stopping point
   * with time still on the clock" is asking. The three dispositions are still the engine's, and
   * the 60-second park gate is still read from the engine's own snapshot, never re-derived.
   */
  async function requestEndOfBlock(item: AgendaTaskItem): Promise<void> {
    await guard(async () => {
      const now = deps.now();
      const atBoundary = await endOfBlockPrompt(deps.episode, now);
      if (atBoundary) {
        setPhase({ kind: 'prompt', item, prompt: atBoundary, atBoundary: true });
        return;
      }
      const episode = await deps.episode.runtime.getActiveEpisode();
      const snapshot = await currentTimer(deps.episode, now);
      if (!episode || !snapshot) {
        await finish();
        return;
      }
      setPhase({
        kind: 'prompt',
        atBoundary: false,
        item,
        prompt: {
          taskId: episode.taskId,
          face: snapshot.face,
          workedMinutes: minutesFromMs(snapshot.workedMs),
          hyperfocusQuanta: episode.hyperfocusQuanta,
          options: ['done', snapshot.parkAvailable ? 'park' : 'skip', 'easier'],
          selfCareNudge: selfCareNudgeDue(episode.hyperfocusQuanta),
        },
      });
    });
  }

  /** The boundary was reached while the user was on the work screen (or away and back). */
  async function pollBoundary(item: AgendaTaskItem): Promise<void> {
    const prompt = await endOfBlockPrompt(deps.episode, deps.now());
    if (prompt) setPhase({ kind: 'prompt', item, prompt, atBoundary: true });
  }

  // ── The two extends (constraint #12 — two affordances, never one) ────────────────────────

  /** `+5`. Flat, uncapped, countdown stays a countdown, nothing queued at press time, no nag. */
  async function plusFive(item: AgendaTaskItem): Promise<void> {
    await guard(async () => {
      await applyShortExtension(deps.episode);
      setPhase({ kind: 'work', item, episodeOpen: true });
    });
  }

  /** `Keep going`. One hyperfocus quantum; the face flips to count-up; the only path the §4.3
   *  self-care guardrail governs. */
  async function keepGoing(item: AgendaTaskItem): Promise<void> {
    await guard(async () => {
      const result = await applyHyperfocusExtension(deps.episode);
      session.coaching.push(...result.coaching.map((entry) => ({ ...entry, taskId: item.task.id })));
      setPhase({ kind: 'work', item, episodeOpen: true });
    });
  }

  // ── The three dispositions ───────────────────────────────────────────────────────────────

  /**
   * Declining or escaping from a task the user never STARTED.
   *
   * The work screen offers "Not this one" and the escape valve before the block begins, and both
   * of those are dispositions — but the engine's disposition calls all require an open episode and
   * throw without one, so before this existed those two buttons silently did nothing.
   *
   * The fix opens a ZERO-LENGTH episode first rather than reimplementing the outcome here. That
   * keeps every semantic in task 13 where it belongs — `skip_count`, the `task_skipped` follow-up,
   * the third-skip recalibration, the session counter, the interaction row — at the cost of one row
   * that is written and closed in the same breath. It also lands on the right side of the 60-second
   * gate for free: a task that was never started has worked 0 ms, so `parkAvailable` is false and
   * the engine treats an escape from it as a skip, which is exactly what declining an unstarted
   * task is.
   */
  async function ensureEpisodeForDisposition(): Promise<void> {
    const open = await deps.episode.runtime.getActiveEpisode();
    if (open) return;
    const phase = view.phase;
    if (phase.kind !== 'work') return;
    await startEpisode(deps.episode, {
      sessionId: requireSessionId(),
      item: phase.item,
      now: deps.now(),
    });
  }

  async function done(): Promise<void> {
    await closeWith(() => completeEpisode(deps.episode, deps.now()));
  }

  /** Park. Separate call, separate primitive, separate column — never reachable from `skip`. */
  async function park(): Promise<void> {
    await closeWith(() => parkEpisode(deps.episode, deps.now()));
  }

  async function skip(reason?: string): Promise<void> {
    await closeWith(async () => {
      await ensureEpisodeForDisposition();
      return skipEpisode(deps.episode, deps.now(), reason ? { reason } : undefined);
    });
  }

  async function somethingEasier(): Promise<void> {
    await closeWith(async () => {
      await ensureEpisodeForDisposition();
      return escapeToEasier(deps.episode, deps.now());
    });
  }

  async function closeWith(close: () => Promise<EpisodeCloseResult>): Promise<void> {
    await guard(async () => {
      const result = await close();
      session.coaching.push(
        ...result.coaching.map((entry) => ({ ...entry, taskId: result.taskId })),
      );

      // `immediate` means immediate. The third skip in a session says the plan has misjudged what
      // the user has right now, and spec §7.2's answer is to STOP SERVING TASKS and talk — so
      // walking on to the next agenda item would be doing exactly the thing the trigger fired to
      // prevent. The session closes first: the conversation is about what they can take on now,
      // and a fresh session after it is the rematch.
      const interrupt = result.coaching.find(
        (entry) => urgencyForTrigger(entry.trigger) === 'immediate',
      );
      if (interrupt) {
        await finish();
        setPhase({
          kind: 'coaching_interrupt',
          trigger: interrupt.trigger,
          taskIds: interrupt.trigger === 'task_skipped' ? [result.taskId] : [],
        });
        return;
      }

      await followTail(result.tail);
    });
  }

  /** Executes the directive the engine handed back. `regenerate` goes out to the planner (never
   *  a shift or a shrink in place — task 28 §4.2); `continue` walks on; `summary` ends. */
  async function followTail(directive: TailDirective): Promise<void> {
    if (directive.kind === 'summary') {
      await finish();
      return;
    }
    if (directive.kind === 'continue') {
      await serveFrom(session.cursor + 1);
      return;
    }
    const plan = await runTailDirective(deps.planning, planRequest(), directive, deps.now(), rng);
    if (!plan || plan.outcome !== 'planned' || !plan.items.some((item) => item.kind === 'task')) {
      await finish();
      return;
    }
    await adoptPlan(plan);
  }

  /** Re-plans whatever session time is left against a refreshed check-in. Used by the recovered
   *  session (its plan died with the process) and by a break that ran long (spec §8.2 — a long
   *  break re-plans the remaining time, and carries no guilt). */
  async function replanRemainder(): Promise<void> {
    await guard(async () => {
      const remaining = await remainingMinutes();
      if (remaining <= 0) {
        await finish();
        return;
      }
      setPhase({ kind: 'planning' });
      session.tools = await knownTools();
      const plan = await replanRemainingFromRepositories(
        deps.planning,
        planRequest(),
        remaining,
        deps.now(),
        rng,
        { excludeTaskIds: new Set(await servedTaskIds()) },
      );
      await adoptPlan(plan);
    });
  }

  // ── Breaks ───────────────────────────────────────────────────────────────────────────────

  /** Ends the break. An overrun of a full break length or more re-plans the tail rather than
   *  serving a stale one (spec §8.2's break-overrun caller of replanRemaining). */
  async function endBreak(breakEndAtMs: number): Promise<void> {
    const overrunMs = deps.now() - breakEndAtMs;
    if (overrunMs >= BREAK_MINUTES * MS_PER_MINUTE) {
      await replanRemainder();
      return;
    }
    await serveFrom(session.cursor + 1);
  }

  // ── Ending ───────────────────────────────────────────────────────────────────────────────

  /** The session's own clock ran out while a prompt sat unanswered. Polled, not pushed — the
   *  predicate deduplicates, so asking repeatedly is safe (task 13 report §7). */
  async function pollLapse(): Promise<boolean> {
    const sessionId = session.sessionId;
    if (!sessionId) return false;
    const result = await checkSessionLapse(deps.episode, { sessionId, now: deps.now() });
    if (!result.lapsed) return false;
    session.lapsed = true;
    session.coaching.push(...result.coaching);
    return true;
  }

  /** Closes the session cleanly and builds the summary. `status: 'completed'` overwrites the
   *  born-'abandoned' value (constraint #14) — the user got here, so the session did end. */
  async function finish(): Promise<void> {
    const sessionId = session.sessionId;
    if (!sessionId) {
      setPhase({ kind: 'summary', summary: emptySummary() });
      return;
    }
    await closeSession(deps.episode, { sessionId, now: deps.now(), status: 'completed' });
    const row = await deps.sessions.getById(sessionId);
    setPhase({ kind: 'summary', summary: await buildSummary(row) });
  }

  function emptySummary(): SessionSummary {
    return { session: undefined, completed: 0, parked: 0, skipped: 0, ranLongTitles: [], lapsed: false };
  }

  async function buildSummary(row: Session | undefined): Promise<SessionSummary> {
    const ranLongIds = [
      ...new Set(
        session.coaching
          .filter((entry) => entry.kind === 'repeated_extension' && entry.taskId != null)
          .map((entry) => entry.taskId as number),
      ),
    ];
    const titles: string[] = [];
    for (const taskId of ranLongIds) {
      const task = await deps.episode.tasks.getById(taskId);
      if (task) titles.push(task.title);
    }
    return {
      session: row,
      completed: row?.tasksCompleted ?? 0,
      parked: row?.tasksProgressed ?? 0,
      skipped: row?.tasksSkipped ?? 0,
      ranLongTitles: titles,
      lapsed: session.lapsed,
    };
  }

  /** The user's own end-of-session energy (spec §6.2's "energy check"). This and `userEnergyStart`
   *  are the two fields on the row nothing in task 13 can supply, so task 24 owns both — see the
   *  findings report's note on the 13/24 boundary. Projected through `scales.ts`. */
  async function recordEndEnergy(energy: UserEnergy): Promise<void> {
    const sessionId = session.sessionId;
    if (!sessionId) return;
    await guard(() =>
      deps.sessions.update(sessionId, { userEnergyEnd: userToInternalEnergy(energy) }),
    );
  }

  /** Ends the session from the dashboard's point of view. Safe to call with nothing running. */
  async function abandon(): Promise<void> {
    const sessionId = session.sessionId;
    if (!sessionId) return;
    await guard(() =>
      closeSession(deps.episode, { sessionId, now: deps.now(), status: 'completed' }),
    );
    session = emptyState();
  }

  // ── Crash recovery (routing only — recoverOpenEpisode has already run at launch) ─────────

  /**
   * Adopts a session that survived a crash. `recoverOpenEpisode` has already closed the episode
   * as abandoned, credited the time and left the task parked and active; all that is left is to
   * put the user back on the right screen.
   *
   * The PLAN did not survive the process — it is derived state, never persisted — so the tail is
   * regenerated from a refreshed check-in once the recovered task is dealt with. Energy comes back
   * off the `sessions` row; context is asked again, which is also the honest thing to do after an
   * unknown gap.
   */
  async function adoptRecoveredSession(input: {
    sessionId: string;
    directive: RecoveryDirective;
    creditedMinutes: number;
  }): Promise<void> {
    await guard(async () => {
      const row = await deps.sessions.getById(input.sessionId);
      session = emptyState();
      session.sessionId = input.sessionId;
      session.sessionType = row?.sessionType ?? 'moderate';
      session.plannedMinutes = row?.plannedDuration ?? 30;
      session.energy = energyFromRow(row);
      session.tools = await knownTools();

      if (input.directive.kind === 'session_over') {
        // recoverOpenEpisode already closed this one as 'abandoned'. Nothing to resume.
        setPhase({ kind: 'summary', summary: await buildSummary(row) });
        return;
      }

      const task = await deps.episode.tasks.getById(input.directive.taskId);
      if (!task) {
        await finish();
        return;
      }

      if (input.directive.kind === 'resume_block') {
        const item: AgendaTaskItem = {
          kind: 'task',
          task,
          blockKind: input.directive.blockKind,
          plannedMinutes: input.directive.plannedMinutes,
          deepFocus: false,
          resumeClaim: true,
        };
        await resumeBlock(item, input.directive.blockEndAtMs);
        return;
      }

      setPhase({ kind: 'recovered', task, creditedMinutes: input.creditedMinutes });
    });
  }

  function energyFromRow(row: Session | undefined): UserEnergy {
    const internal = row?.userEnergyStart;
    if (internal == null) return 'med';
    if (internal <= 2) return 'low';
    if (internal >= 4) return 'high';
    return 'med';
  }

  /**
   * The three answers to "your block expired while the app was gone".
   *
   * `keep_working` opens a fresh block on the same task. `done` opens a zero-length episode so the
   * completion goes through the normal fold (the crash credit is already in `accumulated_minutes`;
   * this adds nothing and folds the total into ONE history entry). `later` does nothing at all —
   * recovery already parked the task with its time, and inventing a second disposition on top of
   * that would double-record it. NONE of the three writes a skip: a crash is not user failure.
   */
  async function resolveRecovered(
    task: Task,
    choice: 'keep_working' | 'done' | 'later',
  ): Promise<void> {
    const item: AgendaTaskItem = {
      kind: 'task',
      task,
      blockKind: task.durationType === 'floor' ? 'openBlock' : 'countdown',
      plannedMinutes: Math.max(1, task.estimatedDuration - task.accumulatedMinutes),
      deepFocus: false,
      resumeClaim: true,
    };
    if (choice === 'keep_working') {
      await beginBlock(item);
      return;
    }
    if (choice === 'done') {
      await guard(async () => {
        const now = deps.now();
        await startEpisode(deps.episode, { sessionId: requireSessionId(), item, now });
        const result = await completeEpisode(deps.episode, now);
        session.coaching.push(
          ...result.coaching.map((entry) => ({ ...entry, taskId: result.taskId })),
        );
      });
    }
    setPhase({ kind: 'check_in_context', resuming: true });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  /**
   * The app came back to the foreground.
   *
   * IT DOES NOT PAUSE. Backgrounding is normal — music, a phone call, work that happens on the
   * phone itself — and reading it as abandonment would punish the user for using their device
   * (task 13 report §8). The timer is timestamp-based, so the only thing that can have changed is
   * whether the boundary passed while the app was away; that is what this checks.
   */
  async function onForeground(): Promise<void> {
    const phase = view.phase;
    if (phase.kind === 'work' && phase.episodeOpen) {
      await pollBoundary(phase.item);
    }
    publish({});
  }

  return {
    getState: () => view,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The live timer reading — recomputed from the stored end-time on every call, never ticked. */
    readTimer: () => currentTimer(deps.episode, deps.now()),
    begin,
    setEnergy,
    setDuration,
    setContexts,
    toolsConfirmed,
    toolsMissing,
    beginBlock,
    pause,
    resume,
    requestEndOfBlock,
    pollBoundary,
    plusFive,
    keepGoing,
    done,
    park,
    skip,
    somethingEasier,
    endBreak,
    pollLapse,
    finish,
    recordEndEnergy,
    abandon,
    adoptRecoveredSession,
    resolveRecovered,
    replanRemainder,
    onForeground,
  };
}

export type SessionController = ReturnType<typeof createSessionController>;
