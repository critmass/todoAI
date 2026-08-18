#!/usr/bin/env node
/* eslint-env node */
/**
 * Task 41 — pull capture logs off the device (brief §7.4).
 *
 * THIS IS THE ONLY EGRESS PATH, AND THEREFORE THE REDACTION SEAM (design §10, brief §5e, ruled
 * 2026-08-07). Capture writes RAW, locally; nothing leaves the device from `record()`, so there is
 * nothing to redact at write time and putting a scrubber there would destroy the raw material task
 * 31 needs before it is ever read. The gate is here instead:
 *
 *   structured streams  pull freely.
 *   free_text streams   REFUSE without either `--anonymize <module>` (declared, unimplemented,
 *                       owner: task 42 §4b) or an explicit `--raw-i-am-jason`.
 *
 * In alpha the second flag is the normal path and that is correct — the subject is the developer.
 * The point is that the SHAPE of the gate exists now, so task 42 implements a transform rather than
 * inventing a pipeline.
 *
 * Three things the record must keep saying, repeated here because this is the file the egress
 * tooling grows from (orientation §5, task 43 §4):
 *   1. Anonymising free text is best-effort and unsolvable. "Anonymized" never means
 *      "safe to publish".
 *   2. The real risk is RE-IDENTIFICATION BY COMBINATION — a task list is close to a fingerprint
 *      with every proper noun stripped. That is why open beta drops free text STRUCTURALLY.
 *   3. Structured streams anonymise essentially completely and free text does not, and that
 *      asymmetry is what makes the ladder principled rather than arbitrary.
 *
 * Usage:
 *   node scripts/pull-capture.js [options]
 *     --out <dir>            where to write (default ./local/capture)
 *     --stream <name>        repeatable; default every stream
 *     --since <YYYY-MM-DD>   day partitions on or after this date
 *     --session <id>         filter records by sessionId (implies --merge)
 *     --run <id>             filter records by run id (implies --merge)
 *     --merge                write one merged, seq-sorted NDJSON instead of per-stream files
 *     --raw-i-am-jason       acknowledge pulling free-text streams un-anonymised
 *     --anonymize <module>   DECLARED, UNIMPLEMENTED — task 42 §4b owns it
 *     --device <serial>      adb -s <serial>
 *     --keep-pull            keep the raw adb pull directory
 *     --report-only          analyse an already-pulled directory; runs no adb
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mirrors src/capture/streams.ts. Kept as a literal on purpose: this script must run from a plain
// Node checkout with no build step, and a drift between the two is caught by
// scripts/__tests__/pull-capture.test.js, which reads the TypeScript and compares.
const STREAMS = {
  conversation: { egress: 'free_text', fate: 'dropped_at_open_beta' },
  modeltext: { egress: 'free_text', fate: 'dropped_at_open_beta' },
  mutationtext: { egress: 'free_text', fate: 'dropped_at_open_beta' },
  crisis: { egress: 'free_text', fate: 'removed_before_closed_beta' },
  modelio: { egress: 'structured', fate: 'survives' },
  validation: { egress: 'structured', fate: 'survives' },
  mutation: { egress: 'structured', fate: 'survives' },
  episode: { egress: 'structured', fate: 'survives' },
  planning: { egress: 'structured', fate: 'survives' },
  coaching: { egress: 'structured', fate: 'survives' },
  runtime: { egress: 'structured', fate: 'survives' },
  lifecycle: { egress: 'structured', fate: 'survives' },
};

const PACKAGE = 'com.todoai';
const DEVICE_ROOT = `/sdcard/Android/data/${PACKAGE}/files/capture`;

function parseArgs(argv) {
  const args = {
    out: path.join('local', 'capture'),
    streams: [],
    since: null,
    session: null,
    run: null,
    merge: false,
    raw: false,
    anonymize: null,
    device: null,
    keepPull: false,
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--out': args.out = next(); break;
      case '--stream': args.streams.push(next()); break;
      case '--since': args.since = next(); break;
      case '--session': args.session = next(); args.merge = true; break;
      case '--run': args.run = next(); args.merge = true; break;
      case '--merge': args.merge = true; break;
      case '--raw-i-am-jason': args.raw = true; break;
      case '--anonymize': args.anonymize = next(); break;
      case '--device': args.device = next(); break;
      case '--keep-pull': args.keepPull = true; break;
      case '--report-only': args.reportOnly = true; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`unknown option: ${flag}`);
    }
  }
  return args;
}

function printUsage() {
  const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
  process.stdout.write(header.replace(/^\/\*.*\n/, '').replace(/^ \* ?/gm, '') + '\n');
}

function fail(message) {
  process.stderr.write(`pull-capture: ${message}\n`);
  process.exit(1);
}

/** The egress gate. Refuses rather than silently pulling less than asked for — a tool that quietly
 *  drops a stream teaches you to trust an incomplete pull. */
function resolveStreams(args) {
  const requested = args.streams.length > 0 ? args.streams : Object.keys(STREAMS);
  for (const name of requested) {
    if (!STREAMS[name]) fail(`unknown stream: ${name} (known: ${Object.keys(STREAMS).join(', ')})`);
  }
  const freeText = requested.filter((name) => STREAMS[name].egress === 'free_text');
  if (freeText.length > 0 && !args.raw && !args.anonymize) {
    fail(
      `refusing to pull free-text streams (${freeText.join(', ')}) without an egress decision.\n` +
        '  --anonymize <module>   declared but UNIMPLEMENTED (task 42 §4b owns it)\n' +
        '  --raw-i-am-jason       pull raw, acknowledging it is un-anonymised\n' +
        '\n' +
        'Anonymising free text is best-effort and unsolvable; "anonymized" never means\n' +
        '"safe to publish", and re-identification by combination is the real risk.',
    );
  }
  if (args.anonymize) {
    fail(
      `--anonymize is a declared seam with no implementation (module: ${args.anonymize}).\n` +
        'Owner: task 42 §4b. It is refused rather than ignored, because silently pulling raw\n' +
        'data after someone asked for anonymisation is the worst available outcome.',
    );
  }
  return requested;
}

function adb(args, deviceArgs) {
  return execFileSync('adb', [...deviceArgs, ...args], { encoding: 'utf8' });
}

function pullFromDevice(streams, args) {
  const deviceArgs = args.device ? ['-s', args.device] : [];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'todoai-pull-'));
  for (const stream of streams) {
    const target = path.join(staging, stream);
    fs.mkdirSync(target, { recursive: true });
    try {
      adb(['pull', `${DEVICE_ROOT}/${stream}`, target], deviceArgs);
    } catch {
      // A stream directory that does not exist is NORMAL and is not an error: once task 42 removes
      // `crisis` and task 43 removes the free-text streams, nothing creates those directories at
      // all. `lifecycle.boot.streamsCompiled` is what says whether the absence is expected.
      process.stderr.write(`  (no ${stream}/ on device)\n`);
    }
  }
  return staging;
}

/** A pulled tree can be `<root>/<stream>/<day>.ndjson` or, after `adb pull`, one level deeper. */
function collectFiles(root, stream, since) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ndjson')) {
        const day = entry.name.replace(/\.ndjson$/, '');
        if (!since || day >= since) out.push({ day, full });
      }
    }
  };
  walk(path.join(root, stream));
  return out.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function analyse(records, streams) {
  const runs = new Map();
  for (const row of records) {
    if (!runs.has(row.run)) {
      runs.set(row.run, { seqs: new Set(), boot: null, dropped: [], streams: new Set() });
    }
    const run = runs.get(row.run);
    run.seqs.add(row.seq);
    run.streams.add(row.stream);
    if (row.stream === 'lifecycle' && row.type === 'boot') run.boot = row;
    if (row.dropped) run.dropped.push({ seq: row.seq, ...row.dropped });
  }

  const findings = [];
  for (const [runId, run] of runs) {
    // 🔴 A run with NO boot record is capture's honest failure mode made visible (design §7.2): if
    // the first write of a run failed and every later one did too, nothing about it is logged
    // anywhere on the device. A silently lossy logger produces confident wrong conclusions.
    if (!run.boot) {
      findings.push(`run ${runId}: NO BOOT RECORD — this run's completeness cannot be established`);
    }

    // A gap analysis over the process-global seq is ONLY valid against the stream set that was
    // compiled into that run (design §3.4). If the pull was filtered, or the build had fewer
    // streams, apparent gaps mean nothing.
    const compiled = run.boot && run.boot.streamsCompiled ? run.boot.streamsCompiled : null;
    const pulledAll = compiled ? compiled.every((name) => streams.includes(name)) : false;
    const seqs = [...run.seqs].sort((a, b) => a - b);
    if (!pulledAll) {
      findings.push(
        `run ${runId}: gap analysis SKIPPED — ${
          compiled ? 'not every compiled stream was pulled' : 'no boot record naming the stream set'
        }`,
      );
    } else {
      const gaps = [];
      for (let i = 1; i < seqs.length; i++) {
        if (seqs[i] !== seqs[i - 1] + 1) gaps.push(`${seqs[i - 1]}→${seqs[i]}`);
      }
      if (seqs.length > 0 && seqs[0] !== 1) gaps.unshift(`starts at ${seqs[0]}, not 1`);
      findings.push(
        gaps.length === 0
          ? `run ${runId}: seq contiguous 1..${seqs[seqs.length - 1]} (${seqs.length} records)`
          : `run ${runId}: ${gaps.length} GAP(S) in the merged seq — ${gaps.slice(0, 10).join(', ')}`,
      );
    }

    for (const drop of run.dropped) {
      findings.push(`run ${runId}: capture reported ${drop.count} dropped — ${drop.lastReason}`);
    }
  }
  return findings;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const streams = resolveStreams(args);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const source = args.reportOnly ? outDir : pullFromDevice(streams, args);

  const all = [];
  const perStream = new Map();
  const unparseable = [];
  let bytes = 0;

  for (const stream of streams) {
    const rows = [];
    for (const file of collectFiles(source, stream, args.since)) {
      const text = fs.readFileSync(file.full, 'utf8');
      bytes += Buffer.byteLength(text);
      const lines = text.split('\n').filter((line) => line !== '');
      lines.forEach((line, index) => {
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Design §6 rule 5: a trailing partial line is only reachable through power loss and is
          // tolerated. A partial line MID-FILE is a bug and must be reported loudly.
          const where = index === lines.length - 1 ? 'trailing (tolerated)' : 'MID-FILE (a bug)';
          unparseable.push(`${stream}/${file.day} line ${index + 1}: ${where}`);
        }
      });
    }
    perStream.set(stream, rows);
    all.push(...rows);
  }

  const matches = (row) =>
    (!args.session || row.sessionId === args.session) && (!args.run || row.run === args.run);
  const filtered = all.filter(matches);

  if (args.merge) {
    // Merged and sorted by the process-global seq, which is what "reconstruct the timeline end to
    // end" (brief §8) actually requires — neither clock has the resolution to order two records in
    // the same millisecond, and both can move.
    filtered.sort((a, b) => (a.run === b.run ? a.seq - b.seq : a.wallMs - b.wallMs));
    const target = path.join(outDir, 'merged.ndjson');
    fs.writeFileSync(target, filtered.map((row) => JSON.stringify(row)).join('\n') + '\n');
    process.stdout.write(`wrote ${filtered.length} records → ${target}\n`);
  } else {
    for (const [stream, rows] of perStream) {
      const kept = rows.filter(matches);
      if (kept.length === 0) continue;
      const target = path.join(outDir, `${stream}.ndjson`);
      fs.writeFileSync(target, kept.map((row) => JSON.stringify(row)).join('\n') + '\n');
      process.stdout.write(`  ${stream}: ${kept.length} records → ${target}\n`);
    }
  }

  process.stdout.write(`\n${(bytes / 1024).toFixed(1)} KB read, ${all.length} records\n`);
  for (const stream of streams) {
    const rows = perStream.get(stream);
    if (rows.length > 0) {
      process.stdout.write(
        `  ${stream.padEnd(13)} ${String(rows.length).padStart(6)}  ${STREAMS[stream].egress}, ${STREAMS[stream].fate}\n`,
      );
    }
  }

  if (unparseable.length > 0) {
    process.stdout.write('\nUNPARSEABLE LINES:\n');
    for (const line of unparseable) process.stdout.write(`  ${line}\n`);
  }

  process.stdout.write('\nINTEGRITY:\n');
  for (const finding of analyse(all, streams)) process.stdout.write(`  ${finding}\n`);

  if (!args.reportOnly && !args.keepPull) fs.rmSync(source, { recursive: true, force: true });
}

if (require.main === module) main();

module.exports = { STREAMS, analyse, resolveStreams, parseArgs };
