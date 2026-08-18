// Task 41 — `record()`: the one entry point (brief §4). Everything above it is a call site that
// passes data and knows nothing else.
//
// THIS FILE MUST NOT IMPORT `react-native`, DIRECTLY OR TRANSITIVELY. The force-kill acceptance
// test (./__tests__/forceKill.test.ts) drives this exact code in a bare Node child process it
// SIGKILLs, over a Node `fs` writer double. If a react-native import creeps in here the test can
// only be run against a re-implementation, and a re-implementation proves nothing.

import type { CaptureEvent } from './events';
import { captureContext } from './context';
import { CAPTURE_FORMAT_VERSION, STREAMS, type StreamName } from './streams';
import type { CaptureWriter } from './writer';

/**
 * 🔴 PINNED FUTURE DECISION — `fsync` per event, for ALPHA ONLY.
 *
 * Ruled by Jason 2026-08-17 (amendment §7), superseding the parent design §1.2's boundary-only
 * recommendation. Revert to `fsync` on episode boundaries and AppState background transitions at
 * the closed-beta build; owner is task 42, which is already touching every capture surface.
 *
 * WHAT IT DOES AND DOES NOT BUY, so the guarantee is not misread. It does NOT improve the
 * force-kill test: `am force-stop`, `kill -9` and a native SIGSEGV destroy the process but not the
 * kernel page cache, which a synchronous write(2) already reaches. It buys durability against
 * POWER LOSS AND KERNEL PANIC — and on this hardware that is not theoretical: the S23 FE reaches
 * SKIN status 3 (SEVERE) by ~20 minutes under load and PowerManager status 6 is SHUTDOWN, so a
 * thermal shutdown mid-session is a power-loss-class event, and it is exactly the failure mode
 * where the surrounding records are most diagnostic.
 *
 * The cost is ~1–5 ms per event on f2fs — negligible against a ~25 s generation, but a BURST risk
 * at app open where the recurrence sweep can fire many `mutation` records back to back. The
 * findings report measures app-open time with capture on and off; that number decides whether the
 * beta revert is pulled forward.
 */
export const FSYNC_PER_EVENT = true;

let writer: CaptureWriter | null = null;
let seq = 0;
let runId = mintRunId();
let droppedCount = 0;
let droppedTotal = 0;
let lastDropReason: string | null = null;
const processStartWallMs = Date.now();

/** Per-process id, minted at module load. Not random for aesthetics: after a force-kill the app
 *  relaunches and appends to the SAME day's file, so without it the pre-crash and post-crash
 *  records are one undifferentiated sequence with `seq` restarting at 1 — and the acceptance test
 *  ("no event lost before the kill") is literally unverifiable, because proving the pre-kill run
 *  is contiguous first requires knowing which records belong to it (design §3.2). */
function mintRunId(): string {
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * 0x100000000).toString(36);
  return `${stamp}-${noise}`;
}

/**
 * Day partition by LOCAL calendar date (design §6 rule 3), matching `chatController`'s
 * `localTodayISO` convention. Not UTC: a human asking for "yesterday's session" means their
 * yesterday, and `adb pull capture/modelio/2026-08-18.ndjson` should be the obvious command.
 * Records carry `wallMs` regardless, so nothing downstream depends on the filename.
 */
export function localDayISO(wallMs: number): string {
  const date = new Date(wallMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function setCaptureWriter(next: CaptureWriter | null): void {
  writer = next;
}

export function captureWriter(): CaptureWriter | null {
  return writer;
}

/** The `seq` most recently assigned. Used for `textRef`: a call site records the `modeltext`
 *  record, then reads this to point a `modelio` record at it. Safe because JS is single-threaded
 *  and `record()` is synchronous end to end — nothing can interleave between the two statements. */
export function lastSeq(): number {
  return seq;
}

export function currentRunId(): string {
  return runId;
}

export function processStartMs(): number {
  return processStartWallMs;
}

export interface CaptureHealth {
  run: string;
  seq: number;
  droppedTotal: number;
  lastDropReason: string | null;
}

export function captureHealth(): CaptureHealth {
  return { run: runId, seq, droppedTotal, lastDropReason };
}

/**
 * Writes one event. NEVER THROWS, NEVER RETURNS ANYTHING — `void` so that no call site can
 * accidentally start depending on it, and every call site is a statement rather than an
 * expression (design §7.1). If the native module is absent (Jest, or a JS bundle running against
 * an APK built before it existed) this is a counted no-op, never a crash.
 *
 * AND IT NEVER GOES SILENT (design §7.2, brief §5c): the next SUCCESSFUL record after any failure
 * carries `dropped: {count, lastReason}` and resets the counter. That mechanism fails in the one
 * case that matters most — no subsequent write succeeds because the disk is full — which is why
 * `lifecycle.capture` records a running total at every background transition, and why
 * `scripts/pull-capture.js` reports a run with NO boot record as its own loud condition. This
 * design can still be lossy; the tooling's job is to make that visible rather than to claim it
 * cannot happen.
 */
export function record(event: CaptureEvent): void {
  const assigned = ++seq;
  try {
    const active = writer;
    if (!active) throw new Error('capture writer not installed');

    const frame = captureContext.current();
    const wallMs = Date.now();
    const envelope: Record<string, unknown> = {
      v: CAPTURE_FORMAT_VERSION,
      seq: assigned,
      run: runId,
      wallMs,
      monoMs: active.monoMs(),
      sessionId: frame.sessionId,
      episodeId: frame.episodeId,
      taskId: frame.taskId,
    };
    if (droppedCount > 0) {
      envelope.dropped = { count: droppedCount, lastReason: lastDropReason };
    }

    const stream = event.stream as StreamName;
    const definition = STREAMS[stream];
    if (!definition) throw new Error(`unknown capture stream: ${String(stream)}`);

    // One complete JSON object, its trailing newline in the SAME buffer, so a line is never torn
    // by interleaving (design §2). Envelope first: every consumer — jq, grep, task 31's loader —
    // filters on envelope fields before it looks at a payload.
    const line = `${JSON.stringify({ ...envelope, ...event })}\n`;
    active.append(definition.dir, localDayISO(wallMs), line);

    // Reset only AFTER a write that actually succeeded, so the count survives a run of failures.
    droppedCount = 0;
  } catch (err) {
    droppedCount++;
    droppedTotal++;
    lastDropReason = err instanceof Error ? err.message : String(err);
  }
}

/** Tests only. Resets the process-global counters so one suite's records cannot leak into
 *  another's assertions. */
export function resetCaptureStateForTests(): void {
  seq = 0;
  runId = mintRunId();
  droppedCount = 0;
  droppedTotal = 0;
  lastDropReason = null;
  writer = null;
}
