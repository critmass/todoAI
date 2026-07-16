// Task 6 — the LLMProvider interface (spec §3.6) and its supporting types. Backend-agnostic:
// everything above this interface is provider-independent, which is what keeps the parked
// PrismML fork a contained future swap (orientation §5). Two implementations live alongside:
// MockLLMProvider (test double, ./mockProvider.ts) and TernaryBonsaiProvider (llama.rn,
// ./ternaryBonsaiProvider.ts).

import type { ModelTier } from '../../types/db';

export type { ModelTier };

/** A chat turn. Prompting ALWAYS goes through this messages shape so llama.rn applies the
 *  model's embedded chat template (constraint #1) — raw completion strings are never used. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Per-call generation options. `tools` is deliberately absent: coaching resolutions are a
 * grammar-constrained union, NOT native tool-calling (D8 / constraint #8), so the app never
 * uses llama.rn's tool path. Constrained calls set `grammar` + greedy sampling (temperature 0,
 * topK 1 — constraint #4); prose turns leave `grammar` unset and use normal sampling.
 */
export interface GenerateOptions {
  /** Fully slot-substituted GBNF grammar text (build dynamic ones via buildGrammar first). */
  grammar?: string;
  /** Hard output-token cap (the surface's §2 budget). Hitting it means truncated → invalid. */
  maxTokens?: number;
  /** Sampling temperature. Constrained calls force 0 (greedy). */
  temperature?: number;
  /** top_k. Constrained calls force 1 (deterministic single-best token). */
  topK?: number;
  /** Optional stop strings. */
  stop?: string[];
}

/** Timing/health numbers surfaced from a generation (spec §3.5 tracks these as health metrics). */
export interface GenerationTimings {
  promptMs: number;
  promptPerSecond: number;
  predictedN: number;
  predictedPerSecond: number;
}

export interface LLMResponse {
  text: string;
  /** True when generation stopped by hitting maxTokens rather than a natural stop — the output
   *  is by-definition truncated and therefore invalid for a constrained call (D9). */
  truncated: boolean;
  timings?: GenerationTimings;
}

/** Thermal headroom advisory (spec §3.5): 'ok' run normally; 'reduce' shorten context/output;
 *  'defer' postpone heavy background work. Heat is the binding constraint on this hardware. */
export type ThermalHeadroom = 'ok' | 'reduce' | 'defer';

export interface LLMCapabilities {
  grammar: boolean;
  /** Native tool-calling. Always false here — the app uses union grammars instead (D8). */
  tools: boolean;
  contextWindow: number;
}

/**
 * The provider contract (spec §3.6). `generateResponse` is the single generation entry point;
 * the D10 validate→retry→fallback ladder (./ladder.ts) orchestrates it for constrained calls.
 */
export interface LLMProvider {
  generateResponse(messages: ChatMessage[], opts?: GenerateOptions): Promise<LLMResponse>;
  isAvailable(): boolean;
  getCapabilities(): LLMCapabilities;
  estimateTokens(text: string): number;
  currentThermalHeadroom(): ThermalHeadroom;
  activeTier(): ModelTier;
}
