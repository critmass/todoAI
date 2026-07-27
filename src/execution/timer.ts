// Task 13 — the timer arithmetic, pure. No repositories, no wall-clock read: every function here
// takes `now` (epoch ms) as an argument, which is what makes block expiry, session lapse, extend
// chaining, the 60-second gate, the >20% pause rule and crash-recovery credit all testable
// headless (brief §5, Phase A).
//
// THE INVARIANT EVERYTHING ELSE RESTS ON (spec §8.2): the app stores an END-TIME and computes
// remaining from the wall clock. It never counts ticks and never trusts an accumulator. State is
// persisted at task start and after a pause only — not per tick — because the stored end-time is
// already sufficient: while the app is dead the timer "keeps running" simply because wall time
// passes and the end-time does not move.
//
// PAUSING MOVES THE END-TIME. On resume, `blockEndAtMs` is pushed out by the pause duration, so
// an interruption never eats the block. This is exactly why §8.2 requires a persist after every
// pause: the end-time is the state, so a changed end-time must be durable before the next crash.

import type { ActiveEpisode } from '../types/domain';
import type { Task } from '../types/domain';
import { treatedAsOpenEnded } from '../planning/plannedMinutes';
import {
  EXTEND_QUANTUM_MINUTES,
  GUARDRAIL_LONG_EXTEND_THRESHOLD,
  GUARDRAIL_SELF_CARE_NUDGE,
  LONG_EXTEND_BLOCK_MULTIPLE,
  PARK_GATE_MS,
  PAUSE_COACHING_RATIO,
  REPEATED_EXTENSION_ESTIMATE_FRACTION,
  REPEATED_EXTENSION_MINUTES_FLOOR,
  REPEATED_EXTENSION_PRESS_COUNT,
  SELF_CARE_NUDGE_EVERY_QUANTA,
  SHORT_EXTENSION_MINUTES,
} from './constants';

export const MS_PER_MINUTE = 60_000;

/** Episode minutes, rounded to the nearest whole minute. One rounding rule for every consumer —
 *  the completion fold, the park credit, and the crash credit all report the same number for the
 *  same elapsed time, so a task worked in five sittings cannot drift against its own history. */
export function minutesFromMs(ms: number): number {
  return Math.round(Math.max(0, ms) / MS_PER_MINUTE);
}

/** Which face the execution screen runs. An extend stretch counts UP on ANY task regardless of
 *  blockKind (design §3.1) — but only the hyperfocus path switches the face; a `+5` leaves a
 *  countdown a countdown (amendment §1). */
export type TimerFace = 'countdown' | 'countup';

export interface TimerSnapshot {
  face: TimerFace;
  /** Wall time since the episode opened, pauses INCLUDED. */
  elapsedWallMs: number;
  /** Time actually worked: wall elapsed minus every pause, including one still open. Frozen while
   *  paused. This is what the 60-second gate, the episode's reported minutes, and the pause ratio
   *  are all computed from. */
  workedMs: number;
  /** Countdown face: time left in the block. Frozen while paused (the end-time moves on resume).
   *  Negative once the boundary has passed with the prompt still unanswered. */
  remainingMs: number;
  paused: boolean;
  pausedMs: number;
  /** The block boundary has been reached. For a countdown this is the timer hitting zero; for an
   *  openBlock it is the gross boundary being met — which RAISES THE PROMPT rather than ending
   *  anything (brief §1.1). Both routes lead to the same five-option prompt. */
  boundaryReached: boolean;
  /** Whether "Pause for later" may be offered yet (design §1.3's 60-second gate). Before this, a
   *  bail is an ordinary skip. */
  parkAvailable: boolean;
}

function openPauseMs(episode: ActiveEpisode, at: number): number {
  if (episode.pausedAtMs == null) return 0;
  return Math.max(0, at - episode.pausedAtMs);
}

/** Worked time at `now` — wall elapsed minus closed pauses minus any open pause. While paused
 *  this is frozen at the moment the pause began, which is the whole point of tracking the open
 *  pause separately rather than only its total. */
export function workedMs(episode: ActiveEpisode, now: number): number {
  const wall = Math.max(0, now - episode.startedAtMs);
  return Math.max(0, wall - episode.pausedMs - openPauseMs(episode, now));
}

export function timerSnapshot(episode: ActiveEpisode, now: number): TimerSnapshot {
  const paused = episode.pausedAtMs != null;
  // While paused the clock stands still: read remaining against the pause instant, not `now`.
  const reference = episode.pausedAtMs ?? now;
  const remainingMs = episode.blockEndAtMs - reference;
  const worked = workedMs(episode, now);
  return {
    face: episode.hyperfocusQuanta > 0 || episode.blockKind === 'openBlock' ? 'countup' : 'countdown',
    elapsedWallMs: Math.max(0, now - episode.startedAtMs),
    workedMs: worked,
    remainingMs,
    paused,
    pausedMs: episode.pausedMs + openPauseMs(episode, now),
    boundaryReached: remainingMs <= 0,
    parkAvailable: worked >= PARK_GATE_MS,
  };
}

// ── Extension arithmetic ───────────────────────────────────────────────────────────────────────

/** `+5 minutes`: move the block end by a flat five. No cap, no nudge, no promotion to hyperfocus,
 *  ever — press it ten times if that is what the task needs. Not knowing how much longer something
 *  will take is the executive-function symptom this app exists to absorb, not a behavior to
 *  correct; a cap here would turn the button into an accusation (amendment §2, ruled). */
export function shortExtensionEnd(blockEndAtMs: number): number {
  return blockEndAtMs + SHORT_EXTENSION_MINUTES * MS_PER_MINUTE;
}

/** `Keep going`: move the block end by one hyperfocus quantum. Chaining is allowed. */
export function hyperfocusExtensionEnd(blockEndAtMs: number): number {
  return blockEndAtMs + EXTEND_QUANTUM_MINUTES * MS_PER_MINUTE;
}

// ── The guardrail (option B, hyperfocus only) ──────────────────────────────────────────────────

/** True when the end-of-block prompt should carry the one-line self-care check: every second
 *  consecutive hyperfocus quantum (~50 min). One tap still continues; never blocking. Reads only
 *  `hyperfocusQuanta`, so a chain of `+5` presses can never reach it. */
export function selfCareNudgeDue(hyperfocusQuanta: number): boolean {
  if (!GUARDRAIL_SELF_CARE_NUDGE) return false;
  return hyperfocusQuanta > 0 && hyperfocusQuanta % SELF_CARE_NUDGE_EVERY_QUANTA === 0;
}

/** True when the hyperfocus stretch has grown beyond `LONG_EXTEND_BLOCK_MULTIPLE` x the ORIGINAL
 *  block. Expressed against the quanta rather than the current block end precisely so that `+5`
 *  minutes — which also move the block end — cannot contribute to it (amendment §4). */
export function longExtendThresholdCrossed(
  plannedMinutes: number,
  hyperfocusQuanta: number,
): boolean {
  if (!GUARDRAIL_LONG_EXTEND_THRESHOLD) return false;
  const addedMinutes = hyperfocusQuanta * EXTEND_QUANTUM_MINUTES;
  return addedMinutes > plannedMinutes * (LONG_EXTEND_BLOCK_MULTIPLE - 1);
}

// ── Repeated `+5` → a conversation at task close ───────────────────────────────────────────────

export type RepeatedExtensionArm = 'count' | 'percentage';

export interface ShortExtensionTotals {
  presses: number;
  minutes: number;
}

/**
 * Which arm (if either) of the `repeated_extension` trigger has tripped for one task in one
 * session — whichever comes first (amendment §3):
 *
 *   count arm      the 3rd `+5` press.
 *   percentage arm cumulative `+5` minutes >= 50% of `estimated_duration`, subject to a >= 10
 *                  cumulative-minute floor.
 *
 * FLOOR-TYPED TASKS AND BLOWN ESTIMATES USE THE COUNT ARM ONLY: a floor has no ceiling to be past,
 * and running long there is definitionally not an estimation error. `treatedAsOpenEnded` is task
 * 11's own predicate — the same one that decides `blockKind` — so the two can never disagree
 * about what "already being treated as an open block" means.
 */
export function repeatedExtensionArm(
  totals: ShortExtensionTotals,
  task: Task,
): RepeatedExtensionArm | null {
  if (totals.presses >= REPEATED_EXTENSION_PRESS_COUNT) return 'count';
  if (treatedAsOpenEnded(task)) return null;
  const percentageThreshold = task.estimatedDuration * REPEATED_EXTENSION_ESTIMATE_FRACTION;
  if (totals.minutes >= REPEATED_EXTENSION_MINUTES_FLOOR && totals.minutes >= percentageThreshold) {
    return 'percentage';
  }
  return null;
}

// ── Pause accounting (spec §8.2) ───────────────────────────────────────────────────────────────

/** Fraction of the episode spent paused, over wall time. 0 for a zero-length episode. */
export function pauseRatio(episode: ActiveEpisode, now: number): number {
  const wall = Math.max(0, now - episode.startedAtMs);
  if (wall === 0) return 0;
  return (episode.pausedMs + openPauseMs(episode, now)) / wall;
}

export function pauseCoachingDue(episode: ActiveEpisode, now: number): boolean {
  return pauseRatio(episode, now) > PAUSE_COACHING_RATIO;
}

// ── Crash-recovery credit (design §1.4) ────────────────────────────────────────────────────────

/**
 * Milliseconds to credit to `accumulated_minutes` when an open episode is found at relaunch:
 * `elapsed - known pause time`, with elapsed BOUNDED BY THE BLOCK END.
 *
 * The bound is not an addition to the design — it is §1.4 composed with §1.1's own timer
 * semantics. The block end is when the stretch was scheduled to stop and raise the prompt; the
 * app cannot have been working past a boundary it would have stopped at. Without the bound, a
 * crash followed by a relaunch three days later would credit three days of "work", which is not
 * the generous-but-bounded choice §1.4 argues for — it is unbounded, and it would poison the one
 * `actual_duration_history` entry the fold eventually writes.
 *
 * A pause left open by the crash is subtracted too, clamped to the same bound: if the app died
 * while paused, the dead time reads as pause, which errs toward crediting LESS work. That is the
 * safe direction — over-crediting corrupts learning, under-crediting only costs a few minutes in
 * a cumulative total.
 */
export function recoveryCreditMs(episode: ActiveEpisode, now: number): number {
  const boundedEnd = Math.min(now, episode.blockEndAtMs);
  const wall = Math.max(0, boundedEnd - episode.startedAtMs);
  const openPause =
    episode.pausedAtMs == null ? 0 : Math.max(0, boundedEnd - episode.pausedAtMs);
  return Math.max(0, wall - episode.pausedMs - openPause);
}
