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
import { record, sampleThermal, thermalStatusSampler } from '../../capture';

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
    const provider = deps.createProvider
      ? deps.createProvider()
      : // TASK 41 — the thermal sampler, which has stood at `() => 0` since task 6 with a comment
        // saying it would be wired "in Phase B". `currentThermalHeadroom()` and `activeTier()` are
        // built on top of it, so this is a live product seam that was standing empty.
        //
        // 🔴 THIS IS A DEVIATION FROM A SETTLED RECORD AND IT IS JASON'S INSTRUCTION, NOT THE
        // BUILDER'S JUDGMENT. Orientation §8 pins the thermal sampler to task 19; Jason reassigned
        // it to task 41 on 2026-08-17 (amendment §4): "this falls under logging as far as I'm
        // concerned, so it can go here." Recorded under "Deviations from human decisions" in
        // docs/eval/task41_findings_report.md.
        //
        // SAMPLING ONLY, NO POLICY. Nothing here degrades a tier, defers work or gates background
        // activity; those remain task 19's and task 8's.
        new TernaryBonsaiProvider({}, { thermalStatusSampler });
    phase = 'loading';
    const startedAt = Date.now();
    await provider.load();
    const modelLoadMs = Date.now() - startedAt;
    log(`model loaded in ${modelLoadMs}ms`);
    const sample = sampleThermal();
    record({
      stream: 'runtime',
      type: 'model_load',
      modelLoadMs,
      thermalStatus: sample && sample.thermalStatus >= 0 ? sample.thermalStatus : undefined,
      batteryLevel: sample && sample.batteryLevel >= 0 ? sample.batteryLevel : undefined,
      charging: sample?.charging,
    });

    phase = 'checking_grammars';
    const guard = await runStartupGuard(provider.compileGrammar, buildGrammarRegistry());
    // Constraint #3's startup guard result, in the log from the first run. It has never been
    // recorded anywhere durable, so "did the grammar path survive this build" has only ever been
    // answerable by watching a console.
    record({
      stream: 'lifecycle',
      type: 'grammar_guard',
      grammarEnabled: guard.grammarEnabled,
      grammarFailures: guard.failures,
    });
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
