import * as fs from 'fs';
import * as path from 'path';
import * as llm from '../index';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

describe('src/llm barrel', () => {
  it('imports cleanly and exposes a validate + mapper per surface, plus shared helpers', () => {
    expect(typeof llm.validateTaskExtraction).toBe('function');
    expect(typeof llm.extractionToTaskWrite).toBe('function');
    expect(typeof llm.validateTaskBreakdown).toBe('function');
    expect(typeof llm.subtaskImportance).toBe('function');
    expect(typeof llm.breakdownToSubtaskWrites).toBe('function');
    expect(typeof llm.validateCoachingResolution).toBe('function');
    expect(typeof llm.validateSummary).toBe('function');
    expect(typeof llm.resolveDue).toBe('function');
    expect(typeof llm.buildGrammar).toBe('function');
    expect(typeof llm.expandBoundedRepetition).toBe('function');
    expect(typeof llm.boundedStringRule).toBe('function');
    expect(llm.LlmOutputValidationError).toBeDefined();
  });

  it('every SCHEMA_PATHS entry resolves to a real file on disk', () => {
    for (const surface of Object.values(llm.SCHEMA_PATHS)) {
      for (const relativePath of Object.values(surface)) {
        const fullPath = path.join(REPO_ROOT, relativePath);
        expect(fs.existsSync(fullPath)).toBe(true);
      }
    }
  });
});
