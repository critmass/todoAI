import { expandBoundedRepetition, rewriteBoundedRepetition } from '../boundedRepetition';

describe('expandBoundedRepetition', () => {
  it('expands {1,3} to a mandatory copy plus two nested optionals', () => {
    expect(expandBoundedRepetition('jchar', 1, 3)).toBe('jchar (jchar (jchar)?)?');
  });

  it('expands {0,2} to fully-optional nesting with no mandatory copies', () => {
    expect(expandBoundedRepetition('jchar', 0, 2)).toBe('(jchar (jchar)?)?');
  });

  it('expands an exact count {2,2} with no optional tail', () => {
    expect(expandBoundedRepetition('jchar', 2, 2)).toBe('jchar jchar');
  });

  it('expands {0,0} to the empty match', () => {
    expect(expandBoundedRepetition('jchar', 0, 0)).toBe('""');
  });

  it('rejects invalid bounds', () => {
    expect(() => expandBoundedRepetition('jchar', -1, 3)).toThrow();
    expect(() => expandBoundedRepetition('jchar', 5, 3)).toThrow();
  });
});

describe('rewriteBoundedRepetition', () => {
  it('rewrites a bounded-repetition rule fragment produced by primitives.ts', () => {
    const original = 'str80 ::= "\\"" jchar{1,3} "\\""';
    const rewritten = rewriteBoundedRepetition(original, 'jchar');
    expect(rewritten).toBe('str80 ::= "\\"" jchar (jchar (jchar)?)? "\\""');
  });

  it('leaves the rule unchanged if the element never appears with {m,n}', () => {
    const original = 'weekday ::= "\\"monday\\"" | "\\"tuesday\\""';
    expect(rewriteBoundedRepetition(original, 'jchar')).toBe(original);
  });
});
