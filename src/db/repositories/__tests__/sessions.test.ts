import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createSessionsRepository, type SessionsRepository } from '../sessions';

describe('sessionsRepository', () => {
  let conn: TestSqliteConnection;
  let repo: SessionsRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createSessionsRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update -> getById round-trips (caller-supplied id)', async () => {
    const created = await repo.create('session-abc', {
      sessionType: 'moderate',
      plannedDuration: 45,
      status: 'completed',
      userEnergyStart: 3,
      modelTier: '4B',
    });

    expect(created.id).toBe('session-abc');
    expect(created.sessionType).toBe('moderate');
    expect(created.status).toBe('completed');
    expect(created.escapeValveUsed).toBe(false); // BOOLEAN default false, round-tripped
    expect(created.tasksCompleted).toBe(0);

    const fetched = await repo.getById('session-abc');
    expect(fetched).toEqual(created);

    const updated = await repo.update('session-abc', {
      actualDuration: 50,
      tasksCompleted: 3,
      escapeValveUsed: true,
    });
    expect(updated.actualDuration).toBe(50);
    expect(updated.tasksCompleted).toBe(3);
    expect(updated.escapeValveUsed).toBe(true);

    const refetched = await repo.getById('session-abc');
    expect(refetched).toEqual(updated);
  });

  it('recentPerformance aggregates by session_type from the view', async () => {
    await repo.create('s1', { sessionType: 'quick', plannedDuration: 10, status: 'completed', tasksCompleted: 2 });
    await repo.create('s2', { sessionType: 'quick', plannedDuration: 10, status: 'completed', tasksCompleted: 4 });
    await repo.create('s3', { sessionType: 'deep_focus', plannedDuration: 60, status: 'abandoned' });

    const stats = await repo.recentPerformance();
    const quick = stats.find((s) => s.sessionType === 'quick');
    expect(quick?.sessionCount).toBe(2);
    expect(quick?.avgTasksCompleted).toBeCloseTo(3, 5);

    const deepFocus = stats.find((s) => s.sessionType === 'deep_focus');
    expect(deepFocus?.sessionCount).toBe(1);
    expect(deepFocus?.completionRate).toBeCloseTo(0, 5);
  });
});
