// Shared GBNF rule fragments (strategy D3: compact JSON, bounded everything, closed enums).
// These build rule-definition strings ("name ::= ..."); callers assemble them into a full
// grammar file. Nothing here executes a grammar - these are pure string builders.

/** The JSON-safe character class: excludes '"', backslash, and control chars 0x00-0x1F,
 *  or a valid backslash escape sequence. Defined once per grammar; bounded string rules
 *  reference it by name (JCHAR_RULE_NAME) rather than repeating the class inline. */
export const JCHAR_RULE_NAME = 'jchar';
const JCHAR_CLASS = String.raw`[^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})`;
export const JCHAR_RULE = `${JCHAR_RULE_NAME} ::= ${JCHAR_CLASS}`;

/** A GBNF rule definition for a JSON string bounded to [min,max] characters, e.g.
 *  `str80 ::= "\"" jchar{1,80} "\""`. Assumes JCHAR_RULE is already defined in the grammar. */
export function boundedStringRule(ruleName: string, min: number, max: number): string {
  if (min < 0 || max < min) {
    throw new Error(`boundedStringRule: invalid bounds [${min},${max}] for "${ruleName}"`);
  }
  return `${ruleName} ::= "\\"" ${JCHAR_RULE_NAME}{${min},${max}} "\\""`;
}

/** A GBNF rule definition for a positive integer with no more than maxDigits digits and no
 *  leading zero, e.g. boundedIntRule('minutes', 4) -> `minutes ::= [1-9] [0-9]{0,3}`.
 *  This bounds *digit count*, not the exact numeric range (GBNF can't express ">1440
 *  forbidden" without enumerating every value) - the zod cross-field rules enforce the exact
 *  range downstream (D10). This mirrors the strategy doc's own illustrative idiom (§3.3). */
export function boundedIntRule(ruleName: string, maxDigits: number): string {
  if (maxDigits < 1) {
    throw new Error(`boundedIntRule: maxDigits must be >= 1 for "${ruleName}"`);
  }
  if (maxDigits === 1) {
    return `${ruleName} ::= [1-9]`;
  }
  return `${ruleName} ::= [1-9] [0-9]{0,${maxDigits - 1}}`;
}

/** A GBNF rule definition that is a closed set of literal string alternatives, e.g.
 *  literalAlternationRule('weekday', ['monday', ..., 'sunday']) ->
 *  `weekday ::= "\"monday\"" | ... | "\"sunday\""`. For closed enums (D3.4). */
export function literalAlternationRule(ruleName: string, values: readonly string[]): string {
  if (values.length === 0) {
    throw new Error(`literalAlternationRule: "${ruleName}" needs at least one literal`);
  }
  const alternatives = values.map((v) => `"\\"${v}\\""`).join(' | ');
  return `${ruleName} ::= ${alternatives}`;
}

/** A GBNF rule definition that is JSON `null` or a reference to another rule, e.g.
 *  nullableRule('importance', 'importance_value') -> `importance ::= "null" | importance_value`. */
export function nullableRule(ruleName: string, innerRuleName: string): string {
  return `${ruleName} ::= "null" | ${innerRuleName}`;
}
