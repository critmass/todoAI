// Task 14 — typed errors, matching the style of src/db/errors.ts (a named class per condition a
// caller genuinely branches on, never a stringly-typed check at the call site).

/** The device is out of space. Raised where spec §8.4 says a session must be BLOCKED rather than
 *  degraded — the reciprocal of task 41 §5d, where capture drops and counts instead. */
export class NoSpaceError extends Error {
  constructor(readonly operation: string, readonly cause?: unknown) {
    super(`${operation} failed: the device is out of space`);
    this.name = 'NoSpaceError';
  }
}

/** A database file could not be read well enough to be worth continuing with. */
export class DatabaseCorruptError extends Error {
  constructor(readonly path: string, readonly problems: readonly string[]) {
    super(`Database at ${path} failed its integrity check: ${problems.join('; ')}`);
    this.name = 'DatabaseCorruptError';
  }
}

/** Neither backup slot held a database that passed `PRAGMA integrity_check`. */
export class NoUsableBackupError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`No usable backup: ${reasons.join('; ')}`);
    this.name = 'NoUsableBackupError';
  }
}

/** A destructive step of the ladder was called without the explicit consent spec §8.4 requires. */
export class ConsentRequiredError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} destroys data and requires explicit user consent`);
    this.name = 'ConsentRequiredError';
  }
}

/**
 * True when a thrown SQLite error means "no room left".
 *
 * SQLite reports this as `SQLITE_FULL` ("database or disk is full"). op-sqlite surfaces the driver
 * message; better-sqlite3 sets `code = 'SQLITE_FULL'`. ⚠ THIS PREDICATE IS THE HONEST HALF OF THE
 * FREE-SPACE STORY, NOT THE WHOLE OF IT: it fires only AFTER an attempt. Nothing in this tree can
 * report free disk space before one — see the findings report's free-space section, which puts the
 * tradeoff to Jason rather than resolving it here.
 */
export function isDiskFullError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code === 'SQLITE_FULL' || code.startsWith('SQLITE_FULL'))) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /SQLITE_FULL|disk is full|disk or database is full|database or disk is full|ENOSPC|no space left/i.test(
    message,
  );
}
