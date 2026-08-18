// Task 41 — the real writer, over the CaptureLog TurboModule.
//
// This is the ONLY file in `src/capture/` that imports the native spec, which is what lets
// `record.ts` and everything below it run in a bare Node child process for the force-kill test.

import { ANDROID_EXTERNAL_FILES_PATH } from '@op-engineering/op-sqlite';

import NativeCaptureLog from '../specs/NativeCaptureLog';
import { CAPTURE_ROOT_DIR } from './streams';
import { FSYNC_PER_EVENT } from './record';
import type { CaptureWriter } from './writer';

/** True when the APK actually carries the module. False under Jest, and false on a JS bundle
 *  running against a build made before the module existed — in which case capture becomes a
 *  counted no-op (design §1.2's degradation, matching the alarm's precedent). */
export function nativeCaptureAvailable(): boolean {
  return NativeCaptureLog != null;
}

export function createNativeCaptureWriter(): CaptureWriter | null {
  const native = NativeCaptureLog;
  if (!native) return null;
  return {
    append(dir, day, line) {
      native.append(dir, day, line, FSYNC_PER_EVENT);
    },
    monoMs: () => native.elapsedRealtimeMs(),
    sizeOnDisk: () => native.sizeOnDisk(),
    deleteDay: (day) => native.deleteDay(day),
    listDays: () => {
      const csv = native.listDaysCsv();
      return csv === '' ? [] : csv.split(',');
    },
  };
}

/** Where `capture/` lives on device, for the findings report and `scripts/pull-capture.js`.
 *  Null when the module is absent. */
export function captureRootPath(): string | null {
  return NativeCaptureLog ? NativeCaptureLog.rootPath() : null;
}

/**
 * Normalises the native module's free-space answer: **`null` means "cannot tell", and is never
 * conflated with `0`.**
 *
 * Exported so the distinction is pinned by a test rather than trusted. A caller deciding whether to
 * block a session must be able to separate "the disk is full" from "I could not measure it"; the
 * native side signals the latter with -1, and any non-finite or negative value is treated the same
 * way rather than being passed through as a number.
 */
export function normaliseAvailableBytes(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

/**
 * Free bytes on the volume holding `path`, or **`null` when the answer is unknown** — the native
 * module is absent (Jest, or an APK built before this method existed), the path cannot be stat'd, or
 * the call threw.
 *
 * 🔴 ADDED FOR TASK 14 AND CONSUMED BY NOTHING HERE. Ruled by Jason 2026-08-18: task 14's report
 * costed a `StatFs` method and recommended bundling it with this module's rebuild rather than
 * spending a separate device build on it. **Task 41 exposes the number; task 14 wires it.** Nothing
 * in `src/services/backup/` is touched, no threshold or policy is defined here, and capture's own
 * black-swan ceiling warning (./retention.ts) is a different mechanism against a different budget —
 * capture's 512 MB of its own files, not the volume's free space.
 *
 * Pass the location you are about to WRITE to. Task 14 writes backups to
 * `ANDROID_EXTERNAL_FILES_PATH` and salvage to `ANDROID_DATABASE_PATH`, which are not guaranteed to
 * be the same volume — see the spec file for why this is path-scoped.
 */
export function availableBytesFor(path: string): number | null {
  const native = NativeCaptureLog;
  if (!native) return null;
  try {
    return normaliseAvailableBytes(native.availableBytesFor(path));
  } catch {
    return null;
  }
}

/**
 * Design §6 rule 6 asks that the storage root come from op-sqlite's `ANDROID_EXTERNAL_FILES_PATH`
 * "so there is one notion of where the app's storage is" (constraint #10).
 *
 * ⚠ THE IMPLEMENTATION DEVIATES, AND VERIFIES INSTEAD OF ASSERTING. The Kotlin module computes its
 * own root from `Context.getExternalFilesDir(null)` — the same call op-sqlite's constant is derived
 * from — because handing a native file-writer a path string from JS adds a failure mode (a wrong or
 * empty constant becomes a write outside app-private storage) for no benefit. What rule 6 actually
 * protects is that there is ONE directory, so this compares the two and returns the disagreement
 * rather than trusting either. A mismatch is recorded once at boot and is a real finding.
 */
export function rootPathDisagreement(): { native: string; opSqlite: string } | null {
  const native = captureRootPath();
  if (!native) return null;
  const expected = `${ANDROID_EXTERNAL_FILES_PATH}/${CAPTURE_ROOT_DIR}`;
  return native === expected ? null : { native, opSqlite: expected };
}

/**
 * Thermal / battery, sampled from the same module.
 *
 * 🔴 THIS IS A DEVIATION FROM A SETTLED RECORD, AND IT IS JASON'S INSTRUCTION, NOT THE BUILDER'S
 * JUDGMENT. Orientation §8 pins the thermal sampler to task 19 ("assigned to 19 so it can't fall
 * between them"). Jason reassigned it to task 41 on 2026-08-17 — "this falls under logging as far
 * as I'm concerned, so it can go here" — recorded in
 * `docs/design/capture_format_task41_amendment_rulings.md` §4 and in this task's findings report
 * under "Deviations from human decisions".
 *
 * SAMPLING ONLY, NO POLICY. What reads this is (a) the `runtime` stream and (b)
 * `TernaryBonsaiProvider`'s `thermalStatusSampler`, which has stood at `() => 0` since task 6.
 * Nothing here degrades a tier, defers work or gates background activity; those remain task 19's
 * and task 8's, and the tiering ladder itself is RETIRED (orientation §5) because the six-model
 * spike measured that a smaller model throttles at the same twenty minutes.
 */
export interface ThermalSample {
  /** PowerManager 0 NONE … 6 SHUTDOWN, or -1 when unreadable. */
  thermalStatus: number;
  /** 0..1, or -1 when unreadable. */
  batteryLevel: number;
  charging: boolean;
}

export function sampleThermal(): ThermalSample | null {
  const native = NativeCaptureLog;
  if (!native) return null;
  try {
    return {
      thermalStatus: native.thermalStatus(),
      batteryLevel: native.batteryLevel(),
      charging: native.isCharging(),
    };
  } catch {
    return null;
  }
}

/**
 * The sampler shape `TernaryBonsaiProvider` expects: an Android PowerManager thermal status, 0
 * when unknown. Zero rather than a throw, because `currentThermalHeadroom()` maps 0 to 'ok' and a
 * missing sensor must not be read as heat — and because capture must never be able to change what
 * the model path does. It only informs it.
 */
export function thermalStatusSampler(): number {
  const sample = sampleThermal();
  if (!sample || sample.thermalStatus < 0) return 0;
  return sample.thermalStatus;
}
