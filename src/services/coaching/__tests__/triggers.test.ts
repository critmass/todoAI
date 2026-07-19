import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createCoachingRepository } from '../../../db/repositories/coaching';
import { createTasksRepository } from '../../../db/repositories/tasks';
import { enqueueCoachingTrigger, urgencyForTrigger } from '../triggers';

describe('urgencyForTrigger (§7.2 spec-pinned mapping)', () => {
  it('maps the three spec triggers to their urgency tiers', () => {
    expect(urgencyForTrigger('task_skipped')).toBe('next_start');
    expect(urgencyForTrigger('session_recalibration')).toBe('immediate');
    expect(urgencyForTrigger('app_reorientation')).toBe('next_open');
  });

  it('maps R4/R7\'s new triggers (migration 002) to their urgency tiers', () => {
    expect(urgencyForTrigger('buried_task')).toBe('next_open');
    expect(urgencyForTrigger('breakdown_complete')).toBe('immediate');
  });
});

describe('enqueueCoachingTrigger', () => {
  let conn: TestSqliteConnection;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
  });
  afterEach(() => conn.close());

  it('enqueues a skip at next_start and links the related task', async () => {
    const coaching = createCoachingRepository(conn);
    const tasks = createTasksRepository(conn);
    const task = await tasks.create({ title: 'Skipped one', estimatedDuration: 15 });

    const entry = await enqueueCoachingTrigger(coaching, {
      trigger: 'task_skipped',
      relatedTaskIds: [task.id],
      triggerData: { reason: 'too tired' },
    });

    expect(entry.triggerType).toBe('task_skipped');
    expect(entry.urgency).toBe('next_start');
    expect(entry.triggerData).toEqual({ reason: 'too tired' });

    const queue = await coaching.priorityQueue();
    const found = queue.find((q) => q.id === entry.id);
    expect(found?.relatedTaskIds).toEqual([task.id]);
  });

  it('enqueues a 3-skip recalibration at immediate urgency', async () => {
    const coaching = createCoachingRepository(conn);
    const entry = await enqueueCoachingTrigger(coaching, {
      trigger: 'session_recalibration',
      triggerData: { skipCount: 3 },
    });
    expect(entry.urgency).toBe('immediate');
  });

  it('respects an explicit urgency override', async () => {
    const coaching = createCoachingRepository(conn);
    const entry = await enqueueCoachingTrigger(coaching, {
      trigger: 'task_skipped',
      urgency: 'immediate',
    });
    expect(entry.urgency).toBe('immediate');
  });
});
