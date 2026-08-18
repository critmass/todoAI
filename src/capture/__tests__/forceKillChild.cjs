/* eslint-env node */
// Task 41 — the child half of the force-kill acceptance test (design §14.1, brief §8).
//
// Runs the REAL `record()` path (transpiled from src/capture/record.ts by the parent test, not
// re-implemented here) over a Node `fs` writer double, appending as fast as it can, and ACKs each
// event to a separate file only AFTER record() has returned. The parent SIGKILLs this process at a
// random point and then asserts that every acked seq is present in the capture files.
//
// The ack channel deliberately uses the same durability class as the capture channel — a
// synchronous write(2) into the kernel page cache — so a false failure cannot come from the ack
// file being lossier than the thing it is auditing. A BUFFERING implementation of `append` fails
// immediately here: it would ack seq N while the file on disk still ends at some earlier seq.
//
// `.cjs`, not `.js`, so Jest's default `**/__tests__/**/*.[jt]s?(x)` does not collect this as a
// test suite with no tests in it.

const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const ackPath = process.argv[3];
const MAX_EVENTS = 5000;

const { record, setCaptureWriter, lastSeq } = require('./record.js');

/** The Node writer double. Mirrors the Kotlin module's semantics: one open handle per
 *  stream/day, one blocking write(2) per line, the trailing newline in the same buffer. */
function nodeWriter() {
  const handles = new Map();
  const started = Date.now();
  function handleFor(dir, day) {
    const key = `${dir}/${day}`;
    let fd = handles.get(key);
    if (fd === undefined) {
      fs.mkdirSync(path.join(outDir, dir), { recursive: true });
      fd = fs.openSync(path.join(outDir, dir, `${day}.ndjson`), 'a');
      handles.set(key, fd);
    }
    return fd;
  }
  return {
    append(dir, day, line) {
      const fd = handleFor(dir, day);
      const buffer = Buffer.from(line, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(fd, buffer, written, buffer.length - written);
      }
    },
    monoMs: () => Date.now() - started,
    sizeOnDisk: () => 0,
    deleteDay: () => 0,
    listDays: () => [],
  };
}

setCaptureWriter(nodeWriter());

const ackFd = fs.openSync(ackPath, 'a');
const filler = 'x'.repeat(120);

// A rotation across four streams, because `seq` is PROCESS-GLOBAL rather than per-stream
// (design §3.4): loss is detected by merging every stream for a run and looking for gaps in the
// union, so a single-stream harness would not exercise the property being asserted.
const shapes = [
  (n) => ({
    stream: 'conversation',
    type: 'turn',
    from: 'user',
    purpose: 'task_input',
    kind: 'user',
    text: `turn ${n} ${filler}`,
    todayISO: '2026-08-18',
  }),
  (n) => ({
    stream: 'lifecycle',
    type: 'capture',
    droppedTotal: 0,
    lastDropReason: `beat ${n}`,
  }),
  (n) => ({
    stream: 'mutation',
    type: 'task',
    entityId: n,
    field: 'estimatedDuration',
    before: n,
    after: n + 1,
    actor: 'user',
    surface: 'editor',
  }),
  (n) => ({
    stream: 'modelio',
    type: 'call',
    textRef: null,
    surface: 'harness',
    constrained: false,
    grammarId: null,
    grammarSha8: null,
    grammarSlots: null,
    rung: 'prose',
    attempt: 1,
    maxTokens: 160,
    temperature: null,
    topK: null,
    truncated: false,
    timings: null,
    model: { tier: null, available: false },
    latencyMs: n,
    outcome: 'ok',
  }),
];

// The readiness signal is sent only after a WARMUP of real events has been recorded and acked, so
// the parent's kill lands during writing rather than during module load — and so `acked.length`
// is non-zero by construction rather than by hoping the child got a time slice. The loop keeps
// going long past it, which is where the kill actually falls.
const WARMUP = 50;

for (let n = 1; n <= MAX_EVENTS; n++) {
  record(shapes[n % shapes.length](n));
  fs.writeSync(ackFd, Buffer.from(`${lastSeq()}\n`, 'utf8'));
  if (n === WARMUP) process.stdout.write('ready\n');
}

// Ran out of work before the kill arrived. Spin without writing so the parent's SIGKILL still
// lands on a live process; anything acked above must still be on disk.
for (;;) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, 50);
}
