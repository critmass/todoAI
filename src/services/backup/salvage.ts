// Task 14 — step 2 of spec §8.4's ladder: salvage what is still readable out of a damaged database.
//
// THE MECHANISM (brief §2): `ATTACH` the damaged file to a FRESH, fully migrated database and copy
// table by table with `INSERT … SELECT`. This is also the answer to "what does salvage read": the
// table list comes from the fresh database's own `sqlite_master`, so views are skipped by
// construction (they are not tables), and each table is copied inside its own try/catch, so a
// corrupt table costs that table and not the run.
//
// FOREIGN KEYS AND THE `ATTACH` INTERACTION (constraint #9, brief §5). Enforcement MUST be off
// while copying: tables arrive one at a time and a damaged source can be missing parents entirely,
// so an enforced copy would reject good child rows for the crime of being copied first. The pragma
// is therefore set OFF on the salvage connection *outside any transaction* — task 26's finding is
// that toggling it inside one is silently a no-op (docs/eval/task26_findings_report.md §2) — the
// copy runs, `validateConsistency` then repairs what enforcement would have prevented, and the
// pragma is restored to ON in a `finally`. Constraint #9 is satisfied by the connection this
// function hands back, not by it never having been relaxed.
//
// TRIGGERS ARE DROPPED FOR THE DURATION AND PUT BACK. `INSERT … SELECT` fires triggers, and the
// destination is a freshly migrated schema, so `prevent_circular_dependencies` would
// `RAISE(ABORT)` on a damaged dependency graph and take the whole `task_dependencies` copy down
// with it. That matters MORE since migration 008 (task 49) widened it from the direct reverse
// pair to a full reachability walk: any cycle in the source, of any length, would now abort the
// copy. Their DDL is read out of `sqlite_master` and replayed verbatim afterwards, so nothing is
// reconstructed by hand — and `validateConsistency` runs after the replay to break whatever
// cycles came across.

import type { SqliteConnection } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { validateConsistency, type ConsistencyReport } from './consistency';
import type { DbFileRef, DbOperations, ManagedDb } from './types';

const ATTACH_ALIAS = 'salvagesrc';

/** Never copied from the source. `schema_metadata` holds the migration version: the destination is
 *  at the CURRENT schema by construction, and copying an older source's row would claim otherwise —
 *  the exact "restored a stale schema and assumed it's current" failure brief §4b warns about. */
const NEVER_COPIED = new Set(['schema_metadata']);

/** Live timer state (migration 005). Salvage KEEPS it by default and restore clears it — see
 *  `restore.ts` for why those two answers differ. */
export const RUNTIME_TABLES = ['active_episode', 'session_runtime', 'session_task_extension'];

export interface SalvageDeps {
  ops: DbOperations;
  /** The damaged database to read. */
  source: DbFileRef;
  /** Where the rebuilt database is written. Must not be the working path — promoting it there is a
   *  separate, explicit step (`promoteToWorking`). */
  destination: DbFileRef;
  /** Drop live timer state from the rebuilt database. Defaults to false: a salvage recovers the
   *  instant the app died, and `active_episode`'s existence is that crash's signal (migration 005). */
  clearRuntimeTables?: boolean;
}

export interface SalvagedTable {
  table: string;
  rowsCopied: number;
  /** Rows the source held but that would not go in — a failed CHECK, an unreadable page. Spec
   *  §8.4's "malformed records skipped with logging". */
  rowsSkipped: number;
  /** True when the bulk copy failed and the row-by-row fallback took over. */
  degraded: boolean;
}

export interface SalvageReport {
  destination: DbFileRef;
  recovered: SalvagedTable[];
  /** Tables present in the current schema that could not be read out of the source at all. */
  lost: Array<{ table: string; error: string }>;
  /** Tables the source simply does not have — an older schema, not damage. */
  absentFromSource: string[];
  consistency: ConsistencyReport;
  /** Convenience for the ladder's accept/reject policy and for telling the user what survived. */
  taskRowsRecovered: number;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function tableNames(db: Pick<SqliteConnection, 'execute'>, schema = 'main'): Promise<string[]> {
  const result = await db.execute(
    `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return result.rows.map((row) => String(row.name));
}

async function columnNames(
  db: Pick<SqliteConnection, 'execute'>,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await db.execute(`PRAGMA ${schema}.table_info(${quote(table)})`);
  return result.rows.map((row) => String(row.name));
}

/** Copies one table, degrading from a single bulk statement to row-at-a-time only if it has to. */
async function copyTable(
  db: Pick<SqliteConnection, 'execute'>,
  table: string,
  columns: string[],
): Promise<SalvagedTable> {
  const columnList = columns.map(quote).join(', ');
  const target = `main.${quote(table)}`;
  const source = `${ATTACH_ALIAS}.${quote(table)}`;

  try {
    const result = await db.execute(
      `INSERT OR REPLACE INTO ${target} (${columnList}) SELECT ${columnList} FROM ${source}`,
    );
    return { table, rowsCopied: result.rowsAffected ?? 0, rowsSkipped: 0, degraded: false };
  } catch {
    // Fall through to the per-row path: one bad page or one CHECK-violating row must not cost the
    // whole table. Rowids are read first because that scan can succeed on an index when a full
    // table scan cannot.
  }

  const rowids = await db.execute(`SELECT rowid AS rid FROM ${source}`);
  let rowsCopied = 0;
  let rowsSkipped = 0;
  for (const entry of rowids.rows) {
    try {
      const row = await db.execute(
        `SELECT ${columnList} FROM ${source} WHERE rowid = ?`,
        [Number(entry.rid)],
      );
      const values = row.rows[0];
      if (!values) {
        rowsSkipped += 1;
        continue;
      }
      const placeholders = columns.map(() => '?').join(', ');
      await db.execute(
        `INSERT OR REPLACE INTO ${target} (${columnList}) VALUES (${placeholders})`,
        columns.map((column) => values[column] ?? null),
      );
      rowsCopied += 1;
    } catch {
      rowsSkipped += 1;
    }
  }
  return { table, rowsCopied, rowsSkipped, degraded: true };
}

/**
 * Restores each AUTOINCREMENT table's high-water mark to the greater of the source's recorded value
 * and what actually got copied. Task 26 §3b found that a rebuild silently RE-USES an id when the
 * source's highest row had been deleted, because the new `sqlite_sequence` entry is derived from
 * MAX(id) of the surviving rows — and a salvage is a rebuild, with the added certainty that rows
 * are missing. AUTOINCREMENT's whole promise is that an id is never reused.
 */
async function restoreSequences(db: Pick<SqliteConnection, 'execute'>): Promise<void> {
  let sourceSequences: Array<{ name: string; seq: number }> = [];
  try {
    const result = await db.execute(`SELECT name, seq FROM ${ATTACH_ALIAS}.sqlite_sequence`);
    sourceSequences = result.rows.map((row) => ({ name: String(row.name), seq: Number(row.seq) }));
  } catch {
    return; // No AUTOINCREMENT table was ever written in the source; nothing to preserve.
  }
  for (const entry of sourceSequences) {
    try {
      const current = await db.execute('SELECT seq FROM main.sqlite_sequence WHERE name = ?', [
        entry.name,
      ]);
      if (current.rows.length === 0) {
        await db.execute('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)', [
          entry.name,
          entry.seq,
        ]);
      } else if (Number(current.rows[0].seq) < entry.seq) {
        await db.execute('UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?', [
          entry.seq,
          entry.name,
        ]);
      }
    } catch {
      // A missing sqlite_sequence row for a table nothing was ever inserted into is not an error.
    }
  }
}

/**
 * Rebuilds as much of `source` as is readable into a fresh database at `destination`.
 *
 * The returned connection is left OPEN and with `PRAGMA foreign_keys = ON` (constraint #9); the
 * caller closes it, or hands it to `promoteToWorking`.
 */
export async function salvageDatabase(
  deps: SalvageDeps,
): Promise<{ report: SalvageReport; db: ManagedDb }> {
  // A fresh destination every time — a leftover from an earlier attempt would be silently merged.
  deps.ops.open(deps.destination).delete();
  const db = deps.ops.open(deps.destination);

  const report: SalvageReport = {
    destination: deps.destination,
    recovered: [],
    lost: [],
    absentFromSource: [],
    consistency: {
      repairs: [],
      danglingDependencies: 0,
      cyclesBroken: 0,
      orphansDeleted: 0,
      orphansNulled: 0,
      skipped: [],
    },
    taskRowsRecovered: 0,
  };

  try {
    return { report: await rebuild(deps, db, report), db };
  } catch (err) {
    // Never leak the destination handle out of a failed salvage - the caller has no reference to
    // close, and on Windows an open handle also makes the scratch file undeletable.
    db.close();
    throw err;
  }
}

async function rebuild(
  deps: SalvageDeps,
  db: ManagedDb,
  report: SalvageReport,
): Promise<SalvageReport> {
  await runMigrations(db);

  // Outside any transaction — see this file's header and task 26 §2.
  await db.execute('PRAGMA foreign_keys = OFF');
  const triggers = await db.execute(
    "SELECT sql FROM main.sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
  );
  const triggerSql = triggers.rows.map((row) => String(row.sql));
  const triggerNames = await db.execute("SELECT name FROM main.sqlite_master WHERE type = 'trigger'");

  try {
    for (const row of triggerNames.rows) {
      await db.execute(`DROP TRIGGER IF EXISTS ${quote(String(row.name))}`);
    }

    const sourceHandle = deps.ops.open(deps.source);
    const sourcePath = sourceHandle.path();
    sourceHandle.close();
    await db.execute(`ATTACH DATABASE ? AS ${ATTACH_ALIAS}`, [sourcePath]);

    try {
      const destinationTables = await tableNames(db, 'main');
      const sourceTables = new Set(await tableNames(db, ATTACH_ALIAS).catch(() => []));
      const skipRuntime = deps.clearRuntimeTables === true;

      for (const table of destinationTables) {
        if (NEVER_COPIED.has(table)) continue;
        if (skipRuntime && RUNTIME_TABLES.includes(table)) continue;
        if (!sourceTables.has(table)) {
          report.absentFromSource.push(table);
          continue;
        }
        try {
          const sourceColumns = new Set(await columnNames(db, ATTACH_ALIAS, table));
          const shared = (await columnNames(db, 'main', table)).filter((column) =>
            sourceColumns.has(column),
          );
          if (shared.length === 0) {
            report.lost.push({ table, error: 'no columns in common with the source' });
            continue;
          }
          report.recovered.push(await copyTable(db, table, shared));
        } catch (err) {
          report.lost.push({ table, error: err instanceof Error ? err.message : String(err) });
        }
      }

      await restoreSequences(db);
    } finally {
      await db.execute(`DETACH DATABASE ${ATTACH_ALIAS}`).catch(() => undefined);
    }

    for (const sql of triggerSql) {
      await db.execute(sql);
    }

    report.consistency = await validateConsistency(db);

    try {
      const tasks = await db.execute('SELECT COUNT(*) AS n FROM tasks');
      report.taskRowsRecovered = Number(tasks.rows[0]?.n ?? 0);
    } catch {
      report.taskRowsRecovered = 0;
    }
  } finally {
    await db.execute('PRAGMA foreign_keys = ON');
  }

  return report;
}
