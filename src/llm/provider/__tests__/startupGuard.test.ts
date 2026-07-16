import { runStartupGuard, type TryCompile } from '../startupGuard';
import { buildGrammarRegistry } from '../grammarRegistry';
import { MockLLMProvider } from '../mockProvider';

describe('runStartupGuard', () => {
  const registry = [
    { surface: 'task_extraction' as const, grammar: 'GRAMMAR_A' },
    { surface: 'task_breakdown' as const, grammar: 'GRAMMAR_B' },
    { surface: 'coaching_resolution' as const, grammar: 'GRAMMAR_C' },
    { surface: 'summary' as const, grammar: 'GRAMMAR_D' },
  ];

  it('enables the grammar path when every grammar compiles', async () => {
    const tryCompile: TryCompile = async () => {}; // all succeed
    const result = await runStartupGuard(tryCompile, registry);
    expect(result.grammarEnabled).toBe(true);
    expect(result.attempted).toBe(4);
    expect(result.failures).toEqual([]);
  });

  it('disables the grammar path if ANY grammar fails to compile (constraint #3 fallback)', async () => {
    const tryCompile: TryCompile = async (grammar) => {
      if (grammar === 'GRAMMAR_C') throw new Error('bad rule');
    };
    const result = await runStartupGuard(tryCompile, registry);
    expect(result.grammarEnabled).toBe(false);
    expect(result.failures).toEqual([{ surface: 'coaching_resolution', error: 'bad rule' }]);
  });

  it('attempts every grammar (does not stop at the first failure)', async () => {
    const attempted: string[] = [];
    const tryCompile: TryCompile = async (_grammar, surface) => {
      attempted.push(surface);
      throw new Error(`fail ${surface}`);
    };
    const result = await runStartupGuard(tryCompile, registry);
    expect(attempted).toEqual([
      'task_extraction',
      'task_breakdown',
      'coaching_resolution',
      'summary',
    ]);
    expect(result.failures).toHaveLength(4);
    expect(result.grammarEnabled).toBe(false);
  });

  it('drives the real app grammar registry through MockLLMProvider.compileGrammar', async () => {
    // All representative grammars "compile" — the happy path over the real registry shape.
    const provider = new MockLLMProvider();
    const result = await runStartupGuard(provider.compileGrammar);
    expect(result.grammarEnabled).toBe(true);
    expect(result.attempted).toBe(4);
    expect(provider.compileAttempts).toHaveLength(4);
    // The substituted templates are real GBNF text, not leftover {{slots}}.
    for (const grammar of provider.compileAttempts) {
      expect(grammar).not.toContain('{{');
    }
  });

  it('falls back when a simulated bad grammar in the real registry fails to compile', async () => {
    const registryEntries = buildGrammarRegistry();
    const badSurface = 'coaching_resolution';
    const badGrammar = registryEntries.find((e) => e.surface === badSurface)!.grammar;
    const provider = new MockLLMProvider({
      failCompileFor: (grammar) => grammar === badGrammar,
    });
    const result = await runStartupGuard(provider.compileGrammar, registryEntries);
    expect(result.grammarEnabled).toBe(false);
    expect(result.failures.map((f) => f.surface)).toEqual([badSurface]);
  });
});
