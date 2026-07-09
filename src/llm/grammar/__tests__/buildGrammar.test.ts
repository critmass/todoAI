import { buildGrammar, escapeGbnfLiteral } from '../buildGrammar';

describe('escapeGbnfLiteral', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeGbnfLiteral('plain')).toBe('plain');
    expect(escapeGbnfLiteral('has "quotes"')).toBe('has \\"quotes\\"');
    expect(escapeGbnfLiteral('back\\slash')).toBe('back\\\\slash');
    expect(escapeGbnfLiteral('both\\ "and"')).toBe('both\\\\ \\"and\\"');
  });
});

describe('buildGrammar', () => {
  it('substitutes a single-value slot as a one-alternative alternation', () => {
    const template = 'task_id ::= {{task_id}}';
    expect(buildGrammar(template, { task_id: ['12'] })).toBe('task_id ::= ("12")');
  });

  it('substitutes a multi-value slot as a pipe-joined alternation', () => {
    const template = 'task_id ::= {{task_id}}';
    expect(buildGrammar(template, { task_id: ['12', '47', '103'] })).toBe(
      'task_id ::= ("12"|"47"|"103")',
    );
  });

  it('substitutes multiple distinct slots in one template', () => {
    const template = 'root ::= {{task_id}} {{tag}}';
    const result = buildGrammar(template, { task_id: ['1'], tag: ['home', 'work'] });
    expect(result).toBe('root ::= ("1") ("home"|"work")');
  });

  it('GBNF-escapes injected values containing quotes or backslashes rather than breaking the grammar', () => {
    const template = 'tag ::= {{tag}}';
    const result = buildGrammar(template, { tag: ['weird"tag', 'back\\slash'] });
    expect(result).toBe('tag ::= ("weird\\"tag"|"back\\\\slash")');
  });

  it('throws when a referenced slot has no values provided', () => {
    const template = 'task_id ::= {{task_id}}';
    expect(() => buildGrammar(template, {})).toThrow(/task_id/);
    expect(() => buildGrammar(template, { task_id: [] })).toThrow(/task_id/);
  });

  it('leaves a template with no slot placeholders untouched', () => {
    const template = 'root ::= "static"';
    expect(buildGrammar(template, {})).toBe(template);
  });
});
