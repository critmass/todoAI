import {
  DEFAULT_TERNARY_BONSAI_CONFIG,
  buildCompletionParams,
  mapCompletionResult,
  selectTier,
  thermalHeadroomFromAndroidStatus,
} from '../ternaryBonsaiSupport';

const CONFIG = DEFAULT_TERNARY_BONSAI_CONFIG;

describe('buildCompletionParams', () => {
  it('a constrained call forwards grammar + greedy knobs from the ladder', () => {
    const params = buildCompletionParams(
      { grammar: 'root ::= "x"', maxTokens: 100, temperature: 0, topK: 1 },
      CONFIG,
    );
    expect(params).toEqual({ grammar: 'root ::= "x"', n_predict: 100, temperature: 0, top_k: 1 });
  });

  it('a prose call inherits the config prose temperature and default cap', () => {
    const params = buildCompletionParams({}, CONFIG);
    expect(params.grammar).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    expect(params.n_predict).toBe(CONFIG.defaultMaxTokens);
    expect(params.temperature).toBe(CONFIG.defaultProseTemperature);
  });

  it('an explicit temperature always wins over the default', () => {
    expect(buildCompletionParams({ temperature: 0.2 }, CONFIG).temperature).toBe(0.2);
  });

  it('passes stop strings through when set', () => {
    expect(buildCompletionParams({ stop: ['\n\n'] }, CONFIG).stop).toEqual(['\n\n']);
  });

  it('passes grammar through as authored — comments included (device-verified: the parser accepts them)', () => {
    const grammar = '# comment\nroot ::= "x"';
    expect(buildCompletionParams({ grammar, temperature: 0, topK: 1 }, CONFIG).grammar).toBe(grammar);
  });
});

describe('mapCompletionResult', () => {
  it('maps text and timings, not truncated on a natural stop', () => {
    const res = mapCompletionResult(
      { text: '{"a":1}', stopped_eos: true, timings: { predicted_n: 8, predicted_per_second: 5.2 } },
      200,
    );
    expect(res.text).toBe('{"a":1}');
    expect(res.truncated).toBe(false);
    expect(res.timings).toMatchObject({ predictedN: 8, predictedPerSecond: 5.2 });
  });

  it('flags truncation via stopped_limit', () => {
    const res = mapCompletionResult({ text: '{"a', stopped_limit: true }, 200);
    expect(res.truncated).toBe(true);
  });

  it('flags truncation when predicted tokens reach the requested cap', () => {
    const res = mapCompletionResult({ text: 'xxxx', timings: { predicted_n: 50 } }, 50);
    expect(res.truncated).toBe(true);
  });

  it('defaults missing text to empty string', () => {
    expect(mapCompletionResult({}, 100).text).toBe('');
  });
});

describe('selectTier', () => {
  it('always returns 4B today — the only runnable rung (seam wired, no degradation logic)', () => {
    expect(selectTier()).toBe('4B');
    expect(selectTier({ thermal: 'defer' })).toBe('4B');
  });
});

describe('thermalHeadroomFromAndroidStatus', () => {
  it('maps Android PowerManager thermal status to headroom advisories', () => {
    expect(thermalHeadroomFromAndroidStatus(0)).toBe('ok'); // NONE
    expect(thermalHeadroomFromAndroidStatus(1)).toBe('ok'); // LIGHT
    expect(thermalHeadroomFromAndroidStatus(2)).toBe('reduce'); // MODERATE
    expect(thermalHeadroomFromAndroidStatus(3)).toBe('reduce'); // SEVERE
    expect(thermalHeadroomFromAndroidStatus(4)).toBe('defer'); // CRITICAL
    expect(thermalHeadroomFromAndroidStatus(6)).toBe('defer'); // SHUTDOWN
  });
});
