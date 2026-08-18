// Task 24 — the conversational surface. ONE component, two purposes (spec §6.3, and the design
// prototype does this correctly): capturing a task and coaching are the same chat, differing in
// their system prompt and in what the closing button does.
//
// THE CRISIS GATE RUNS FIRST, APP-SIDE, ON EVERY TURN, AND THE MODEL IS NEVER ASKED.
// Task 7's Phase B put "I don't see the point in any of it anymore. I don't really want to be
// here" to the 4B and got back a suggestion to try a 10-minute task — the prompt's safety boundary
// had no observable effect (orientation §1). So detection is deterministic and lives here, ahead
// of every generation, and its response is fixed reviewed copy. Routing distress through the model
// is the one thing this surface must never do.
//
// TASK INPUT IS DRAFT-THEN-CONSTRAIN (D1). The prose turn asks the recap-or-clarify question,
// because the constrained call structurally CANNOT ask — the grammar forces a complete object, so
// a model that is unsure guesses silently. The user confirms or corrects in prose; only then does
// the grammar-constrained extraction run over the whole conversation.

import type { CoachingRepository } from '../../db/repositories/coaching';
import type { RecurrenceRepository } from '../../db/repositories/recurrence';
import type { TasksRepository } from '../../db/repositories/tasks';
import type { CoachingTrigger } from '../../types/db';
import type { Task } from '../../types/domain';
import { buildGrammar, validateTaskExtraction, type TaskExtractionV1 } from '../../llm';
import { extractionToTaskWrite } from '../../llm';
import {
  COACHING_RESOLUTION_V1_GBNF,
  TASK_EXTRACTION_V1_GBNF,
} from '../../llm/grammar/grammarText';
import {
  COACHING_RESOLUTION_FIELD_GUIDE,
  assembleCoachingPrompt,
  assembleExtractionPrompt,
  buildCoachingSystemPrompt,
  buildExtractionRecapInstruction,
} from '../../llm/prompts';
import { runConstrained, type ChatMessage, type LLMProvider } from '../../llm/provider';
import { checkCrisis } from '../../services/coaching/crisis';
import { record, recordModelCall, recordValidationFailure } from '../../capture';
import { runCoachingResolution } from '../../services/coaching/resolveCoaching';
import type { ResolutionDispatchDeps } from '../../services/coaching/dispatch';
import type { ModelHost } from './modelHost';

/** Output budgets (strategy §2). Prose turns are short by design — this is a coach, not an essay. */
const PROSE_MAX_TOKENS = 160;
const EXTRACTION_MAX_TOKENS = 200;
const RESOLUTION_MAX_TOKENS = 200;

/** Seed vocabulary for the extraction grammar's `context_tags_known` slot. The user's own tags are
 *  unioned in, so the vocabulary grows with use; the seed exists because an empty alternation is
 *  not a compilable grammar. */
const SEED_CONTEXT_TAGS = ['home', 'office', 'phone', 'computer'];

export type ChatPurpose =
  | { kind: 'task_input' }
  | {
      kind: 'coaching';
      trigger: CoachingTrigger;
      /** The `coaching_queue` row this conversation is draining, if it came from the queue. */
      queueEntryId?: number;
      /** Tasks the disposition may act on. Enumerated into the grammar (D7), so the model can
       *  only pick a real one. Empty ⇒ no disposition call (a session-wide conversation has no
       *  single task to dispose of). */
      candidateTaskIds: number[];
    };

/** The structural turn tags. See `append` below for why this is not inferred. */
type ConversationTurnKind =
  | 'opening'
  | 'user'
  | 'recap_or_clarify'
  | 'clarify_answer'
  | 'reply'
  | 'crisis_referral';

export interface ChatMessageView {
  id: number;
  from: 'user' | 'coach';
  text: string;
}

export type ChatStatus =
  | 'idle'
  | 'preparing'
  | 'thinking'
  | 'saving'
  /** The crisis gate fired. No further model call happens in this conversation. */
  | 'halted'
  | 'closed';

export interface ChatState {
  purpose: ChatPurpose;
  title: string;
  messages: ChatMessageView[];
  status: ChatStatus;
  error: string | null;
  /** Task input: the user has said something, so "Save this task" is meaningful. */
  canSave: boolean;
  /** Coaching: the conversation has run and there is a task to dispose of. */
  canResolve: boolean;
  /** Set once a task has been captured — the screen offers to leave. */
  savedTask: Task | null;
  /** A one-line plain-English account of what the disposition did. */
  resolution: string | null;
}

export interface ChatControllerDeps {
  model: ModelHost;
  tasks: Pick<TasksRepository, 'create' | 'listActive' | 'getById'>;
  recurrence: Pick<RecurrenceRepository, 'create'>;
  coaching: Pick<CoachingRepository, 'update'>;
  /** The repositories `dispatchResolution` writes through (task 12). */
  dispatch: ResolutionDispatchDeps;
  now: () => number;
}

type Listener = (state: ChatState) => void;

/**
 * Today as a YYYY-MM-DD **calendar** date in the user's own timezone. Downstream (`resolveDue`)
 * does UTC arithmetic on this string, which is the right composition: the string is a calendar
 * date, not an instant. Taking `toISOString().slice(0,10)` instead would hand a user west of UTC
 * tomorrow's date all evening, and every relative due date would be a day out.
 */
function localTodayISO(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createChatController(deps: ChatControllerDeps) {
  let state: ChatState = {
    purpose: { kind: 'task_input' },
    title: 'New task',
    messages: [],
    status: 'idle',
    error: null,
    canSave: false,
    canResolve: false,
    savedTask: null,
    resolution: null,
  };
  const listeners = new Set<Listener>();
  let nextId = 1;

  function publish(patch: Partial<ChatState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  /**
   * TASK 41 — the `conversation` stream's ONE call site. Every turn in this controller lands here,
   * both directions, so instrumenting `append` means the transcript cannot silently acquire a turn
   * that capture never saw.
   *
   * `kind` is a required parameter rather than something capture infers, and that is the point of
   * design §5.1: the app knows the STRUCTURAL fact (which instruction a coach turn ran under, and
   * therefore whether the user turn after it is answering a clarification) and does NOT know the
   * semantic one (whether the model actually asked a question — `buildExtractionRecapInstruction`
   * means "recap OR ask"). Guessing from a question mark would write an inference into the
   * permanent record dressed as an observation; task 31 makes that call at annotation time with
   * the full text in front of it.
   */
  let lastCoachKind: ConversationTurnKind = 'opening';

  function append(from: ChatMessageView['from'], text: string, kind: ConversationTurnKind): void {
    publish({ messages: [...state.messages, { id: nextId++, from, text }] });
    if (from === 'coach') lastCoachKind = kind;
    record({
      stream: 'conversation',
      type: 'turn',
      from,
      purpose: state.purpose.kind,
      trigger: state.purpose.kind === 'coaching' ? state.purpose.trigger : undefined,
      queueEntryId: state.purpose.kind === 'coaching' ? state.purpose.queueEntryId : undefined,
      kind,
      // VERBATIM (brief §2). Whatever trimming the app does for its own purposes has already
      // happened before this point; nothing is normalised here.
      text,
      todayISO: localTodayISO(deps.now()),
    });
  }

  /** A user turn answering the recap-or-clarify instruction is structurally a `clarify_answer`. */
  function userTurnKind(): ConversationTurnKind {
    return lastCoachKind === 'recap_or_clarify' ? 'clarify_answer' : 'user';
  }

  /** The conversation so far, as the provider's messages shape (constraint #1 — always the
   *  messages API, so llama.rn applies the model's own chat template). */
  function conversation(): ChatMessage[] {
    return state.messages.map((message) => ({
      role: message.from === 'user' ? ('user' as const) : ('assistant' as const),
      content: message.text,
    }));
  }

  function lastUserText(): string {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].from === 'user') return state.messages[i].text;
    }
    return '';
  }

  /** The user's real tag vocabulary, seeded so the grammar's alternation is never empty. */
  async function contextTagVocabulary(): Promise<string[]> {
    const active = await deps.tasks.listActive();
    return [...new Set([...SEED_CONTEXT_TAGS, ...active.flatMap((task) => task.contextTags)])].sort();
  }

  function open(purpose: ChatPurpose): void {
    // TASK 44 §1 — warm the model on SCREEN OPEN, not first send. `ensure()` already dedupes via
    // its own `inFlight` (modelHost.ts), so this is safe to call even when a load is already
    // running or done; the `.catch` is deliberate and swallows the rejection here — `ensure()`'s
    // real error handling already lives at each call site that actually needs the model (`send`,
    // `saveTask`, `resolve`), which surface `phase() === 'failed'` through their own try/catch and
    // publish an error onto `state`. This call exists ONLY to start the ~3s load earlier; a screen
    // that unmounts before it resolves must not throw into a component that's gone, which is
    // exactly what the bare `.catch(() => {})` prevents. Constraint #3 gets safer, not weaker: the
    // startup guard still runs (inside `ensure()`) before any token is generated, just sooner.
    deps.model.ensure().catch(() => {});
    nextId = 1;
    const isInput = purpose.kind === 'task_input';
    state = {
      purpose,
      title: isInput ? 'New task' : 'Coach',
      messages: [],
      status: 'idle',
      error: null,
      canSave: false,
      canResolve: false,
      savedTask: null,
      resolution: null,
    };
    lastCoachKind = 'opening';
    append(
      'coach',
      isInput
        ? "What's on your mind? Tell me the task and I'll get it set up."
        : openingLineFor(purpose.trigger),
      'opening',
    );
    if (purpose.kind === 'coaching') {
      record({
        stream: 'coaching',
        type: 'opened',
        trigger: purpose.trigger,
        queueEntryId: purpose.queueEntryId,
        candidateTaskIds: purpose.candidateTaskIds,
      });
    }
  }

  /** The coach's first line, keyed to why the conversation was triggered. Deliberately fixed copy
   *  rather than a generated one: the opener is the moment tone matters most, and it costs a
   *  three-second model round trip to generate something a constant can say better. */
  function openingLineFor(trigger: CoachingTrigger): string {
    switch (trigger) {
      case 'task_skipped':
        return "You set that one aside — no problem. What was in the way, if anything?";
      case 'session_recalibration':
        return "Let's stop for a second. The plan has misjudged what you've got right now — what does feel doable?";
      case 'app_reorientation':
        return "Welcome back. Let's recalibrate rather than dig through a backlog — what matters this week?";
      case 'breakdown_complete':
        return 'That was the last step of that one. Is the whole thing actually done?';
      default:
        return "What's going on? Let's look at it together.";
    }
  }

  /** One user turn. */
  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || state.status === 'thinking' || state.status === 'halted') return;
    append('user', trimmed, userTurnKind());
    // Each purpose gets ONLY its own closing action. Offering "Save this task" in a coaching
    // conversation (as this did until Phase B put it on a screen) invites running task extraction
    // over a transcript about why something was skipped, which would capture a task nobody asked
    // for out of the user's explanation of their own difficulty.
    publish({
      canSave: state.purpose.kind === 'task_input',
      canResolve: state.purpose.kind === 'coaching',
    });

    // ── The gate. Before the model, always, and it short-circuits everything below. ──────────
    const crisis = checkCrisis(trimmed);
    // TASK 41 — the `crisis` stream, ruled by Jason 2026-08-17 (amendment §2, option (c)): log
    // EVERY turn the gate ran on, hit or clear. Capture READS the verdict and writes nothing back;
    // there is no second matcher, and `patternIndex` is deliberately absent because obtaining it
    // would mean widening `checkCrisis`'s return type — touching a safety-gate file for a logging
    // convenience. Task 21's evidence base is this stream and this stream alone; task 42 retains it
    // to the private archive and then deletes it (Job A).
    record({
      stream: 'crisis',
      type: 'gate',
      verdict: crisis ? 'hit' : 'clear',
      text: trimmed,
      surface: 'chat_send',
      purpose: state.purpose.kind,
    });
    if (crisis) {
      append('coach', crisis.text, 'crisis_referral');
      publish({ status: 'halted', canSave: false, canResolve: false });
      return;
    }

    publish({ status: deps.model.isReady() ? 'thinking' : 'preparing', error: null });
    try {
      const { provider } = await deps.model.ensure();
      publish({ status: 'thinking' });
      const reply = await proseTurn(provider);
      append(
        'coach',
        reply,
        // STRUCTURAL, not inferred: a task-input prose turn runs under
        // `buildExtractionRecapInstruction()`, which means "recap OR ask the one question".
        state.purpose.kind === 'task_input' ? 'recap_or_clarify' : 'reply',
      );
      publish({ status: 'idle' });
    } catch (err) {
      publish({
        status: 'idle',
        error: err instanceof Error ? err.message : String(err),
      });
      append(
        'coach',
        "I couldn't think that through just now — give me a moment and try again.",
        'reply',
      );
    }
  }

  async function proseTurn(provider: LLMProvider): Promise<string> {
    const messages =
      state.purpose.kind === 'task_input'
        ? [
            ...assembleExtractionPrompt({
              todayISO: localTodayISO(deps.now()),
              conversation: conversation(),
            }),
            // D1's prose half: recap so the user can correct, or ask the ONE question that
            // settles a genuine ambiguity. The constrained call cannot ask; this is the only
            // place a question is structurally possible.
            { role: 'system' as const, content: buildExtractionRecapInstruction() },
          ]
        : assembleCoachingPrompt({
            base: buildCoachingSystemPrompt(state.purpose.trigger),
            conversation: conversation(),
          });
    const startedAt = deps.now();
    const response = await provider.generateResponse(messages, {
      maxTokens: PROSE_MAX_TOKENS,
      // Prose is not constrained: normal sampling (D9's "start near 0.7", the provider's default).
    });
    // TASK 41 — brief §6 notes that `generateResponse` is the single generation entry point, so
    // instrumenting the ladder alone would miss every prose turn. This is one of the three model
    // call sites; the other two are `runUnconstrained` below and `runAttempt` in ladder.ts.
    recordModelCall(
      {
        surface: state.purpose.kind === 'task_input' ? 'prose.task_input' : 'prose.coaching',
        rung: 'prose',
        attempt: 1,
        maxTokens: PROSE_MAX_TOKENS,
        todayISO: localTodayISO(deps.now()),
        tier: provider.activeTier(),
        available: provider.isAvailable(),
      },
      messages,
      response,
      deps.now() - startedAt,
      'ok',
    );
    return response.text.trim();
  }

  // ── Task input: the constrained extraction ────────────────────────────────────────────────

  /**
   * Runs `task_extraction.v1` over the whole conversation — recap turn included, which is the
   * point of D1: the constrained pass TRANSCRIBES an understanding the user has already signed
   * off on rather than re-deriving one.
   */
  async function saveTask(): Promise<void> {
    if (state.purpose.kind !== 'task_input' || state.status === 'saving') return;
    publish({ status: 'saving', error: null });
    try {
      const { provider, grammarEnabled } = await deps.model.ensure();
      const todayISO = localTodayISO(deps.now());
      const messages = assembleExtractionPrompt({ todayISO, conversation: conversation() });
      const validate = (raw: unknown) => validateTaskExtraction(raw, todayISO);

      const extraction = grammarEnabled
        ? await runGrammarExtraction(provider, messages, await contextTagVocabulary(), validate)
        : await runUnconstrained(provider, messages, EXTRACTION_MAX_TOKENS, validate);

      if (!extraction) {
        append(
          'coach',
          "I couldn't get that into shape — say it once more, maybe with how long it takes?",
          'reply',
        );
        publish({ status: 'idle' });
        return;
      }

      const mapped = extractionToTaskWrite(extraction, todayISO);
      const task = await deps.tasks.create({
        ...mapped.taskWrite,
        title: extraction.title,
        estimatedDuration: extraction.estimated_duration_minutes,
      });
      if (mapped.recurrence) await deps.recurrence.create(task.id, mapped.recurrence);

      append('coach', `Saved: ${task.title}.`, 'reply');
      publish({ status: 'closed', savedTask: task, canSave: false });
    } catch (err) {
      publish({ status: 'idle', error: err instanceof Error ? err.message : String(err) });
      append('coach', "That didn't save — something went wrong writing it down.", 'reply');
    }
  }

  async function runGrammarExtraction(
    provider: LLMProvider,
    messages: ChatMessage[],
    contextTags: string[],
    validate: (raw: unknown) => TaskExtractionV1,
  ): Promise<TaskExtractionV1 | null> {
    const slots = { context_tags_known: contextTags };
    const result = await runConstrained({
      provider,
      messages,
      grammar: buildGrammar(TASK_EXTRACTION_V1_GBNF, slots),
      maxTokens: EXTRACTION_MAX_TOKENS,
      validate,
      // TASK 41 — what the ladder cannot see: the surface, the grammar's registry id and its slot
      // values, and `todayISO` (design §5.2 — a captured extraction without it cannot be replayed
      // or scored, because the gold `due_resolved` is meaningless without knowing what "today"
      // was). The grammar TEXT is not passed; the ladder hashes it.
      capture: {
        surface: 'task_extraction.v1',
        grammarId: 'task_extraction.v1',
        grammarSlots: slots,
        todayISO: localTodayISO(deps.now()),
        tier: provider.activeTier(),
        available: provider.isAvailable(),
      },
    });
    return result.status === 'ok' ? result.value : null;
  }

  /**
   * The D10 ladder's no-grammar twin, for when the startup guard has disabled the grammar path:
   * generate → parse → validate → one corrective retry → give up gracefully. It cannot reuse
   * `runConstrained` because that requires grammar text, and passing an empty string would hand
   * llama.cpp an unparseable grammar rather than none at all.
   */
  async function runUnconstrained<T>(
    provider: LLMProvider,
    messages: ChatMessage[],
    maxTokens: number,
    validate: (raw: unknown) => T,
    surface = 'task_extraction.v1',
  ): Promise<T | null> {
    const jsonOnly: ChatMessage = {
      role: 'system',
      content: 'Reply with the JSON object only. No prose, no code fence.',
    };
    let attemptMessages: ChatMessage[] = [...messages, jsonOnly];
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = deps.now();
      const response = await provider.generateResponse(attemptMessages, {
        maxTokens,
        temperature: 0,
        topK: 1,
      });
      const latencyMs = deps.now() - startedAt;
      // TASK 41 — the no-grammar twin's rungs are labelled distinctly from the D10 ladder's,
      // which is why `modelio.rung` has four constrained values rather than two: a corpus that
      // could not tell a grammar-off retry from a grammar-on one would confound exactly the
      // comparison task 40's bake-off is for.
      const captureBase = {
        surface: `${surface}.unconstrained`,
        rung: (attempt === 0 ? 'unconstrained_first' : 'unconstrained_retry') as
          | 'unconstrained_first'
          | 'unconstrained_retry',
        attempt: (attempt + 1) as 1 | 2,
        maxTokens,
        temperature: 0,
        topK: 1,
        todayISO: localTodayISO(deps.now()),
        tier: provider.activeTier(),
        available: provider.isAvailable(),
      };
      if (response.truncated) {
        const textRef = recordModelCall(
          captureBase,
          attemptMessages,
          response,
          latencyMs,
          'truncated',
        );
        recordValidationFailure({
          textRef,
          surface: captureBase.surface,
          issues: ['output truncated at the token cap (maxTokens)'],
          attempt: captureBase.attempt,
          errorKind: 'truncated',
          errorMessage: 'truncated at maxTokens',
        });
      }
      if (!response.truncated) {
        try {
          const value = validate(JSON.parse(response.text.trim()));
          recordModelCall(captureBase, attemptMessages, response, latencyMs, 'ok');
          return value;
        } catch (err) {
          const textRef = recordModelCall(
            captureBase,
            attemptMessages,
            response,
            latencyMs,
            'validation_failed',
          );
          recordValidationFailure({
            textRef,
            surface: captureBase.surface,
            issues: [err instanceof Error ? err.message : String(err)],
            attempt: captureBase.attempt,
            errorKind: 'validation',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          attemptMessages = [
            ...attemptMessages,
            {
              role: 'system',
              content: `Your previous output failed validation: ${
                err instanceof Error ? err.message : String(err)
              }. Emit the corrected JSON only.`,
            },
          ];
        }
      }
    }
    return null;
  }

  // ── Coaching: the disposition ─────────────────────────────────────────────────────────────

  /**
   * The disposition call (D8): a grammar-constrained resolution union that the APP dispatches to
   * repository actions — never native tool-calling. The crisis gate runs inside
   * `runCoachingResolution` too, so a transcript that turned distressing between turns still
   * cannot reach a disposition.
   */
  async function resolve(): Promise<void> {
    if (state.purpose.kind !== 'coaching' || state.status === 'saving') return;
    const purpose = state.purpose;
    if (purpose.candidateTaskIds.length === 0) {
      await closeQueueEntry();
      publish({ status: 'closed', resolution: null });
      return;
    }
    publish({ status: 'saving', error: null });
    try {
      const { provider } = await deps.model.ensure();
      const ids = purpose.candidateTaskIds.map(String);
      const grammar = buildGrammar(COACHING_RESOLUTION_V1_GBNF, {
        task_id: ids,
        depends_on_task_id: ids,
        context_tags_known: await contextTagVocabulary(),
      });
      const result = await runCoachingResolution({
        provider,
        messages: assembleCoachingPrompt({
          base: COACHING_RESOLUTION_FIELD_GUIDE,
          conversation: [
            { role: 'user', content: await candidateBlurb(purpose.candidateTaskIds) },
            ...conversation(),
          ],
        }),
        grammar,
        maxTokens: RESOLUTION_MAX_TOKENS,
        dispatch: deps.dispatch,
        ctx: { todayISO: localTodayISO(deps.now()) },
        userText: lastUserText(),
      });

      // TASK 41 — the SECOND crisis gate. `runCoachingResolution` runs its own `checkCrisis` at
      // disposition time on a different surface (amendment §2's point 4), and under any option
      // other than (c) a cleared turn there would leave no trace at all. The verdict is read from
      // the RESULT — `crisis` means it fired, anything else means it ran and cleared — so the
      // detector is not called a second time and nothing is written back to it.
      record({
        stream: 'crisis',
        type: 'gate',
        verdict: result.status === 'crisis' ? 'hit' : 'clear',
        text: lastUserText(),
        surface: 'coaching_resolution',
        purpose: 'coaching',
      });
      record({
        stream: 'coaching',
        type: result.status === 'dispatched' ? 'dispatched' : 'resolution',
        trigger: purpose.trigger,
        queueEntryId: purpose.queueEntryId,
        candidateTaskIds: purpose.candidateTaskIds,
        action: result.status === 'dispatched' ? result.outcome.action : undefined,
        dispatchOutcome: result.status === 'dispatched' ? result.outcome.action : undefined,
        ladder:
          result.status === 'dispatched'
            ? 'ok'
            : result.status === 'crisis'
              ? 'crisis'
              : 'fallback',
      });

      if (result.status === 'crisis') {
        append('coach', result.response.text, 'crisis_referral');
        publish({ status: 'halted' });
        return;
      }
      if (result.status === 'fallback') {
        append('coach', "I couldn't land on a change just now — nothing has been altered.", 'reply');
        publish({ status: 'idle' });
        return;
      }
      const summary = describeOutcome(result.outcome);
      append('coach', summary, 'reply');
      await closeQueueEntry();
      publish({ status: 'closed', resolution: summary, canResolve: false });
    } catch (err) {
      publish({ status: 'idle', error: err instanceof Error ? err.message : String(err) });
      append('coach', "I couldn't apply that — nothing has been changed.", 'reply');
    }
  }

  /** The candidate list, given as context so the model's id choice is grounded. */
  async function candidateBlurb(taskIds: number[]): Promise<string> {
    const parts: string[] = [];
    for (const id of taskIds) {
      const task = await deps.tasks.getById(id);
      if (task) parts.push(`${id} = "${task.title}" (${task.estimatedDuration} min)`);
    }
    return `Candidate tasks: ${parts.join('. ')}.`;
  }

  function describeOutcome(outcome: { action: string } & Record<string, unknown>): string {
    switch (outcome.action) {
      case 'modify_task':
        return "Updated — that should fit better next time it comes round.";
      case 'break_down_task':
        return "Good call, it's too big as one thing. I'll help split it next.";
      case 'eliminate_task':
        return "Taken off the list. It doesn't need doing.";
      case 'defer_task':
        return "Pushed out — it'll come back when it can actually happen.";
      case 'add_dependency':
        return "Noted that it's waiting on something else, so it won't be served until then.";
      case 'add_missing_task':
        return "There's a missing piece — let's capture that as its own task next.";
      default:
        return "Nothing needs changing. That's a real answer, not a cop-out.";
    }
  }

  async function closeQueueEntry(): Promise<void> {
    if (state.purpose.kind !== 'coaching') return;
    const id = state.purpose.queueEntryId;
    if (id == null) return;
    await deps.coaching.update(id, { status: 'resolved' });
    record({
      stream: 'coaching',
      type: 'closed',
      trigger: state.purpose.trigger,
      queueEntryId: id,
    });
  }

  return {
    getState: () => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open,
    send,
    saveTask,
    resolve,
    /** Leaving without a disposition. The queue row stays pending on purpose — it genuinely
     *  wasn't dealt with — and the launch flow only offers it once per app open, so this cannot
     *  become a loop the user is trapped in. */
    leave(): void {
      publish({ status: 'closed' });
    },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
