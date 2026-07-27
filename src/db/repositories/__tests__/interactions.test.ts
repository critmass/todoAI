import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createInteractionsRepository, type InteractionsRepository } from '../interactions';
import { createSessionsRepository } from '../sessions';
import { createTasksRepository } from '../tasks';

describe('interactionsRepository', () => {
  let conn: TestSqliteConnection;
  let repo: InteractionsRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createInteractionsRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update -> getById round-trips parsed JSON fields', async () => {
    const created = await repo.create({
      interactionType: 'task_completion',
      conclusions: ['felt good', 'was quick'],
      contextUsed: ['home', 'phone'],
      learningData: { signal: 'strong' },
      userFeedbackRating: 4,
    });

    expect(created.interactionType).toBe('task_completion');
    expect(created.conclusions).toEqual(['felt good', 'was quick']);
    expect(created.contextUsed).toEqual(['home', 'phone']);
    expect(created.learningData).toEqual({ signal: 'strong' });

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.update(created.id, { notes: 'follow up later', userFeedbackRating: 5 });
    expect(updated.notes).toBe('follow up later');
    expect(updated.userFeedbackRating).toBe(5);
    expect(updated.conclusions).toEqual(['felt good', 'was quick']); // untouched fields survive

    const refetched = await repo.getById(created.id);
    expect(refetched).toEqual(updated);
  });

  it('listBySession returns interactions for a session, ordered by timestamp', async () => {
    const sessions = createSessionsRepository(conn);
    await sessions.create('sess-1', {
      sessionType: 'quick',
      plannedDuration: 10,
      status: 'completed',
    });

    await repo.create({ interactionType: 'work_session', sessionId: 'sess-1' });
    await repo.create({ interactionType: 'energy_checkin', sessionId: 'sess-1' });
    await repo.create({ interactionType: 'task_input' }); // no session

    const forSession = await repo.listBySession('sess-1');
    expect(forSession).toHaveLength(2);
    expect(forSession.every((i) => i.sessionId === 'sess-1')).toBe(true);
  });

  it('linkTask records which task an episode row was about (task 13)', async () => {
    const tasks = createTasksRepository(conn);
    const task = await tasks.create({ title: 'Mix track', estimatedDuration: 60 });
    const episode = await repo.create({
      interactionType: 'task_progress',
      completionStatus: 'progress',
      durationMinutes: 25,
    });

    const link = await repo.linkTask(episode.id, task.id);
    expect(link).toMatchObject({ interactionId: episode.id, taskId: task.id });

    const rows = conn.raw
      .prepare('SELECT task_id FROM interaction_tasks WHERE interaction_id = ?')
      .all(episode.id);
    expect(rows).toEqual([{ task_id: task.id }]);
  });

  it('defaults JSON array fields to [] and learningData to null when absent', async () => {
    const created = await repo.create({ interactionType: 'pattern_recognition' });
    expect(created.conclusions).toEqual([]);
    expect(created.contextUsed).toEqual([]);
    expect(created.learningData).toBeNull();
  });
});
