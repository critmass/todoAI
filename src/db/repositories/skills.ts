import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  fireableSkillRowToDomain,
  skillConditionRowToDomain,
  skillDomainToRow,
  skillEvidenceRowToDomain,
  skillRowToDomain,
  type FireableSkill,
  type Skill,
  type SkillCondition,
  type SkillEvidence,
  type SkillWriteInput,
} from '../../types/domain';
import type {
  ConditionOp,
  EvidenceType,
  FireableSkillsRow,
  SkillConditionRow,
  SkillEvidenceRow,
  SkillRow,
} from '../../types/db';

export type CreateSkillInput = SkillWriteInput & { instruction: string };

export function createSkillsRepository(db: SqliteConnection) {
  async function getById(id: number): Promise<Skill | undefined> {
    const result = await db.execute('SELECT * FROM skills WHERE id = ?', [id]);
    const row = result.rows[0] as unknown as SkillRow | undefined;
    return row ? skillRowToDomain(row) : undefined;
  }

  async function create(input: CreateSkillInput): Promise<Skill> {
    const row = skillDomainToRow(input);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] as never);

    const result = await db.execute(
      `INSERT INTO skills (${columns.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('skillsRepository.create: insert did not return an id');
    }
    const created = await getById(id);
    if (!created) {
      throw new NotFoundError('skill', id);
    }
    return created;
  }

  async function update(id: number, patch: SkillWriteInput): Promise<Skill> {
    const row = skillDomainToRow(patch);
    const columns = Object.keys(row) as Array<keyof typeof row>;
    if (columns.length > 0) {
      const setClause = columns.map((column) => `${column} = ?`).join(', ');
      const values = columns.map((column) => row[column] as never);
      await db.execute(`UPDATE skills SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    const updated = await getById(id);
    if (!updated) {
      throw new NotFoundError('skill', id);
    }
    return updated;
  }

  async function addCondition(
    skillId: number,
    conditionKey: string,
    conditionOp: ConditionOp,
    conditionValue: string,
  ): Promise<SkillCondition> {
    const result = await db.execute(
      'INSERT INTO skill_conditions (skill_id, condition_key, condition_op, condition_value) VALUES (?, ?, ?, ?)',
      [skillId, conditionKey, conditionOp, conditionValue],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('skillsRepository.addCondition: insert did not return an id');
    }
    const conditionResult = await db.execute('SELECT * FROM skill_conditions WHERE id = ?', [id]);
    return skillConditionRowToDomain(conditionResult.rows[0] as unknown as SkillConditionRow);
  }

  /** Unambiguous condition read for a skill - see FireableSkill's doc comment on why the
   *  fireable_skills view's GROUP_CONCAT'd conditions column is lossy. */
  async function listConditions(skillId: number): Promise<SkillCondition[]> {
    const result = await db.execute('SELECT * FROM skill_conditions WHERE skill_id = ?', [skillId]);
    return (result.rows as unknown as SkillConditionRow[]).map(skillConditionRowToDomain);
  }

  async function addEvidence(
    skillId: number,
    evidenceType: EvidenceType,
    interactionId?: number,
  ): Promise<SkillEvidence> {
    const result = await db.execute(
      'INSERT INTO skill_evidence (skill_id, evidence_type, interaction_id) VALUES (?, ?, ?)',
      [skillId, evidenceType, interactionId ?? null],
    );
    const id = result.insertId;
    if (id == null) {
      throw new Error('skillsRepository.addEvidence: insert did not return an id');
    }
    const evidenceResult = await db.execute('SELECT * FROM skill_evidence WHERE id = ?', [id]);
    return skillEvidenceRowToDomain(evidenceResult.rows[0] as unknown as SkillEvidenceRow);
  }

  async function listEvidence(skillId: number): Promise<SkillEvidence[]> {
    const result = await db.execute('SELECT * FROM skill_evidence WHERE skill_id = ?', [skillId]);
    return (result.rows as unknown as SkillEvidenceRow[]).map(skillEvidenceRowToDomain);
  }

  /** From the fireable_skills view: active skills (is_active = TRUE), any scope. */
  async function fireable(): Promise<FireableSkill[]> {
    const result = await db.execute('SELECT * FROM fireable_skills');
    return (result.rows as unknown as FireableSkillsRow[]).map(fireableSkillRowToDomain);
  }

  return {
    getById,
    create,
    update,
    addCondition,
    listConditions,
    addEvidence,
    listEvidence,
    fireable,
  };
}

export type SkillsRepository = ReturnType<typeof createSkillsRepository>;
