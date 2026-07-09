// {m,n} -> nested-optional expander (strategy D3.5 fallback insurance). `{m,n}` support in
// the llama.cpp bundled with llama.rn 0.12.5 is unverified (no device in this session - see
// eval Q1). Grammars are authored with `{m,n}` directly; if Q1 later shows it unsupported,
// regenerating with this expansion is a config flip, not a rewrite.

/**
 * Expands `element{min,max}` into an equivalent nested-optional GBNF sequence:
 * `min` mandatory copies of `element`, followed by up to `(max - min)` more copies nested in
 * optionals, e.g. expandBoundedRepetition('jchar', 1, 3) -> `jchar (jchar (jchar)?)?`.
 *
 * `element` should be a single GBNF term (a rule name, or a parenthesized group) - the caller
 * is responsible for wrapping a multi-token element in parens before passing it in.
 */
export function expandBoundedRepetition(element: string, min: number, max: number): string {
  if (min < 0 || max < min) {
    throw new Error(`expandBoundedRepetition: invalid bounds [${min},${max}]`);
  }

  let optionalTail = '';
  for (let i = 0; i < max - min; i++) {
    optionalTail = optionalTail === '' ? `(${element})?` : `(${element} ${optionalTail})?`;
  }

  const mandatory = Array(min).fill(element);
  const parts = optionalTail === '' ? mandatory : [...mandatory, optionalTail];

  if (parts.length === 0) {
    // min === max === 0: the rule matches nothing at all.
    return '""';
  }
  return parts.join(' ');
}

/** Rewrites every `name{min,max}` occurrence of `elementRuleName` within a larger GBNF rule
 *  body to its nested-optional expansion, e.g. rewriteBoundedRepetition('jchar{1,80}',
 *  'jchar') -> `jchar (jchar (jchar (... 80 deep))?)?`. Convenience for expanding a rule
 *  fragment produced by primitives.ts without hand-parsing bounds twice. */
export function rewriteBoundedRepetition(ruleBody: string, elementRuleName: string): string {
  const pattern = new RegExp(`${elementRuleName}\\{(\\d+),(\\d+)\\}`, 'g');
  return ruleBody.replace(pattern, (_match, min: string, max: string) =>
    expandBoundedRepetition(elementRuleName, Number(min), Number(max)),
  );
}
