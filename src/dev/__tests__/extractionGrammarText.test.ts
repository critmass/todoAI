import * as fs from 'fs';
import * as path from 'path';
import { TASK_EXTRACTION_V1_GBNF } from '../extractionGrammarText';

// extractionGrammarText.ts is a generated, Metro-importable copy of
// src/llm/extraction/task_extraction.v1.gbnf (task 5's real, checked-in grammar - untouched).
// This guards against the copy drifting from the source; if it fails, regenerate the copy,
// don't hand-patch either file.
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
    expect(TASK_EXTRACTION_V1_GBNF).toBe(fileContents);
  });
});
