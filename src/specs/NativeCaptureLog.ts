// Task 41 — the codegen spec for the capture log (design §1, ruled 12.1 by Jason 2026-08-17:
// option (a), a new app-owned TurboModule with a SYNCHRONOUS append).
//
// WHY THIS IS NATIVE AT ALL. There is no way to write a file from JS in this tree: package.json
// has no filesystem library, React Native core has no file-write API, and `op-sqlite` exposes path
// constants and a DB-asset mover but no general write. So capture needed either a new dependency
// or a new module before a single byte could be appended.
//
// WHY NOT `react-native-fs`. Its `appendFile` returns a Promise and performs its write(2) on a
// native background executor. The window between the JS call returning and the bytes reaching the
// kernel is sub-millisecond — and the events that live in it are the ones immediately preceding a
// crash, which are the single most valuable capture this facility will ever take (constraint #3:
// llama.cpp can kill this process with no JS error and no tombstone). Brief §5b is "lossless means
// synchronous at the event" and brief §8's acceptance test is a force-kill that loses nothing;
// only a blocking append satisfies both.
//
// WHAT SYNCHRONOUS BUYS, PRECISELY. When `append` returns, the bytes are in the KERNEL PAGE CACHE,
// which is owned by the kernel and not by the process. `am force-stop`, `kill -9` and a native
// SIGSEGV all destroy the process without touching it. THE DURABILITY BOUNDARY IS PROCESS DEATH,
// NOT POWER LOSS — and process death is what the acceptance test tests. `fsync` (the `sync`
// argument below) is the separate, more expensive guarantee against power loss and kernel panic.
//
// PRECEDENT: `NativeEpisodeAlarm.ts` already declares a synchronous `canScheduleExactAlarms()`,
// codegen'd and working on the S23 FE. Sync TurboModule methods are proven here, not hoped for.

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Appends one complete line to `<external files>/capture/<dir>/<day>.ndjson`, creating the
   * directory and the file if needed. BLOCKS until write(2) has returned.
   *
   * `sync` requests an `fsync` on the same call — per event for alpha, ruled 2026-08-17, with a
   * pinned revert to boundary-only at closed beta (task 42). Separated as an argument rather than
   * baked in precisely so that revert is a one-line change on the JS side.
   *
   * Returns true if the bytes were written. False (rather than throwing) is not used: a failure
   * throws, and `record()` counts it — see design §7.2's `dropped` mechanism.
   */
  append(dir: string, day: string, line: string, sync: boolean): boolean;

  /**
   * `SystemClock.elapsedRealtime()`. NOT `uptimeMillis()` and NOT `performance.now()`:
   * elapsedRealtime counts across deep sleep — which is this app's entire hard problem — and is
   * stable across process restarts within a boot, so it orders a pre-crash run against the
   * post-crash relaunch (design §3.4).
   */
  elapsedRealtimeMs(): number;

  /** Total bytes under `capture/`. Cheap at a background transition, far too expensive per
   *  append — the ceiling is checked at the `lifecycle.capture` write, never on the hot path. */
  sizeOnDisk(): number;

  /**
   * Day partitions present, ascending, comma-separated (`2026-08-17,2026-08-18`); empty string
   * when there are none.
   *
   * A CSV string rather than an array, deliberately: TurboModule codegen's array return type for a
   * SYNCHRONOUS Kotlin method is the one signature in this spec I could not verify against an
   * existing working example in this repo, and `README_build.md` / task 24 §9.6's `.cxx` trap
   * means the cost of guessing wrong is a device session. Every other method here returns a
   * primitive whose Kotlin mapping the alarm module already demonstrates. Split on the JS side.
   */
  listDaysCsv(): string;

  /** Deletes one whole day across every stream. Rotation deletes days, never parts of a file
   *  (design §6 rule 4). Returns the number of files removed. */
  deleteDay(day: string): number;

  /**
   * `PowerManager.getCurrentThermalStatus()` — 0 NONE … 6 SHUTDOWN. -1 when the API is
   * unavailable (below API 29).
   *
   * 🔴 SAMPLING ONLY, NO POLICY. Ruled by Jason 2026-08-17 (amendment §4) as a deviation from
   * orientation §8, which pins the thermal sampler to task 19: "this falls under logging as far as
   * I'm concerned, so it can go here". Tier degradation, deferral logic and background-work gating
   * remain task 19's and task 8's. Building any of them here would be a second deviation nobody
   * has ruled on.
   */
  thermalStatus(): number;

  /** Battery level as 0..1, or -1 if unreadable. */
  batteryLevel(): number;

  /** Whether the device is on a charger. */
  isCharging(): boolean;

  /** The absolute path of `capture/`, for the findings report and `scripts/pull-capture.js`. */
  rootPath(): string;
}

// `get`, not `getEnforcing`, mirroring the alarm module's precedent: under Jest, or on a JS bundle
// running against an APK built before this module existed, capture must become a counted no-op —
// never a launch crash. A logger that can stop the app from starting is worse than no logger.
export default TurboModuleRegistry.get<Spec>('CaptureLog');
