// Task 41 — the `modeltext` / `modelio` / `validation` triple, written together because they are
// one event seen at three egress classes.
//
// WHY THE SPLIT EXISTS AT ALL (design §4.1, ruled 12.2). Brief §2 classifies `modelio` as
// "free-text (content) / structured (metadata)". A stream with two egress classes cannot be
// DROPPED at a ladder rung, only FILTERED field by field — and orientation §5 settles that pruning
// happens by dropping. So the prose lives in `modeltext` (gone at open beta) and the metadata in
// `modelio` (survives), joined by `textRef`, which is the `seq` of the modeltext record. Task 43's
// rung becomes `rm -rf` plus a union-member deletion instead of a scrubber nobody reviews.
//
// WHY GRAMMAR ID + HASH + SLOTS, NOT THE GRAMMAR TEXT. `task_extraction.v1.gbnf` is 5,090 bytes;
// recording it per attempt would roughly triple `modelio` to store a constant that is in git. The
// hash proves WHICH text was used — including whether task 37's fix had landed — and the slots are
// the only part that varies per call. (Provisional builder call, amendment §8: the risk accepted is
// an unmatched hash from an uncommitted local grammar edit.)

import type { ChatMessage, LLMResponse } from '../../llm/provider/types';
import type { ModelRung } from '../events';
import { lastSeq, record } from '../record';
import { sha8 } from '../sha256';

export interface ModelCallCapture {
  surface: string;
  rung: ModelRung;
  attempt: 1 | 2;
  maxTokens: number;
  temperature?: number | null;
  topK?: number | null;
  /** Fully slot-substituted grammar text, as handed to llama.cpp. Absent for prose and for the
   *  unconstrained ladder. */
  grammar?: string | null;
  /** Registry key, e.g. 'task_extraction.v1'. */
  grammarId?: string | null;
  grammarSlots?: Record<string, string[]> | null;
  /** §5.2 — required on extraction surfaces or the corpus cannot resolve a relative due date. */
  todayISO?: string;
  tier?: string | null;
  available?: boolean;
}

/**
 * Records one model attempt. Returns nothing — call sites are statements, and nothing above
 * capture may branch on whether a record was written (design §7.1).
 *
 * `messages` and `raw` are stored VERBATIM. That is a deliberate, provisional call (amendment §8):
 * the composed array for turn N contains the system prompt, the field guide and turns 1..N−1, so a
 * six-turn conversation stores the static prefix six times, and content-addressing it is the
 * obvious optimisation. It is not taken for alpha because brief §7.5 demands MEASURED volume and
 * optimising an unmeasured quantity — at the cost of making the corpus a join instead of a read —
 * is the wrong order of operations. Pulling that lever later is a `v` bump, not a re-collection.
 */
export function recordModelCall(
  input: ModelCallCapture,
  messages: ChatMessage[],
  response: LLMResponse | null,
  latencyMs: number,
  outcome: 'ok' | 'parse_failed' | 'validation_failed' | 'truncated' | 'threw',
): void {
  record({ stream: 'modeltext', type: 'call', messages, raw: response?.text ?? '' });
  const textRef = lastSeq();
  record({
    stream: 'modelio',
    type: 'call',
    textRef,
    surface: input.surface,
    constrained: input.grammar != null,
    grammarId: input.grammarId ?? null,
    grammarSha8: input.grammar ? sha8(input.grammar) : null,
    grammarSlots: input.grammarSlots ?? null,
    rung: input.rung,
    attempt: input.attempt,
    maxTokens: input.maxTokens,
    temperature: input.temperature ?? null,
    topK: input.topK ?? null,
    truncated: response?.truncated ?? false,
    timings: response?.timings ?? null,
    model: { tier: (input.tier as never) ?? null, available: input.available ?? true },
    latencyMs,
    outcome,
    todayISO: input.todayISO,
  });
}

/** The `validation` record for a failed attempt. `textRef` points at the `modeltext` record whose
 *  `raw` failed — which is the artifact brief §1 calls "the single most diagnostic artifact the
 *  system produces" and which the code currently throws away. */
export function recordValidationFailure(input: {
  textRef: number | null;
  surface: string;
  issues: string[];
  attempt: 1 | 2;
  errorKind: 'validation' | 'parse' | 'truncated' | 'other';
  errorMessage: string;
}): void {
  record({ stream: 'validation', type: 'failure', ...input });
}
