// Task 14 — step 1 of spec §8.4's recovery ladder: `PRAGMA integrity_check`.

import type { SqliteConnection } from '../../db/connection';

export type IntegrityResult =
  | { ok: true; problems: readonly [] }
  /** `problems` carries `integrity_check`'s own rows, or the driver error if the pragma itself
   *  could not run — which is the loudest possible corruption signal and must not be swallowed. */
  | { ok: false; problems: readonly string[] };

export interface IntegrityOptions {
  /** `PRAGMA quick_check` instead — same page-level checks, skips the (expensive) index-content
   *  cross-check. Spec §8.4 wants a check before every session; this is the one that can afford to
   *  run there. Note it is a WEAKER check: it can pass a database whose indexes disagree with their
   *  tables, so the full check is what the recovery ladder itself uses. */
  quick?: boolean;
  /** `integrity_check(N)` stops after N problems. Defaults to 10 — enough to describe the damage,
   *  cheap enough to run on a badly damaged file. */
  maxErrors?: number;
}

export async function checkIntegrity(
  db: Pick<SqliteConnection, 'execute'>,
  options: IntegrityOptions = {},
): Promise<IntegrityResult> {
  const pragma = options.quick ? 'quick_check' : 'integrity_check';
  const limit = options.maxErrors ?? 10;
  try {
    const result = await db.execute(`PRAGMA ${pragma}(${limit})`);
    const messages = result.rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((value) => value.length > 0);
    if (messages.length === 1 && messages[0] === 'ok') {
      return { ok: true, problems: [] };
    }
    // A pragma that returns nothing at all is not a pass. SQLite always says 'ok' when it is happy.
    return { ok: false, problems: messages.length > 0 ? messages : ['integrity_check returned no rows'] };
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }
}

/** True when the file behind this connection is an empty (zero-page) database. op-sqlite's `open()`
 *  CREATES the file if it is absent, so "the backup does not exist" and "the backup is an empty
 *  file we just created by looking at it" are the same observable — and this is how the ladder
 *  tells that apart from a real snapshot. */
export async function isEmptyDatabase(db: Pick<SqliteConnection, 'execute'>): Promise<boolean> {
  try {
    const result = await db.execute('PRAGMA page_count');
    const pages = Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
    return pages === 0;
  } catch {
    return false;
  }
}

/** Best available estimate of the bytes a `VACUUM INTO` of this database will need. It is an
 *  OVER-estimate: the output is defragmented, so it is normally smaller. Recorded in
 *  `backup_log.backup_size_bytes` and labelled as an estimate in the report — nothing in this tree
 *  can stat the resulting file. */
export async function estimateDatabaseBytes(db: Pick<SqliteConnection, 'execute'>): Promise<number> {
  const pageCount = await db.execute('PRAGMA page_count');
  const pageSize = await db.execute('PRAGMA page_size');
  const pages = Number(Object.values(pageCount.rows[0] ?? {})[0] ?? 0);
  const size = Number(Object.values(pageSize.rows[0] ?? {})[0] ?? 0);
  return pages * size;
}
