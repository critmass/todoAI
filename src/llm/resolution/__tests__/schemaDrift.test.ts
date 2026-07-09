// D2: zod validator and JSON Schema agree on a shared valid/invalid fixture set. ajv actually
// evaluates the .json file, so this is a real agreement check, not a declared one.
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { coachingResolutionSchema } from '../validator';

const schemaPath = path.join(__dirname, '..', 'coaching_resolution.v1.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
const ajvValidate = ajv.compile(jsonSchema);

const fixtures: Array<{ name: string; value: unknown; expectValid: boolean }> = [
  {
    name: 'modify_task, all-null changes',
    value: {
      action: 'modify_task',
      task_id: 12,
      changes: { duration_minutes: null, context_tags: null, energy: null, approach_notes: null },
    },
    expectValid: true,
  },
  {
    name: 'modify_task, all changes populated',
    value: {
      action: 'modify_task',
      task_id: 12,
      changes: { duration_minutes: 30, context_tags: ['home'], energy: 'low', approach_notes: 'note' },
    },
    expectValid: true,
  },
  { name: 'break_down_task', value: { action: 'break_down_task', task_id: 47 }, expectValid: true },
  {
    name: 'eliminate_task',
    value: { action: 'eliminate_task', task_id: 47, reason: 'no longer relevant' },
    expectValid: true,
  },
  {
    name: 'defer_task, until null',
    value: { action: 'defer_task', task_id: 1, until: null },
    expectValid: true,
  },
  {
    name: 'defer_task, until on_date',
    value: { action: 'defer_task', task_id: 1, until: { kind: 'on_date', date: '2026-12-03' } },
    expectValid: true,
  },
  {
    name: 'defer_task, until condition',
    value: { action: 'defer_task', task_id: 1, until: { condition: 'once ready' } },
    expectValid: true,
  },
  {
    name: 'add_dependency',
    value: { action: 'add_dependency', task_id: 12, depends_on_task_id: 47 },
    expectValid: true,
  },
  { name: 'add_missing_task', value: { action: 'add_missing_task', title: 'buy stamps' }, expectValid: true },
  { name: 'no_change', value: { action: 'no_change', reason: 'fine as is' }, expectValid: true },
  { name: 'unknown action', value: { action: 'delete_everything', task_id: 1 }, expectValid: false },
  {
    name: 'no_change with cross-variant task_id key',
    value: { action: 'no_change', reason: 'fine', task_id: 12 },
    expectValid: false,
  },
  {
    name: 'modify_task missing changes.approach_notes',
    value: {
      action: 'modify_task',
      task_id: 12,
      changes: { duration_minutes: null, context_tags: null, energy: null },
    },
    expectValid: false,
  },
  { name: 'non-positive task_id', value: { action: 'break_down_task', task_id: 0 }, expectValid: false },
  { name: 'reason too long', value: { action: 'no_change', reason: 'x'.repeat(121) }, expectValid: false },
  { name: 'title too long on add_missing_task', value: { action: 'add_missing_task', title: 'x'.repeat(81) }, expectValid: false },
  {
    name: 'defer_task until with unknown kind',
    value: { action: 'defer_task', task_id: 1, until: { kind: 'someday' } },
    expectValid: false,
  },
  {
    name: 'modify_task changes duration_minutes out of range',
    value: {
      action: 'modify_task',
      task_id: 1,
      changes: { duration_minutes: 0, context_tags: null, energy: null, approach_notes: null },
    },
    expectValid: false,
  },
];

describe('coaching_resolution.v1: zod validator agrees with the JSON Schema', () => {
  for (const fixture of fixtures) {
    it(`${fixture.expectValid ? 'valid' : 'invalid'}: ${fixture.name}`, () => {
      const zodResult = coachingResolutionSchema.safeParse(fixture.value).success;
      const ajvResult = ajvValidate(fixture.value) as boolean;

      expect(zodResult).toBe(fixture.expectValid);
      expect(ajvResult).toBe(fixture.expectValid);
      expect(zodResult).toBe(ajvResult);
    });
  }
});
