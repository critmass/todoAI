import * as fs from 'fs';
import * as path from 'path';
import { buildGrammar } from '../buildGrammar';

// Task 37 (docs/briefs/grammar_separator_hole_task_37.md; measured in
// docs/eval/qwen35_spike_findings.md, "Two defects found"): the separator-token hole.
//
// A free-text rule written as `name ::= "\"" jchar{1,n} "\""` is satisfied by the single token
// `","` — the quote opens the string, the comma is a legal jchar, the quote closes it. The
// output is well-formed JSON, schema-valid, and passes the validator, and it is useless. The
// fix is to require the first character to be alphanumeric (`firstChar`); the spike confirmed
// that a MINIMUM LENGTH does not close the hole (a 3-char minimum still produced
// `",Trash collection"`), so this guard is specifically about the first position.
//
// This is the regression lint for that fix, mirroring ruleNaming.test.ts's structure: it reads
// the checked-in .gbnf sources (the text that actually reaches the on-device parser) rather
// than trusting a code path.

/** A rule body that opens a JSON string — `"\""` followed by whatever comes next. Captures the
 *  term immediately after the opening quote literal so the guard can check it is `firstChar`. */
const STRING_OPENING = /"\\""\s+(\S+)/g;

function readGbnf(...segments: string[]): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', ...segments), 'utf-8');
}

const GBNF_FILES: Record<string, string> = {
  'task_extraction.v1.gbnf': readGbnf('extraction', 'task_extraction.v1.gbnf'),
  'task_breakdown.v1.gbnf': readGbnf('breakdown', 'task_breakdown.v1.gbnf'),
  'coaching_resolution.v1.gbnf': readGbnf('resolution', 'coaching_resolution.v1.gbnf'),
  'summary.v1.gbnf': readGbnf('summary', 'summary.v1.gbnf'),
};

/** Every non-comment line of a GBNF source. Comments are left in the file deliberately (`#`
 *  parses fine on this build — orientation §1) but must not be scanned, since they quote the
 *  vulnerable pattern in order to explain it. */
function ruleLines(gbnfText: string): string[] {
  return gbnfText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('no .gbnf free-text string opens with a bare jchar (task 37 separator-token hole)', () => {
  for (const [filename, text] of Object.entries(GBNF_FILES)) {
    it(`${filename}: every quoted string rule opens with firstChar`, () => {
      const openings: string[] = [];
      for (const line of ruleLines(text)) {
        for (const match of line.matchAll(STRING_OPENING)) {
          openings.push(`${line} -> ${match[1]}`);
        }
      }
      // Guard the guard: if the regex ever stops matching, this test would pass vacuously.
      expect(openings.length).toBeGreaterThan(0);
      for (const opening of openings) {
        // `tagKnown ::= "\"" {{context_tags_known}} "\""` is the one legitimate exemption: its
        // body is a D7 dynamic slot that buildGrammar replaces with a closed alternation of
        // literal values the app already holds, not a free-text character class. There is no
        // separator to emit there — the model can only pick one of the offered strings.
        if (opening.endsWith(' -> {{context_tags_known}}')) continue;
        expect(opening.endsWith(' -> firstChar')).toBe(true);
      }
    });

    it(`${filename}: defines firstChar as the alphanumeric class`, () => {
      expect(ruleLines(text)).toContain('firstChar ::= [a-zA-Z0-9]');
    });

    it(`${filename}: contains no bare jchar{1,n} repetition`, () => {
      for (const line of ruleLines(text)) {
        expect(line).not.toMatch(/jchar\{1,/);
      }
    });
  }
});

// Constraint #3 (orientation §4): the startup guard compiles every registered grammar, including
// the dynamic ones, via buildGrammar against representative slot values. A real llama.cpp parse
// is device-only; what is checkable headlessly is that substitution still succeeds and the
// tightened rules survive it intact.
const REPRESENTATIVE_SLOTS = {
  context_tags_known: ['home', 'office', 'phone', 'computer'],
  task_id: ['1', '2', '3'],
  depends_on_task_id: ['1', '2', '3'],
  parent_task_id: ['1'],
};

describe('buildGrammar substitution preserves the firstChar constraint', () => {
  for (const filename of [
    'task_extraction.v1.gbnf',
    'task_breakdown.v1.gbnf',
    'coaching_resolution.v1.gbnf',
  ]) {
    it(`${filename}: substituted text still defines firstChar and has no bare jchar{1,n}`, () => {
      const substituted = buildGrammar(GBNF_FILES[filename], REPRESENTATIVE_SLOTS);
      expect(substituted).not.toContain('{{');
      expect(ruleLines(substituted)).toContain('firstChar ::= [a-zA-Z0-9]');
      for (const line of ruleLines(substituted)) {
        expect(line).not.toMatch(/jchar\{1,/);
      }
    });
  }
});
