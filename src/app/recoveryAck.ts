// Task 14 §13 (surface B, controller half) — turns the recovery ladder's `RecoveryOutcome` (run at
// launch in `appServices.ts`, BEFORE the connection opens) into the plain-language acknowledgement
// the launch screen shows. Pure and side-effect-free: it imports only TYPES from the backup service,
// no repository, no clock, so it is unit-testable and keeps `RecoveryAckScreen` presentational.
//
// Returns null when there is nothing to acknowledge — the healthy launch, which is the common case
// and the reason the screen is skipped almost every time.

import type { RecoveryAckProps } from './screens/contracts';
import type { RecoveryOutcome } from '../services/backup';

/** The screen's props minus its callback — the shell supplies `onAcknowledge` when it renders. */
export type RecoveryAckContent = Omit<RecoveryAckProps, 'onAcknowledge'>;

function pluralTables(n: number): string {
  return `${n} ${n === 1 ? 'table' : 'tables'}`;
}

export function buildRecoveryAck(outcome: RecoveryOutcome): RecoveryAckContent | null {
  // Spec §8.4: partial corruption tells the user what was recovered vs lost; total loss requires an
  // explicit acknowledgement. A healthy launch sets neither flag and shows no screen.
  if (!outcome.requiresAcknowledgement) return null;

  if (outcome.status === 'salvaged') {
    const details: string[] = [];
    const report = outcome.salvage;
    if (report) {
      details.push(`Kept ${report.taskRowsRecovered} of your tasks`);
      details.push(`Rebuilt ${pluralTables(report.recovered.length)} of data`);
      if (report.lost.length > 0) {
        details.push(`Couldn't recover ${pluralTables(report.lost.length)}`);
      }
    }
    return {
      title: 'Recovered your data',
      body:
        'Your data was damaged, so it was rebuilt from everything that could still be read. Most ' +
        'of it should be here, but some of the newest changes may be missing.',
      details,
      grave: false,
    };
  }

  if (outcome.status === 'restored') {
    const details: string[] = [];
    const from = outcome.restore?.from;
    if (from) {
      details.push(from.createdAt ? `Restored a backup from ${from.createdAt}` : 'Restored your most recent backup');
    }
    if (outcome.restore?.migrated) {
      details.push('The backup was updated to the current version');
    }
    return {
      title: 'Restored a backup',
      body:
        "Your data couldn't be opened, so your most recent backup was restored. Anything you " +
        'changed after that backup was taken may be missing.',
      details,
      grave: false,
    };
  }

  // 'unrecoverable' — the working database and both backups were unreadable. Nothing has been
  // deleted; the ladder stops here and the destructive fresh-start / full-reset are the user's
  // call, offered elsewhere. This screen only breaks the news.
  return {
    title: "Couldn't open your data",
    body:
      "Your data and its backups couldn't be read, so this session couldn't recover them. Nothing " +
      'has been deleted. You can start fresh from the app when you are ready.',
    details: [],
    grave: true,
  };
}
