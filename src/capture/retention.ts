// Task 41 — retention. Ruled by Jason 2026-08-17 (amendment §5): KEEP EVERYTHING, with the 512 MB
// ceiling and oldest-day-first rotation as the backstop, plus ONE warning surface and NO second
// trigger.
//
// 🔴 THE WARNING IS A BLACK-SWAN NET, NOT A WORKFLOW PROMPT, AND BUILDING IT AS ONE WOULD BE
// BUILDING THE WRONG FEATURE. At the projected ~250 KB/day, 512 MB is roughly FIVE YEARS away, so
// on that projection this never fires. A second trigger on "volume since the last pull" — the one
// that actually would fire — was proposed and RULED AGAINST: Jason dumps logs regularly without
// being told, and "the warning is probably never going to be triggered and is there for
// long-tail/black-swan". Two consequences that constrain the code below:
//
//   • It must be RARE ENOUGH TO BE ALARMING. No progress bars, no percentage nag, nothing that
//     trains the eye to dismiss it. If it appears, something is wrong and the number on it is the
//     finding.
//   • ITS NON-FIRING IS NOT EVIDENCE OF ANYTHING and must never be reported as such. The findings
//     report's volume figure comes from the device measurement, not from the absence of a warning.
//
// Three further constraints, all consequences of decisions already made:
//   1. It lives inside `src/capture/` (this file + ./CaptureCeilingNotice.tsx), rendered by a
//      single line in the shell. Otherwise deleting capture leaves a dangling screen and breaks
//      the removability property (orientation §5).
//   2. It never interrupts mid-episode. App open or session close only — this is an ADHD app and
//      capture is not permitted to compete with focus.
//   3. It is a WARNING, NOT A BLOCK. Task 14 blocks sessions on insufficient space; capture
//      degrades where the product database blocks (design §8.3). CAPTURE IS NEVER A REASON A
//      SESSION CANNOT START.

import { record } from './record';
import { captureHealth } from './record';
import { captureWriter } from './record';

/** Hard ceiling across `capture/` (design §8.2). Also the bound task 14 can reason about when it
 *  treats `capture/` as reclaimable space — capture's own ceiling exists so that capture cannot be
 *  the cause of the no-space condition that blocks task 14. */
export const CAPTURE_CEILING_BYTES = 512 * 1024 * 1024;

/** Where the single warning fires. 80% of the ceiling: far enough below it that there is room to
 *  pull logs off to the laptop, far enough above ordinary use that reaching it means the volume
 *  projection was wrong by orders of magnitude. */
export const CAPTURE_WARN_BYTES = Math.floor(CAPTURE_CEILING_BYTES * 0.8);

export interface CaptureCeilingState {
  bytesOnDisk: number;
  /** Over the warn threshold. The shell shows the notice at the next app open or session close. */
  warn: boolean;
  /** Days deleted by rotation on this check. Whole day directories only — never parts of a file
   *  (design §6 rule 4) — and never the newest, which is what you are debugging. */
  rotatedDays: string[];
}

let pendingWarning: CaptureCeilingState | null = null;

/**
 * The `lifecycle.capture` write: capture's own health, plus the ceiling check.
 *
 * Called at AppState background transitions and at session close — never per append. Design §7.2's
 * second mechanism: `dropped` on the envelope fails in the one case that matters most (no
 * subsequent write succeeds because the disk is full, so the counter dies with the process), and
 * this bounds the unreported window to one background transition. It does not fix that case; it
 * makes it visible, which is the difference between a lossy logger and a silently lossy one.
 */
export function checkCeilingAndReportHealth(): CaptureCeilingState | null {
  const writer = captureWriter();
  if (!writer) return null;

  let bytesOnDisk = 0;
  const rotatedDays: string[] = [];
  try {
    bytesOnDisk = writer.sizeOnDisk();
    if (bytesOnDisk > CAPTURE_CEILING_BYTES) {
      // Oldest first, and never the newest day: rotation is a backstop against a runaway, and the
      // records you most need are the ones you are looking at.
      const days = writer.listDays();
      for (const day of days.slice(0, Math.max(0, days.length - 1))) {
        if (bytesOnDisk <= CAPTURE_CEILING_BYTES) break;
        writer.deleteDay(day);
        rotatedDays.push(day);
        bytesOnDisk = writer.sizeOnDisk();
      }
    }
  } catch {
    // A failed size check must not be able to stop anything. The health record below still goes
    // out with whatever was measured.
  }

  const health = captureHealth();
  const state: CaptureCeilingState = {
    bytesOnDisk,
    warn: bytesOnDisk >= CAPTURE_WARN_BYTES,
    rotatedDays,
  };
  record({
    stream: 'lifecycle',
    type: 'capture',
    droppedTotal: health.droppedTotal,
    lastDropReason: health.lastDropReason ?? undefined,
    bytesOnDisk,
    overCeiling: bytesOnDisk > CAPTURE_CEILING_BYTES,
  });

  if (state.warn) pendingWarning = state;
  return state;
}

/** What the shell reads to decide whether to render the notice. Null in the overwhelmingly normal
 *  case, which is the intended steady state and is NOT evidence that volume is fine. */
export function pendingCeilingWarning(): CaptureCeilingState | null {
  return pendingWarning;
}

/** Dismissal. One acknowledgement clears it until the next check crosses the threshold again —
 *  deliberately not persisted, because a warning this rare should reappear after a restart if the
 *  condition is still true. */
export function dismissCeilingWarning(): void {
  pendingWarning = null;
}
