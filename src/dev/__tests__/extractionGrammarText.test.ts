import * as fs from 'fs';
import * as path from 'path';
import { TASK_EXTRACTION_V1_GBNF } from '../extractionGrammarText';

// extractionGrammarText.ts is a generated, Metro-importable copy of
// src/llm/extraction/task_extraction.v1.gbnf (task 5's real, checked-in grammar - untouched).
// This guards against the copy drifting from the source; if it fails, regenerate the copy,
// don't hand-patch either file.
//
// Line endings are normalized on both sides for the reason spelled out in
// src/llm/grammar/__tests__/grammarText.test.ts: a template literal's CRLFs become LFs at parse
// time, so on an autocrlf checkout byte-exact equality is unreachable. Content drift is still caught.
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

describe('TASK_EXTRACTION_V1_GBNF', () => {
  it('is byte-identical to src/llm/extraction/task_extraction.v1.gbnf', () => {
    const gbnfPath = path.join(
      __dirname,
      '..',
      '..',
      'llm',
      'extraction',
      'task_extraction.v1.gbnf',
    );
    const fileContents = fs.readFileSync(gbnfPath, 'utf-8');
    expect(lf(TASK_EXTRACTION_V1_GBNF)).toBe(lf(fileContents));
  });
});
