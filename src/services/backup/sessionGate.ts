// Task 14 — the pre-session gate. Spec §8.4: "copy DB at session start … block session start if
// there's no space to copy."
//
// THE FREE-SPACE PROBLEM, STATED HONESTLY. "Block if there is no space" implies knowing BEFORE the
// attempt, and nothing in this tree — not op-sqlite, not React Native core — can report free disk
// space. What this gate does instead is make the attempt itself the test: the pre-session backup is
// the copy the spec is talking about, so if it cannot be written for want of space, the session is
// blocked, and it is blocked before any session state exists. That is a genuine implementation of
// the rule and NOT a substitute for knowing in advance — it cannot warn at 90% full, cannot say how
// much is needed, and pays the cost of a failed write to find out. The alternatives (a
// `setReservedBytes` guard, or a small native call) are a build-cost decision and are put to Jason
// in the findings report rather than chosen here.
//
// THE RECIPROCAL WITH CAPTURE (brief §4e, task 41 §5d). Capture DEGRADES on a full disk — it drops
// records, counts the drops and warns. The product database BLOCKS — this gate. The two are
// deliberately opposite: a dropped capture record costs a line of diagnostics, while an unbacked-up
// session risks the user's actual data. Task 41's design §8.3 also caps capture at 512 MB so that
// capture can never be the CAUSE of the condition this gate blocks on, and hands `capture/` to task
// 14 as reclaimable space — which is what `reclaimSpace` on `BackupDeps` is for.

import { createBackup, type BackupDeps, type BackupResult } from './backup';
import { NoSpaceError } from './errors';
import { checkIntegrity, type IntegrityResult } from './integrity';

export type SessionStartGate =
  | { allowed: true; backup: BackupResult; quickCheck: IntegrityResult }
  | {
      allowed: false;
      /** 'no_space' → tell the user to free space; 'integrity' → run `runRecoveryLadder` first. */
      reason: 'no_space' | 'integrity';
      detail: string;
      quickCheck: IntegrityResult;
    };

/**
 * Runs the cheap integrity pass and takes the pre-session backup. The session may start only if
 * this returns `allowed: true`.
 *
 * `PRAGMA quick_check` rather than the full check because this runs before every session: it does
 * the same page-level verification and skips the index-content cross-check, so it is fast enough to
 * be unconditional. It is a WEAKER test — a database whose indexes disagree with their tables can
 * pass it — which is why the recovery ladder itself uses the full `integrity_check`.
 */
export async function ensurePreSessionBackup(deps: BackupDeps): Promise<SessionStartGate> {
  const quickCheck = await checkIntegrity(deps.working, { quick: true });
  if (!quickCheck.ok) {
    return {
      allowed: false,
      reason: 'integrity',
      detail: quickCheck.problems.join('; '),
      quickCheck,
    };
  }
  try {
    const backup = await createBackup(deps, 'pre_session');
    return { allowed: true, backup, quickCheck };
  } catch (err) {
    if (err instanceof NoSpaceError) {
      return { allowed: false, reason: 'no_space', detail: err.message, quickCheck };
    }
    throw err;
  }
}
