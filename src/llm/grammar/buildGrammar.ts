// Slot substitution for dynamic-vocabulary grammars (strategy D7). Some grammars can't be
// fully static because the legal value set (task ids in play, known context tags) is known
// only at call time. Templates mark a slot with `{{slot_name}}`; buildGrammar substitutes it
// with a GBNF alternation of the slot's literal values, GBNF-escaped. Task 6 supplies the
// slot values at runtime; this module only builds the substitution mechanism.

const SLOT_PATTERN = /\{\{(\w+)\}\}/g;

/** Escapes a string for embedding as a GBNF string-literal token (inside `"..."`). */
export function escapeGbnfLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export type GrammarSlotValues = Record<string, readonly string[]>;

/**
 * Replaces every `{{slot_name}}` in `template` with a parenthesized GBNF alternation of that
 * slot's values, e.g. slots={ task_id: ['12','47'] } turns `{{task_id}}` into `("12"|"47")`.
 * Throws if the template references a slot that's missing from `slots` or has zero values -
 * an empty alternation isn't valid GBNF, and a caller needing "no known values yet" (e.g. a
 * fresh install with no context tags) should use a template variant that doesn't reference
 * that slot at all rather than pass an empty list here.
 */
export function buildGrammar(template: string, slots: GrammarSlotValues): string {
  return template.replace(SLOT_PATTERN, (_match, slotName: string) => {
    const values = slots[slotName];
    if (!values || values.length === 0) {
      throw new Error(`buildGrammar: slot "${slotName}" needs at least one value`);
    }
    const alternatives = values.map((v) => `"${escapeGbnfLiteral(v)}"`).join('|');
    return `(${alternatives})`;
  });
}
