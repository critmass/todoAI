import {
  FIRST_CHAR_RULE,
  FIRST_CHAR_RULE_NAME,
  JCHAR_RULE,
  JCHAR_RULE_NAME,
  boundedIntRule,
  boundedStringRule,
  literalAlternationRule,
  nullableRule,
} from '../primitives';

describe('JCHAR_RULE', () => {
  it('excludes the quote/backslash/control-char range and allows valid escapes', () => {
    expect(JCHAR_RULE_NAME).toBe('jchar');
    expect(JCHAR_RULE).toBe(`jchar ::= ${String.raw`[^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})`}`);
    expect(JCHAR_RULE).toContain('[0-9a-fA-F]{4}');
    expect(JCHAR_RULE).toContain('bfnrt');
  });
});

describe('boundedStringRule', () => {
  it('opens a min>=1 string with firstChar, preserving the [min,max] character span', () => {
    // 1..80 chars total: firstChar supplies 1, jchar{0,79} supplies the rest.
    expect(boundedStringRule('str80', 1, 80)).toBe('str80 ::= "\\"" firstChar jchar{0,79} "\\""');
  });

  it('shifts both bounds down by one for a min>1 string', () => {
    // 3..10 chars total: firstChar supplies 1, jchar{2,9} supplies the rest.
    expect(boundedStringRule('str10', 3, 10)).toBe('str10 ::= "\\"" firstChar jchar{2,9} "\\""');
  });

  it('offers the empty string as an explicit alternative when min is 0', () => {
    // Can't force an empty string to start with an alphanumeric - there's no first character.
    expect(boundedStringRule('opt80', 0, 80)).toBe(
      'opt80 ::= "\\"\\"" | "\\"" firstChar jchar{0,79} "\\""',
    );
  });

  it('collapses to the empty-string literal when min and max are both 0', () => {
    expect(boundedStringRule('empty0', 0, 0)).toBe('empty0 ::= "\\"\\""');
  });

  it('rejects invalid bounds', () => {
    expect(() => boundedStringRule('bad', -1, 5)).toThrow();
    expect(() => boundedStringRule('bad', 10, 5)).toThrow();
  });
});

describe('FIRST_CHAR_RULE', () => {
  it('is the alphanumeric class, matching the .gbnf definitions (task 37)', () => {
    expect(FIRST_CHAR_RULE_NAME).toBe('firstChar');
    expect(FIRST_CHAR_RULE).toBe('firstChar ::= [a-zA-Z0-9]');
  });
});

describe('boundedIntRule', () => {
  it('bounds digit count with no leading zero, single-digit case', () => {
    expect(boundedIntRule('importance', 1)).toBe('importance ::= [1-9]');
  });

  it('bounds digit count with no leading zero, multi-digit case', () => {
    expect(boundedIntRule('minutes', 4)).toBe('minutes ::= [1-9] [0-9]{0,3}');
  });

  it('rejects a non-positive digit count', () => {
    expect(() => boundedIntRule('bad', 0)).toThrow();
  });
});

describe('literalAlternationRule', () => {
  it('produces a closed set of quoted literal alternatives', () => {
    expect(literalAlternationRule('weekday', ['monday', 'tuesday'])).toBe(
      'weekday ::= "\\"monday\\"" | "\\"tuesday\\""',
    );
  });

  it('rejects an empty value list', () => {
    expect(() => literalAlternationRule('empty', [])).toThrow();
  });
});

describe('nullableRule', () => {
  it('produces null-or-inner-rule alternation', () => {
    expect(nullableRule('importance', 'importance_value')).toBe(
      'importance ::= "null" | importance_value',
    );
  });
});
