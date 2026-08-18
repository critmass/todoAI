// Task 14 — barrel for the backup / restore / corruption-recovery layer (spec §8.4).
//
// `./opSqliteOperations` is deliberately NOT re-exported here: it imports the native module, which
// throws at import time outside a real RN runtime. The app's wiring imports it directly; everything
// else injects a `DbOperations` double.

export {
  chooseSlot,
  createBackup,
  listBackupCandidates,
  IN_FLIGHT_MARKER,
  type BackupCandidate,
  type BackupDeps,
  type BackupResult,
} from './backup';
export {
  validateConsistency,
  findBackEdge,
  type ConsistencyReport,
  type ConsistencyRepair,
} from './consistency';
export {
  ConsentRequiredError,
  DatabaseCorruptError,
  NoSpaceError,
  NoUsableBackupError,
  isDiskFullError,
} from './errors';
export {
  checkIntegrity,
  estimateDatabaseBytes,
  isEmptyDatabase,
  type IntegrityOptions,
  type IntegrityResult,
} from './integrity';
export {
  runRecoveryLadder,
  type LadderDeps,
  type RecoveryAttempt,
  type RecoveryOutcome,
  type RecoveryStatus,
  type RecoveryStep,
} from './ladder';
export {
  clearRuntimeTables,
  freshStart,
  fullReset,
  promoteToWorking,
  restoreFromBackup,
  type FreshStartResult,
  type RestoreDeps,
  type RestoreResult,
} from './restore';
export {
  salvageDatabase,
  RUNTIME_TABLES,
  type SalvageDeps,
  type SalvageReport,
  type SalvagedTable,
} from './salvage';
export { ensurePreSessionBackup, type SessionStartGate } from './sessionGate';
export {
  resolveConfig,
  toSqliteTimestamp,
  DEFAULT_SALVAGE_NAME,
  DEFAULT_SLOT_NAMES,
  type BackupConfig,
  type BackupType,
  type DbFileRef,
  type DbOperations,
  type ManagedDb,
  type ResolvedConfig,
} from './types';
