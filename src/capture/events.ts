// Task 41 — the event union. Exhaustive by construction: a new stream cannot be added without a
// ./streams.ts entry (which forces an egress class and a ladder fate), and a stream's records
// cannot be written without a member of this union.
//
// THIS IS WHAT MAKES REMOVABILITY VERIFIABLE RATHER THAN ASSERTED (design §11). Delete a member
// here and `npx tsc --noEmit` names every call site that wrote it. Task 42's bundle-grep becomes
// a confirmation of something the compiler already proved, rather than the only evidence.
//
// A call site supplies ONLY the fields below. The envelope (design §3.1 — v, seq, run, wallMs,
// monoMs, sessionId, episodeId, taskId, dropped) is stamped by record(); no call site may set it.

import type { CoachingTrigger, EpisodeBlockKind, SessionType } from '../types/db';
import type { ChatMessage, GenerationTimings, ModelTier } from '../llm/provider/types';

// ── free text ──────────────────────────────────────────────────────────────────────────────

/**
 * Every conversational turn, both directions, verbatim.
 *
 * ON `kind`, AND ON NOT PRETENDING TO KNOW MORE THAN THE CODE DOES (design §5.1). The app cannot
 * know whether the model asked a question or recapped: `proseTurn` appends one instruction,
 * `buildExtractionRecapInstruction()`, that means "recap OR ask the one question". So the tag is
 * the STRUCTURAL fact — the coach turn that ran under that instruction is `recap_or_clarify`, and
 * the user turn that follows it is `clarify_answer`. A heuristic ("did it end in a question
 * mark") would write a guess into the permanent record as though it were observed. Task 31 makes
 * the semantic call at annotation time with the full text in front of it.
 */
export interface ConversationEvent {
  stream: 'conversation';
  type: 'turn';
  from: 'user' | 'coach';
  purpose: 'task_input' | 'coaching';
  trigger?: CoachingTrigger;
  kind: 'opening' | 'user' | 'recap_or_clarify' | 'clarify_answer' | 'reply' | 'crisis_referral';
  /** VERBATIM. No trim, no normalisation, no truncation — the typos and abbreviations ARE the
   *  signal for task 31 (brief §2). */
  text: string;
  /** design §5.2 — without it every relative due date in the corpus is unresolvable. */
  todayISO: string;
  queueEntryId?: number;
}

export interface ModelTextEvent {
  stream: 'modeltext';
  type: 'call';
  /** The composed array AS SENT, verbatim. */
  messages: ChatMessage[];
  /** The raw completion BEFORE any parse — brief §1's second instance of thrown-away data. */
  raw: string;
}

export interface MutationTextEvent {
  stream: 'mutationtext';
  type: 'value';
  entityId: number;
  field: string;
  before: string | null;
  after: string | null;
}

/**
 * The crisis gate's input and verdict on EVERY turn it ran on, hit or clear — ruled by Jason
 * 2026-08-17 (amendment §2, option (c)), superseding the parent design's §5.9 near-miss list.
 *
 * `patternIndex` is deliberately absent. Getting it would mean widening `checkCrisis`'s return
 * type — touching a safety-gate file for a logging convenience — or re-running the patterns
 * inside capture, which reintroduces exactly the matcher option (c) was chosen to avoid. The
 * reviewer has the verbatim text and the regexes are in the repo. CAPTURE READS THE DETECTOR'S
 * VERDICT AND WRITES NOTHING BACK.
 */
export interface CrisisEvent {
  stream: 'crisis';
  type: 'gate';
  verdict: 'hit' | 'clear';
  text: string;
  /** Two gates, not one: `runCoachingResolution` runs its own `checkCrisis` at disposition time. */
  surface: 'chat_send' | 'coaching_resolution';
  purpose: 'task_input' | 'coaching';
}

// ── structured ─────────────────────────────────────────────────────────────────────────────

export type ModelRung =
  | 'first'
  | 'retry'
  | 'unconstrained_first'
  | 'unconstrained_retry'
  | 'prose';

export interface ModelIoEvent {
  stream: 'modelio';
  type: 'call';
  /** `seq` of the `modeltext` record holding the actual strings. */
  textRef: number | null;
  surface: string;
  constrained: boolean;
  grammarId: string | null;
  /** SHA-256 (first 8 hex chars) of the EXPANDED grammar text actually handed to llama.cpp, so a
   *  pre- and post-task-37 grammar are distinguishable in the log. The full text is a constant
   *  that lives in git; storing 5,090 bytes per attempt to duplicate it is the wrong trade
   *  (design §5.3). Verifiable host-side with `sha256sum`. */
  grammarSha8: string | null;
  /** `buildGrammar`'s substitutions — the only part of a grammar that varies per call. */
  grammarSlots: Record<string, string[]> | null;
  rung: ModelRung;
  attempt: 1 | 2;
  maxTokens: number;
  temperature: number | null;
  topK: number | null;
  truncated: boolean;
  timings: GenerationTimings | null;
  model: { tier: ModelTier | null; available: boolean };
  /** Measured around generateResponse, wall clock. */
  latencyMs: number;
  outcome: 'ok' | 'parse_failed' | 'validation_failed' | 'truncated' | 'threw';
  todayISO?: string;
}

export interface ValidationEvent {
  stream: 'validation';
  type: 'failure';
  /** `seq` of the `modeltext` record whose `raw` failed. */
  textRef: number | null;
  surface: string;
  issues: string[];
  attempt: 1 | 2;
  errorKind: 'validation' | 'parse' | 'truncated' | 'other';
  errorMessage: string;
}

/**
 * The actor vocabulary, ruled by Jason 2026-08-17 (amendment §3), superseding the parent design's
 * `user | model | system`. `model` was the wrong word: the thing acting is the coaching surface,
 * not the inference engine, and `coach` is the vocabulary the app already speaks.
 *
 * `planner` IS A SENTINEL WHOSE EXPECTED COUNT IS ZERO, and its emptiness is its value. A
 * `planner` row is direct evidence that `src/planning/`'s stated-but-unenforced `PlanAdjustment`
 * contract has been violated (orientation §3). Nothing may be attributed to it by default or by a
 * fallback branch: every enumerated writer is attributed explicitly at the wiring point in
 * `src/app/appServices.ts`, and `planner` is only what a repository wrapper records when it is
 * invoked through a bundle that named no actor. A `planner` row is always a fact about the code,
 * never a shrug.
 */
export type MutationActor = 'user' | 'coach' | 'system' | 'planner';

export type MutationSurface =
  | 'editor'
  | 'chat_extraction'
  | 'coaching_dispatch'
  | 'recurrence_sweep'
  | 'completion_fold'
  | 'episode_close'
  /** Paired with actor `planner` only — the sentinel's surface. */
  | 'unattributed';

export interface MutationEvent {
  stream: 'mutation';
  type: 'task' | 'recurrence' | 'dependency' | 'create' | 'delete';
  entityId: number;
  /** Domain field name, camelCase, matching src/types/domain.ts. */
  field: string;
  /** Structured fields only. Free-text fields carry lengths plus a `textRef` instead — that split
   *  is what lets the REST of mutation survive open beta (design §5.5). */
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  textRef?: number;
  beforeLen?: number;
  afterLen?: number;
  actor: MutationActor;
  surface: MutationSurface;
}

export type EpisodeEventType =
  | 'session_start'
  | 'session_close'
  | 'session_lapse'
  | 'start'
  | 'pause'
  | 'resume'
  | 'boundary_reached'
  | 'extend_short'
  | 'extend_hyperfocus'
  | 'complete'
  | 'park'
  | 'skip'
  | 'escape'
  | 'recover';

export interface EpisodeEvent {
  stream: 'episode';
  type: EpisodeEventType;
  /**
   * ABSENT UNTIL TASK 44 LANDS, AND DELIBERATELY NOT GUESSED. `sessions.origin` (migration 007)
   * is task 44's, ruled 2026-08-07; nothing in the tree records origin today, so capture has no
   * truthful value to write and writes none. Task 44 wires it by calling
   * `captureContext.setSession(id, origin)`; until then this field is simply absent, which is a
   * legible gap rather than a fabricated `'planned'` on every row.
   */
  origin?: 'planned' | 'quickstart';
  blockKind?: EpisodeBlockKind;
  plannedMinutes?: number;
  actualMinutes?: number;
  workedMs?: number;
  pausedMs?: number;
  pauseCount?: number;
  hyperfocusQuanta?: number;
  shortExtensions?: number;
  outcome?: string;
  tail?: string;
  /** The one id shared between capture and the product database, so a corrupted-DB investigation
   *  can go the other way too. */
  interactionId?: number;
  creditMinutes?: number;
  recoveryDirective?: string;
  coachingEnqueued?: Array<{ trigger: CoachingTrigger; kind?: string }>;
  sessionStatus?: string;
  lapsed?: boolean;
  reason?: string;
}

export interface PlanningEvent {
  stream: 'planning';
  type: 'selection_boundary' | 'plan' | 'replan';
  poolSize?: number;
  /** TASK IDS ONLY, NEVER TITLES — which is what keeps this stream genuinely structured and lets
   *  it survive open beta (design §5.7). */
  eligible?: Array<{ taskId: number; factors: Record<string, number>; score: number }>;
  capabilityRejects?: Array<{ taskId: number; reason: string }>;
  dependencyRejects?: Array<{ taskId: number; blockedBy: number[]; reason: string }>;
  agenda?: Array<{ taskId?: number; kind: string; plannedMinutes: number; deepFocus?: boolean }>;
  checkIn?: {
    sessionType: SessionType;
    sessionMinutes?: number;
    energy: string;
    contexts: string[];
    tools: string[];
  };
  outcome?: string;
  replanReason?: string;
}

export interface CoachingEvent {
  stream: 'coaching';
  type: 'enqueued' | 'opened' | 'resolution' | 'dispatched' | 'closed' | 'abandoned';
  trigger: CoachingTrigger;
  /** `trigger_data.kind` — 'repeated_extension' etc. Not a trigger type (constraint #12). */
  triggerKind?: string;
  queueEntryId?: number;
  urgency?: string;
  candidateTaskIds?: number[];
  /** The resolution union's action. Any model-authored PROSE reaches `modeltext` via the ladder,
   *  never here — which is what reclassifies this stream mixed → structured (design §5.8). */
  action?: string;
  /** Enum/numeric fields only. */
  actionFields?: Record<string, string | number | boolean | null>;
  dispatchOutcome?: string;
  ladder?: 'ok' | 'fallback' | 'crisis';
}

export interface RuntimeEvent {
  stream: 'runtime';
  type: 'app_state' | 'model_load' | 'sample';
  appState?: string;
  msSinceProcessStart?: number;
  msSinceModelLoad?: number;
  modelLoadMs?: number;
  /** PowerManager 0 NONE … 6 SHUTDOWN. SAMPLING ONLY — NO POLICY. Tier degradation, deferral and
   *  background-work gating remain task 19's and task 8's (amendment §4). */
  thermalStatus?: number;
  /** 0..1. */
  batteryLevel?: number;
  charging?: boolean;
}

export interface LifecycleEvent {
  stream: 'lifecycle';
  type:
    | 'boot'
    | 'launch'
    | 'grammar_guard'
    | 'crash_recovery'
    | 'alarm_scheduled'
    | 'alarm_fired'
    | 'alarm_missed'
    | 'migration'
    | 'capture';
  // boot only, once per run:
  build?: { debug: boolean };
  schemaVersion?: string;
  /** design §3.4 — a gap analysis over the global `seq` is only valid against this. */
  streamsCompiled?: string[];
  formatVersion?: number;
  bootWallMs?: number;
  bootMonoMs?: number;
  // grammar guard:
  grammarEnabled?: boolean;
  grammarFailures?: Array<{ surface: string; error: string }>;
  // alarm — constraint #13's 11 ms measurement gets a permanent home here:
  scheduledAtMs?: number;
  firedAtMs?: number;
  deltaMs?: number;
  exactAllowed?: boolean;
  // capture's own health (design §7.2):
  droppedTotal?: number;
  lastDropReason?: string;
  bytesOnDisk?: number;
  overCeiling?: boolean;
}

export type CaptureEvent =
  | ConversationEvent
  | ModelTextEvent
  | MutationTextEvent
  | CrisisEvent
  | ModelIoEvent
  | ValidationEvent
  | MutationEvent
  | EpisodeEvent
  | PlanningEvent
  | CoachingEvent
  | RuntimeEvent
  | LifecycleEvent;
