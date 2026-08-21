// Task 14 §13 (surface B) — the launch-acknowledgement presenter. Pure input→output, so these are
// plain data tests: they pin that a healthy launch shows NOTHING, and that each acted-on outcome
// produces the right headline, tone and the "what was recovered / what was lost" lines spec §8.4
// requires.

import { buildRecoveryAck } from '../recoveryAck';
import type {
  ConsistencyReport,
  RecoveryOutcome,
  RestoreResult,
  SalvageReport,
} from '../../services/backup';

function consistency(): ConsistencyReport {
  return {
    repairs: [],
    danglingDependencies: 0,
    cyclesBroken: 0,
    orphansDeleted: 0,
    orphansNulled: 0,
    skipped: [],
  };
}

function baseOutcome(over: Partial<RecoveryOutcome>): RecoveryOutcome {
  return {
    status: 'healthy',
    attempts: [],
    integrity: { ok: true, problems: [] },
    workingDbReplaced: false,
    backups: [],
    offers: [],
    requiresAcknowledgement: false,
    ...over,
  };
}

function salvageReport(over: Partial<SalvageReport> = {}): SalvageReport {
  return {
    destination: { name: 'todoai.salvage.db' },
    recovered: [
      { table: 'tasks', rowsCopied: 12, rowsSkipped: 0, degraded: false },
      { table: 'sessions', rowsCopied: 4, rowsSkipped: 0, degraded: false },
    ],
    lost: [{ table: 'interactions', error: 'malformed' }],
    absentFromSource: [],
    consistency: consistency(),
    taskRowsRecovered: 12,
    ...over,
  };
}

function restoreResult(over: Partial<RestoreResult> = {}): RestoreResult {
  return {
    from: {
      slot: { name: 'todoai.backup.a.db' },
      path: '/x/todoai.backup.a.db',
      createdAt: '2026-08-20 09:00:00',
      schemaVersion: '011',
      usable: true,
    },
    schemaVersion: '011',
    migrated: false,
    runtimeRowsCleared: 3,
    consistency: consistency(),
    ...over,
  };
}

describe('buildRecoveryAck (task 14 §13, surface B)', () => {
  it('shows nothing for a healthy launch — the common case', () => {
    expect(buildRecoveryAck(baseOutcome({ status: 'healthy' }))).toBeNull();
  });

  it('shows nothing whenever requiresAcknowledgement is false, whatever the status', () => {
    // Defensive: the flag, not the status, is the gate spec §8.4 words.
    expect(
      buildRecoveryAck(baseOutcome({ status: 'salvaged', requiresAcknowledgement: false })),
    ).toBeNull();
  });

  it('tells the user what was kept and what was lost after a salvage (partial corruption)', () => {
    const ack = buildRecoveryAck(
      baseOutcome({
        status: 'salvaged',
        workingDbReplaced: true,
        requiresAcknowledgement: true,
        salvage: salvageReport(),
      }),
    );
    expect(ack).not.toBeNull();
    expect(ack!.grave).toBe(false);
    expect(ack!.title).toMatch(/recovered/i);
    const lines = ack!.details.join(' | ');
    expect(lines).toMatch(/12/); // tasks kept
    expect(lines).toMatch(/2 tables/); // rebuilt count
    expect(lines).toMatch(/1 table/); // one table lost
  });

  it('names the backup a restore came from', () => {
    const ack = buildRecoveryAck(
      baseOutcome({
        status: 'restored',
        workingDbReplaced: true,
        requiresAcknowledgement: true,
        restore: restoreResult({ migrated: true }),
      }),
    );
    expect(ack!.grave).toBe(false);
    expect(ack!.title).toMatch(/restored/i);
    expect(ack!.details.join(' | ')).toMatch(/2026-08-20 09:00:00/);
    expect(ack!.details.join(' | ')).toMatch(/current version/i);
  });

  it('is grave on total loss and offers no false comfort', () => {
    const ack = buildRecoveryAck(
      baseOutcome({
        status: 'unrecoverable',
        requiresAcknowledgement: true,
        offers: ['fresh_start', 'full_reset'],
      }),
    );
    expect(ack!.grave).toBe(true);
    expect(ack!.title).toMatch(/couldn't open/i);
    // Nothing has been deleted is the one reassurance that is actually true here.
    expect(ack!.body).toMatch(/nothing has been deleted/i);
  });
});
