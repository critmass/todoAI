import { runConstrained, type ConstrainedCall } from '../ladder';
import { MockLLMProvider } from '../mockProvider';
import { validateTaskExtraction } from '../..';
import { LlmOutputValidationError } from '../../errors';

// A trivial validator to isolate ladder control-flow from any real schema: accepts { ok: true }.
function validateOkFlag(raw: unknown): { ok: true } {
  if (typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true) {
    return { ok: true };
  }
  throw new LlmOutputValidationError('test_surface', ['ok: must be true']);
}

function baseCall(provider: MockLLMProvider): ConstrainedCall<{ ok: true }> {
  return {
    provider,
    messages: [{ role: 'user', content: 'do it' }],
    grammar: 'root ::= "x"',
    maxTokens: 50,
    validate: validateOkFlag,
  };
}

describe('runConstrained — D10 ladder', () => {
  it('returns ok on the first attempt when output validates (valid@1)', async () => {
    const provider = new MockLLMProvider({ responses: ['{"ok":true}'] });
    const result = await runConstrained(baseCall(provider));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.attempts).toBe(1);
      expect(result.value).toEqual({ ok: true });
    }
    expect(provider.calls).toHaveLength(1);
  });

  it('forces greedy sampling (temp 0, topK 1) and passes the grammar', async () => {
    const provider = new MockLLMProvider({ responses: ['{"ok":true}'] });
    await runConstrained(baseCall(provider));
    expect(provider.calls[0].opts).toMatchObject({
      grammar: 'root ::= "x"',
      maxTokens: 50,
      temperature: 0,
      topK: 1,
    });
  });

  it('retries once with a corrective system note, then succeeds (attempts 2)', async () => {
    const provider = new MockLLMProvider({ responses: ['{"ok":false}', '{"ok":true}'] });
    const result = await runConstrained(baseCall(provider));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.attempts).toBe(2);

    // Second call carries the appended corrective-retry note quoting the first issue.
    const retryMessages = provider.calls[1].messages;
    const note = retryMessages[retryMessages.length - 1];
    expect(note.role).toBe('system');
    expect(note.content).toContain('failed validation');
    expect(note.content).toContain('ok: must be true'); // the first issue, verbatim
    // The original turns are preserved ahead of the note.
    expect(retryMessages[0]).toEqual({ role: 'user', content: 'do it' });
  });

  it('falls back gracefully after two failures (never loops)', async () => {
    const provider = new MockLLMProvider({ responses: ['not json', '{"ok":false}'] });
    const result = await runConstrained(baseCall(provider));
    expect(result.status).toBe('fallback');
    if (result.status === 'fallback') {
      expect(result.attempts).toBe(2);
      expect(result.lastResponse.text).toBe('{"ok":false}');
      expect(result.error).toBeInstanceOf(Error);
    }
    expect(provider.calls).toHaveLength(2); // exactly two — no third attempt
  });

  it('treats a truncated (token-cap) generation as a failure', async () => {
    const provider = new MockLLMProvider({
      responses: [
        { text: '{"ok":tru', truncated: true }, // chopped off at the cap
        '{"ok":true}',
      ],
    });
    const result = await runConstrained(baseCall(provider));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.attempts).toBe(2);
    // The retry note mentions truncation, not a JSON parse artifact.
    const note = provider.calls[1].messages.at(-1);
    expect(note?.content).toContain('truncated');
  });

  it('accepts a custom retry-note builder', async () => {
    const provider = new MockLLMProvider({ responses: ['{"ok":false}', '{"ok":true}'] });
    await runConstrained({
      ...baseCall(provider),
      buildRetryNote: (issue) => ({ role: 'system', content: `FIXME(${issue})` }),
    });
    expect(provider.calls[1].messages.at(-1)?.content).toBe('FIXME(ok: must be true)');
  });
});

describe('runConstrained — with a real task-5 validator', () => {
  const TODAY = '2026-07-15';
  const validExtraction = JSON.stringify({
    title: 'Take out trash',
    description: null,
    estimated_duration_minutes: 5,
    duration_from_user: true,
    due: null,
    context_tags: ['home'],
    tool_requirements: [],
    energy: 'low',
    importance_user: 3,
    recurrence: { type: 'scheduled', days: ['tuesday'] },
  });

  it('orchestrates validateTaskExtraction end-to-end (valid@1)', async () => {
    const provider = new MockLLMProvider({ responses: [validExtraction] });
    const result = await runConstrained({
      provider,
      messages: [{ role: 'user', content: 'take out the trash every tuesday' }],
      grammar: 'root ::= "x"',
      maxTokens: 200,
      validate: (raw) => validateTaskExtraction(raw, TODAY),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.title).toBe('Take out trash');
      expect(result.value.recurrence).toEqual({ type: 'scheduled', days: ['tuesday'] });
    }
  });

  it('retries a schema-invalid extraction, quoting the real first issue', async () => {
    const missingTitle = JSON.stringify({ ...JSON.parse(validExtraction), title: '' });
    const provider = new MockLLMProvider({ responses: [missingTitle, validExtraction] });
    const result = await runConstrained({
      provider,
      messages: [{ role: 'user', content: 'x' }],
      grammar: 'root ::= "x"',
      maxTokens: 200,
      validate: (raw) => validateTaskExtraction(raw, TODAY),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.attempts).toBe(2);
    expect(provider.calls[1].messages.at(-1)?.content).toContain('title');
  });
});
