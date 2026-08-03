#!/usr/bin/env node
/**
 * Polls the device's thermal sensors and battery while a spike run is in progress, writing one
 * JSON object per sample to a JSONL file.
 *
 * WHY HOST-SIDE. The harness cannot read these itself. React Native exposes no thermal API, and
 * the sensors live behind `dumpsys` / sysfs — reaching them from JS would mean adding a native
 * module, which this project has deliberately refused to do for a throwaway spike (a second
 * untested native dependency on top of llama.rn). So the sampler runs here, stamps each reading
 * with wall-clock time, and `scripts/join-thermals.js` matches those readings to the harness's
 * per-iteration samples by timestamp. That is why each sustained-decode sample carries `ts`.
 *
 * WHICH SENSORS, AND WHY IT MATTERS. The first day of this spike quoted `dumpsys battery`
 * temperature as "the" thermal number. That was the wrong sensor twice over: it reports the
 * BATTERY, not the SoC (measured 13C lower than AP under load), and it is contaminated by
 * discharge heating at low state of charge, so it partly tracks battery level rather than
 * compute. The sensor that governs throttling is SKIN, and its `mStatus` is the throttling
 * severity — that is the number the envelope question actually turns on.
 *
 *   AP        application processor / SoC
 *   SKIN      the throttling trigger; mStatus 0=NONE 1=LIGHT 2=MODERATE 3=SEVERE
 *             4=CRITICAL 5=EMERGENCY 6=SHUTDOWN
 *   BAT       battery pack
 *   PATHM     power path
 *   USB       connector
 *
 * Usage:
 *   node scripts/thermal-sampler.js <serial> <out.jsonl> [intervalSeconds]
 *
 * Runs until killed. Interval defaults to 10s — fast enough to resolve a throttling transition,
 * slow enough that the adb round-trips do not themselves warm the phone.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const [, , serial, outPath, intervalArg] = process.argv;
if (!serial || !outPath) {
  console.error('Usage: node scripts/thermal-sampler.js <serial> <out.jsonl> [intervalSeconds]');
  process.exit(1);
}
const intervalMs = Math.max(2, Number(intervalArg) || 10) * 1000;

function adb(args) {
  try {
    return execFileSync('adb', ['-s', serial, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  } catch (err) {
    // A dropped cable or a busy device should pause the sampler, not kill the run it is watching.
    return '';
  }
}

/** Parses `Temperature{mValue=58.0, mType=0, mName=AP, mStatus=0}` lines. Later duplicates of a
 *  name overwrite earlier ones; dumpsys lists each sensor more than once and the values agree. */
function readThermals() {
  const out = adb(['shell', 'dumpsys', 'thermalservice']);
  const zones = {};
  const re = /Temperature\{mValue=([-\d.]+),\s*mType=(\d+),\s*mName=([A-Z0-9_]+),\s*mStatus=(-?\d+)\}/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    zones[m[3]] = { value: Number(m[1]), status: Number(m[4]) };
  }
  return zones;
}

function readBattery() {
  const out = adb(['shell', 'dumpsys', 'battery']);
  const pick = (key) => {
    const m = new RegExp(`^\\s+${key}:\\s*(-?\\d+)`, 'm').exec(out);
    return m ? Number(m[1]) : null;
  };
  return {
    level: pick('level'),
    // dumpsys reports tenths of a degree; convert so it is directly comparable to the zones.
    temperatureC: pick('temperature') !== null ? pick('temperature') / 10 : null,
    voltageMv: pick('voltage'),
    status: pick('status'),
  };
}

const stream = fs.createWriteStream(outPath, { flags: 'a' });
let n = 0;

function sample() {
  const zones = readThermals();
  const battery = readBattery();
  if (Object.keys(zones).length === 0 && battery.level === null) return; // device unreachable
  const row = { ts: Date.now(), iso: new Date().toISOString(), zones, battery };
  stream.write(JSON.stringify(row) + '\n');
  n++;
  const skin = zones.SKIN;
  const ap = zones.AP;
  process.stdout.write(
    `[${n}] AP=${ap ? ap.value.toFixed(1) : '?'}C ` +
      `SKIN=${skin ? skin.value.toFixed(1) : '?'}C status=${skin ? skin.status : '?'} ` +
      `bat=${battery.level}% ${battery.temperatureC}C\n`,
  );
}

sample();
const timer = setInterval(sample, intervalMs);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    stream.end(() => {
      process.stdout.write(`\nthermal-sampler: wrote ${n} samples to ${outPath}\n`);
      process.exit(0);
    });
  });
}
