// Task 6 — MockLLMProvider: the test double standing in for the real 4B across the whole
// headless phase (and for any app logic that shouldn't need a model). It must simulate the three
// things the ladder and startup guard are tested against: VALID output, INVALID output, and
// GRAMMAR-COMPILE FAILURE. Nothing here touches llama.rn.
//
// Scripting model: either supply a fixed queue of `responses` (each generateResponse call shifts
// the next), or a `responder` function computed from the call (so a test can, e.g., fail the
// first attempt and succeed once the corrective-retry system note is present). Every call is
// recorded on `.calls` for assertions.

import type {
  ChatMessage,
  GenerateOptions,
  LLMCapabilities,
  LLMProvider,
  LLMResponse,
  ModelTier,
  ThermalHeadroom,
} from './types';

/** A scripted generation result. A bare string is shorthand for `{ text, truncated:false }`. */
export interface MockStep {
  text: string;
  truncated?: boolean;
  timings?: LLMResponse['timings'];
}

export type MockResponder = (
  messages: ChatMessage[],
  opts: GenerateOptions,
  callIndex: number,
) => MockStep | string;

export interface MockCall {
  messages: ChatMessage[];
  opts: GenerateOptions;
}

export interface MockLLMProviderConfig {
  /** A queue of scripted results, consumed in order across generateResponse calls. */
  responses?: Array<MockStep | string>;
  /** A function form, evaluated per call — takes precedence over `responses` when set. */
  responder?: MockResponder;
  available?: boolean;
  capabilities?: Partial<LLMCapabilities>;
  tier?: ModelTier;
  thermal?: ThermalHeadroom;
  /** Startup-guard simulation: return true for a grammar that should "fail to compile". */
  failCompileFor?: (grammar: string, surface: string) => boolean;
}

const DEFAULT_CAPABILITIES: LLMCapabilities = {
  grammar: true,
  tools: false,
  contextWindow: 2048,
};

function toStep(result: MockStep | string): MockStep {
  return typeof result === 'string' ? { text: result, truncated: false } : result;
}

export class MockLLMProvider implements LLMProvider {
  readonly calls: MockCall[] = [];
  /** Grammars passed to compileGrammar, in order — for startup-guard assertions. */
  readonly compileAttempts: string[] = [];

  private readonly queue: Array<MockStep | string>;
  private readonly responder?: MockResponder;
  private readonly config: MockLLMProviderConfig;

  constructor(config: MockLLMProviderConfig = {}) {
    this.config = config;
    this.queue = [...(config.responses ?? [])];
    this.responder = config.responder;
  }

  async generateResponse(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<LLMResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ messages, opts });

    let result: MockStep | string;
    if (this.responder) {
      result = this.responder(messages, opts, callIndex);
    } else if (this.queue.length > 0) {
      result = this.queue.shift() as MockStep | string;
    } else {
      throw new Error(
        `MockLLMProvider: no scripted response for call #${callIndex} (queue exhausted, no responder)`,
      );
    }

    const step = toStep(result);
    return { text: step.text, truncated: step.truncated ?? false, timings: step.timings };
  }

  /**
   * Simulates the startup-guard compile check (constraint #3). Resolves if the grammar "compiles";
   * rejects if `failCompileFor` marks it bad. Usable directly as the guard's TryCompile.
   */
  compileGrammar = async (grammar: string, surface = ''): Promise<void> => {
    this.compileAttempts.push(grammar);
    if (this.config.failCompileFor?.(grammar, surface)) {
      throw new Error(`MockLLMProvider: simulated grammar-compile failure for "${surface}"`);
    }
  };

  isAvailable(): boolean {
    return this.config.available ?? true;
  }

  getCapabilities(): LLMCapabilities {
    return { ...DEFAULT_CAPABILITIES, ...this.config.capabilities };
  }

  estimateTokens(text: string): number {
    // Rough heuristic (~4 chars/token); the mock never needs a real tokenizer.
    return Math.ceil(text.length / 4);
  }

  currentThermalHeadroom(): ThermalHeadroom {
    return this.config.thermal ?? 'ok';
  }

  activeTier(): ModelTier {
    return this.config.tier ?? '4B';
  }
}
