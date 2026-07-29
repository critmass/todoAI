// Task 24 — owning the model's lifetime for the app.
//
// TWO THINGS THIS EXISTS TO GET RIGHT.
//
// 1. THE STARTUP GUARD RUNS BEFORE ANY GENERATION (constraint #3). A malformed grammar can kill
//    the process uncatchably the first time llama.cpp parses it, which no retry ladder can
//    recover from, so every registered grammar is compile-checked before the model is used for
//    anything — and if any fails, the grammar path is disabled app-wide and the constrained
//    surfaces fall back to prompt-JSON + validation.
//
//    The constraint says "at startup, before any user session". This loads the model and runs the
//    guard on FIRST MODEL USE rather than at process launch, and that is a deliberate reading, not
//    a shortcut: loading a 4B takes ~3 seconds and real heat on this hardware, and a timer-only
//    session never needs the model at all. What the constraint actually protects — that no grammar
//    is ever first-parsed in front of a user, mid-flow — is preserved exactly: the guard runs
//    inside an explicit "getting ready" state, before the first token is ever generated.
//
// 2. THE 4B LOADS ONCE PER PROCESS. ~3 s cold, and the thermal envelope is the binding constraint
//    on this device (orientation §1) — reloading per conversation would be the most expensive
//    mistake available.

import { buildGrammarRegistry, runStartupGuard, type LLMProvider } from '../../llm/provider';
import { TernaryBonsaiProvider } from '../../llm/provider/ternaryBonsaiProvider';

export interface ReadyModel {
  provider: LLMProvider;
  /** False iff the startup guard caught a grammar that would not compile. Every constrained
   *  surface must then take the prompt-JSON + validation path instead (D10). */
  grammarEnabled: boolean;
}

export interface ModelHost {
  /** Loads the model and runs the startup guard, once. Safe to await repeatedly. */
  ensure(): Promise<ReadyModel>;
  isReady(): boolean;
  /** Progress for the "getting ready" state, so a 3-second load is explained rather than felt. */
  phase(): 'idle' | 'loading' | 'checking_grammars' | 'ready' | 'failed';
}

export interface ModelHostDeps {
  /** Test seam: supply a MockLLMProvider (plus its own compile check) instead of llama.rn. */
  createProvider?: () => LLMProvider & {
    load(): Promise<void>;
    compileGrammar: (grammar: string, surface?: string) => Promise<void>;
  };
  onLog?: (line: string) => void;
}

export function createModelHost(deps: ModelHostDeps = {}): ModelHost {
  let ready: ReadyModel | null = null;
  let inFlight: Promise<ReadyModel> | null = null;
  let phase: ReturnType<ModelHost['phase']> = 'idle';

  const log = deps.onLog ?? (() => {});

  async function load(): Promise<ReadyModel> {
    const provider = deps.createProvider ? deps.createProvider() : new TernaryBonsaiProvider();
    phase = 'loading';
    const startedAt = Date.now();
    await provider.load();
    log(`model loaded in ${Date.now() - startedAt}ms`);

    phase = 'checking_grammars';
    const guard = await runStartupGuard(provider.compileGrammar, buildGrammarRegistry());
    if (!guard.grammarEnabled) {
      for (const failure of guard.failures) {
        log(`grammar FAILED to compile: ${failure.surface} — ${failure.error}`);
      }
      log('grammar path DISABLED app-wide; constrained surfaces fall back to prompt-JSON.');
    }

    phase = 'ready';
    ready = { provider, grammarEnabled: guard.grammarEnabled };
    return ready;
  }

  return {
    async ensure(): Promise<ReadyModel> {
      if (ready) return ready;
      if (!inFlight) {
        inFlight = load().catch((err) => {
          phase = 'failed';
          inFlight = null;
          throw err;
        });
      }
      return inFlight;
    },
    isReady: () => ready !== null,
    phase: () => phase,
  };
}
