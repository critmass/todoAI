// Task 12 — the coaching disposition step end-to-end: run the coaching_resolution union through
// the D10 ladder (generate → validate → retry → fallback), then dispatch the validated action to
// the repositories. The flow trigger is app-driven (D11): the coaching conversation runs as prose;
// when it reaches disposition, the app makes this constrained resolution call over the transcript.

import { runConstrained, type LadderResult } from '../../llm/provider/ladder';
import type { ChatMessage, LLMProvider } from '../../llm/provider/types';
import { validateCoachingResolution, type CoachingResolutionV1 } from '../../llm';
import {
  dispatchResolution,
  type DispatchOutcome,
  type ResolutionContext,
  type ResolutionDispatchDeps,
} from './dispatch';

/** Strategy §2 output budget for a coaching resolution. */
export const RESOLUTION_MAX_TOKENS = 100;

export interface RunCoachingResolutionArgs {
  provider: LLMProvider;
  /** The coaching transcript + resolution field guide, assembled for the disposition call. */
  messages: ChatMessage[];
  /** The coaching_resolution grammar with candidate task ids already substituted (D7). */
  grammar: string;
  maxTokens?: number;
  dispatch: ResolutionDispatchDeps;
  ctx: ResolutionContext;
}

export type CoachingResolutionResult =
  | { status: 'dispatched'; outcome: DispatchOutcome; attempts: 1 | 2 }
  | { status: 'fallback'; error: Error };

/**
 * Generates a coaching resolution under grammar + validation (D10), then applies it. On two
 * validation failures the ladder falls back gracefully (spec §8.3) — no disposition is applied,
 * and the caller takes the "give me a moment" path rather than acting on unvalidated output.
 */
export async function runCoachingResolution(
  args: RunCoachingResolutionArgs,
): Promise<CoachingResolutionResult> {
  const ladder: LadderResult<CoachingResolutionV1> = await runConstrained({
    provider: args.provider,
    messages: args.messages,
    grammar: args.grammar,
    maxTokens: args.maxTokens ?? RESOLUTION_MAX_TOKENS,
    validate: (raw) => validateCoachingResolution(raw),
  });

  if (ladder.status === 'fallback') {
    return { status: 'fallback', error: ladder.error };
  }

  const outcome = await dispatchResolution(args.dispatch, ladder.value, args.ctx);
  return { status: 'dispatched', outcome, attempts: ladder.attempts };
}
