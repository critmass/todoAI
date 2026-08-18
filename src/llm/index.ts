// Barrel export for the structured-output layer (task 5: schemas, grammars, validators,
// mappers). Static artifacts and pure functions only - see src/llm/README.md.
//
// Deliberately no Node built-ins (`fs`/`path`) here: this barrel's validators/mappers are
// meant to run on-device too (task 6 imports them), and Node core modules aren't available in
// an RN/Metro bundle. SCHEMA_PATHS below are plain string constants for that reason - desktop
// tooling (the eval harness, task 20) resolves them against the repo root itself.

export {
  taskExtractionSchema,
  validate as validateTaskExtraction,
  type TaskExtractionV1,
} from './extraction/validator';
export { extractionToTaskWrite, type ExtractionMapped } from './extraction/mapper';

export {
  taskBreakdownSchema,
  validate as validateTaskBreakdown,
  type TaskBreakdownV1,
} from './breakdown/validator';
export {
  subtaskImportance,
  breakdownToSubtaskWrites,
  sequentialUnlocks,
  type ParentContext,
  type SubtaskWrite,
} from './breakdown/mapper';

export {
  coachingResolutionSchema,
  validate as validateCoachingResolution,
  type CoachingResolutionV1,
} from './resolution/validator';

export { summarySchema, validate as validateSummary, type SummaryV1 } from './summary/validator';

export { resolveDue, type DueSpec } from './due/dueSpec';

export { buildGrammar, escapeGbnfLiteral, type GrammarSlotValues } from './grammar/buildGrammar';
export { expandBoundedRepetition, rewriteBoundedRepetition } from './grammar/boundedRepetition';
export {
  JCHAR_RULE,
  JCHAR_RULE_NAME,
  FIRST_CHAR_RULE,
  FIRST_CHAR_RULE_NAME,
  boundedStringRule,
  boundedIntRule,
  literalAlternationRule,
  nullableRule,
} from './grammar/primitives';

export { LlmOutputValidationError } from './errors';

/** Schema/grammar file paths, relative to the repo root - for desktop tooling that needs to
 *  read the .json/.gbnf files directly (the eval harness, a future codegen step). */
export const SCHEMA_PATHS = {
  taskExtraction: {
    json: 'src/llm/extraction/task_extraction.v1.json',
    gbnf: 'src/llm/extraction/task_extraction.v1.gbnf',
  },
  taskBreakdown: {
    json: 'src/llm/breakdown/task_breakdown.v1.json',
    gbnf: 'src/llm/breakdown/task_breakdown.v1.gbnf',
  },
  coachingResolution: {
    json: 'src/llm/resolution/coaching_resolution.v1.json',
    gbnf: 'src/llm/resolution/coaching_resolution.v1.gbnf',
  },
  summary: {
    json: 'src/llm/summary/summary.v1.json',
    gbnf: 'src/llm/summary/summary.v1.gbnf',
  },
} as const;
