#!/usr/bin/env node
/**
 * Joins host-side thermal samples onto the harness's per-iteration decode samples by timestamp,
 * so every tok/s figure carries the thermal state it was measured under.
 *
 * The harness records wall-clock `ts` on each sustained-decode sample; `scripts/thermal-sampler.js`
 * records `ts` on each sensor reading. This matches each decode sample to the nearest thermal
 * reading and annotates it. A reading further away than MAX_SKEW_MS is treated as no reading
 * rather than silently attached — a tok/s number paired with a temperature from two minutes
 * earlier is worse than one with no temperature at all.
 *
 * Usage:
 *   node scripts/join-thermals.js <results.json> <thermals.jsonl> [out.json]
 *
 * Default output: overwrites <results.json> in place with `thermal` added to each sample plus a
 * `thermalSummary` per run (peak AP, peak SKIN, worst throttling status, battery drop).
 */
const fs = require('fs');

/** Sampler runs at 10s; 20s allows one missed poll before a sample is left unannotated. */
const MAX_SKEW_MS = 20000;

function nearest(readings, ts) {
  let best = null;
  let bestDelta = Infinity;
  for (const r of readings) {
    const d = Math.abs(r.ts - ts);
    if (d < bestDelta) {
      bestDelta = d;
      best = r;
    }
  }
  return bestDelta <= MAX_SKEW_MS ? { reading: best, skewMs: bestDelta } : null;
}

function main() {
  const [, , resultsPath, thermalsPath, outArg] = process.argv;
  if (!resultsPath || !thermalsPath) {
    console.error('Usage: node scripts/join-thermals.js <results.json> <thermals.jsonl> [out.json]');
    process.exitCode = 1;
    return;
  }
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const readings = fs
    .readFileSync(thermalsPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (readings.length === 0) {
    console.error('No usable thermal readings — nothing to join.');
    process.exitCode = 1;
    return;
  }

  let annotated = 0;
  let unmatched = 0;

  for (const [tag, run] of Object.entries(results)) {
    if (!run || !Array.isArray(run.samples)) continue;
    let peakAp = null;
    let peakSkin = null;
    let worstStatus = null;
    let firstLevel = null;
    let lastLevel = null;
    // Per-run, not the global tally: a run with zero matches must not inherit a summary just
    // because some earlier run in the same file matched.
    let runAnnotated = 0;

    for (const s of run.samples) {
      if (typeof s.ts !== 'number') {
        unmatched++;
        continue;
      }
      const hit = nearest(readings, s.ts);
      if (!hit) {
        unmatched++;
        continue;
      }
      const z = hit.reading.zones || {};
      s.thermal = {
        apC: z.AP ? z.AP.value : null,
        skinC: z.SKIN ? z.SKIN.value : null,
        skinStatus: z.SKIN ? z.SKIN.status : null,
        batC: z.BAT ? z.BAT.value : null,
        batteryLevel: hit.reading.battery ? hit.reading.battery.level : null,
        batteryMv: hit.reading.battery ? hit.reading.battery.voltageMv : null,
        skewMs: hit.skewMs,
      };
      annotated++;
      runAnnotated++;
      if (s.thermal.apC !== null) peakAp = Math.max(peakAp ?? -Infinity, s.thermal.apC);
      if (s.thermal.skinC !== null) peakSkin = Math.max(peakSkin ?? -Infinity, s.thermal.skinC);
      if (s.thermal.skinStatus !== null) {
        worstStatus = Math.max(worstStatus ?? -Infinity, s.thermal.skinStatus);
      }
      if (s.thermal.batteryLevel !== null) {
        if (firstLevel === null) firstLevel = s.thermal.batteryLevel;
        lastLevel = s.thermal.batteryLevel;
      }
    }

    if (runAnnotated > 0) {
      run.thermalSummary = {
        peakApC: peakAp,
        peakSkinC: peakSkin,
        worstSkinStatus: worstStatus,
        batteryStartPct: firstLevel,
        batteryEndPct: lastLevel,
        batteryDropPct: firstLevel !== null && lastLevel !== null ? firstLevel - lastLevel : null,
      };
      console.log(
        `${tag}: peakAP=${peakAp}C peakSKIN=${peakSkin}C worstStatus=${worstStatus} ` +
          `battery ${firstLevel}%→${lastLevel}%`,
      );
    }
  }

  const outPath = outArg || resultsPath;
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
  console.log(`Annotated ${annotated} samples (${unmatched} unmatched) → ${outPath}`);
}

main();
