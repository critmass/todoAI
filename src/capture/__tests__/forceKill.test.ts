// Task 41 — THE ACCEPTANCE TEST, WRITTEN BEFORE THE IMPLEMENTATION (amendment §10's build order,
// brief §8: "a deliberate force-kill mid-episode loses no event before the kill — buffering bugs
// surface nowhere else").
//
// WHAT THIS PROVES: the protocol. Synchronous-at-the-event, `seq` contiguity across a
// process-global counter spanning four streams, one complete line per write, no torn records, and
// that every event `record()` RETURNED FROM is on disk after a SIGKILL. A buffering regression
// fails it immediately, which is the whole reason it exists before the writer does.
//
// 🔴 WHAT THIS DOES NOT PROVE, STATED SO NOBODY OVER-READS A GREEN. It exercises the NODE writer,
// not the Kotlin one. `fs.writeSync` and `FileOutputStream.write` have the same semantics here —
// a blocking write(2) into the kernel page cache, which SIGKILL does not touch — but "the same
// semantics" is a desktop inference. The device is ground truth, and design §14.2 is Jason's run:
// `adb shell am force-stop com.todoai` mid-episode on the S23 FE.
//
// It also does not test `fsync`. Per-event fsync (amendment §7) defends against POWER LOSS, which
// SIGKILL is not; the harness deliberately omits it so the test asserts the STRICTER property —
// that the page cache alone is sufficient, which is the mechanism the TurboModule was chosen for.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CAPTURE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(CAPTURE_DIR, '..', '..');

/** Modules the harness needs at runtime. `events.ts` and `writer.ts` are type-only from
 *  `record.ts`, so they are erased and never required — record.ts imports nothing outside this
 *  list, and nothing from `react-native`, which is what makes a bare Node child possible at all. */
const RUNTIME_MODULES = ['streams.ts', 'context.ts', 'record.ts'];

let workspace: string;

/** Transpiles the real capture sources with the repo's own babel config (the same one Jest uses),
 *  so the child runs the shipped code rather than a copy of it. */
function buildWorkspace(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const babel = require('@babel/core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoai-capture-'));
  for (const file of RUNTIME_MODULES) {
    const source = path.join(CAPTURE_DIR, file);
    const result = babel.transformFileSync(source, { cwd: REPO_ROOT, filename: source });
    fs.writeFileSync(path.join(dir, file.replace(/\.ts$/, '.js')), result.code);
  }
  fs.copyFileSync(path.join(__dirname, 'forceKillChild.cjs'), path.join(dir, 'child.cjs'));
  return dir;
}

interface Harvest {
  /** Every `seq` present in a capture file, across all streams. */
  onDisk: Set<number>;
  /** Every `seq` the child reported `record()` as having returned from. */
  acked: number[];
  lines: number;
  unparseable: string[];
  droppedFields: unknown[];
}

function harvest(outDir: string, ackPath: string): Harvest {
  const onDisk = new Set<number>();
  const unparseable: string[] = [];
  const droppedFields: unknown[] = [];
  let lines = 0;

  const streams = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  for (const stream of streams) {
    for (const file of fs.readdirSync(path.join(outDir, stream))) {
      const text = fs.readFileSync(path.join(outDir, stream, file), 'utf8');
      for (const line of text.split('\n')) {
        if (line === '') continue;
        lines++;
        try {
          const parsed = JSON.parse(line) as { seq: number; dropped?: unknown };
          onDisk.add(parsed.seq);
          if (parsed.dropped !== undefined) droppedFields.push(parsed.dropped);
        } catch {
          unparseable.push(line);
        }
      }
    }
  }

  const ackText = fs.existsSync(ackPath) ? fs.readFileSync(ackPath, 'utf8') : '';
  const ackLines = ackText.split('\n').filter((line) => line !== '');
  const acked: number[] = [];
  for (const line of ackLines) {
    const value = Number(line);
    // The ack file is written by the same synchronous mechanism, so a torn final line is only
    // reachable the same way a torn capture line is. Tolerated on the LAST line only.
    if (Number.isInteger(value)) acked.push(value);
    else if (line !== ackLines[ackLines.length - 1]) throw new Error(`torn ack mid-file: ${line}`);
  }
  return { onDisk, acked, lines, unparseable, droppedFields };
}

async function runOnce(iteration: number): Promise<Harvest> {
  const outDir = path.join(workspace, `run-${iteration}`);
  const ackPath = path.join(workspace, `ack-${iteration}.txt`);
  fs.mkdirSync(outDir, { recursive: true });

  const child = spawn(process.execPath, [path.join(workspace, 'child.cjs'), outDir, ackPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for "ready" so the kill lands during writing rather than during module load.
  await new Promise<void>((resolve) => {
    let seen = false;
    child.stdout.on('data', () => {
      if (!seen) {
        seen = true;
        resolve();
      }
    });
    child.on('exit', () => resolve());
  });

  // Randomised so a buffering bug cannot survive by lining up with one fixed timing.
  const delayMs = 1 + Math.floor(Math.random() * 15);
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  // The closest host-side analogue of `am force-stop`: the process dies with no graceful shutdown
  // and no chance to flush anything it was holding. On POSIX this is SIGKILL; on Windows Node
  // maps it to TerminateProcess, which is the same class of death — no handlers, no flush.
  child.kill('SIGKILL');
  await exited;

  return harvest(outDir, ackPath);
}

describe('capture survives a force-kill (design §14.1)', () => {
  beforeAll(() => {
    workspace = buildWorkspace();
  });

  afterAll(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes real events through the real record() path', async () => {
    const result = await runOnce(0);
    expect(result.lines).toBeGreaterThan(0);
    expect(result.acked.length).toBeGreaterThan(0);
  }, 30000);

  it('loses nothing acked, tears no line, and leaves no gap in the global seq', async () => {
    // Fifty iterations with randomised timing (design §14.1), run five at a time. The batching is
    // purely wall-clock: process spawn dominates, and a 40-second test in a 15-second suite is a
    // test somebody eventually deletes. Each run has its own output directory and its own child,
    // so nothing is shared and the randomised kill timing is untouched.
    const results: Harvest[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const iterations = [1, 2, 3, 4, 5].map((offset) => batch * 5 + offset);
      results.push(...(await Promise.all(iterations.map((iteration) => runOnce(iteration)))));
    }

    for (const result of results) {
      // The child ran and wrote something. A harness that silently did nothing would otherwise
      // pass every assertion below vacuously.
      expect(result.acked.length).toBeGreaterThan(0);

      // Every line is a complete JSON object — including the last. One write(2) per line with the
      // newline in the same buffer means SIGKILL cannot land inside a record (design §6 rule 5:
      // a partial line is only reachable through power loss).
      expect(result.unparseable).toEqual([]);

      // Nothing was dropped: `dropped` on the envelope is capture reporting its own failures
      // (design §7.2), and its presence here would mean the writer double failed.
      expect(result.droppedFields).toEqual([]);

      // 🔴 THE ASSERTION THE TEST EXISTS FOR. Every seq the child reported `record()` as having
      // RETURNED from is on disk. A buffered append acks first and writes later, and dies in
      // between.
      const missing = result.acked.filter((seq) => !result.onDisk.has(seq));
      expect(missing).toEqual([]);

      // The global seq run is contiguous from 1 with no gaps, across all four streams merged.
      // A gap in ONE stream's file is normal and expected — `seq` is process-global — so loss is
      // only detectable in the union (design §3.4).
      const merged = [...result.onDisk].sort((a, b) => a - b);
      expect(merged[0]).toBe(1);
      expect(merged[merged.length - 1]).toBe(merged.length);
    }
  }, 180000);
});
