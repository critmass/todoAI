// Task 57 (task 53 W10) — coverage for `../retention.ts`, which had no test file at all.
//
// The module's own header is emphatic: the 512 MB ceiling and oldest-day-first rotation are a
// BLACK-SWAN NET, and non-firing is not evidence of anything. This suite tests the MECHANISM (the
// rotation loop, the warn threshold, the try/catch, the pending-warning state) rather than the
// projection that it will rarely fire in production.
//
// Fake `CaptureWriter` pattern follows `record.test.ts` / `mutationCapture.test.ts`: a plain object
// literal implementing the interface, installed via `setCaptureWriter`. Unlike those suites' fakes,
// `sizeOnDisk()` here must actually SHRINK after `deleteDay()` — a fake that always returns the same
// number would hide the "stop once under the ceiling" behaviour entirely, so it is backed by a
// mutable day -> bytes map that both `sizeOnDisk` and `deleteDay` read from.

import { captureContext } from '../context';
import {
  captureHealth,
  captureWriter,
  resetCaptureStateForTests,
  setCaptureWriter,
} from '../record';
import {
  CAPTURE_CEILING_BYTES,
  CAPTURE_WARN_BYTES,
  checkCeilingAndReportHealth,
  dismissCeilingWarning,
  pendingCeilingWarning,
  type CaptureCeilingState,
} from '../retention';
import type { CaptureWriter } from '../writer';

interface Written {
  dir: string;
  day: string;
  line: string;
}

/** A `CaptureWriter` double backed by a real day -> bytes map, so `sizeOnDisk()` reflects
 *  `deleteDay()` the same way the real filesystem-backed writer would. `append` is captured so
 *  tests can inspect the `lifecycle.capture` health record retention.ts writes via `record()`. */
function makeFakeWriter(initialDays: Record<string, number>) {
  const days = new Map(Object.entries(initialDays));
  const written: Written[] = [];
  const deletedDays: string[] = [];
  let throwOnSizeOnDisk = false;
  let throwOnDeleteDay = false;

  const writer: CaptureWriter = {
    append(dir, day, line) {
      written.push({ dir, day, line });
    },
    monoMs: () => 0,
    sizeOnDisk() {
      if (throwOnSizeOnDisk) throw new Error('sizeOnDisk failed');
      let total = 0;
      for (const bytes of days.values()) total += bytes;
      return total;
    },
    deleteDay(day) {
      if (throwOnDeleteDay) throw new Error('deleteDay failed');
      const existed = days.has(day);
      days.delete(day);
      deletedDays.push(day);
      return existed ? 1 : 0;
    },
    // Ascending, matching the interface's contract ("Day directories present on disk, ascending").
    listDays: () => Array.from(days.keys()).sort(),
  };

  return {
    writer,
    written,
    deletedDays,
    daysRemaining: () => Array.from(days.keys()).sort(),
    setThrowOnSizeOnDisk: (value: boolean) => {
      throwOnSizeOnDisk = value;
    },
    setThrowOnDeleteDay: (value: boolean) => {
      throwOnDeleteDay = value;
    },
  };
}

const healthRecordOf = (written: Written[]) =>
  written
    .map((entry) => JSON.parse(entry.line) as Record<string, unknown>)
    .find((row) => row.stream === 'lifecycle' && row.type === 'capture');

// ⚠ `pendingWarning` in retention.ts is module-level mutable state. Reset it (and record.ts's own
// module state) before every test so a warning left pending by one test cannot make a later test
// pass for the wrong reason — exactly the class of bug task 53 exists to stop.
beforeEach(() => {
  resetCaptureStateForTests();
  captureContext.reset();
  dismissCeilingWarning();
});

describe('rotation (design §6 rule 4, "never the newest, which is what you are debugging")', () => {
  it('rotates the oldest day first and stops as soon as it is back under the ceiling', () => {
    // Three day-slots' worth of bytes each: 4 days over the ceiling, and it should take deleting
    // exactly 2 (oldest first) to get back under — not all of them, and not the newest.
    const dayBytes = Math.ceil(CAPTURE_CEILING_BYTES / 3); // 178,956,971
    const fake = makeFakeWriter({
      '2026-08-01': dayBytes,
      '2026-08-02': dayBytes,
      '2026-08-03': dayBytes,
      '2026-08-04': dayBytes, // newest
    });
    setCaptureWriter(fake.writer);

    const state = checkCeilingAndReportHealth();

    // 4 * dayBytes = 715,827,884 > ceiling. After deleting day 1: 3 * dayBytes = 536,870,913,
    // still 1 byte over. After deleting day 2: 2 * dayBytes = 357,913,942, under — loop stops.
    expect(fake.deletedDays).toEqual(['2026-08-01', '2026-08-02']);
    expect(state?.rotatedDays).toEqual(['2026-08-01', '2026-08-02']);
    expect(fake.daysRemaining()).toEqual(['2026-08-03', '2026-08-04']);
    expect(state?.bytesOnDisk).toBe(2 * dayBytes);
  });

  it('never deletes the newest day, even when the ceiling is still exceeded afterward', () => {
    // 🔴 This is the mutation-1 guard: `days.slice(0, days.length - 1)` -> `days`. Every day here
    // individually exceeds the ceiling, so the loop over the oldest-N-minus-one never gets back
    // under the ceiling and runs to the end of the slice rather than stopping early — the only way
    // the newest day can be proven never-touched is if the mutated `for (const day of days)` would
    // reach for it too and this test would then fail.
    const perDay = CAPTURE_CEILING_BYTES + 1000;
    const fake = makeFakeWriter({
      '2026-08-01': perDay,
      '2026-08-02': perDay,
      '2026-08-03': perDay,
      '2026-08-04': perDay, // newest — must survive
    });
    setCaptureWriter(fake.writer);

    const state = checkCeilingAndReportHealth();

    expect(fake.deletedDays).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(fake.daysRemaining()).toEqual(['2026-08-04']);
    expect(state?.rotatedDays).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    // Still over the ceiling — rotation is capped by "not the newest", not guaranteed to succeed.
    expect(state?.bytesOnDisk).toBeGreaterThan(CAPTURE_CEILING_BYTES);
  });

  it('does not rotate at all when already under the ceiling', () => {
    const fake = makeFakeWriter({ '2026-08-01': 1000, '2026-08-02': 2000 });
    setCaptureWriter(fake.writer);

    const state = checkCeilingAndReportHealth();

    expect(fake.deletedDays).toEqual([]);
    expect(state?.rotatedDays).toEqual([]);
    expect(fake.daysRemaining()).toEqual(['2026-08-01', '2026-08-02']);
    expect(state?.bytesOnDisk).toBe(3000);
  });
});

describe('the warn threshold (task 53 W5: pin with a literal, not just the symbol)', () => {
  it('is 80% of the ceiling, and that is asserted against a literal', () => {
    // 512 MiB * 0.8 = 429,496,729.6, floored. A constant compared only to itself pins nothing
    // (W5) — this literal is what actually fails if CAPTURE_WARN_BYTES moves to e.g. 20%.
    expect(CAPTURE_WARN_BYTES).toBe(429496729);
  });

  it('warns at or above the threshold and not below it, checked against literal byte counts', () => {
    const below = makeFakeWriter({ '2026-08-01': 429496728 });
    setCaptureWriter(below.writer);
    expect(checkCeilingAndReportHealth()?.warn).toBe(false);

    dismissCeilingWarning();
    const at = makeFakeWriter({ '2026-08-02': 429496729 });
    setCaptureWriter(at.writer);
    expect(checkCeilingAndReportHealth()?.warn).toBe(true);
  });
});

describe('the try/catch: "a failed size check must not be able to stop anything"', () => {
  it('does not propagate when sizeOnDisk() throws, and still emits the lifecycle.capture record', () => {
    const fake = makeFakeWriter({ '2026-08-01': 10 });
    fake.setThrowOnSizeOnDisk(true);
    setCaptureWriter(fake.writer);

    let state: CaptureCeilingState | null = null;
    let threw = false;
    try {
      state = checkCeilingAndReportHealth();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(state?.bytesOnDisk).toBe(0);
    expect(state?.rotatedDays).toEqual([]);
    expect(fake.deletedDays).toEqual([]);

    const health = healthRecordOf(fake.written);
    expect(health).toMatchObject({ stream: 'lifecycle', type: 'capture', bytesOnDisk: 0 });
  });

  it('does not propagate when deleteDay() throws mid-rotation, and still emits the health record', () => {
    const perDay = CAPTURE_CEILING_BYTES + 1000;
    const fake = makeFakeWriter({ '2026-08-01': perDay, '2026-08-02': perDay });
    fake.setThrowOnDeleteDay(true);
    setCaptureWriter(fake.writer);

    let state: CaptureCeilingState | null = null;
    let threw = false;
    try {
      state = checkCeilingAndReportHealth();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // sizeOnDisk() succeeded before the loop; deleteDay() threw on the first rotation attempt, so
    // nothing was recorded as rotated and the measured bytes are whatever was last read.
    expect(state?.rotatedDays).toEqual([]);
    expect(state?.bytesOnDisk).toBe(2 * perDay);

    const health = healthRecordOf(fake.written);
    expect(health).toMatchObject({ stream: 'lifecycle', type: 'capture', bytesOnDisk: 2 * perDay });
  });
});

describe('pendingCeilingWarning() / dismissCeilingWarning()', () => {
  it('sets the pending warning when a check warns, and dismissal clears it', () => {
    const fake = makeFakeWriter({ '2026-08-01': CAPTURE_WARN_BYTES });
    setCaptureWriter(fake.writer);

    const state = checkCeilingAndReportHealth();
    expect(state?.warn).toBe(true);
    expect(pendingCeilingWarning()).toEqual(state);

    dismissCeilingWarning();
    expect(pendingCeilingWarning()).toBeNull();
  });

  it('leaves no pending warning after a check that does not warn', () => {
    const fake = makeFakeWriter({ '2026-08-01': 10 });
    setCaptureWriter(fake.writer);

    const state = checkCeilingAndReportHealth();
    expect(state?.warn).toBe(false);
    expect(pendingCeilingWarning()).toBeNull();
  });
});

describe('no writer installed', () => {
  it('returns null and performs no size check, no rotation, no health record', () => {
    expect(captureWriter()).toBeNull();

    const result = checkCeilingAndReportHealth();

    expect(result).toBeNull();
    expect(pendingCeilingWarning()).toBeNull();
    // record() is never reached on this path, so the drop counter (reset to 0 in beforeEach)
    // must not have moved.
    expect(captureHealth().droppedTotal).toBe(0);
  });
});
