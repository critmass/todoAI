import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createLearningRepository, type LearningRepository } from '../learning';

describe('learningRepository', () => {
  let conn: TestSqliteConnection;
  let repo: LearningRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createLearningRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('algorithm_weights are seeded by migration 001 and readable/updatable', async () => {
    const all = await repo.listAlgorithmWeights();
    expect(all).toHaveLength(5);

    const importance = await repo.getAlgorithmWeightByFactor('importance');
    expect(importance?.weightPercentage).toBe(25);

    const updated = await repo.updateAlgorithmWeight('importance', {
      weightPercentage: 30,
      dataPointsCount: 12,
    });
    expect(updated.weightPercentage).toBe(30);
    expect(updated.dataPointsCount).toBe(12);
  });

  it('energy_patterns: create -> get -> update round-trips by (pattern_type, pattern_key)', async () => {
    const created = await repo.createEnergyPattern({
      patternType: 'hourly',
      patternKey: '14',
      averageEnergy: 3.2,
      sampleCount: 5,
    });
    expect(created.patternType).toBe('hourly');
    expect(created.patternKey).toBe('14');
    expect(created.averageEnergy).toBe(3.2);

    const fetched = await repo.getEnergyPattern('hourly', '14');
    expect(fetched).toEqual(created);

    const updated = await repo.updateEnergyPattern('hourly', '14', {
      averageEnergy: 3.5,
      sampleCount: 6,
    });
    expect(updated.averageEnergy).toBe(3.5);
    expect(updated.sampleCount).toBe(6);

    // A different pattern_key must not be touched by the update.
    await repo.createEnergyPattern({ patternType: 'hourly', patternKey: '15', averageEnergy: 4 });
    const other = await repo.getEnergyPattern('hourly', '15');
    expect(other?.averageEnergy).toBe(4);
  });

  it('context_effectiveness: create -> get -> update round-trips, task_type nullable', async () => {
    const created = await repo.createContextEffectiveness({
      contextName: 'home',
      completionRate: 0.8,
    });
    expect(created.taskType).toBeNull();

    const fetched = await repo.getContextEffectiveness('home', null);
    expect(fetched).toEqual(created);

    const updated = await repo.updateContextEffectiveness('home', null, { completionRate: 0.9 });
    expect(updated.completionRate).toBe(0.9);

    const withTaskType = await repo.createContextEffectiveness({
      contextName: 'home',
      taskType: 'chore',
      completionRate: 0.5,
    });
    expect(await repo.getContextEffectiveness('home', 'chore')).toEqual(withTaskType);
    // The null-task_type row for the same context must be unaffected.
    expect((await repo.getContextEffectiveness('home', null))?.completionRate).toBe(0.9);
  });
});
