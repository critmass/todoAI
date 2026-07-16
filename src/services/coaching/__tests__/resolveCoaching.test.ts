import {
  createTestConnection,
  type TestSqliteConnection,
} from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createTasksRepository, type TasksRepository } from '../../../db/repositories/tasks';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { MockLLMProvider } from '../../../llm/provider/mockProvider';
import { runCoachingResolution } from '../resolveCoaching';
import type { ResolutionDispatchDeps } from '../dispatch';

const TODAY = '2026-07-15';
const GRAMMAR = 'root ::= "x"'; // the mock ignores it; grammar building is D7's concern elsewhere

describe('runCoachingResolution (D10 ladder → dispatch)', () => {
  let conn: TestSqliteConnection;
  let tasks: TasksRepository;
  let deps: ResolutionDispatchDeps;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    deps = { tasks, dependencies: createDependenciesRepository(conn) };
  });
  afterEach(() => conn.close());

  it('dispatches a valid resolution (valid@1) and applies the effect', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const provider = new MockLLMProvider({
      responses: [JSON.stringify({ action: 'eliminate_task', task_id: t.id, reason: 'done with it' })],
    });

    const result = await runCoachingResolution({
      provider,
      messages: [{ role: 'user', content: "let's drop this" }],
      grammar: GRAMMAR,
      dispatch: deps,
      ctx: { todayISO: TODAY },
    });

    expect(result.status).toBe('dispatched');
    if (result.status === 'dispatched') {
      expect(result.attempts).toBe(1);
      expect(result.outcome.action).toBe('eliminate_task');
    }
    expect((await tasks.getById(t.id))?.status).toBe('deleted');
  });

  it('retries an invalid union then dispatches (attempts 2)', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const provider = new MockLLMProvider({
      responses: [
        '{"action":"not_a_real_action"}', // fails validateCoachingResolution
        JSON.stringify({ action: 'no_change', reason: 'actually fine' }),
      ],
    });

    const result = await runCoachingResolution({
      provider,
      messages: [{ role: 'user', content: 'hmm' }],
      grammar: GRAMMAR,
      dispatch: deps,
      ctx: { todayISO: TODAY },
    });

    expect(result.status).toBe('dispatched');
    if (result.status === 'dispatched') {
      expect(result.attempts).toBe(2);
      expect(result.outcome).toEqual({ action: 'no_change', reason: 'actually fine' });
    }
    // The active task is untouched by a no_change.
    expect((await tasks.getById(t.id))?.status).toBe('active');
  });

  it('falls back after two invalid unions and applies NOTHING', async () => {
    const t = await tasks.create({ title: 'T', estimatedDuration: 30 });
    const provider = new MockLLMProvider({
      responses: ['garbage', '{"action":"still_bad"}'],
    });

    const result = await runCoachingResolution({
      provider,
      messages: [{ role: 'user', content: 'x' }],
      grammar: GRAMMAR,
      dispatch: deps,
      ctx: { todayISO: TODAY },
    });

    expect(result.status).toBe('fallback');
    // No disposition applied on fallback — the task is unchanged.
    expect((await tasks.getById(t.id))?.status).toBe('active');
    expect(provider.calls).toHaveLength(2); // exactly one retry, no loop
  });
});
