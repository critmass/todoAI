// Barrel for the LLM provider layer (task 6, spec §3.6). Backend-agnostic surface: the interface,
// the D10 ladder, the startup guard, the grammar registry, and the two implementations.
export type {
  ChatMessage,
  GenerateOptions,
  GenerationTimings,
  LLMResponse,
  LLMCapabilities,
  LLMProvider,
  ThermalHeadroom,
  ModelTier,
} from './types';

export {
  runConstrained,
  type ConstrainedCall,
  type LadderResult,
} from './ladder';

export {
  runStartupGuard,
  type TryCompile,
  type StartupGuardResult,
  type GrammarCompileFailure,
} from './startupGuard';

export {
  buildGrammarRegistry,
  REPRESENTATIVE_SLOTS,
  type GenerationSurface,
  type GrammarRegistryEntry,
} from './grammarRegistry';

export {
  MockLLMProvider,
  type MockLLMProviderConfig,
  type MockStep,
  type MockResponder,
  type MockCall,
} from './mockProvider';

export {
  DEFAULT_TERNARY_BONSAI_CONFIG,
  buildCompletionParams,
  mapCompletionResult,
  selectTier,
  thermalHeadroomFromAndroidStatus,
  type TernaryBonsaiConfig,
  type CompletionParams,
  type RawCompletionResult,
} from './ternaryBonsaiSupport';

// NOTE: TernaryBonsaiProvider (./ternaryBonsaiProvider.ts) is intentionally NOT re-exported here.
// It imports llama.rn; keep it a direct import from the app entry point / Phase-B wiring so the
// backend-agnostic surface above never drags the native module into unrelated code.
