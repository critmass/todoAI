// Task 24 — the codegen spec for the episode expiry alarm (constraint #13).
//
// WHY THIS IS NATIVE AT ALL. Task 13's Phase B established, twice on the S23 FE, that a JS
// `setTimeout` scheduled for the block end does NOT fire at that instant while the app is
// backgrounded or dozing — Android suspends the JS thread and the timer simply waits for the
// foreground, arriving 38 s and 45 s late (task 13 findings §9.4). The timer ENGINE is unaffected
// because it is timestamp-based, but spec §6.2's "the app takes focus like an alarm" cannot be
// built out of a timer that only fires once you are already looking at the app.
//
// So the alarm is `AlarmManager` — the only mechanism on Android that is exempt from Doze and App
// Standby — and the thing it delivers is a full-screen-intent notification.

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Schedules (or re-schedules — one alarm exists at a time) the expiry alarm for `atMs`, an
   * epoch-millisecond wall-clock instant. Called on every open, resume and extension, because
   * every one of those moves the block end.
   */
  schedule(atMs: number, title: string, body: string): void;
  /** Cancels any pending alarm. The episode closed, or the user paused. */
  cancel(): void;
  /**
   * Whether the OS will honour an exact alarm right now. False on API 31/32 without the user's
   * grant; the Settings screen offers `openExactAlarmSettings` in that case. When false the module
   * still schedules, but inexactly — a degraded alarm beats a dropped one.
   */
  canScheduleExactAlarms(): boolean;
  /** Opens the system screen where the exact-alarm permission is granted. */
  openExactAlarmSettings(): void;
}

// `get`, not `getEnforcing`: a JS bundle running against an APK built before this module existed
// (or under Jest) must degrade to no alarm, not to a crash on launch.
export default TurboModuleRegistry.get<Spec>('EpisodeAlarm');
