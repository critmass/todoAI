import {
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
  it('produces a quoted, bounded jchar repetition', () => {
    expect(boundedStringRule('str80', 1, 80)).toBe('str80 ::= "\\"" jchar{1,80} "\\""');
  });

  it('rejects invalid bounds', () => {
    expect(() => boundedStringRule('bad', -1, 5)).toThrow();
    expect(() => boundedStringRule('bad', 10, 5)).toThrow();
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
