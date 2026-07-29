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

  function append(from: ChatMessageView['from'], text: string): void {
    publish({ messages: [...state.messages, { id: nextId++, from, text }] });
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
    append(
      'coach',
      isInput
        ? "What's on your mind? Tell me the task and I'll get it set up."
        : openingLineFor(purpose.trigger),
    );
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
    append('user', trimmed);
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
    if (crisis) {
      append('coach', crisis.text);
      publish({ status: 'halted', canSave: false, canResolve: false });
      return;
    }

    publish({ status: deps.model.isReady() ? 'thinking' : 'preparing', error: null });
    try {
      const { provider } = await deps.model.ensure();
      publish({ status: 'thinking' });
      const reply = await proseTurn(provider);
      append('coach', reply);
      publish({ status: 'idle' });
    } catch (err) {
      publish({
        status: 'idle',
        error: err instanceof Error ? err.message : String(err),
      });
      append('coach', "I couldn't think that through just now — give me a moment and try again.");
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
    const response = await provider.generateResponse(messages, {
      maxTokens: PROSE_MAX_TOKENS,
      // Prose is not constrained: normal sampling (D9's "start near 0.7", the provider's default).
    });
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

      append('coach', `Saved: ${task.title}.`);
      publish({ status: 'closed', savedTask: task, canSave: false });
    } catch (err) {
      publish({ status: 'idle', error: err instanceof Error ? err.message : String(err) });
      append('coach', "That didn't save — something went wrong writing it down.");
    }
  }

  async function runGrammarExtraction(
    provider: LLMProvider,
    messages: ChatMessage[],
    contextTags: string[],
    validate: (raw: unknown) => TaskExtractionV1,
  ): Promise<TaskExtractionV1 | null> {
    const result = await runConstrained({
      provider,
      messages,
      grammar: buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: contextTags }),
      maxTokens: EXTRACTION_MAX_TOKENS,
      validate,
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
  ): Promise<T | null> {
    const jsonOnly: ChatMessage = {
      role: 'system',
      content: 'Reply with the JSON object only. No prose, no code fence.',
    };
    let attemptMessages: ChatMessage[] = [...messages, jsonOnly];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await provider.generateResponse(attemptMessages, {
        maxTokens,
        temperature: 0,
        topK: 1,
      });
      if (!response.truncated) {
        try {
          return validate(JSON.parse(response.text.trim()));
        } catch (err) {
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

      if (result.status === 'crisis') {
        append('coach', result.response.text);
        publish({ status: 'halted' });
        return;
      }
      if (result.status === 'fallback') {
        append('coach', "I couldn't land on a change just now — nothing has been altered.");
        publish({ status: 'idle' });
        return;
      }
      const summary = describeOutcome(result.outcome);
      append('coach', summary);
      await closeQueueEntry();
      publish({ status: 'closed', resolution: summary, canResolve: false });
    } catch (err) {
      publish({ status: 'idle', error: err instanceof Error ? err.message : String(err) });
      append('coach', "I couldn't apply that — nothing has been changed.");
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
