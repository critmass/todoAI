import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  interactionDomainToRow,
  interactionRowToDomain,
  interactionTaskRowToDomain,
  type Interaction,
  type InteractionTaskLink,
  type InteractionWriteInput,
} from '../../types/domain';
import type { InteractionRow, InteractionTaskRow, InteractionType } from '../../types/db';

export type CreateInteractionInput = InteractionWriteInput & { interactionType: InteractionType };

export function createInteractionsRepository(db: SqliteConnection) {
  async function getById(id: number): Promise<Interaction | undefined> {
    const result = await db.execute('SELECT * FROM interactions WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as InteractionRow | undefined;
    return row ? interactionRowToDomain(row) : undefined;
  }

  async function create(input: CreateInteractionInput): Promise<Interaction> {
    const row = interactionDomainToRow(input);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] as never);

    const result = await db.execute(
      `INSERT INTO interactions (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('interactionsRepository.create: insert did not return an id');
    }
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('interaction', id);
    }
    return created;
  }

  async function update(id: number, patch: InteractionWriteInput): Promise<Interaction> {
    const row = interactionDomainToRow(patch);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    if (columns.length > 0) {
      const setClause = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => row[column] as never);
      await db.execute(`UPDATE interactions SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('interaction', id);
    }
    return updated;
  }

  /** Links an interaction to the task it was about, via interaction_tasks. Episode rows (task 13)
   *  need this: `interaction_type='task_completion'` alone does not say WHICH task was completed,
   *  and per-episode history is the sitting-level data the fold deliberately does not keep
   *  (task 28 design §2.1: "future learning that wants sitting-level data reads interactions"). */
  async function linkTask(interactionId: number, taskId: number): Promise<InteractionTaskLink> {
    const result = await db.execute(
      'INSERT INTO interaction_tasks (interaction_id, task_id) VALUES (?, ?)',
      [interactionId, taskId],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('interactionsRepository.linkTask: insert did not return an id');
    }
    const linkResult = await db.execute('SELECT * FROM interaction_tasks WHERE id = ?', [id]);
    return interactionTaskRowToDomain(linkResult.rows[0] as unknown as InteractionTaskRow);
  }

  async function listBySession(sessionId: string): Promise<Interaction[]> {
    const result = await db.execute(
      'SELECT * FROM interactions WHERE session_id = ? ORDER BY timestamp',
      [sessionId],
    );
    return (result.rows as unknown as InteractionRow[]).map(interactionRowToDomain);
  }

  return { getById, create, update, linkTask, listBySession };
}

export type InteractionsRepository = ReturnType<typeof createInteractionsRepository>;
