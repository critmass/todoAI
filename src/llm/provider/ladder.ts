// Task 6 — the D10 runtime failure ladder (strategy §3.9, spec §3.3.4/§8.3). Per constrained
// call: generate (grammar, greedy, capped) → validate → on failure ONE corrective retry → on the
// second failure a graceful "give me a moment" fallback. Never loops, never blocks the app. This
// orchestrates task 5's existing validators/mappers; it does not reimplement them.
//
// Greedy is enforced here (temperature 0, topK 1 — constraint #4) so every constrained call is
// reproducible regardless of what the caller passed.

import { LlmOutputValidationError } from '../errors';
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
): Promise<AttemptOutcome<T>> {
  const parse = call.parse ?? ((text: string) => JSON.parse(text.trim()));
  const response = await call.provider.generateResponse(
    messages,
    constrainedOptions(call.grammar, call.maxTokens),
  );

  // A generation that hit the token cap is truncated → invalid by definition (D9); don't even
  // try to parse a chopped-off object — report it as the failure so the retry note is useful.
  if (response.truncated) {
    return {
      response,
      ok: false,
      error: new LlmOutputValidationError('constrained_generation', [
        'output truncated at the token cap (maxTokens) — increase budget or shorten input',
      ]),
    };
  }

  try {
    const raw = parse(response.text);
    const value = call.validate(raw);
    return { response, ok: true, value, raw };
  } catch (err) {
    return { response, ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Runs one constrained call through the D10 ladder. Returns `{status:'ok'}` with the validated
 * value on the first or second attempt, or `{status:'fallback'}` after two failures — the
 * caller then takes the "give me a moment" path, salvaging `lastResponse` (D10 step 4). Exactly
 * one corrective retry; never a loop.
 */
export async function runConstrained<T>(call: ConstrainedCall<T>): Promise<LadderResult<T>> {
  const first = await runAttempt(call, call.messages);
  if (first.ok) {
    return { status: 'ok', value: first.value as T, raw: first.raw, attempts: 1, response: first.response };
  }

  // One corrective retry (D10 step 3): append a terse system note quoting the first issue.
  const buildNote = call.buildRetryNote ?? defaultRetryNote;
  const retryMessages: ChatMessage[] = [
    ...call.messages,
    buildNote(firstIssueOf(first.error)),
  ];

  const second = await runAttempt(call, retryMessages);
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
