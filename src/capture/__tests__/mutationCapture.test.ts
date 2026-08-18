// Task 41 — the `mutation` / `mutationtext` split and the `planner` sentinel.
//
// Runs against the real repositories over better-sqlite3, the same way every other repository test
// in this suite does, so the diff is taken over real domain objects rather than a hand-written
// shape that could drift from `Task`.

import { createTestConnection } from '../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../db/migrations';
import { createTasksRepository } from '../../db/repositories/tasks';
import { createRecurrenceRepository } from '../../db/repositories/recurrence';
import { createDependenciesRepository } from '../../db/repositories/dependencies';
import type { Repositories } from '../../db';
import { record, resetCaptureStateForTests, setCaptureWriter } from '../record';
import { captureContext } from '../context';
import { withMutationCapture } from '../streams/mutationCapture';
import type { CaptureWriter } from '../writer';

interface Row {
  stream: string;
  [key: string]: unknown;
}

let rows: Row[];

function collectingWriter(): CaptureWriter {
  return {
    append(_dir, _day, line) {
      rows.push(JSON.parse(line) as Row);
    },
    monoMs: () => 0,
    sizeOnDisk: () => 0,
    deleteDay: () => 0,
    listDays: () => [],
  };
}

async function buildRepos(): Promise<Repositories> {
  const db = createTestConnection();
  await runMigrations(db);
  // Only the three repositories the wrapper touches are real; the rest are never called here.
  return {
    tasks: createTasksRepository(db),
    recurrence: createRecurrenceRepository(db),
    dependencies: createDependenciesRepository(db),
  } as unknown as Repositories;
}

const ofStream = (stream: string) => rows.filter((row) => row.stream === stream);

beforeEach(() => {
  rows = [];
  resetCaptureStateForTests();
  captureContext.reset();
  setCaptureWriter(collectingWriter());
});

describe('withMutationCapture', () => {
  it('attributes every write to the bundle that was wired, not to the call site', async () => {
    const repos = await buildRepos();
    const editor = withMutationCapture(repos, 'user', 'editor');
    await editor.tasks.create({ title: 'Renew passport', estimatedDuration: 20 });

    const mutations = ofStream('mutation');
    expect(mutations.length).toBeGreaterThan(0);
    for (const row of mutations) {
      expect(row.actor).toBe('user');
      expect(row.surface).toBe('editor');
    }
  });

  it('splits free text into mutationtext and leaves a textRef plus lengths behind', async () => {
    const repos = await buildRepos();
    const coach = withMutationCapture(repos, 'coach', 'chat_extraction');
    const task = await coach.tasks.create({ title: 'Call the dentist', estimatedDuration: 10 });
    rows = [];
    await coach.tasks.update(task.id, { title: 'Call the dentist about the crown' });

    const [text] = ofStream('mutationtext');
    const titleMutation = ofStream('mutation').find((row) => row.field === 'title');

    // The structured row carries no prose at all — which is what lets `mutation` survive open beta
    // while `mutationtext` is dropped with the rest of the free text (design §5.5).
    expect(text).toMatchObject({ field: 'title', before: 'Call the dentist' });
    expect(titleMutation).toMatchObject({
      field: 'title',
      before: null,
      after: null,
      beforeLen: 'Call the dentist'.length,
      afterLen: 'Call the dentist about the crown'.length,
      textRef: text.seq,
    });
  });

  it('reads the prior row so `before` is real, without touching src/db', async () => {
    const repos = await buildRepos();
    const wrapped = withMutationCapture(repos, 'system', 'recurrence_sweep');
    const task = await wrapped.tasks.create({ title: 'Water plants', estimatedDuration: 5 });
    rows = [];
    await wrapped.tasks.update(task.id, { estimatedDuration: 15 });

    const duration = ofStream('mutation').find((row) => row.field === 'estimatedDuration');
    expect(duration).toMatchObject({ before: 5, after: 15 });
  });

  it('records nothing for a write that changed nothing', async () => {
    const repos = await buildRepos();
    const wrapped = withMutationCapture(repos, 'user', 'editor');
    const task = await wrapped.tasks.create({ title: 'Stretch', estimatedDuration: 5 });
    rows = [];
    await wrapped.tasks.update(task.id, { estimatedDuration: 5 });
    expect(ofStream('mutation')).toEqual([]);
  });

  it('attributes a bundle wired with NO actor to the planner sentinel', async () => {
    // 🔴 The sentinel's expected count is ZERO. This test exists to pin the mechanism, not to bless
    // the value: reaching `planner` in production means a repository was wired through a bundle
    // that named nobody, and a `planner` row is direct evidence of the unenforced PlanAdjustment
    // contract being violated (amendment §3). Do not "fix" such a row by widening the default.
    const repos = await buildRepos();
    const unattributed = withMutationCapture(repos);
    await unattributed.tasks.create({ title: 'Mystery write', estimatedDuration: 5 });

    for (const row of ofStream('mutation')) {
      expect(row.actor).toBe('planner');
      expect(row.surface).toBe('unattributed');
    }
  });

  it('leaves the repository behaviour completely unchanged', async () => {
    const repos = await buildRepos();
    const wrapped = withMutationCapture(repos, 'user', 'editor');
    const created = await wrapped.tasks.create({ title: 'Same', estimatedDuration: 30 });
    const direct = await repos.tasks.getById(created.id);
    expect(direct).toEqual(created);
  });

  it('cannot break the app when capture itself is failing', async () => {
    setCaptureWriter({
      append() {
        throw new Error('ENOSPC');
      },
      monoMs: () => 0,
      sizeOnDisk: () => 0,
      deleteDay: () => 0,
      listDays: () => [],
    });
    const repos = await buildRepos();
    const wrapped = withMutationCapture(repos, 'user', 'editor');
    const task = await wrapped.tasks.create({ title: 'Still works', estimatedDuration: 5 });
    expect(task.title).toBe('Still works');
  });
});

describe('record() is a statement, never an expression', () => {
  it('returns undefined so no call site can branch on it', () => {
    expect(record({ stream: 'lifecycle', type: 'launch' })).toBeUndefined();
  });
});
