import * as fs from 'fs';
import * as path from 'path';
import { buildGrammar } from '../buildGrammar';

// Q1c (docs/eval/Q1c_findings_report.md): llama.cpp's GBNF parser on this build lexes rule
// names with an is_word_char predicate that accepts letters, digits, and `-`, but NOT `_` - an
// underscore inside a rule name silently truncates the identifier and the parser then fails on
// the malformed remainder ("failed to parse grammar"). This is the regression guard for that
// constraint: no checked-in rule name, and nothing buildGrammar emits for a dynamic template,
// may contain `_`. JSON keys and string literal values are untouched by this rule - it governs
// only bare rule identifiers (the LHS of `::=`).
const RULE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const RULE_DEFINITION_LINE = /^([^\s#][^\s]*)\s*::=/;

/** Extracts every rule name (LHS of `::=`) from a GBNF source, skipping comments/blank lines. */
function extractRuleNames(gbnfText: string): string[] {
  const names: string[] = [];
  for (const line of gbnfText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(RULE_DEFINITION_LINE);
    if (match) names.push(match[1]);
  }
  return names;
}

function readGbnf(...segments: string[]): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', ...segments), 'utf-8');
}

const GBNF_FILES: Record<string, string> = {
  'task_extraction.v1.gbnf': readGbnf('extraction', 'task_extraction.v1.gbnf'),
  'task_breakdown.v1.gbnf': readGbnf('breakdown', 'task_breakdown.v1.gbnf'),
  'coaching_resolution.v1.gbnf': readGbnf('resolution', 'coaching_resolution.v1.gbnf'),
  'summary.v1.gbnf': readGbnf('summary', 'summary.v1.gbnf'),
};

describe('checked-in .gbnf rule names contain no underscores', () => {
  for (const [filename, text] of Object.entries(GBNF_FILES)) {
    it(`${filename}: every rule name matches ${RULE_NAME_PATTERN}`, () => {
      const names = extractRuleNames(text);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).toMatch(RULE_NAME_PATTERN);
      }
    });
  }
});

// Representative slot values for each dynamic-vocabulary template (D7) - substitution only
// replaces `{{slot_name}}` placeholders, but the lint still needs to run on the emitted text
// since that's what actually reaches the on-device parser.
const REPRESENTATIVE_SLOTS = {
  context_tags_known: ['home', 'office', 'phone', 'computer'],
  task_id: ['1', '2', '3'],
  depends_on_task_id: ['1', '2', '3'],
  parent_task_id: ['1'],
};

describe("buildGrammar's substituted output contains no underscored rule names", () => {
  for (const filename of ['task_extraction.v1.gbnf', 'task_breakdown.v1.gbnf', 'coaching_resolution.v1.gbnf']) {
    it(`${filename}: substituted text's rule names match ${RULE_NAME_PATTERN}`, () => {
      const substituted = buildGrammar(GBNF_FILES[filename], REPRESENTATIVE_SLOTS);
      const names = extractRuleNames(substituted);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).toMatch(RULE_NAME_PATTERN);
      }
    });
  }
});
