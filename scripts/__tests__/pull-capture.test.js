/* eslint-env jest, node */
const fs = require('fs');
const path = require('path');

const { STREAMS, analyse, resolveStreams, parseArgs } = require('../pull-capture');

describe('pull-capture: the stream table stays in step with src/capture/streams.ts', () => {
  // The script must run from a plain Node checkout with no build step, so it carries its own copy
  // of the table. This is the test that keeps the copy honest — a drift here means the egress gate
  // could classify a free-text stream as structured and pull it without an acknowledgement.
  it('matches the TypeScript source exactly', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'capture', 'streams.ts'),
      'utf8',
    );
    const body = source.slice(source.indexOf('export const STREAMS'));
    const entries = [
      ...body.matchAll(
        /(\w+):\s*\{\s*dir:\s*'([^']+)',\s*egress:\s*'([^']+)',\s*fate:\s*'([^']+)'\s*\}/g,
      ),
    ];
    expect(entries.length).toBe(12);
    const fromSource = Object.fromEntries(
      entries.map(([, name, dir, egress, fate]) => [name, { dir, egress, fate }]),
    );
    for (const [name, definition] of Object.entries(fromSource)) {
      expect(STREAMS[name]).toBeDefined();
      expect(STREAMS[name].egress).toBe(definition.egress);
      expect(STREAMS[name].fate).toBe(definition.fate);
      // The directory IS the stream name in the contract; the script assumes that when it walks.
      expect(definition.dir).toBe(name);
    }
    expect(Object.keys(STREAMS).sort()).toEqual(Object.keys(fromSource).sort());
  });
});

describe('the egress gate (design §10)', () => {
  it('pulls structured streams without ceremony', () => {
    expect(resolveStreams(parseArgs(['--stream', 'modelio', '--stream', 'episode']))).toEqual([
      'modelio',
      'episode',
    ]);
  });

  it('REFUSES free text without an explicit egress decision', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => resolveStreams(parseArgs(['--stream', 'conversation']))).toThrow('exit');
    expect(stderr.mock.calls.join('')).toContain('refusing to pull free-text streams');
    exit.mockRestore();
    stderr.mockRestore();
  });

  it('refuses --anonymize rather than ignoring it', () => {
    // Silently pulling raw data after someone asked for anonymisation is the worst available
    // outcome; the seam is declared and unimplemented (task 42 §4b owns it).
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() =>
      resolveStreams(parseArgs(['--stream', 'conversation', '--anonymize', 'scrub'])),
    ).toThrow('exit');
    expect(stderr.mock.calls.join('')).toContain('declared seam with no implementation');
    exit.mockRestore();
    stderr.mockRestore();
  });

  it('lets --raw-i-am-jason through, which is the normal alpha path', () => {
    expect(resolveStreams(parseArgs(['--stream', 'crisis', '--raw-i-am-jason']))).toEqual([
      'crisis',
    ]);
  });

  it('defaults to every stream, and therefore also refuses by default', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => resolveStreams(parseArgs([]))).toThrow('exit');
    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe('integrity analysis', () => {
  const allStreams = Object.keys(STREAMS);
  const boot = (run) => ({
    run,
    seq: 1,
    stream: 'lifecycle',
    type: 'boot',
    streamsCompiled: allStreams,
  });

  it('reports a contiguous run', () => {
    const records = [
      boot('r1'),
      { run: 'r1', seq: 2, stream: 'modelio' },
      { run: 'r1', seq: 3, stream: 'conversation' },
    ];
    expect(analyse(records, allStreams).join('\n')).toContain('seq contiguous 1..3');
  });

  it('finds a gap in the MERGED sequence, not in one stream', () => {
    // A gap in a single stream's file is normal — seq is process-global.
    const records = [boot('r1'), { run: 'r1', seq: 2, stream: 'modelio' }, { run: 'r1', seq: 5, stream: 'modelio' }];
    expect(analyse(records, allStreams).join('\n')).toContain('GAP(S)');
  });

  it('reports a run with no boot record as its own loud condition', () => {
    const records = [{ run: 'r2', seq: 1, stream: 'modelio' }];
    expect(analyse(records, allStreams).join('\n')).toContain('NO BOOT RECORD');
  });

  it('SKIPS the gap analysis when not every compiled stream was pulled', () => {
    // Otherwise a filtered pull would manufacture alarming "gaps" that mean nothing — and once
    // task 42 and 43 prune streams, later builds have permanent legitimate gaps.
    const records = [boot('r1'), { run: 'r1', seq: 3, stream: 'modelio' }];
    expect(analyse(records, ['modelio']).join('\n')).toContain('SKIPPED');
  });

  it('surfaces capture reporting its own dropped events', () => {
    const records = [
      boot('r1'),
      { run: 'r1', seq: 2, stream: 'modelio', dropped: { count: 4, lastReason: 'ENOSPC' } },
    ];
    expect(analyse(records, allStreams).join('\n')).toContain('4 dropped — ENOSPC');
  });
});
