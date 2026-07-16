import * as fs from 'fs';
import * as path from 'path';
import {
  COACHING_RESOLUTION_V1_GBNF,
  SUMMARY_V1_GBNF,
  TASK_BREAKDOWN_V1_GBNF,
  TASK_EXTRACTION_V1_GBNF,
} from '../grammarText';

// grammarText.ts embeds byte-identical copies of task 5's checked-in .gbnf files so the RN
// bundle (which cannot import a raw .gbnf) has the grammar text at runtime. These guard against
// the copies drifting from source; on failure, regenerate grammarText.ts — don't hand-patch it.
const llmRoot = path.join(__dirname, '..', '..');

const cases: Array<[string, string, string]> = [
  ['TASK_EXTRACTION_V1_GBNF', TASK_EXTRACTION_V1_GBNF, 'extraction/task_extraction.v1.gbnf'],
  ['TASK_BREAKDOWN_V1_GBNF', TASK_BREAKDOWN_V1_GBNF, 'breakdown/task_breakdown.v1.gbnf'],
  [
    'COACHING_RESOLUTION_V1_GBNF',
    COACHING_RESOLUTION_V1_GBNF,
    'resolution/coaching_resolution.v1.gbnf',
  ],
  ['SUMMARY_V1_GBNF', SUMMARY_V1_GBNF, 'summary/summary.v1.gbnf'],
];

describe('grammarText embedded constants', () => {
  it.each(cases)('%s is byte-identical to its source .gbnf', (_name, constant, relPath) => {
    const fileContents = fs.readFileSync(path.join(llmRoot, relPath), 'utf-8');
    expect(constant).toBe(fileContents);
  });
});
