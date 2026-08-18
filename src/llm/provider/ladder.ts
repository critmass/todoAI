// Task 6 — the D10 runtime failure ladder (strategy §3.9, spec §3.3.4/§8.3). Per constrained
// call: generate (grammar, greedy, capped) → validate → on failure ONE corrective retry → on the
// second failure a graceful "give me a moment" fallback. Never loops, never blocks the app. This
// orchestrates task 5's existing validators/mappers; it does not reimplement them.
//
// Greedy is enforced here (temperature 0, topK 1 — constraint #4) so every constrained call is
// reproducible regardless of what the caller passed.

import { LlmOutputValidationError } from '../errors';
import {
  recordModelCall,
  recordValidationFailure,
  type ModelCallCapture,
} from '../../capture';
import type { ChatMessage, GenerateOptions, LLMProvider, LLMResponse } from './types';

/** Description of one constrained generation to run through the ladder. `validate` is a task-5
 *  validator closure (it throws LlmOutputValidationError on failure); `parse` turns raw text
 *  into the value `validate` inspects (defaults to JSON.parse over trimmed text). */
export interface ConstrainedCall<T> {
  provider: LLMProvider;
  messages: ChatMessage[];
  /** Fully slot-substituted grammar text. */
  grammar: string;
  /** The surface's hard output cap (strategy §2). */
  maxTokens: number;
  validate: (raw: unknown) => T;
  parse?: (text: string) => unknown;
  /** Builds the corrective-retry system note from the first failure issue. A sensible default is
   *  used if omitted (D10 step 3). */
  buildRetryNote?: (firstIssue: string) => ChatMessage;
  /**
   * TASK 41 CAPTURE. What the caller knows about this call that the ladder cannot see — the
   * surface name, the grammar's registry id and its slot values, and `todayISO` on extraction
   * surfaces (without which every relative due date in the corpus is unresolvable, design §5.2).
   * ONE optional field, so removing the `modelio`/`modeltext`/`validation` streams is deleting it
   * and letting `tsc` name the two call sites that set it.
   */
  capture?: Omit<ModelCallCapture, 'rung' | 'attempt' | 'maxTokens' | 'grammar'>;
}

export type LadderResult<T> =
  | { status: 'ok'; value: T; raw: unknown; attempts: 1 | 2; response: LLMResponse }
  | {
      status: 'fallback';
      attempts: 2;
      /** The last raw text produced, for salvage (D10 step 4) and dev-only fixture capture. */
      lastResponse: LLMResponse;
      /** The final validation/parse error. */
      error: Error;
    };

/** Greedy, capped options for a constrained generation (D9): temperature 0, top_k 1. */
function constrainedOptions(grammar: string, maxTokens: number): GenerateOptions {
  return { grammar, maxTokens, temperature: 0, topK: 1 };
}

function defaultRetryNote(firstIssue: string): ChatMessage {
  return {
    role: 'system',
    content: `Your previous output failed validation: ${firstIssue}. Emit the corrected JSON only.`,
  };
}

/** The first human-readable issue from a failure, for the corrective-retry note. */
function firstIssueOf(error: unknown): string {
  if (error instanceof LlmOutputValidationError && error.issues.length > 0) {
    return error.issues[0];
  }
  return error instanceof Error ? error.message : String(error);
}

interface AttemptOutcome<T> {
  response: LLMResponse;
  ok: boolean;
  value?: T;
  raw?: unknown;
  error?: Error;
}

async function runAttempt<T>(
  call: ConstrainedCall<T>,
  messages: ChatMessage[],
  attempt: 1 | 2,
): Promise<AttemptOutcome<T>> {
  const parse = call.parse ?? ((text: string) => JSON.parse(text.trim()));
  const options = constrainedOptions(call.grammar, call.maxTokens);
  const startedAt = Date.now();
  const response = await call.provider.generateResponse(messages, options);
  const latencyMs = Date.now() - startedAt;

  const surface = call.capture?.surface ?? 'constrained_generation';
  const capture: ModelCallCapture = {
    ...call.capture,
    surface,
    rung: attempt === 1 ? 'first' : 'retry',
    attempt,
    maxTokens: call.maxTokens,
    temperature: options.temperature ?? null,
    topK: options.topK ?? null,
    grammar: call.grammar,
  };

  // A generation that hit the token cap is truncated → invalid by definition (D9); don't even
  // try to parse a chopped-off object — report it as the failure so the retry note is useful.
  if (response.truncated) {
    const textRef = recordModelCall(capture, messages, response, latencyMs, 'truncated');
    const error = new LlmOutputValidationError(
      'constrained_generation',
      ['output truncated at the token cap (maxTokens) — increase budget or shorten input'],
      response.text,
    );
    recordValidationFailure({
      textRef,
      surface,
      issues: error.issues,
      attempt,
      errorKind: 'truncated',
      errorMessage: error.message,
    });
    return { response, ok: false, error };
  }

  try {
    const raw = parse(response.text);
    const value = call.validate(raw);
    recordModelCall(capture, messages, response, latencyMs, 'ok');
    return { response, ok: true, value, raw };
  } catch (err) {
    // WHERE THE PAYLOAD USED TO DIE. The error now carries the raw completion out to whoever
    // catches it — `resolveCoaching`, `chatController` — rather than only into the log.
    const validation = err instanceof LlmOutputValidationError;
    const error = validation
      ? (err as LlmOutputValidationError).withPayload(response.text)
      : err instanceof Error
        ? err
        : new Error(String(err));
    const textRef = recordModelCall(
      capture,
      messages,
      response,
      latencyMs,
      validation ? 'validation_failed' : 'parse_failed',
    );
    recordValidationFailure({
      textRef,
      surface,
      issues: validation ? (err as LlmOutputValidationError).issues : [error.message],
      attempt,
      errorKind: validation ? 'validation' : 'parse',
      errorMessage: error.message,
    });
    return { response, ok: false, error };
  }
}

/**
 * Runs one constrained call through the D10 ladder. Returns `{status:'ok'}` with the validated
 * value on the first or second attempt, or `{status:'fallback'}` after two failures — the
 * caller then takes the "give me a moment" path, salvaging `lastResponse` (D10 step 4). Exactly
 * one corrective retry; never a loop.
 */
export async function runConstrained<T>(call: ConstrainedCall<T>): Promise<LadderResult<T>> {
  const first = await runAttempt(call, call.messages, 1);
  if (first.ok) {
    return { status: 'ok', value: first.value as T, raw: first.raw, attempts: 1, response: first.response };
  }

  // One corrective retry (D10 step 3): append a terse system note quoting the first issue.
  const buildNote = call.buildRetryNote ?? defaultRetryNote;
  const retryMessages: ChatMessage[] = [
    ...call.messages,
    buildNote(firstIssueOf(first.error)),
  ];

  const second = await runAttempt(call, retryMessages, 2);
  if (second.ok) {
    return { status: 'ok', value: second.value as T, raw: second.raw, attempts: 2, response: second.response };
  }

  // Graceful fallback (D10 step 4 / spec §8.3): never loops, never blocks.
  return {
    status: 'fallback',
    attempts: 2,
    lastResponse: second.response,
    error: second.error ?? new Error('constrained generation failed twice'),
  };
}
