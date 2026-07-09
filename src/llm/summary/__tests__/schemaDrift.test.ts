// D2: zod validator and JSON Schema agree on a shared valid/invalid fixture set. ajv actually
// evaluates the .json file, so this is a real agreement check, not a declared one.
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { summarySchema } from '../validator';

const schemaPath = path.join(__dirname, '..', 'summary.v1.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
const ajvValidate = ajv.compile(jsonSchema);

function baseValid() {
  return {
    summary_schema_version: '1',
    kind: 'work_session',
    key_points: ['completed two tasks'],
    disposition: null,
    energy_note: null,
  };
}

const fixtures: Array<{ name: string; value: unknown; expectValid: boolean }> = [
  { name: 'minimal object', value: baseValid(), expectValid: true },
  {
    name: 'fully populated, 3 key points',
    value: { ...baseValid(), key_points: ['a', 'b', 'c'], disposition: 'note', energy_note: 'tired' },
    expectValid: true,
  },
  { name: 'kind = coaching_conversation', value: { ...baseValid(), kind: 'coaching_conversation' }, expectValid: true },
  { name: 'wrong schema version', value: { ...baseValid(), summary_schema_version: '2' }, expectValid: false },
  { name: 'unknown kind', value: { ...baseValid(), kind: 'chit_chat' }, expectValid: false },
  { name: 'zero key points', value: { ...baseValid(), key_points: [] }, expectValid: false },
  { name: 'four key points', value: { ...baseValid(), key_points: ['a', 'b', 'c', 'd'] }, expectValid: false },
  { name: 'unknown extra key', value: { ...baseValid(), extra: 'nope' }, expectValid: false },
  { name: 'key point too long', value: { ...baseValid(), key_points: ['x'.repeat(121)] }, expectValid: false },
  { name: 'disposition too long', value: { ...baseValid(), disposition: 'x'.repeat(121) }, expectValid: false },
  { name: 'energy_note too long', value: { ...baseValid(), energy_note: 'x'.repeat(81) }, expectValid: false },
  {
    name: 'missing required key',
    value: (() => {
      const rest: Record<string, unknown> = baseValid();
      delete rest.energy_note;
      return rest;
    })(),
    expectValid: false,
  },
];

describe('summary.v1: zod validator agrees with the JSON Schema', () => {
  for (const fixture of fixtures) {
    it(`${fixture.expectValid ? 'valid' : 'invalid'}: ${fixture.name}`, () => {
      const zodResult = summarySchema.safeParse(fixture.value).success;
      const ajvResult = ajvValidate(fixture.value) as boolean;

      expect(zodResult).toBe(fixture.expectValid);
      expect(ajvResult).toBe(fixture.expectValid);
      expect(zodResult).toBe(ajvResult);
    });
  }
});
