// Shared GBNF rule fragments (strategy D3: compact JSON, bounded everything, closed enums).
// These build rule-definition strings ("name ::= ..."); callers assemble them into a full
// grammar file. Nothing here executes a grammar - these are pure string builders.

/** The JSON-safe character class: excludes '"', backslash, and control chars 0x00-0x1F,
 *  or a valid backslash escape sequence. Defined once per grammar; bounded string rules
 *  reference it by name (JCHAR_RULE_NAME) rather than repeating the class inline. */
export const JCHAR_RULE_NAME = 'jchar';
const JCHAR_CLASS = String.raw`[^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})`;
export const JCHAR_RULE = `${JCHAR_RULE_NAME} ::= ${JCHAR_CLASS}`;

/** The alphanumeric class used to open every free-text string, closing the separator-token
 *  hole (task 37, docs/eval/task37_findings_report.md): a rule of the bare shape
 *  `"\"" jchar{1,n} "\""` is satisfied by the single token `","` alone - the quote opens the
 *  string, a comma is a legal jchar, the quote closes it, and the result is schema-valid and
 *  useless. Requiring the first character to be alphanumeric removes that token from
 *  contention. Defined once per grammar, like JCHAR_RULE; boundedStringRule references it by
 *  name (FIRST_CHAR_RULE_NAME) rather than repeating the class inline. */
export const FIRST_CHAR_RULE_NAME = 'firstChar';
const FIRST_CHAR_CLASS = '[a-zA-Z0-9]';
export const FIRST_CHAR_RULE = `${FIRST_CHAR_RULE_NAME} ::= ${FIRST_CHAR_CLASS}`;

/** A GBNF rule definition for a JSON string bounded to [min,max] characters, hardened against
 *  the task-37 separator-token hole: any non-empty output must open with FIRST_CHAR_RULE_NAME
 *  (alphanumeric), not a bare jchar. For min >= 1, e.g. boundedStringRule('str80', 1, 80) ->
 *  `str80 ::= "\"" firstChar jchar{0,79} "\""` - firstChar supplies the first of the 1..80
 *  required characters, jchar{0,79} the rest, so the rule still spans exactly 1..80 characters
 *  overall. For min === 0 the empty string can't be forced to start with an alphanumeric (there
 *  is no first character to constrain), so the rule is an explicit alternation of the empty
 *  string and the min-1 case, e.g. boundedStringRule('opt80', 0, 80) ->
 *  `opt80 ::= "\"\"" | "\"" firstChar jchar{0,79} "\""`.
 *  Assumes JCHAR_RULE and FIRST_CHAR_RULE are already defined in the grammar. */
export function boundedStringRule(ruleName: string, min: number, max: number): string {
  if (min < 0 || max < min) {
    throw new Error(`boundedStringRule: invalid bounds [${min},${max}] for "${ruleName}"`);
  }
  if (min >= 1) {
    return `${ruleName} ::= "\\"" ${FIRST_CHAR_RULE_NAME} ${JCHAR_RULE_NAME}{${min - 1},${max - 1}} "\\""`;
  }
  // min === 0: the empty string is legal and can't be routed through firstChar (there's no
  // character to constrain), so it's offered as its own literal alternative. The non-empty
  // branch reuses the min>=1 shape with an effective min of 1.
  if (max === 0) {
    return `${ruleName} ::= "\\"\\""`;
  }
  return `${ruleName} ::= "\\"\\"" | "\\"" ${FIRST_CHAR_RULE_NAME} ${JCHAR_RULE_NAME}{0,${max - 1}} "\\""`;
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
