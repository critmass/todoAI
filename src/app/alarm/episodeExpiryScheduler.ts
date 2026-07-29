// Task 24 — the JS half of the expiry alarm: task 13's injected `EpisodeExpiryScheduler` seam,
// implemented over the AlarmManager TurboModule.
//
// THERE IS NO `setTimeout` IN THIS FILE AND THERE MUST NEVER BE ONE. Constraint #13 exists because
// task 13's Phase B measured a JS timer arriving 38 s and 45 s late from background and doze: the
// JS thread is suspended, so the callback waits for the foreground it is supposed to summon. Any
// future "just add a JS timer as a backup" is a regression against a finding, not a belt-and-
// braces improvement — the engine already needs no callback at all, because it is timestamp-based.

import { PermissionsAndroid, Platform } from 'react-native';

import type { EpisodeExpiryScheduler } from '../../execution';
import NativeEpisodeAlarm from '../../specs/NativeEpisodeAlarm';

/** Copy the alarm carries. Deliberately task-agnostic: a notification that names the task would
 *  put the user's task list on their lock screen. */
const ALARM_TITLE = "Time's up";
const ALARM_BODY = 'That block just ended — where are you with it?';

export interface AlarmStatus {
  /** The native module is present in this build at all. False under Jest and on a stale APK. */
  available: boolean;
  /** The OS will honour an exact alarm. False ⇒ alarms still fire, but batched by Doze. */
  exact: boolean;
}

export interface EpisodeAlarm extends EpisodeExpiryScheduler {
  status(): AlarmStatus;
  /** Opens the system exact-alarm settings screen (API 31+). No-op elsewhere. */
  openSettings(): void;
}

/**
 * The scheduler the app runs with. Every call is guarded: a JS bundle running against an APK built
 * before this module existed must lose the alarm, not the app — the session is still completely
 * correct without it, because nothing in the engine depends on the alarm having fired.
 */
export function createEpisodeAlarm(): EpisodeAlarm {
  const native = NativeEpisodeAlarm;

  return {
    schedule(atMs: number): void {
      native?.schedule(atMs, ALARM_TITLE, ALARM_BODY);
    },
    cancel(): void {
      native?.cancel();
    },
    status(): AlarmStatus {
      if (!native) return { available: false, exact: false };
      return { available: true, exact: native.canScheduleExactAlarms() };
    },
    openSettings(): void {
      native?.openExactAlarmSettings();
    },
  };
}

/** A scheduler that does nothing, for tests and for any surface that runs without an episode. */
export const noopEpisodeAlarm: EpisodeAlarm = {
  schedule() {},
  cancel() {},
  status: () => ({ available: false, exact: false }),
  openSettings() {},
};

/**
 * Asks for POST_NOTIFICATIONS once (API 33+). Without it the alarm still fires and the app is
 * still correct on return — the timer is arithmetic against a stored end-time — but the user is
 * not interrupted, which is the entire point of the alarm. Called at launch, not mid-session: a
 * permission dialog on top of a running block is exactly the interruption the app exists to avoid.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) return true; // below API 33 — notifications are granted at install
  const already = await PermissionsAndroid.check(permission);
  if (already) return true;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
