// Task 6 — pure, device-free support logic for TernaryBonsaiProvider. Kept separate from the
// llama.rn-bound class (./ternaryBonsaiProvider.ts) so the param-building, result-mapping, tier
// selection, and thermal mapping are all unit-testable headless. The class is a thin native
// shell over these functions.

import type { GenerateOptions, LLMResponse, ModelTier, ThermalHeadroom } from './types';

/** Static load/config for the 4B stock path (mirrors the Q1 spike's proven config). */
export interface TernaryBonsaiConfig {
  modelPath: string;
  nCtx: number;
  nThreads: number;
  nGpuLayers: number; // 0 — CPU-only; llama.rn's OpenCL path doesn't cover TQ1_0 (spec §3.2)
  /** Default output cap when a call doesn't specify one. */
  defaultMaxTokens: number;
  /** Default sampling temperature for unconstrained prose turns (D9: "start near 0.7"). */
  defaultProseTemperature: number;
}

export const DEFAULT_TERNARY_BONSAI_CONFIG: TernaryBonsaiConfig = {
  modelPath: 'file:///sdcard/Android/data/com.todoai/files/Ternary-Bonsai-4B-TQ1_0.gguf',
  nCtx: 2048,
  nThreads: 4,
  nGpuLayers: 0,
  defaultMaxTokens: 200,
  defaultProseTemperature: 0.7,
};

/**
 * Strips GBNF `#` line comments and blank lines from grammar text before it reaches llama.cpp.
 *
 * WHY (Phase B, device-grounded): the Q1c GREEN run only parsed the real grammars because
 * `Q1GrammarSpikeScreen`'s Stage 2 stripped comments first — its own note reads "this real
 * grammar is full of `#` comments and is failing to parse ... a strip-before-use step belongs in
 * task 6." The checked-in `.gbnf`/`grammarText.ts` constants keep their comments for humans; this
 * is the "before use" normalization that note called for. Byte-for-byte the transform that went
 * GREEN: drop everything from `#` to end-of-line, trim trailing space, drop now-empty lines.
 *
 * CAVEAT: this strips any `#` to EOL, so a `#` *inside a string literal* would be corrupted. None
 * of the four checked-in grammars contain a `#` in a literal, and slot values (context tags, task
 * ids) are constrained to word characters — but if that ever changes, this needs a real lexer.
 */
export function stripGrammarComments(grammar: string): string {
  return grammar
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** The completion params passed to llama.rn's ctx.completion() (subset used by the app). Shaped
 *  to match the Q1 spike's call: messages API (chat template), grammar, greedy knobs, cap. */
export interface CompletionParams {
  grammar?: string;
  n_predict: number;
  temperature: number;
  top_k?: number;
  stop?: string[];
}

/**
 * Builds llama.rn completion params from the provider-level options. A grammar call arrives from
 * the ladder already carrying temperature 0 / topK 1 (constraint #4); a prose call leaves them
 * unset and inherits the config's prose temperature. Nothing here forces greedy on its own — the
 * ladder owns that policy — but an explicit `opts.temperature` always wins.
 */
export function buildCompletionParams(
  opts: GenerateOptions,
  config: TernaryBonsaiConfig,
): CompletionParams {
  const params: CompletionParams = {
    n_predict: opts.maxTokens ?? config.defaultMaxTokens,
    temperature: opts.temperature ?? config.defaultProseTemperature,
  };
  if (opts.grammar !== undefined) params.grammar = stripGrammarComments(opts.grammar);
  if (opts.topK !== undefined) params.top_k = opts.topK;
  if (opts.stop !== undefined) params.stop = opts.stop;
  return params;
}

/** The raw shape llama.rn's completion() returns (only the fields the app reads). */
export interface RawCompletionResult {
  text?: string;
  stopped_limit?: boolean;
  stopped_eos?: boolean;
  stopped_word?: boolean;
  timings?: Record<string, number>;
}

/**
 * Maps a raw llama.rn completion result to the provider's LLMResponse. `truncated` is true when
 * generation stopped by hitting the token cap (llama.rn's `stopped_limit`), OR — belt and braces
 * — when the predicted-token count reached the requested cap. A truncated constrained output is
 * invalid by definition (D9), which is what the ladder keys off.
 *
 * NOTE(Phase B): the exact llama.rn 0.12.5 field names for stop reason are transcribed from its
 * types but unverified against a live result on this stack — confirm `stopped_limit`/timings keys
 * on-device.
 */
export function mapCompletionResult(
  raw: RawCompletionResult,
  requestedMaxTokens: number,
): LLMResponse {
  const t = raw.timings ?? {};
  const predictedN = t.predicted_n ?? 0;
  const truncated = raw.stopped_limit === true || (requestedMaxTokens > 0 && predictedN >= requestedMaxTokens);
  return {
    text: raw.text ?? '',
    truncated,
    timings: {
      promptMs: t.prompt_ms ?? 0,
      promptPerSecond: t.prompt_per_second ?? 0,
      predictedN,
      predictedPerSecond: t.predicted_per_second ?? 0,
    },
  };
}

/**
 * Tier-selection seam (spec §3.1/§3.6). Today there is exactly one runnable rung — the 4B — so
 * this always returns '4B'; the 8B/1.7B rungs are contingent on quantizations that don't run yet
 * (orientation §5: "build the seam, wire only 4B — no degradation logic for models that can't
 * run"). The signals arg is where a real ladder would weigh memory/thermal/observed tok/s once
 * more rungs exist; it is intentionally ignored now.
 */
export function selectTier(_signals?: { thermal?: ThermalHeadroom }): ModelTier {
  return '4B';
}

/**
 * Maps an Android PowerManager thermal status (0 NONE … 6 SHUTDOWN) to the provider's headroom
 * advisory (spec §3.5). NONE/LIGHT → run normally; MODERATE/SEVERE → reduce; CRITICAL and above
 * → defer heavy work. Pure so the mapping is testable without a device; the actual status sample
 * is injected into the provider (default 'ok') and wired to the native thermal API in Phase B.
 */
export function thermalHeadroomFromAndroidStatus(status: number): ThermalHeadroom {
  if (status >= 4) return 'defer';
  if (status >= 2) return 'reduce';
  return 'ok';
}
