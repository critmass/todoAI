// D2: the zod validator and the JSON Schema are two hand-authored forms of the same source of
// truth (task_extraction.v1.json). This asserts they agree on a shared valid/invalid fixture
// set - ajv actually evaluates the .json file (not just documents it), so this is a real
// agreement check, not a declared one.
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { taskExtractionSchema } from '../validator';

const schemaPath = path.join(__dirname, '..', 'task_extraction.v1.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
const ajvValidate = ajv.compile(jsonSchema);

function baseValid() {
  return {
    title: 'Take out trash',
    description: null,
    estimated_duration_minutes: 10,
    duration_from_user: false,
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  };
}

const fixtures: Array<{ name: string; value: unknown; expectValid: boolean }> = [
  { name: 'minimal all-null object', value: baseValid(), expectValid: true },
  {
    name: 'fully populated, scheduled_quota recurrence',
    value: {
      ...baseValid(),
      description: 'desc',
      due: { kind: 'weekday', day: 'friday', which: 'next' },
      context_tags: ['home'],
      tool_requirements: ['phone'],
      energy: 'med',
      importance_user: 5,
      recurrence: { type: 'scheduled_quota', quota: 3, period: 'week', days: ['monday', 'friday'] },
    },
    expectValid: true,
  },
  { name: 'quota recurrence', value: { ...baseValid(), recurrence: { type: 'quota', quota: 15, period: 'week' } }, expectValid: true },
  { name: 'scheduled recurrence', value: { ...baseValid(), recurrence: { type: 'scheduled', days: ['tuesday'] } }, expectValid: true },
  { name: 'unscheduled recurrence', value: { ...baseValid(), recurrence: { type: 'unscheduled' } }, expectValid: true },
  { name: 'count recurrence', value: { ...baseValid(), recurrence: { type: 'count', target: 10 } }, expectValid: true },
  { name: 'on_date due', value: { ...baseValid(), due: { kind: 'on_date', date: '2026-12-03' } }, expectValid: true },
  { name: 'in_days due', value: { ...baseValid(), due: { kind: 'in_days', days: 14 } }, expectValid: true },
  { name: 'missing required key (title)', value: (() => { const rest: Record<string, unknown> = baseValid(); delete rest.title; return rest; })(), expectValid: false },
  { name: 'unknown extra key', value: { ...baseValid(), extra: 'nope' }, expectValid: false },
  { name: 'title too long', value: { ...baseValid(), title: 'x'.repeat(81) }, expectValid: false },
  { name: 'title empty string', value: { ...baseValid(), title: '' }, expectValid: false },
  { name: 'duration out of range (0)', value: { ...baseValid(), estimated_duration_minutes: 0 }, expectValid: false },
  { name: 'duration out of range (1441)', value: { ...baseValid(), estimated_duration_minutes: 1441 }, expectValid: false },
  { name: 'importance_user out of range', value: { ...baseValid(), importance_user: 11 }, expectValid: false },
  { name: 'energy not in enum', value: { ...baseValid(), energy: 'extreme' }, expectValid: false },
  { name: 'count recurrence missing target', value: { ...baseValid(), recurrence: { type: 'count' } }, expectValid: false },
  { name: 'count recurrence with zero target', value: { ...baseValid(), recurrence: { type: 'count', target: 0 } }, expectValid: false },
  { name: 'scheduled recurrence with empty days', value: { ...baseValid(), recurrence: { type: 'scheduled', days: [] } }, expectValid: false },
  { name: 'quota recurrence with zero quota', value: { ...baseValid(), recurrence: { type: 'quota', quota: 0, period: 'week' } }, expectValid: false },
  { name: 'recurrence variant with cross-variant keys', value: { ...baseValid(), recurrence: { type: 'unscheduled', quota: 3 } }, expectValid: false },
  { name: 'unknown recurrence type', value: { ...baseValid(), recurrence: { type: 'yearly' } }, expectValid: false },
  { name: 'due with unknown kind', value: { ...baseValid(), due: { kind: 'someday' } }, expectValid: false },
  { name: 'context_tags too many items', value: { ...baseValid(), context_tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, expectValid: false },
];

describe('task_extraction.v1: zod validator agrees with the JSON Schema', () => {
  for (const fixture of fixtures) {
    it(`${fixture.expectValid ? 'valid' : 'invalid'}: ${fixture.name}`, () => {
      const zodResult = taskExtractionSchema.safeParse(fixture.value).success;
      const ajvResult = ajvValidate(fixture.value) as boolean;

      expect(zodResult).toBe(fixture.expectValid);
      expect(ajvResult).toBe(fixture.expectValid);
      expect(zodResult).toBe(ajvResult); // the actual drift check
    });
  }
});
