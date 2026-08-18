import { captureContext, episodeIdOf } from '../context';
import {
  captureHealth,
  lastSeq,
  localDayISO,
  record,
  resetCaptureStateForTests,
  setCaptureWriter,
} from '../record';
import { STREAMS, STREAM_NAMES } from '../streams';
import type { CaptureWriter } from '../writer';

interface Written {
  dir: string;
  day: string;
  line: string;
}

function memoryWriter(onAppend?: () => void): { writer: CaptureWriter; written: Written[] } {
  const written: Written[] = [];
  return {
    written,
    writer: {
      append(dir, day, line) {
        onAppend?.();
        written.push({ dir, day, line });
      },
      monoMs: () => 12345,
      sizeOnDisk: () => 0,
      deleteDay: () => 0,
      listDays: () => [],
    },
  };
}

const parsed = (written: Written[]) => written.map((entry) => JSON.parse(entry.line));

beforeEach(() => {
  resetCaptureStateForTests();
  captureContext.reset();
});

describe('the envelope (design §3.1)', () => {
  it('stamps every required field on every record', () => {
    const { writer, written } = memoryWriter();
    setCaptureWriter(writer);
    record({ stream: 'lifecycle', type: 'launch' });

    const [row] = parsed(written);
    expect(row).toMatchObject({
      v: 1,
      seq: 1,
      wallMs: expect.any(Number),
      monoMs: 12345,
      stream: 'lifecycle',
      type: 'launch',
      sessionId: null,
      episodeId: null,
      taskId: null,
    });
    expect(typeof row.run).toBe('string');
  });

  it('writes one complete line with its newline in the same buffer', () => {
    const { writer, written } = memoryWriter();
    setCaptureWriter(writer);
    record({ stream: 'lifecycle', type: 'launch' });
    expect(written[0].line.endsWith('\n')).toBe(true);
    expect(written[0].line.indexOf('\n')).toBe(written[0].line.length - 1);
  });

  it('increments seq GLOBALLY across streams, not per stream', () => {
    const { writer, written } = memoryWriter();
    setCaptureWriter(writer);
    record({ stream: 'lifecycle', type: 'launch' });
    record({ stream: 'runtime', type: 'app_state', appState: 'active' });
    record({ stream: 'lifecycle', type: 'launch' });

    // The consequence the tooling depends on (design §3.4): a gap in ONE stream's file is normal,
    // and loss is only detectable by merging every stream for a run.
    expect(parsed(written).map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(written.map((entry) => entry.dir)).toEqual(['lifecycle', 'runtime', 'lifecycle']);
    expect(lastSeq()).toBe(3);
  });

  it('routes each stream to the directory the on-disk contract names', () => {
    const { writer, written } = memoryWriter();
    setCaptureWriter(writer);
    record({ stream: 'crisis', type: 'gate', verdict: 'clear', text: 'x', surface: 'chat_send', purpose: 'coaching' });
    expect(written[0].dir).toBe(STREAMS.crisis.dir);
  });

  it('partitions by LOCAL calendar date, not UTC', () => {
    // 2026-08-18 at 23:30 local is the 19th in UTC for anyone east of it, and the 18th here. The
    // contract is the human's yesterday, so the filename follows the local clock (design §6 r3).
    const local = new Date(2026, 7, 18, 23, 30).getTime();
    expect(localDayISO(local)).toBe('2026-08-18');
  });
});

describe('failure behaviour (design §7)', () => {
  it('never throws, and counts the drop', () => {
    setCaptureWriter({
      append() {
        throw new Error('ENOSPC');
      },
      monoMs: () => 0,
      sizeOnDisk: () => 0,
      deleteDay: () => 0,
      listDays: () => [],
    });
    expect(() => record({ stream: 'lifecycle', type: 'launch' })).not.toThrow();
    expect(captureHealth().droppedTotal).toBe(1);
    expect(captureHealth().lastDropReason).toContain('ENOSPC');
  });

  it('is a counted no-op with no writer installed (Jest, or an older APK)', () => {
    expect(() => record({ stream: 'lifecycle', type: 'launch' })).not.toThrow();
    expect(captureHealth().droppedTotal).toBe(1);
  });

  it('reports the drop on the next SUCCESSFUL record, then resets', () => {
    let fail = true;
    const { writer, written } = memoryWriter(() => {
      if (fail) throw new Error('disk full');
    });
    setCaptureWriter(writer);

    record({ stream: 'lifecycle', type: 'launch' }); // dropped
    record({ stream: 'lifecycle', type: 'launch' }); // dropped
    fail = false;
    record({ stream: 'lifecycle', type: 'launch' }); // lands, carrying the count
    record({ stream: 'lifecycle', type: 'launch' }); // lands, clean

    const rows = parsed(written);
    expect(rows).toHaveLength(2);
    expect(rows[0].dropped).toEqual({ count: 2, lastReason: expect.stringContaining('disk full') });
    expect(rows[1].dropped).toBeUndefined();
    // The seq the dropped records consumed is genuinely gone — which is exactly what makes a gap
    // in the merged sequence detectable rather than silently absorbed.
    expect(rows.map((row) => row.seq)).toEqual([3, 4]);
  });
});

describe('the correlation frame (design §3.3, §11)', () => {
  it('derives the SAME episodeId from the same active_episode row', () => {
    // The crash-recovery join: `recoverOpenEpisode` re-reads the row and re-derives the id, so the
    // post-crash records join to the pre-crash ones. A random id would make the crash a permanent
    // seam in exactly the case the facility exists for.
    expect(episodeIdOf('s1', 7, 1700)).toBe(episodeIdOf('s1', 7, 1700));
    expect(episodeIdOf('s1', 7, 1700)).not.toBe(episodeIdOf('s1', 7, 1701));
  });

  it('stamps the ambient session, episode and task onto records from anywhere', () => {
    const { writer, written } = memoryWriter();
    setCaptureWriter(writer);
    captureContext.setSession('sess-1');
    captureContext.setEpisode({ taskId: 42, startedAtMs: 1000 });
    record({ stream: 'conversation', type: 'turn', from: 'user', purpose: 'task_input', kind: 'user', text: 'hi', todayISO: '2026-08-18' });

    expect(parsed(written)[0]).toMatchObject({
      sessionId: 'sess-1',
      episodeId: 'sess-1#42@1000',
      taskId: 42,
    });
  });

  it('records no origin until task 44 supplies one', () => {
    // `sessions.origin` (migration 007) does not exist in the tree. Capture writes no origin
    // rather than a fabricated 'planned' on every session row.
    captureContext.setSession('sess-1');
    expect(captureContext.current().origin).toBeUndefined();
  });
});

describe('the stream table', () => {
  it('has one egress class and one ladder fate per stream, for all twelve', () => {
    expect(STREAM_NAMES).toHaveLength(12);
    for (const name of STREAM_NAMES) {
      const definition = STREAMS[name];
      expect(['structured', 'free_text']).toContain(definition.egress);
      expect(['removed_before_closed_beta', 'dropped_at_open_beta', 'survives']).toContain(
        definition.fate,
      );
    }
  });

  it('pins the ladder fates the two pruning tasks read', () => {
    // Task 42 Job A deletes exactly one stream; task 43 drops the free-text ones at open beta.
    // Changing a fate here changes what those tasks delete, so it is pinned rather than trusted.
    expect(STREAMS.crisis.fate).toBe('removed_before_closed_beta');
    const droppedAtOpenBeta = STREAM_NAMES.filter(
      (name) => STREAMS[name].fate === 'dropped_at_open_beta',
    );
    expect(droppedAtOpenBeta.sort()).toEqual(['conversation', 'modeltext', 'mutationtext']);
    // Every surviving stream must be structured. A free-text stream that survives open beta is
    // the silent expiry task 42's brief warns about.
    for (const name of STREAM_NAMES) {
      if (STREAMS[name].fate === 'survives') expect(STREAMS[name].egress).toBe('structured');
    }
  });

  it('gives every stream its own directory', () => {
    const dirs = STREAM_NAMES.map((name) => STREAMS[name].dir);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
