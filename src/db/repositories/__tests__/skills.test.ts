import { createTestConnection, type TestSqliteConnection } from '../../testUtils/sqliteTestConnection';
import { runMigrations } from '../../migrations';
import { createSkillsRepository, type SkillsRepository } from '../skills';

describe('skillsRepository', () => {
  let conn: TestSqliteConnection;
  let repo: SkillsRepository;

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    repo = createSkillsRepository(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('create -> getById -> update round-trips, defaulting scope/confidence/isActive', async () => {
    const created = await repo.create({
      instruction: 'Suggest a 5-minute warm-up task before deep focus on low-energy mornings',
    });
    expect(created.scope).toBe('both');
    expect(created.confidence).toBe(0);
    expect(created.isActive).toBe(true);
    expect(created.timesFired).toBe(0);

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.update(created.id, { confidence: 0.6, timesCorroborated: 2 });
    expect(updated.confidence).toBe(0.6);
    expect(updated.timesCorroborated).toBe(2);
  });

  it('addCondition / listConditions round-trip unambiguously', async () => {
    const skill = await repo.create({ instruction: 'Only fire on low energy afternoons' });
    await repo.addCondition(skill.id, 'energy', 'eq', 'low');
    await repo.addCondition(skill.id, 'hour', 'gte', '12');

    const conditions = await repo.listConditions(skill.id);
    expect(conditions).toHaveLength(2);
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conditionKey: 'energy', conditionOp: 'eq', conditionValue: 'low' }),
        expect.objectContaining({ conditionKey: 'hour', conditionOp: 'gte', conditionValue: '12' }),
      ]),
    );
  });

  it('addEvidence / listEvidence round-trip, interactionId optional', async () => {
    const skill = await repo.create({ instruction: 'test skill' });
    await repo.addEvidence(skill.id, 'origin');
    const evidence = await repo.listEvidence(skill.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].evidenceType).toBe('origin');
    expect(evidence[0].interactionId).toBeNull();
  });

  it('fireable() only returns active skills and parses the conditions column', async () => {
    const active = await repo.create({ instruction: 'active one' });
    const inactive = await repo.create({ instruction: 'inactive one', isActive: false });
    await repo.addCondition(active.id, 'energy', 'eq', 'low');

    const fireable = await repo.fireable();
    const ids = fireable.map((s) => s.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);

    const activeFireable = fireable.find((s) => s.id === active.id);
    expect(activeFireable?.conditions).toEqual(['energyeqlow']);
  });
});
