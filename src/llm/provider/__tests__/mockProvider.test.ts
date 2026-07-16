import { MockLLMProvider } from '../mockProvider';

describe('MockLLMProvider', () => {
  it('serves a scripted queue in order and records calls', async () => {
    const provider = new MockLLMProvider({ responses: ['first', { text: 'second', truncated: true }] });
    const a = await provider.generateResponse([{ role: 'user', content: 'a' }], { maxTokens: 10 });
    const b = await provider.generateResponse([{ role: 'user', content: 'b' }]);
    expect(a).toEqual({ text: 'first', truncated: false, timings: undefined });
    expect(b.text).toBe('second');
    expect(b.truncated).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].opts.maxTokens).toBe(10);
  });

  it('throws a clear error when the queue is exhausted', async () => {
    const provider = new MockLLMProvider({ responses: ['only one'] });
    await provider.generateResponse([]);
    await expect(provider.generateResponse([])).rejects.toThrow(/queue exhausted/);
  });

  it('supports a responder function computed from the call (e.g. retry-aware)', async () => {
    const provider = new MockLLMProvider({
      responder: (messages) => {
        const hasRetryNote = messages.some((m) => m.role === 'system' && m.content.includes('failed'));
        return hasRetryNote ? '{"ok":true}' : '{"ok":false}';
      },
    });
    const first = await provider.generateResponse([{ role: 'user', content: 'x' }]);
    const second = await provider.generateResponse([
      { role: 'user', content: 'x' },
      { role: 'system', content: 'failed validation: ...' },
    ]);
    expect(first.text).toBe('{"ok":false}');
    expect(second.text).toBe('{"ok":true}');
  });

  it('simulates grammar-compile success and failure', async () => {
    const provider = new MockLLMProvider({
      failCompileFor: (grammar) => grammar.includes('BAD'),
    });
    await expect(provider.compileGrammar('root ::= "ok"', 's')).resolves.toBeUndefined();
    await expect(provider.compileGrammar('root ::= BAD', 's')).rejects.toThrow(/compile failure/);
    expect(provider.compileAttempts).toHaveLength(2);
  });

  it('exposes capability/tier/thermal defaults, overridable via config', async () => {
    const dflt = new MockLLMProvider();
    expect(dflt.isAvailable()).toBe(true);
    expect(dflt.getCapabilities()).toEqual({ grammar: true, tools: false, contextWindow: 2048 });
    expect(dflt.activeTier()).toBe('4B');
    expect(dflt.currentThermalHeadroom()).toBe('ok');
    expect(dflt.estimateTokens('12345678')).toBe(2); // ~4 chars/token

    const custom = new MockLLMProvider({
      available: false,
      capabilities: { contextWindow: 4096 },
      tier: '8B',
      thermal: 'defer',
    });
    expect(custom.isAvailable()).toBe(false);
    expect(custom.getCapabilities().contextWindow).toBe(4096);
    expect(custom.activeTier()).toBe('8B');
    expect(custom.currentThermalHeadroom()).toBe('defer');
  });
});
