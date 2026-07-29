// Task 24 — the vocabulary the session flow is expressed in. Kept separate from the controller
// so screens can import the phase union without dragging the repositories in behind it.

import type { AgendaTaskItem, PlanOutcome } from '../../planning/agenda';
import type { EndOfBlockOption, EndOfBlockPrompt, TimerSnapshot } from '../../execution';
import type { Session, Task } from '../../types/domain';
import type { CoachingTrigger, SessionType } from '../../types/db';
import type { UserEnergy } from '../../types/scales';

/** The four session lengths offered at check-in. `minutes` is what the planner is given; the
 *  `type` is spec §5.3's band (Quick ≤10 / Moderate ≤45 / Deep Focus ≥60) and it decides whether
 *  the agenda gets breaks and a deep-focus block at all. */
export interface DurationChoice {
  label: string;
  minutes: number;
  type: SessionType;
}

export const DURATION_CHOICES: readonly DurationChoice[] = [
  { label: 'About 10 minutes', minutes: 10, type: 'quick' },
  { label: 'Half an hour', minutes: 30, type: 'moderate' },
  { label: 'An hour', minutes: 60, type: 'deep_focus' },
  { label: 'Two hours or more', minutes: 120, type: 'deep_focus' },
];

/**
 * Where the session flow currently is. ONE phase at a time, and the agenda behind it is never
 * rendered (spec §2.2/§6.2 — the plan is hidden; the user sees the task they are on and nothing
 * about what comes after it).
 */
export type SessionPhase =
  | { kind: 'check_in_energy' }
  | { kind: 'check_in_duration' }
  /** Also the "you're back" step on a recovered session, where energy is already known. */
  | { kind: 'check_in_context'; resuming: boolean }
  | { kind: 'planning' }
  /** The planner found nothing servable. `outcome` distinguishes §8.1's "no available tasks"
   *  coaching from §8.2's offer to SPLIT rather than end the session. */
  | { kind: 'plan_empty'; outcome: Exclude<PlanOutcome, 'planned'>; splitCandidate: Task | null }
  /** Spec §6.2's tools checklist, asked per task immediately before its block. */
  | { kind: 'tools'; item: AgendaTaskItem }
  | { kind: 'work'; item: AgendaTaskItem; episodeOpen: boolean }
  | { kind: 'prompt'; item: AgendaTaskItem; prompt: EndOfBlockPrompt; atBoundary: boolean }
  | { kind: 'break'; minutes: number; endsAtMs: number }
  /** A crash was recovered and the block had already expired: the credited work is safe and the
   *  task is parked; this asks what the user wants to do about it now. */
  | { kind: 'recovered'; task: Task; creditedMinutes: number }
  /** Coaching the engine queued at `immediate` urgency, which by definition must not wait for the
   *  next session (spec §7.2's third skip: "stop serving tasks and talk about what they can take
   *  on RIGHT NOW"). The shell opens the coach on this phase. */
  | { kind: 'coaching_interrupt'; trigger: CoachingTrigger; taskIds: number[] }
  | { kind: 'summary'; summary: SessionSummary };

export interface SessionSummary {
  session: Session | undefined;
  completed: number;
  parked: number;
  skipped: number;
  /** Titles of tasks whose repeated `+5` presses queued a `repeated_extension` conversation. The
   *  amendment's other half made visible (task 23 review §4.2): the button stays frictionless in
   *  the moment, and the estimate conversation is offered here, at the seam. */
  ranLongTitles: string[];
  /** True when the session ended because its planned time ran out while a prompt was open. */
  lapsed: boolean;
}

/** What the work screen renders. All of it is derived from the stored end-time — nothing ticks. */
export interface WorkView {
  timer: TimerSnapshot | null;
  /** mm:ss for the dominant face: remaining on a countdown, worked on a count-up. */
  display: string;
}

export type { AgendaTaskItem, EndOfBlockOption, EndOfBlockPrompt, TimerSnapshot, UserEnergy };
