// D2: zod validator and JSON Schema agree on a shared valid/invalid fixture set. ajv actually
// evaluates the .json file, so this is a real agreement check, not a declared one.
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { taskBreakdownSchema } from '../validator';

const schemaPath = path.join(__dirname, '..', 'task_breakdown.v1.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
const ajvValidate = ajv.compile(jsonSchema);

function baseValid() {
  return {
    parent_task_id: 42,
    ordered: false,
    subtasks: [
      { title: 'clear a shelf', estimated_duration_minutes: 20, duration_from_user: false },
      { title: 'sort into keep/donate/trash', estimated_duration_minutes: 30, duration_from_user: true },
    ],
  };
}

const fixtures: Array<{ name: string; value: unknown; expectValid: boolean }> = [
  { name: 'minimal 2-subtask object', value: baseValid(), expectValid: true },
  {
    name: 'maximal 8-subtask object',
    value: {
      parent_task_id: 1,
      ordered: true,
      subtasks: Array.from({ length: 8 }, (_, i) => ({
        title: `step ${i + 1}`,
        estimated_duration_minutes: 15,
        duration_from_user: false,
      })),
    },
    expectValid: true,
  },
  {
    name: 'fewer than 2 subtasks',
    value: { ...baseValid(), subtasks: [baseValid().subtasks[0]] },
    expectValid: false,
  },
  {
    name: 'more than 8 subtasks',
    value: { ...baseValid(), subtasks: Array.from({ length: 9 }, () => baseValid().subtasks[0]) },
    expectValid: false,
  },
  { name: 'unknown extra root key', value: { ...baseValid(), extra: 'nope' }, expectValid: false },
  {
    name: 'unknown extra subtask key',
    value: {
      ...baseValid(),
      subtasks: [{ ...baseValid().subtasks[0], energy: 'high' }, baseValid().subtasks[1]],
    },
    expectValid: false,
  },
  { name: 'non-positive parent_task_id', value: { ...baseValid(), parent_task_id: 0 }, expectValid: false },
  {
    name: 'subtask title too long',
    value: {
      ...baseValid(),
      subtasks: [{ ...baseValid().subtasks[0], title: 'x'.repeat(81) }, baseValid().subtasks[1]],
    },
    expectValid: false,
  },
  {
    name: 'subtask duration out of range',
    value: {
      ...baseValid(),
      subtasks: [
        { ...baseValid().subtasks[0], estimated_duration_minutes: 1441 },
        baseValid().subtasks[1],
      ],
    },
    expectValid: false,
  },
  { name: 'missing required root key (ordered)', value: (() => { const rest: Record<string, unknown> = baseValid(); delete rest.ordered; return rest; })(), expectValid: false },
];

describe('task_breakdown.v1: zod validator agrees with the JSON Schema', () => {
  for (const fixture of fixtures) {
    it(`${fixture.expectValid ? 'valid' : 'invalid'}: ${fixture.name}`, () => {
      const zodResult = taskBreakdownSchema.safeParse(fixture.value).success;
      const ajvResult = ajvValidate(fixture.value) as boolean;

      expect(zodResult).toBe(fixture.expectValid);
      expect(ajvResult).toBe(fixture.expectValid);
      expect(zodResult).toBe(ajvResult);
    });
  }
});
