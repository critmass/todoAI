import { validate, summarySchema } from '../validator';
import { LlmOutputValidationError } from '../../errors';

function baseValid() {
  return {
    summary_schema_version: '1',
    kind: 'work_session',
    key_points: ['completed two tasks'],
    disposition: null,
    energy_note: null,
  };
}

describe('validate - accepts well-formed objects', () => {
  it('accepts the minimal object (1 key point, nulls elsewhere)', () => {
    expect(() => validate(baseValid())).not.toThrow();
  });

  it('accepts 3 key points and populated disposition/energy_note', () => {
    const obj = {
      ...baseValid(),
      key_points: ['a', 'b', 'c'],
      disposition: 'wrap up next time',
      energy_note: 'low energy after lunch',
    };
    expect(() => validate(obj)).not.toThrow();
  });

  it('accepts every InteractionType value for kind', () => {
    const kinds = [
      'work_session',
      'coaching_conversation',
      'task_input',
      'energy_checkin',
      'pattern_recognition',
      'task_completion',
      'task_skip',
    ];
    for (const kind of kinds) {
      expect(() => validate({ ...baseValid(), kind })).not.toThrow();
    }
  });
});

describe('validate - rejects malformed structure (zod layer)', () => {
  it('rejects a schema version other than the literal "1"', () => {
    expect(() => validate({ ...baseValid(), summary_schema_version: '2' })).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects an unknown kind', () => {
    expect(() => validate({ ...baseValid(), kind: 'chit_chat' })).toThrow(LlmOutputValidationError);
  });

  it('rejects zero key points', () => {
    expect(() => validate({ ...baseValid(), key_points: [] })).toThrow(LlmOutputValidationError);
  });

  it('rejects more than 3 key points', () => {
    expect(() => validate({ ...baseValid(), key_points: ['a', 'b', 'c', 'd'] })).toThrow(
      LlmOutputValidationError,
    );
  });

  it('rejects an unknown extra key', () => {
    expect(() => validate({ ...baseValid(), extra: 'nope' })).toThrow(LlmOutputValidationError);
  });
});

describe('validate - cross-field rules (D10)', () => {
  it('rejects a key point that is empty after trim', () => {
    expect(() => validate({ ...baseValid(), key_points: ['   '] })).toThrow(LlmOutputValidationError);
  });

  it('rejects a disposition that is empty after trim', () => {
    expect(() => validate({ ...baseValid(), disposition: '   ' })).toThrow(LlmOutputValidationError);
  });

  it('rejects an energy_note that is empty after trim', () => {
    expect(() => validate({ ...baseValid(), energy_note: '   ' })).toThrow(LlmOutputValidationError);
  });
});

describe('summarySchema export', () => {
  it('is usable directly for a plain zod parse (used by the drift test)', () => {
    expect(summarySchema.safeParse(baseValid()).success).toBe(true);
  });
});
