import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createCoachingRepository, type CoachingRepository } from '../coaching';
import { createTasksRepository } from '../tasks';
import { createSessionsRepository } from '../sessions';

describe('coachingRepository', () => {
  let conn: TestSqliteConnection;
  let repo: CoachingRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createCoachingRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update round-trips, defaulting urgency/status', async () => {
    const created = await repo.create({
      triggerType: 'task_skipped',
      triggerData: { taskId: 1, reason: 'too tired' },
    });
    expect(created.urgency).toBe('next_start');
    expect(created.status).toBe('pending');
    expect(created.triggerData).toEqual({ taskId: 1, reason: 'too tired' });

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    const resolved = await repo.update(created.id, { status: 'resolved' });
    expect(resolved.status).toBe('resolved');
  });

  it('an immediate 3-skip trigger gets immediate urgency', async () => {
    const created = await repo.create({
      triggerType: 'repeated_failures',
      urgency: 'immediate',
    });
    expect(created.urgency).toBe('immediate');
  });

  it('priorityQueue surfaces pending entries urgency-first with linked ids', async () => {
    const tasks = createTasksRepository(conn);
    const sessions = createSessionsRepository(conn);
    const task = await tasks.create({ title: 'X', estimatedDuration: 10 });
    await sessions.create('sess-1', { sessionType: 'quick', plannedDuration: 10, status: 'completed' });

    const nextStart = await repo.create({ triggerType: 'task_skipped', urgency: 'next_start' });
    const immediate = await repo.create({ triggerType: 'repeated_failures', urgency: 'immediate' });
    await repo.create({ triggerType: 'app_reorientation', status: 'resolved' }); // excluded: not pending

    await repo.linkTask(nextStart.id, task.id);
    await repo.linkSession(immediate.id, 'sess-1');

    const queue = await repo.priorityQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].id).toBe(immediate.id); // 'immediate' sorts before 'next_start'
    expect(queue[0].relatedSessionIds).toEqual(['sess-1']);
    expect(queue[1].id).toBe(nextStart.id);
    expect(queue[1].relatedTaskIds).toEqual([task.id]);
  });
});
