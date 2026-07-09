import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  recentSessionPerformanceRowToDomain,
  sessionDomainToRow,
  sessionRowToDomain,
  type Session,
  type SessionPerformanceStats,
  type SessionWriteInput,
} from '../../types/domain';
import type { RecentSessionPerformanceRow, SessionRow, SessionStatus, SessionType } from '../../types/db';

export type CreateSessionInput = SessionWriteInput & {
  sessionType: SessionType;
  plannedDuration: number;
  status: SessionStatus;
};

export function createSessionsRepository(db: SqliteConnection) {
  async function getById(id: string): Promise<Session | undefined> {
    const result = await db.execute('SELECT * FROM sessions WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as SessionRow | undefined;
    return row ? sessionRowToDomain(row) : undefined;
  }

  async function create(id: string, input: CreateSessionInput): Promise<Session> {
    const row = { id, ...sessionDomainToRow(input) };
    const columns = Object.keys(row) as Array<keyof typeof row>;
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] as never);

    await db.execute(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${placeholders})`, values);
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('session', id);
    }
    return created;
  }

  async function update(id: string, patch: SessionWriteInput): Promise<Session> {
    const row = sessionDomainToRow(patch);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    if (columns.length > 0) {
      const setClause = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => row[column] as never);
      await db.execute(`UPDATE sessions SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('session', id);
    }
    return updated;
  }

  /** From the recent_session_performance view: last-30-days stats grouped by session_type. */
  async function recentPerformance(): Promise<SessionPerformanceStats[]> {
    const result = await db.execute('SELECT * FROM recent_session_performance');
    return (result.rows as unknown as RecentSessionPerformanceRow[]).map(
      recentSessionPerformanceRowToDomain,
    );
  }

  return { getById, create, update, recentPerformance };
}

export type SessionsRepository = ReturnType<typeof createSessionsRepository>;
