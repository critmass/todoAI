#!/usr/bin/env node
/**
 * Merges freshly reassembled spike results into the accumulated results file.
 *
 * Merge rather than overwrite, because `adb logcat`'s ring buffer rotates. A multi-hour run
 * produces far more log than the buffer holds, so a dump taken at the end can be missing tags
 * that were captured earlier — and `q1-reassemble.js` writes a fresh object, which would drop
 * them. This happened during the first day of the spike: a straight reassemble carried 3 of 9
 * tags. Existing entries win on collision, so an already-recorded result is never replaced by a
 * partial re-read of the same tag.
 *
 * Usage:
 *   node scripts/merge-results.js <accumulated.json> <fresh.json> [more.json ...]
 */
const fs = require('fs');

const [, , outPath, ...freshPaths] = process.argv;
if (!outPath || freshPaths.length === 0) {
  console.error('Usage: node scripts/merge-results.js <accumulated.json> <fresh.json> [...]');
  process.exit(1);
}

const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
const before = Object.keys(existing).length;

let merged = { ...existing };
let added = 0;
for (const p of freshPaths) {
  if (!fs.existsSync(p)) {
    console.error(`skipping missing ${p}`);
    continue;
  }
  const fresh = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [tag, value] of Object.entries(fresh)) {
    if (tag in merged) continue; // existing wins
    merged[tag] = value;
    added++;
  }
}

fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
console.log(`merge-results: ${before} existing + ${added} new = ${Object.keys(merged).length} tags → ${outPath}`);
