import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  coachingExternalDependencyRowToDomain,
  coachingPriorityQueueRowToDomain,
  coachingQueueDomainToRow,
  coachingQueueRowToDomain,
  coachingSessionRowToDomain,
  coachingTaskRowToDomain,
  type CoachingExternalDependencyLink,
  type CoachingPriorityQueueEntry,
  type CoachingQueueEntry,
  type CoachingQueueWriteInput,
  type CoachingSessionLink,
  type CoachingTaskLink,
} from '../../types/domain';
import type {
  CoachingExternalDependencyRow,
  CoachingPriorityQueueRow,
  CoachingQueueRow,
  CoachingSessionRow,
  CoachingTaskRow,
  CoachingTrigger,
} from '../../types/db';

export type CreateCoachingQueueInput = CoachingQueueWriteInput & { triggerType: CoachingTrigger };

export function createCoachingRepository(db: SqliteConnection) {
  async function getById(id: number): Promise<CoachingQueueEntry | undefined> {
    const result = await db.execute('SELECT * FROM coaching_queue WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as CoachingQueueRow | undefined;
    return row ? coachingQueueRowToDomain(row) : undefined;
  }

  async function create(input: CreateCoachingQueueInput): Promise<CoachingQueueEntry> {
    const row = coachingQueueDomainToRow(input);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] as never);

    const result = await db.execute(
      `INSERT INTO coaching_queue (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('coachingRepository.create: insert did not return an id');
    }
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('coaching_queue entry', id);
    }
    return created;
  }

  async function update(id: number, patch: CoachingQueueWriteInput): Promise<CoachingQueueEntry> {
    const row = coachingQueueDomainToRow(patch);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    if (columns.length > 0) {
      const setClause = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => row[column] as never);
      await db.execute(`UPDATE coaching_queue SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('coaching_queue entry', id);
    }
    return updated;
  }

  /** From the coaching_priority_queue view: pending entries, urgency-first then oldest-first,
   *  each with its linked task/session/external-dependency ids. */
  async function priorityQueue(): Promise<CoachingPriorityQueueEntry[]> {
    const result = await db.execute('SELECT * FROM coaching_priority_queue');
    return (result.rows as unknown as CoachingPriorityQueueRow[]).map(
      coachingPriorityQueueRowToDomain,
    );
  }

  async function linkTask(coachingId: number, taskId: number): Promise<CoachingTaskLink> {
    const result = await db.execute(
      'INSERT INTO coaching_tasks (coaching_id, task_id) VALUES (?, ?)',
      [coachingId, taskId],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('coachingRepository.linkTask: insert did not return an id');
    }
    const linkResult = await db.execute('SELECT * FROM coaching_tasks WHERE id = ?', [id]);
    return coachingTaskRowToDomain(linkResult.rows[0] as unknown as CoachingTaskRow);
  }

  async function linkSession(coachingId: number, sessionId: string): Promise<CoachingSessionLink> {
    const result = await db.execute(
      'INSERT INTO coaching_sessions (coaching_id, session_id) VALUES (?, ?)',
      [coachingId, sessionId],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('coachingRepository.linkSession: insert did not return an id');
    }
    const linkResult = await db.execute('SELECT * FROM coaching_sessions WHERE id = ?', [id]);
    return coachingSessionRowToDomain(linkResult.rows[0] as unknown as CoachingSessionRow);
  }

  async function linkExternalDependency(
    coachingId: number,
    externalDependencyId: number,
  ): Promise<CoachingExternalDependencyLink> {
    const result = await db.execute(
      'INSERT INTO coaching_external_dependencies (coaching_id, external_dependency_id) VALUES (?, ?)',
      [coachingId, externalDependencyId],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('coachingRepository.linkExternalDependency: insert did not return an id');
    }
    const linkResult = await db.execute(
      'SELECT * FROM coaching_external_dependencies WHERE id = ?',
      [id],
    );
    return coachingExternalDependencyRowToDomain(
      linkResult.rows[0] as unknown as CoachingExternalDependencyRow,
    );
  }

  return { getById, create, update, priorityQueue, linkTask, linkSession, linkExternalDependency };
}

export type CoachingRepository = ReturnType<typeof createCoachingRepository>;
