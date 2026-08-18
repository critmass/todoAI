// Task 14 — spec §8.4's recovery ladder, in the order the spec states it:
//
//   1. PRAGMA integrity_check
//   2. salvage readable data
//   3. restore from the automatic backup
//   4. offer a fresh start with import
//   5. full reset with explicit consent
//
// STEPS 4 AND 5 ARE NOT RUN BY THIS FUNCTION. The spec words step 4 as an OFFER and step 5 as
// requiring explicit consent, and both destroy the user's data. The ladder therefore stops at
// `unrecoverable`, names what it tried, and hands back the two offers; `freshStart` and `fullReset`
// in `restore.ts` are what a user's answer calls. A ladder that wiped a device because it ran out
// of automatic options would be the single worst bug this task could ship.
//
// ⚠ SALVAGE BEFORE RESTORE IS THE SPEC'S ORDER, AND IT HAS A COST WORTH NAMING. Salvage keeps the
// newest data but may recover only part of it; the backup is complete but older. Following the spec
// literally means a salvage that rescues two tables can be preferred over a backup that holds
// everything from an hour ago. `acceptSalvage` is the injected seam where that policy lives, and
// the outcome carries the backup candidates either way so a caller can offer the choice. The
// default is deliberately conservative — see the findings report, which puts the question to Jason
// rather than settling it here.

import { listBackupCandidates, type BackupCandidate } from './backup';
import { checkIntegrity, type IntegrityResult } from './integrity';
import { promoteToWorking, restoreFromBackup, type RestoreDeps, type RestoreResult } from './restore';
import { salvageDatabase, type SalvageReport } from './salvage';
import { validateConsistency, type ConsistencyReport } from './consistency';
import { resolveConfig } from './types';

export type RecoveryStep = 'integrity_check' | 'salvage' | 'restore';

export type RecoveryStatus = 'healthy' | 'salvaged' | 'restored' | 'unrecoverable';

export interface RecoveryAttempt {
  step: RecoveryStep;
  ok: boolean;
  detail: string;
}

export interface RecoveryOutcome {
  status: RecoveryStatus;
  attempts: RecoveryAttempt[];
  integrity: IntegrityResult;
  /** True when the file at the working path is not the one the ladder started with. A caller
   *  holding a cached connection MUST reopen (`setConnection(null)`). */
  workingDbReplaced: boolean;
  salvage?: SalvageReport;
  restore?: RestoreResult;
  consistency?: ConsistencyReport;
  /** Both slots as they were found, so a surface can say what is available and how old it is —
   *  including after a salvage, where restoring instead is still a live option. */
  backups: BackupCandidate[];
  /** Only ever populated on `unrecoverable`. The user chooses; nothing here acts on it. */
  offers: Array<'fresh_start' | 'full_reset'>;
  /** Spec §8.4: partial corruption tells the user what was recovered vs lost; total loss requires
   *  explicit acknowledgement. */
  requiresAcknowledgement: boolean;
}

export interface LadderDeps extends RestoreDeps {
  /** Whether a salvage is good enough to keep. Default: the `tasks` table came back with rows.
   *  Injected because this is product policy, not a database fact. */
  acceptSalvage?: (report: SalvageReport) => boolean;
  /** Run the consistency validator even when the integrity check passes. Off by default — spec
   *  §8.4 calls that sweep PERIODIC, which is a different schedule from launch. */
  validateWhenHealthy?: boolean;
}

function defaultAcceptSalvage(report: SalvageReport): boolean {
  const tasksRecovered = report.recovered.some((entry) => entry.table === 'tasks');
  return tasksRecovered && report.taskRowsRecovered > 0;
}

export async function runRecoveryLadder(deps: LadderDeps): Promise<RecoveryOutcome> {
  const config = resolveConfig(deps.config);
  const attempts: RecoveryAttempt[] = [];
  const accept = deps.acceptSalvage ?? defaultAcceptSalvage;

  // ── 1. integrity_check ──────────────────────────────────────────────────────────────────────
  const working = deps.ops.open(config.working);
  let integrity: IntegrityResult;
  let consistency: ConsistencyReport | undefined;
  try {
    integrity = await checkIntegrity(working);
    if (integrity.ok && deps.validateWhenHealthy) {
      consistency = await validateConsistency(working);
    }
  } finally {
    working.close();
  }
  attempts.push({
    step: 'integrity_check',
    ok: integrity.ok,
    detail: integrity.ok ? 'ok' : integrity.problems.join('; '),
  });

  const backups = await listBackupCandidates(deps.ops, deps.config);

  if (integrity.ok) {
    return {
      status: 'healthy',
      attempts,
      integrity,
      workingDbReplaced: false,
      consistency,
      backups,
      offers: [],
      requiresAcknowledgement: false,
    };
  }

  // ── 2. salvage ──────────────────────────────────────────────────────────────────────────────
  let salvage: SalvageReport | undefined;
  try {
    const result = await salvageDatabase({
      ops: deps.ops,
      source: config.working,
      destination: config.salvage,
    });
    salvage = result.report;
    if (accept(result.report)) {
      await promoteToWorking(deps.ops, result.db, config.working);
      result.db.close();
      deps.ops.open(config.salvage).delete();
      attempts.push({
        step: 'salvage',
        ok: true,
        detail:
          `recovered ${result.report.recovered.length} table(s), ` +
          `${result.report.taskRowsRecovered} task row(s); lost ${result.report.lost.length}`,
      });
      return {
        status: 'salvaged',
        attempts,
        integrity,
        workingDbReplaced: true,
        salvage: result.report,
        consistency: result.report.consistency,
        backups,
        offers: [],
        // Spec §8.4: partial corruption must TELL the user what was recovered and what was lost.
        requiresAcknowledgement: true,
      };
    }
    result.db.close();
    deps.ops.open(config.salvage).delete();
    attempts.push({
      step: 'salvage',
      ok: false,
      detail: `salvage rejected: ${result.report.taskRowsRecovered} task row(s) recovered`,
    });
  } catch (err) {
    attempts.push({
      step: 'salvage',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 3. restore from the automatic backup ────────────────────────────────────────────────────
  try {
    const restore = await restoreFromBackup(deps);
    attempts.push({
      step: 'restore',
      ok: true,
      detail: `restored ${restore.from.slot.name} (${restore.from.createdAt || 'undated'})`,
    });
    return {
      status: 'restored',
      attempts,
      integrity,
      workingDbReplaced: true,
      salvage,
      restore,
      consistency: restore.consistency,
      backups,
      offers: [],
      requiresAcknowledgement: true,
    };
  } catch (err) {
    attempts.push({
      step: 'restore',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 4 and 5 are offers, not actions. Nothing below this line touches a file. ─────────────────
  return {
    status: 'unrecoverable',
    attempts,
    integrity,
    workingDbReplaced: false,
    salvage,
    backups,
    offers: ['fresh_start', 'full_reset'],
    requiresAcknowledgement: true,
  };
}
