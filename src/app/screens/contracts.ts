// Task 24 — the props every screen is built against.
//
// The screens are PURELY PRESENTATIONAL: they take values and callbacks and render them. No screen
// imports a repository, a service, `src/execution`, `src/planning`, or a clock. Everything that
// decides anything lives in the controllers (`../session`, `../chat`, `../tasks`), which is what
// makes the flow testable without rendering and the screens replaceable at the beta-gate designed
// pass without touching a line of behaviour.

import type { EndOfBlockOption, SessionSummary, TimerSnapshot } from '../session/types';
import type { DurationChoice, UserEnergy } from '../session/types';
import type { ChatMessageView, ChatStatus } from '../chat/chatController';
import type { AlarmStatus } from '../alarm/episodeExpiryScheduler';
import type { DraftValidation, TaskDraft } from '../tasks/taskDraft';
import type { PlanOutcome } from '../../planning/agenda';
import type { SessionPerformanceStats } from '../../types/domain';

// ── Dashboard ────────────────────────────────────────────────────────────────────────────────

export interface DashboardProps {
  /** With no tasks at all, "Add task" is the only sensible thing on screen (the prototype's
   *  empty state) — don't offer to start a session that can have no agenda. */
  hasTasks: boolean;
  onStartWork: () => void;
  onAddTask: () => void;
  onReviewTasks: () => void;
  onMetrics: () => void;
  onSettings: () => void;
}

// ── Task list + editor ───────────────────────────────────────────────────────────────────────

export interface TaskListRow {
  id: number;
  title: string;
  /** e.g. "3× a week on Mon/Wed · In progress". Built by the controller. */
  summary: string;
  /** Task 44 §0 ruling 1 — true for a dependency-blocked task OR one held for R7
   *  `breakdown_complete`. Both quick-start and self-complete are disabled when true. */
  blocked: boolean;
  /** The visible reason ("blocked by X"), non-null iff `blocked`. A disabled button with a
   *  reason, never a hidden one (brief §3). */
  blockedReason: string | null;
}

export interface TaskListProps {
  rows: TaskListRow[];
  onOpen: (taskId: number) => void;
  onAdd: () => void;
  onBack: () => void;
  /** Task 44 §3 — launches a normal, full-check-in session for exactly this one task. */
  onQuickStart: (taskId: number) => void;
  /** Task 44 §4 — marks a task done that was finished away from the app. */
  onSelfComplete: (taskId: number) => void;
  /** True while a self-complete write for that row is in flight (prevents a double-tap). */
  selfCompletingTaskId: number | null;
}

export interface TaskEditorProps {
  draft: TaskDraft;
  validation: DraftValidation;
  /** Patch-merge into the draft. The screen never rebuilds the whole draft itself. */
  onChange: (patch: Partial<TaskDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  /** False when other tasks depend on this one — the delete control shows disabled with the
   *  reason beneath it rather than vanishing (the prototype's dependency-protected delete). */
  canDelete: boolean;
  saving: boolean;
  onBack: () => void;
}

// ── The check-in (spec §6.2: energy → duration → context) ────────────────────────────────────

export interface CheckInEnergyProps {
  onSelect: (energy: UserEnergy) => void;
  onBack: () => void;
}

export interface CheckInDurationProps {
  choices: readonly DurationChoice[];
  onSelect: (choice: DurationChoice) => void;
  onBack: () => void;
}

export interface CheckInContextProps {
  /** Derived from the user's own active tasks — never a hardcoded list. */
  known: string[];
  selected: string[];
  onToggle: (context: string) => void;
  onDone: () => void;
  onBack: () => void;
  /** True when this is the "you're back after a crash" re-check rather than a fresh session. */
  resuming: boolean;
}

export interface ToolsCheckProps {
  taskTitle: string;
  tools: string[];
  onConfirm: () => void;
  /** "Not with me" — the app re-plans around it. Framed as the app's misjudgement, not a decline. */
  onMissing: () => void;
  onBack: () => void;
}

// ── Execution ────────────────────────────────────────────────────────────────────────────────

export interface WorkProps {
  taskTitle: string;
  /** True for a task being picked back up — the prototype's quiet "Picking this back up". */
  resumed: boolean;
  /** Set after the escape valve has re-planned, explaining why this task is different. */
  easierNote: string | null;
  /** Null before the user presses START: nothing durable exists yet. */
  timer: TimerSnapshot | null;
  /** mm:ss for the dominant face. */
  display: string;
  /** 0–1, for the ring. */
  progress: number;
  onStart: () => void;
  /** The timer face IS the pause control (the prototype's interaction). */
  onTogglePause: () => void;
  onEndBlock: () => void;
  /** Always present, always low-emphasis (design principle #2). */
  onSomethingEasier: () => void;
  /** Before the block starts, declining costs nothing and records nothing. */
  onNotThisOne: () => void;
  onBack: () => void;
}

export interface EndOfBlockProps {
  taskTitle: string;
  workedMinutes: number;
  /** Exactly what the engine offered. `park` and `skip` are mutually exclusive — the engine
   *  substitutes `skip` inside the 60-second gate, and the screen must render whichever it got
   *  rather than deciding for itself. */
  options: readonly EndOfBlockOption[];
  /** The §4.3 self-care line, every second consecutive hyperfocus quantum. Never after a `+5`. */
  selfCareNudge: boolean;
  /** False when the user ended the block early — the two extends are absent in that case. */
  atBoundary: boolean;
  onDone: () => void;
  onPlusFive: () => void;
  onKeepGoing: () => void;
  onPark: () => void;
  onSkip: () => void;
  onSomethingEasier: () => void;
}

export interface BreakProps {
  minutes: number;
  display: string;
  onContinue: () => void;
}

export interface RecoveredProps {
  taskTitle: string;
  creditedMinutes: number;
  onKeepWorking: () => void;
  onDone: () => void;
  onLater: () => void;
}

// Task 44 §3 — the check-in warning screen (ruling §0.4). Fires when any condition the ordinary
// capability pre-filter would have checked — wrong context, missing tools, doesn't fit the time —
// would have filtered this task out, had it gone through the pool instead of being hand-picked.
export interface QuickStartWarningProps {
  taskTitle: string;
  /** One sentence per failed condition, already worded for display (the controller reuses the
   *  real `src/planning/` predicates to build these — see sessionController's `quickStartReasons`). */
  reasons: string[];
  /** Proceeding is allowed — the point is informed consent, not a block. */
  onProceedAnyway: () => void;
  onBack: () => void;
}

// Task 14 §13 — the session-start gate's refusal screen (surface A). Shown when the pre-session
// backup could not be taken, so the session must NOT start: spec §8.4 blocks rather than degrades,
// and the block happens before `sessions.create`, so no session row exists behind this screen.
// Purely presentational — `reason` is the gate's own discriminant and `detail` its raw message.
export interface SessionBlockedProps {
  /** 'no_space' → a backup couldn't be written for lack of space (the primary case); 'integrity'
   *  → the working database failed its pre-session quick-check and needs the launch-time recovery
   *  ladder, which only runs on a fresh start (see the wiring report's scope note). */
  reason: 'no_space' | 'integrity';
  /** The gate's `detail`: the specific space/SQLite message. Shown small (for support/adb), never
   *  as the headline. */
  detail: string;
  /** Leaves the flow back to the dashboard. Nothing to abandon — no session was created. */
  onDismiss: () => void;
}

// Task 14 §13 — the launch recovery-acknowledgement screen (surface B). Shown once at launch when
// the recovery ladder acted (`requiresAcknowledgement`), before the dashboard. Purely presentational:
// the controller (`buildRecoveryAck`) turns the `RecoveryOutcome` into these plain-language strings,
// so this screen imports nothing from `src/services/backup`.
export interface RecoveryAckProps {
  title: string;
  body: string;
  /** One short line per thing worth telling the user — what was recovered, what was lost, where a
   *  restore came from. May be empty. */
  details: string[];
  /** True on total loss (`unrecoverable`): the tone is graver and the button copy differs. */
  grave: boolean;
  onAcknowledge: () => void;
}

export interface PlanEmptyProps {
  outcome: Exclude<PlanOutcome, 'planned'>;
  /** For `nothing_fits`: the task to offer splitting rather than ending the session. */
  splitCandidateTitle: string | null;
  onSplit: () => void;
  onCoach: () => void;
  onBack: () => void;
}

export interface SessionSummaryProps {
  summary: SessionSummary;
  /** Spec §6.2's end-of-session energy check. Optional — the user may just leave. */
  energy: UserEnergy | null;
  onEnergy: (energy: UserEnergy) => void;
  /** Offered only when a task ran long enough to queue a `repeated_extension` conversation. */
  onRevisitEstimate: (() => void) | null;
  onDone: () => void;
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────

export interface ChatProps {
  title: string;
  messages: ChatMessageView[];
  status: ChatStatus;
  error: string | null;
  canSave: boolean;
  canResolve: boolean;
  savedTaskTitle: string | null;
  resolution: string | null;
  onSend: (text: string) => void;
  onSave: () => void;
  onResolve: () => void;
  onBack: () => void;
}

// ── Metrics + settings (minimal for personal ship) ───────────────────────────────────────────

export interface MetricsProps {
  activeTaskCount: number;
  inProgressCount: number;
  /** From the `recent_session_performance` view — last 30 days by session type. */
  performance: SessionPerformanceStats[];
  onBack: () => void;
}

export interface SettingsProps {
  alarm: AlarmStatus;
  notificationsGranted: boolean;
  onOpenAlarmSettings: () => void;
  onRequestNotifications: () => void;
  modelPhase: 'idle' | 'loading' | 'checking_grammars' | 'ready' | 'failed';
  schemaVersion: string;
  onBack: () => void;
}
