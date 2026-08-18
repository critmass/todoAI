// Task 41 — bringing capture up, once per process.
//
// The boot record is not decoration. `lifecycle.boot` carries the run's environment ONCE per run
// rather than on every record — and critically it carries `streamsCompiled`, because `seq` is
// process-global and a GAP ANALYSIS IS ONLY VALID AGAINST THE STREAM SET THAT WAS COMPILED
// (design §3.4). Once task 42 removes `crisis` and task 43 removes the free-text streams, later
// builds have permanent, legitimate gaps in the merged sequence. This cannot be retrofitted, which
// is why it is written from the very first run.
//
// AND THE HONEST LIMIT, WHICH BELONGS IN THE RECORD (design §7.2): if the very first write of a
// run fails and every subsequent one does too, nothing is logged about it anywhere on the device.
// That is why `scripts/pull-capture.js` reports a run with NO boot record as its own loud
// condition. This design can still be lossy; the tooling's job is to make that visible rather than
// to pretend it cannot happen.

import { record, currentRunId, processStartMs, setCaptureWriter } from './record';
import { createNativeCaptureWriter, nativeCaptureAvailable, sampleThermal } from './nativeWriter';
import { CAPTURE_FORMAT_VERSION, STREAM_NAMES } from './streams';
import type { CaptureWriter } from './writer';

export interface InstallCaptureInput {
  /** The applied migration version, for joining a capture run to the schema it ran against. */
  schemaVersion?: string;
  /** Test seam. Supplying a writer skips the native binding entirely. */
  writer?: CaptureWriter | null;
}

export interface CaptureInstallation {
  /** False under Jest, and false on a JS bundle running against an APK built before the module
   *  existed — in which case every `record()` is a counted no-op and the app is unaffected. */
  active: boolean;
  run: string;
}

let installed = false;

export function installCapture(input: InstallCaptureInput = {}): CaptureInstallation {
  if (installed) return { active: true, run: currentRunId() };

  const writer = input.writer !== undefined ? input.writer : createNativeCaptureWriter();
  setCaptureWriter(writer);
  if (!writer) return { active: false, run: currentRunId() };
  installed = true;

  record({
    stream: 'lifecycle',
    type: 'boot',
    build: { debug: __DEV__ },
    schemaVersion: input.schemaVersion,
    streamsCompiled: STREAM_NAMES,
    formatVersion: CAPTURE_FORMAT_VERSION,
    bootWallMs: processStartMs(),
    bootMonoMs: writer.monoMs(),
  });

  // First runtime sample of the run, so the app-open records have a heat baseline to be read
  // against. Sampling only — nothing here changes what the app does (amendment §4).
  const sample = sampleThermal();
  record({
    stream: 'runtime',
    type: 'sample',
    msSinceProcessStart: Date.now() - processStartMs(),
    thermalStatus: sample && sample.thermalStatus >= 0 ? sample.thermalStatus : undefined,
    batteryLevel: sample && sample.batteryLevel >= 0 ? sample.batteryLevel : undefined,
    charging: sample?.charging,
  });

  return { active: nativeCaptureAvailable(), run: currentRunId() };
}

/** Tests only. */
export function resetInstallForTests(): void {
  installed = false;
}
