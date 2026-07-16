// Task 6 — the startup grammar-validation guard (constraint #3, non-negotiable). A malformed
// grammar can kill the process UNCATCHABLY the first time llama.cpp parses it (observed in Q1:
// no JS error, no tombstone) — a death the D10 retry ladder cannot recover from. So EVERY
// registered grammar is compile-checked at init, BEFORE any user session. If any fails, the
// grammar path is disabled and the app falls back to prompt-JSON + validation (D10) — converting
// an uncatchable mid-session crash into a caught startup condition.
//
// What is headless-testable HERE (Phase A): the registry iteration, the compile-attempt orchestration,
// and the fallback decision (fed a `tryCompile` that throws for a simulated bad grammar).
// What is NOT (→ Phase B): that a real malformed grammar's process-death actually happens at
// startup rather than mid-session, and that the guard's pre-session timing genuinely contains it.

import type { GrammarRegistryEntry } from './grammarRegistry';
import { buildGrammarRegistry } from './grammarRegistry';

/** Attempts to compile a grammar; resolves if it parses, rejects/throws if it fails to. On
 *  device this is a real llama.cpp parse attempt (a tiny n_predict completion under the grammar);
 *  in tests it's a simulation. NOTE: a truly uncatchable process death cannot be turned into a
 *  rejection — that case is the Phase-B reality this guard's *timing* (pre-session) defends
 *  against, not something a Promise can observe. */
export type TryCompile = (grammar: string, surface: string) => Promise<void>;

export interface GrammarCompileFailure {
  surface: string;
  error: string;
}

export interface StartupGuardResult {
  /** True iff every registered grammar compiled. When false the app MUST use the prompt-JSON +
   *  validation fallback path for all constrained surfaces (D10), never the grammar path. */
  grammarEnabled: boolean;
  attempted: number;
  failures: GrammarCompileFailure[];
}

/**
 * Runs the startup guard over `registry` (defaults to the full app registry). Attempts every
 * grammar — it does NOT stop at the first failure, so the log names every broken surface in one
 * pass. Grammar decoding is enabled only if all compile checks pass.
 */
export async function runStartupGuard(
  tryCompile: TryCompile,
  registry: GrammarRegistryEntry[] = buildGrammarRegistry(),
): Promise<StartupGuardResult> {
  const failures: GrammarCompileFailure[] = [];

  for (const entry of registry) {
    try {
      await tryCompile(entry.grammar, entry.surface);
    } catch (err) {
      failures.push({
        surface: entry.surface,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    grammarEnabled: failures.length === 0,
    attempted: registry.length,
    failures,
  };
}
