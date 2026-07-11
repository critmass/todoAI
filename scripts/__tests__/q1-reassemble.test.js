const { reassemble } = require('../q1-reassemble');

// Simulated adb logcat lines: real device output prefixes each line with timestamp/PID/tag
// (e.g. "07-11 10:23:45.123  1234  1234 I ReactNativeJS:") before the bracketed payload -
// the parser must find the payload anywhere in the line, not anchor to line start.
function logcatLine(prefix, tag, index, total, chunk) {
  return `${prefix} I ReactNativeJS: [${tag} ${index}/${total}] ${chunk}`;
}

describe('reassemble', () => {
  it('reconstructs a single-chunk tag', () => {
    const raw = logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:stage0', 1, 1, '{"constrains":true}');
    const { result, incomplete } = reassemble(raw);
    expect(result).toEqual({ 'Q1RESULT:stage0': { constrains: true } });
    expect(incomplete).toEqual([]);
  });

  it('reconstructs a multi-chunk tag split across lines, in order', () => {
    const payload = JSON.stringify({ rawOutput: 'x'.repeat(50), passCount: 3 });
    const half = Math.ceil(payload.length / 2);
    const lines = [
      logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:stage2', 1, 2, payload.slice(0, half)),
      logcatLine('07-11 10:00:00.001  1  1', 'Q1RESULT:stage2', 2, 2, payload.slice(half)),
    ].join('\n');
    const { result, incomplete } = reassemble(lines);
    expect(result['Q1RESULT:stage2']).toEqual(JSON.parse(payload));
    expect(incomplete).toEqual([]);
  });

  it('is order-independent for out-of-sequence chunk lines', () => {
    const payload = JSON.stringify({ a: 1, b: 2 });
    const half = Math.ceil(payload.length / 2);
    const lines = [
      logcatLine('07-11 10:00:00.001  1  1', 'Q1RESULT:x', 2, 2, payload.slice(half)),
      logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:x', 1, 2, payload.slice(0, half)),
    ].join('\n');
    const { result } = reassemble(lines);
    expect(result['Q1RESULT:x']).toEqual(JSON.parse(payload));
  });

  it('reports a tag with a missing chunk as incomplete, and omits it from result', () => {
    const raw = logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:stage2', 1, 2, '{"partial":true');
    const { result, incomplete } = reassemble(raw);
    expect(result).toEqual({});
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatch(/Q1RESULT:stage2/);
    expect(incomplete[0]).toMatch(/missing chunk/);
  });

  it('reports a tag whose concatenated chunks are not valid JSON as incomplete', () => {
    const raw = logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:bad', 1, 1, 'not json');
    const { result, incomplete } = reassemble(raw);
    expect(result).toEqual({});
    expect(incomplete[0]).toMatch(/JSON.parse failed/);
  });

  it('keeps separate tags independent and ignores non-matching lines', () => {
    const lines = [
      'unrelated logcat noise with no bracket payload',
      logcatLine('07-11 10:00:00.000  1  1', 'Q1RESULT:stage0', 1, 1, '{"n":1}'),
      logcatLine('07-11 10:00:00.001  1  1', 'Q1DEBUG:stage2grammar', 1, 1, '{"grammar":"root"}'),
    ].join('\n');
    const { result } = reassemble(lines);
    expect(Object.keys(result).sort()).toEqual(['Q1DEBUG:stage2grammar', 'Q1RESULT:stage0']);
  });
});
