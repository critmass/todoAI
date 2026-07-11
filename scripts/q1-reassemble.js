#!/usr/bin/env node
/**
 * Reassembles Q1 grammar-spike results from a saved `adb logcat` dump into one JSON file.
 *
 * The harness (src/dev/Q1GrammarSpikeScreen.tsx) never writes to the device filesystem - see
 * that file's header comment for why (a filesystem-write native module would be a second,
 * untested native dependency on top of llama.rn itself, for a throwaway spike). Instead each
 * stage logs its result as tagged, chunked JSON lines - `[<tag> i/N] <chunk>` - because logcat
 * truncates long lines and splits multi-line `console.log` calls onto separate untagged lines.
 * This script reverses that: finds every tag, orders its chunks, concatenates, JSON.parses, and
 * writes one combined object - fulfilling the brief's "results + manifest go to a file"
 * requirement as a desktop artifact assembled from the pulled log, rather than a device-side
 * write.
 *
 * Usage:
 *   adb logcat -d > q1_logcat.txt
 *   node scripts/q1-reassemble.js q1_logcat.txt [output.json]
 *
 * Default output: docs/eval/q1_results.json
 */
const fs = require('fs');
const path = require('path');

const LINE_PATTERN = /\[([\w.:-]+) (\d+)\/(\d+)\] (.*)$/;

/**
 * Parses raw `adb logcat` text and reassembles every `[<tag> i/N] <chunk>` sequence into
 * `{ [tag]: parsedJsonValue }`. Tags missing a chunk, or whose concatenated chunks don't parse
 * as JSON, are omitted from the result and reported back in `incomplete` instead of thrown -
 * a partial device run (e.g. Stage 2 crashed mid-way) should still yield whatever did complete.
 */
function reassemble(logcatText) {
  const chunksByTag = new Map();

  for (const line of logcatText.split('\n')) {
    const match = LINE_PATTERN.exec(line);
    if (!match) continue;
    const [, tag, indexStr, totalStr, chunk] = match;
    const index = Number(indexStr);
    const total = Number(totalStr);
    if (!chunksByTag.has(tag)) chunksByTag.set(tag, new Array(total).fill(undefined));
    chunksByTag.get(tag)[index - 1] = chunk;
  }

  const result = {};
  const incomplete = [];
  for (const [tag, chunks] of chunksByTag) {
    if (chunks.some((c) => c === undefined)) {
      incomplete.push(`${tag} (missing chunk(s), got ${chunks.filter((c) => c !== undefined).length}/${chunks.length})`);
      continue;
    }
    try {
      result[tag] = JSON.parse(chunks.join(''));
    } catch (err) {
      incomplete.push(`${tag} (JSON.parse failed: ${err.message})`);
    }
  }

  return { result, incomplete };
}

function main() {
  const [, , logcatPath, outputPathArg] = process.argv;
  if (!logcatPath) {
    console.error('Usage: node scripts/q1-reassemble.js <logcat-dump-file> [output.json]');
    process.exitCode = 1;
    return;
  }
  const outputPath = outputPathArg || path.join(__dirname, '..', 'docs', 'eval', 'q1_results.json');

  const raw = fs.readFileSync(logcatPath, 'utf-8');
  const { result, incomplete } = reassemble(raw);

  if (incomplete.length > 0) {
    console.error(`Incomplete or unparseable tags, skipped:\n  ${incomplete.join('\n  ')}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${Object.keys(result).length} tag(s) to ${outputPath}`);
}

module.exports = { reassemble };

if (require.main === module) {
  main();
}
