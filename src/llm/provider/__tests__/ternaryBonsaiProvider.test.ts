// Exercises TernaryBonsaiProvider's lifecycle + mapping with a FAKE injected llama.rn backend, so
// no native module is touched. The real on-device call is Phase B; this proves the wiring around
// it (param assembly, result mapping, load/guard/thermal/tier) is correct headless.
import {
  TernaryBonsaiProvider,
  type InitLlamaFn,
  type LlamaCompletionContext,
} from '../ternaryBonsaiProvider';
import type { RawCompletionResult } from '../ternaryBonsaiSupport';

interface FakeContext extends LlamaCompletionContext {
  calls: Array<Record<string, unknown>>;
}

function makeFakeBackend(result: RawCompletionResult): { initLlama: InitLlamaFn; context: FakeContext } {
  const context: FakeContext = {
    calls: [],
    completion: async (params) => {
      context.calls.push(params);
      return result;
    },
    release: async () => {},
  };
  return { initLlama: async () => context, context };
}

describe('TernaryBonsaiProvider', () => {
  it('throws if used before load()', async () => {
    const { initLlama } = makeFakeBackend({ text: '{}' });
    const provider = new TernaryBonsaiProvider({}, { initLlama });
    expect(provider.isAvailable()).toBe(false);
    await expect(provider.generateResponse([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /not loaded/,
    );
  });

  it('loads the model context and reports available', async () => {
    const { initLlama } = makeFakeBackend({ text: '{}' });
    const provider = new TernaryBonsaiProvider({}, { initLlama });
    await provider.load();
    expect(provider.isAvailable()).toBe(true);
  });

  it('sends the messages + built params to completion and maps the result', async () => {
    const { initLlama, context } = makeFakeBackend({
      text: '{"ok":true}',
      stopped_eos: true,
      timings: { predicted_n: 6, predicted_per_second: 5.2 },
    });
    const provider = new TernaryBonsaiProvider({}, { initLlama });
    await provider.load();

    const res = await provider.generateResponse([{ role: 'user', content: 'hi' }], {
      grammar: 'root ::= "x"',
      maxTokens: 100,
      temperature: 0,
      topK: 1,
    });

    expect(res).toEqual({
      text: '{"ok":true}',
      truncated: false,
      timings: { promptMs: 0, promptPerSecond: 0, predictedN: 6, predictedPerSecond: 5.2 },
    });
    // Chat-template path: messages passed through (constraint #1), greedy knobs forwarded.
    expect(context.calls[0]).toMatchObject({
      messages: [{ role: 'user', content: 'hi' }],
      grammar: 'root ::= "x"',
      n_predict: 100,
      temperature: 0,
      top_k: 1,
    });
  });

  it('compileGrammar runs a 1-token completion under the grammar', async () => {
    const { initLlama, context } = makeFakeBackend({ text: '' });
    const provider = new TernaryBonsaiProvider({}, { initLlama });
    await provider.load();
    await provider.compileGrammar('root ::= "x"');
    expect(context.calls[0]).toMatchObject({ grammar: 'root ::= "x"', n_predict: 1 });
  });

  it('reports capabilities and the 4B tier', async () => {
    const { initLlama } = makeFakeBackend({ text: '' });
    const provider = new TernaryBonsaiProvider({ nCtx: 4096 }, { initLlama });
    expect(provider.getCapabilities()).toEqual({ grammar: true, tools: false, contextWindow: 4096 });
    expect(provider.activeTier()).toBe('4B');
    expect(provider.estimateTokens('12345678')).toBe(2);
  });

  it('derives thermal headroom from the injected status sampler', async () => {
    const { initLlama } = makeFakeBackend({ text: '' });
    let status = 0;
    const provider = new TernaryBonsaiProvider({}, { initLlama, thermalStatusSampler: () => status });
    expect(provider.currentThermalHeadroom()).toBe('ok');
    status = 3;
    expect(provider.currentThermalHeadroom()).toBe('reduce');
    status = 5;
    expect(provider.currentThermalHeadroom()).toBe('defer');
  });
});
