// Task 6 — the registry of every grammar the startup guard must compile-check (constraint #3).
// Each dynamic template (D7) is substituted here via buildGrammar against REPRESENTATIVE slot
// values, so the guard verifies the template's *shape* parses. At real call time the provider
// rebuilds the grammar with the actual slots (real task ids, the real tag vocabulary) — the
// representative build is a startup smoke test, not the runtime grammar.

import { buildGrammar } from '../grammar/buildGrammar';
import {
  COACHING_RESOLUTION_V1_GBNF,
  SUMMARY_V1_GBNF,
  TASK_BREAKDOWN_V1_GBNF,
  TASK_EXTRACTION_V1_GBNF,
} from '../grammar/grammarText';

/** The four structured-output surfaces (strategy §2). Also the natural key for per-surface
 *  budgets and metrics. */
export type GenerationSurface =
  | 'task_extraction'
  | 'task_breakdown'
  | 'coaching_resolution'
  | 'summary';

export interface GrammarRegistryEntry {
  surface: GenerationSurface;
  /** Fully-substituted, representative grammar text — ready to hand to a compile check. */
  grammar: string;
}

/** Representative slot values for the startup compile-check. Small, valid stand-ins — the shape
 *  is what's being verified, not the values (which vary per call). Mirrors the Q1 spike's set. */
export const REPRESENTATIVE_SLOTS = {
  contextTagsKnown: ['home', 'office', 'phone', 'computer'],
  taskIds: ['12', '47', '103'],
  parentTaskId: ['42'],
} as const;

/**
 * Builds the compile-check registry: every registered grammar, dynamic ones substituted with
 * representative slot values (the brief's "each dynamic template via buildGrammar against
 * representative slot values"). Summary is fully static (no slots) and passes through unchanged.
 * Throws only if a template references a slot this function forgot to supply — a developer error
 * surfaced loudly at startup, not a model/grammar failure.
 */
export function buildGrammarRegistry(): GrammarRegistryEntry[] {
  return [
    {
      surface: 'task_extraction',
      grammar: buildGrammar(TASK_EXTRACTION_V1_GBNF, {
        context_tags_known: REPRESENTATIVE_SLOTS.contextTagsKnown,
      }),
    },
    {
      surface: 'task_breakdown',
      grammar: buildGrammar(TASK_BREAKDOWN_V1_GBNF, {
        parent_task_id: REPRESENTATIVE_SLOTS.parentTaskId,
      }),
    },
    {
      surface: 'coaching_resolution',
      grammar: buildGrammar(COACHING_RESOLUTION_V1_GBNF, {
        task_id: REPRESENTATIVE_SLOTS.taskIds,
        depends_on_task_id: REPRESENTATIVE_SLOTS.taskIds,
        context_tags_known: REPRESENTATIVE_SLOTS.contextTagsKnown,
      }),
    },
    {
      // Fully static — buildGrammar is a no-op with no slots, kept uniform for the registry shape.
      surface: 'summary',
      grammar: buildGrammar(SUMMARY_V1_GBNF, {}),
    },
  ];
}
