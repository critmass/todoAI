// Task 6 — TernaryBonsaiProvider: the real LLMProvider over llama.rn 0.12.5 + the 4B TQ1_0
// (the only tier that runs today — orientation §1/§5). All the pure logic lives in
// ./ternaryBonsaiSupport.ts; this class is the thin native shell: it owns the LlamaContext
// lifecycle and forwards to llama.rn's messages/completion API (chat template mandatory —
// constraint #1). The native entry point (initLlama) is injected so the mapping/lifecycle logic
// can be exercised with a fake context headless; the DEFAULT wires the real llama.rn.
//
// NOT verifiable headless (→ Phase B): a real grammar-constrained call returning on-device, the
// startup guard catching a real process-killer, and the Stage 2/3 latency numbers.

import { initLlama as realInitLlama } from 'llama.rn';
import type {
  ChatMessage,
  GenerateOptions,
  LLMCapabilities,
  LLMProvider,
  LLMResponse,
  ModelTier,
  ThermalHeadroom,
} from './types';
import {
  DEFAULT_TERNARY_BONSAI_CONFIG,
  buildCompletionParams,
  mapCompletionResult,
  selectTier,
  stripGrammarComments,
  thermalHeadroomFromAndroidStatus,
  type RawCompletionResult,
  type TernaryBonsaiConfig,
} from './ternaryBonsaiSupport';

/** Minimal structural view of a loaded llama.rn context — only what this provider calls. */
export interface LlamaCompletionContext {
  completion(params: Record<string, unknown>): Promise<RawCompletionResult>;
  release?(): Promise<void>;
}

export type InitLlamaFn = (config: Record<string, unknown>) => Promise<LlamaCompletionContext>;

export interface TernaryBonsaiDeps {
  /** Native loader; defaults to llama.rn's initLlama. Injectable for headless mapping tests. */
  initLlama?: InitLlamaFn;
  /** Samples the Android PowerManager thermal status (0 NONE … 6 SHUTDOWN). Defaults to a stub
   *  returning 0 ('ok'); wired to the native thermal API in Phase B (spec §3.5). */
  thermalStatusSampler?: () => number;
}

export class TernaryBonsaiProvider implements LLMProvider {
  private context: LlamaCompletionContext | null = null;
  private readonly config: TernaryBonsaiConfig;
  private readonly initLlama: InitLlamaFn;
  private readonly thermalStatusSampler: () => number;

  constructor(config: Partial<TernaryBonsaiConfig> = {}, deps: TernaryBonsaiDeps = {}) {
    this.config = { ...DEFAULT_TERNARY_BONSAI_CONFIG, ...config };
    this.initLlama = deps.initLlama ?? (realInitLlama as unknown as InitLlamaFn);
    this.thermalStatusSampler = deps.thermalStatusSampler ?? (() => 0);
  }

  /** Loads the model context (idempotent). Crib of the Q1 spike's proven initLlama config. */
  async load(): Promise<void> {
    if (this.context) return;
    this.context = await this.initLlama({
      model: this.config.modelPath,
      use_mlock: true,
      n_ctx: this.config.nCtx,
      n_threads: this.config.nThreads,
      n_gpu_layers: this.config.nGpuLayers,
    });
  }

  private requireContext(): LlamaCompletionContext {
    if (!this.context) {
      throw new Error('TernaryBonsaiProvider: model not loaded — call load() first');
    }
    return this.context;
  }

  async generateResponse(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<LLMResponse> {
    const ctx = this.requireContext();
    const params = buildCompletionParams(opts, this.config);
    const raw = await ctx.completion({ messages, ...params });
    return mapCompletionResult(raw, params.n_predict);
  }

  /**
   * Startup-guard compile check (constraint #3): forces llama.cpp to parse `grammar` by running a
   * 1-token completion under it. Resolves if it parses, rejects on a catchable failure. A truly
   * uncatchable process death cannot be turned into a rejection — that is the Phase-B reality the
   * guard's pre-session TIMING defends against (see startupGuard.ts).
   */
  compileGrammar = async (grammar: string): Promise<void> => {
    const ctx = this.requireContext();
    await ctx.completion({
      messages: [{ role: 'user', content: 'x' }],
      // Normalize exactly as the runtime path does (buildCompletionParams strips too), so the
      // guard compile-checks byte-for-byte what a real constrained call will hand the parser.
      grammar: stripGrammarComments(grammar),
      n_predict: 1,
      temperature: 0,
      top_k: 1,
    });
  };

  async release(): Promise<void> {
    await this.context?.release?.();
    this.context = null;
  }

  isAvailable(): boolean {
    return this.context !== null;
  }

  getCapabilities(): LLMCapabilities {
    return { grammar: true, tools: false, contextWindow: this.config.nCtx };
  }

  estimateTokens(text: string): number {
    // Heuristic (~4 chars/token). A real tokenizer round-trip is a native call; the app uses this
    // only for budget estimates, so the approximation is deliberate. (Phase B may swap in
    // ctx.tokenize if the budget math needs it.)
    return Math.ceil(text.length / 4);
  }

  currentThermalHeadroom(): ThermalHeadroom {
    return thermalHeadroomFromAndroidStatus(this.thermalStatusSampler());
  }

  activeTier(): ModelTier {
    return selectTier({ thermal: this.currentThermalHeadroom() });
  }
}
