// Task 14 — spec §8.4's consistency validation: "removes dangling deps, breaks cycles, cleans
// orphans". Runs after a salvage (where foreign keys were necessarily off) and periodically against
// the live database.
//
// WHAT THE SCHEMA DOES AND WHERE THIS STILL CARRIES THE WEIGHT. Migration 001's
// `prevent_circular_dependencies` trigger used to test exactly one shape — an existing row that is
// the direct reverse of the new one — so it caught A→B/B→A and nothing longer, and A→B→C→A landed
// cleanly. Migration 008 (task 49) replaced its WHEN clause with a recursive walk, so a cycle of
// any length is now rejected at INSERT.
//
// ⚠ That does NOT retire the cycle breaker below. The trigger is `BEFORE INSERT`, so it guards new
// writes only: it never re-validates rows already on disk, and salvage necessarily DROPs every
// trigger to copy tables across. So this remains the only thing in the tree that can SEE — and the
// only thing that can repair — a cycle that is already there: rows written before 008 landed, rows
// an UPDATE produced (no trigger fires on UPDATE — recorded in 008's header), and rows a salvage
// carried over from a damaged source.
//
// FOREIGN KEYS: this function does not touch `PRAGMA foreign_keys` (constraint #9 — every
// connection sets it ON and nothing here may quietly drop it). It is safe either way: the orphan
// sweep is driven by `PRAGMA foreign_key_check`, which reports violations regardless of whether
// enforcement is on, and the repairs it issues are ordinary DELETEs and UPDATEs. Salvage calls it
// while enforcement is off as part of its own documented dance, and restores ON afterwards.

import type { SqliteConnection } from '../../db/connection';

export interface ConsistencyRepair {
  kind: 'dangling_dependency' | 'dependency_cycle' | 'orphan_deleted' | 'orphan_nulled';
  table: string;
  detail: string;
}

export interface ConsistencyReport {
  repairs: ConsistencyRepair[];
  danglingDependencies: number;
  cyclesBroken: number;
  orphansDeleted: number;
  orphansNulled: number;
  /** Checks that could not run at all (e.g. the table is unreadable). Logged, never fatal. */
  skipped: Array<{ check: string; error: string }>;
}

type Executor = Pick<SqliteConnection, 'execute'>;

function emptyReport(): ConsistencyReport {
  return {
    repairs: [],
    danglingDependencies: 0,
    cyclesBroken: 0,
    orphansDeleted: 0,
    orphansNulled: 0,
    skipped: [],
  };
}

/** Dependency edges pointing at a task row that no longer exists. FK enforcement makes these
 *  impossible to create, which is exactly why they only ever appear after a salvage — where
 *  enforcement had to be off and a source table may have been unreadable. */
async function removeDanglingDependencies(db: Executor, report: ConsistencyReport): Promise<void> {
  const doomed = await db.execute(
    'SELECT d.id, d.task_id, d.depends_on_task_id FROM task_dependencies d ' +
      'WHERE d.task_id NOT IN (SELECT id FROM tasks) ' +
      'OR d.depends_on_task_id NOT IN (SELECT id FROM tasks)',
  );
  for (const row of doomed.rows) {
    await db.execute('DELETE FROM task_dependencies WHERE id = ?', [Number(row.id)]);
    report.danglingDependencies += 1;
    report.repairs.push({
      kind: 'dangling_dependency',
      table: 'task_dependencies',
      detail: `task ${row.task_id} -> ${row.depends_on_task_id} (missing task row)`,
    });
  }
}

interface Edge {
  id: number;
  from: number;
  to: number;
}

/**
 * Finds one back edge per pass with a depth-first search and deletes it, repeating until the graph
 * is acyclic. Deterministic by construction: nodes and their neighbours are both visited in
 * ascending task id, so the same damaged graph always loses the same edges. The bound is the edge
 * count — every pass removes exactly one edge.
 */
async function breakDependencyCycles(db: Executor, report: ConsistencyReport): Promise<void> {
  for (;;) {
    const result = await db.execute(
      'SELECT id, task_id, depends_on_task_id FROM task_dependencies ORDER BY task_id, depends_on_task_id',
    );
    const edges: Edge[] = result.rows.map((row) => ({
      id: Number(row.id),
      from: Number(row.task_id),
      to: Number(row.depends_on_task_id),
    }));
    const back = findBackEdge(edges);
    if (!back) return;
    await db.execute('DELETE FROM task_dependencies WHERE id = ?', [back.id]);
    report.cyclesBroken += 1;
    report.repairs.push({
      kind: 'dependency_cycle',
      table: 'task_dependencies',
      detail: `broke cycle by removing ${back.from} -> ${back.to}`,
    });
  }
}

/** Exported for its own test: the pure half of the cycle breaker. */
export function findBackEdge(edges: readonly Edge[]): Edge | null {
  const adjacency = new Map<number, Edge[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) list.push(edge);
    else adjacency.set(edge.from, [edge]);
  }
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort((a, b) => a - b);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<number, number>(nodes.map((node) => [node, WHITE]));

  function visit(node: number): Edge | null {
    colour.set(node, GREY);
    for (const edge of adjacency.get(node) ?? []) {
      const state = colour.get(edge.to) ?? WHITE;
      if (state === GREY) return edge; // the edge that closes the cycle
      if (state === WHITE) {
        const found = visit(edge.to);
        if (found) return found;
      }
    }
    colour.set(node, BLACK);
    return null;
  }

  for (const node of nodes) {
    if ((colour.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

interface ForeignKeyDefinition {
  id: number;
  from: string;
  onDelete: string;
}

async function foreignKeyDefinitions(db: Executor, table: string): Promise<ForeignKeyDefinition[]> {
  const result = await db.execute(`PRAGMA foreign_key_list('${table.replace(/'/g, "''")}')`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    from: String(row.from),
    onDelete: String(row.on_delete ?? 'NO ACTION').toUpperCase(),
  }));
}

/**
 * Schema-driven orphan cleanup. `PRAGMA foreign_key_check` names every child row whose parent is
 * missing; `PRAGMA foreign_key_list` says what the schema wanted to happen when that parent went
 * away. A constraint declared `ON DELETE SET NULL` gets its column nulled — that IS the schema's
 * own answer for a missing parent, and this schema uses it exactly where the child outlives the
 * parent: `interactions.session_id` and `skill_evidence.interaction_id` (migration 001, and
 * `interactions` keeps it through migration 003's rebuild). Anything else has its row deleted, matching
 * the CASCADE the schema declares.
 * Deriving the action from the schema instead of a hand-maintained table list means a future
 * migration cannot silently leave this sweep out of date.
 */
async function cleanOrphans(db: Executor, report: ConsistencyReport): Promise<void> {
  // Bounded: each pass repairs at least one row, and a repair can only create new violations by
  // cascading, which strictly reduces the row count.
  for (let pass = 0; pass < 32; pass++) {
    const violations = await db.execute('PRAGMA foreign_key_check');
    if (violations.rows.length === 0) return;

    let repaired = 0;
    for (const row of violations.rows) {
      const table = String(row.table);
      const rowid = row.rowid;
      if (rowid === null || rowid === undefined) continue;
      const definitions = await foreignKeyDefinitions(db, table);
      const definition = definitions.find((entry) => entry.id === Number(row.fkid));
      const quoted = `"${table.replace(/"/g, '""')}"`;
      // One damaged row can appear once per violated constraint, and an earlier repair in this
      // same pass may already have removed it - so a repair only counts if it actually changed
      // something. Otherwise a row with two broken FKs would be reported as two orphans.
      if (definition && definition.onDelete === 'SET NULL') {
        const result = await db.execute(
          `UPDATE ${quoted} SET "${definition.from.replace(/"/g, '""')}" = NULL WHERE rowid = ?`,
          [Number(rowid)],
        );
        if ((result.rowsAffected ?? 0) === 0) continue;
        report.orphansNulled += 1;
        report.repairs.push({
          kind: 'orphan_nulled',
          table,
          detail: `${definition.from} pointed at a missing ${String(row.parent)} row`,
        });
      } else {
        const result = await db.execute(`DELETE FROM ${quoted} WHERE rowid = ?`, [Number(rowid)]);
        if ((result.rowsAffected ?? 0) === 0) continue;
        report.orphansDeleted += 1;
        report.repairs.push({
          kind: 'orphan_deleted',
          table,
          detail: `row referenced a missing ${String(row.parent)} row`,
        });
      }
      repaired += 1;
    }
    if (repaired === 0) return;
  }
}

/**
 * Runs the three sweeps in the order spec §8.4 lists them. Every sweep is individually guarded: a
 * check that cannot run against a damaged database is recorded in `skipped` and the rest still run,
 * because a validator that gives up on the first unreadable table is worthless on exactly the
 * database it exists for.
 */
export async function validateConsistency(db: Executor): Promise<ConsistencyReport> {
  const report = emptyReport();
  const sweeps: Array<[string, () => Promise<void>]> = [
    ['dangling_dependencies', () => removeDanglingDependencies(db, report)],
    ['dependency_cycles', () => breakDependencyCycles(db, report)],
    ['orphans', () => cleanOrphans(db, report)],
  ];
  for (const [name, sweep] of sweeps) {
    try {
      await sweep();
    } catch (err) {
      report.skipped.push({ check: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
