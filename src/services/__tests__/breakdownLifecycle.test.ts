import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createTasksRepository, type TasksRepository } from '../../db/repositories/tasks';
import {
  createDependenciesRepository,
  type DependenciesRepository,
} from '../../db/repositories/dependencies';
import { createCoachingRepository, type CoachingRepository } from '../../db/repositories/coaching';
import { validate } from '../../llm/breakdown/validator';
import type { ParentContext } from '../../llm/breakdown/mapper';
import { persistBreakdown } from '../breakdown';
import { completeTask } from '../taskCompletion';
import { createRecurrenceRepository } from '../../db/repositories/recurrence';
import {
  fireBreakdownCompleteIfParentUnblocked,
  pendingBreakdownCompleteTaskIds,
  type BreakdownLifecycleDeps,
} from '../breakdownLifecycle';

describe('breakdownLifecycle (task 25 R7 — parent confirmation)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let dependencies: DependenciesRepository;
  let coaching: CoachingRepository;
  let lifecycleDeps: BreakdownLifecycleDeps;

  const parentCtx: ParentContext = { importance: 700, energyRequirement: 3, contextTags: ['home'] };

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    dependencies = createDependenciesRepository(conn);
    coaching = createCoachingRepository(conn);
    lifecycleDeps = { tasks, dependencies, coaching };
  });
  afterEach(() => conn.close());

  const completionDeps = () => ({
    tasks,
    recurrence: createRecurrenceRepository(conn),
  });

  /** Breaks `parentId` into an ordered 2-subtask chain and returns the created subtasks. */
  async function breakInto(parentId: number, ordered = false) {
    const valid = validate({
      parent_task_id: parentId,
      ordered,
      subtasks: [
        { title: 'step one', estimated_duration_minutes: 15, duration_from_user: false },
        { title: 'step two', estimated_duration_minutes: 15, duration_from_user: false },
      ],
    });
    return persistBreakdown({ tasks, dependencies }, valid, parentCtx);
  }

  it('does not fire while the parent is still blocked by an incomplete subtask', async () => {
    const parent = await tasks.create({ title: 'Parent', estimatedDuration: 60 });
    const subs = await breakInto(parent.id);

    // Complete only the first subtask.
    await completeTask(completionDeps(), subs[0].id);
    const result = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[0].id);

    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('parent_still_blocked');
    expect(await coaching.priorityQueue()).toHaveLength(0);
  });

  it('fires an immediate breakdown_complete when the LAST subtask completes', async () => {
    const parent = await tasks.create({ title: 'Parent', estimatedDuration: 60 });
    const subs = await breakInto(parent.id);

    await completeTask(completionDeps(), subs[0].id);
    await completeTask(completionDeps(), subs[1].id);
    const result = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[1].id);

    expect(result.fired).toBe(true);
    if (result.fired) {
      expect(result.parentTaskId).toBe(parent.id);
      expect(result.urgency).toBe('immediate');
      expect(result.precededByRecalibration).toBe(false);
    }
    const queue = await coaching.priorityQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].triggerType).toBe('breakdown_complete');
    expect(queue[0].urgency).toBe('immediate');
    expect(queue[0].relatedTaskIds).toEqual([parent.id]);
    // R7: it does NOT auto-complete the parent — the check-off is the user's.
    expect((await tasks.getById(parent.id))?.status).toBe('active');
  });

  it('is idempotent — a second call for the same parent does not enqueue a duplicate', async () => {
    const parent = await tasks.create({ title: 'Parent', estimatedDuration: 60 });
    const subs = await breakInto(parent.id);
    await completeTask(completionDeps(), subs[0].id);
    await completeTask(completionDeps(), subs[1].id);

    await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[1].id);
    const second = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[1].id);

    expect(second.fired).toBe(false);
    if (!second.fired) expect(second.reason).toBe('already_pending');
    expect(await coaching.priorityQueue()).toHaveLength(1);
  });

  it('no-ops for a task with no parent', async () => {
    const solo = await tasks.create({ title: 'Solo', estimatedDuration: 10 });
    await completeTask(completionDeps(), solo.id);
    const result = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, solo.id);
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe('no_parent');
  });

  it('nested breakdown: queues the second confirmation behind the first, not a second immediate', async () => {
    // A grandparent broken into [parent, other]; the parent is itself broken into two subtasks.
    const grandparent = await tasks.create({ title: 'Grandparent', estimatedDuration: 120 });
    const [parent, other] = await breakInto(grandparent.id);
    const parentSubs = await breakInto(parent.id);

    // Finish the parent's own subtasks → parent unblocks → first (immediate) confirmation.
    await completeTask(completionDeps(), parentSubs[0].id);
    await completeTask(completionDeps(), parentSubs[1].id);
    const first = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, parentSubs[1].id);
    expect(first.fired && first.urgency).toBe('immediate');

    // Now the user confirms the parent done AND the grandparent's other subtask finishes, so the
    // grandparent unblocks while the parent's confirmation is still pending.
    await completeTask(completionDeps(), parent.id);
    await completeTask(completionDeps(), other.id);
    const second = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, other.id);

    expect(second.fired).toBe(true);
    // Queued behind the still-pending first confirmation rather than stacking two immediates.
    if (second.fired) expect(second.urgency).toBe('next_start');
  });

  it('records that a pending session_recalibration takes precedence (recalibration wins)', async () => {
    const parent = await tasks.create({ title: 'Parent', estimatedDuration: 60 });
    const subs = await breakInto(parent.id);
    await completeTask(completionDeps(), subs[0].id);
    await completeTask(completionDeps(), subs[1].id);

    // A 3-skip recalibration is already pending (enqueued earlier in the session). Backdate its
    // created_at a second so the priority-queue ordering is deterministic despite second-precision
    // CURRENT_TIMESTAMP.
    const recal = await coaching.create({ triggerType: 'session_recalibration', urgency: 'immediate' });
    conn.raw
      .prepare("UPDATE coaching_queue SET created_at = datetime('now', '-1 second') WHERE id = ?")
      .run(recal.id);

    const result = await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[1].id);
    expect(result.fired).toBe(true);
    if (result.fired) expect(result.precededByRecalibration).toBe(true);

    // The view realizes the precedence: the older recalibration drains first, then the celebration.
    const queue = await coaching.priorityQueue();
    expect(queue.map((e) => e.triggerType)).toEqual(['session_recalibration', 'breakdown_complete']);
  });

  it('pendingBreakdownCompleteTaskIds surfaces held parents for the U1 filter (R7c)', async () => {
    const parent = await tasks.create({ title: 'Parent', estimatedDuration: 60 });
    const subs = await breakInto(parent.id);
    await completeTask(completionDeps(), subs[0].id);
    await completeTask(completionDeps(), subs[1].id);

    expect(await pendingBreakdownCompleteTaskIds(coaching)).toEqual(new Set());
    await fireBreakdownCompleteIfParentUnblocked(lifecycleDeps, subs[1].id);
    expect(await pendingBreakdownCompleteTaskIds(coaching)).toEqual(new Set([parent.id]));
  });
});
