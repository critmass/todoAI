import type { Scalar } from '@op-engineering/op-sqlite';
import type { SqliteConnection } from '../connection';
import { NotFoundError } from '../errors';
import {
  algorithmWeightDomainToRow,
  algorithmWeightRowToDomain,
  contextEffectivenessDomainToRow,
  contextEffectivenessRowToDomain,
  energyPatternDomainToRow,
  energyPatternRowToDomain,
  type AlgorithmWeight,
  type AlgorithmWeightWriteInput,
  type ContextEffectiveness,
  type ContextEffectivenessWriteInput,
  type EnergyPattern,
  type EnergyPatternWriteInput,
} from '../../types/domain';
import type {
  AlgorithmFactorName,
  AlgorithmWeightRow,
  ContextEffectivenessRow,
  EnergyPatternRow,
  PatternType,
} from '../../types/db';

export type CreateEnergyPatternInput = EnergyPatternWriteInput & {
  patternType: PatternType;
  patternKey: string;
};
export type CreateContextEffectivenessInput = ContextEffectivenessWriteInput & {
  contextName: string;
};

function buildInsert(
  table: string,
  row: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    values: columns.map((column) => row[column]),
  };
}

function buildUpdate(
  table: string,
  row: Record<string, unknown>,
  whereColumn: string,
): { sql: string; values: unknown[] } | null {
  const columns = Object.keys(row);
  if (columns.length === 0) return null;
  const setClause = columns.map((column) => `${column} = ?`).join(', ');
  return {
    sql: `UPDATE ${table} SET ${setClause} WHERE ${whereColumn} = ?`,
    values: columns.map((column) => row[column]),
  };
}

/** algorithm_weights, energy_patterns, context_effectiveness - the numeric-learning tables
 *  (spec §5.4). This DAO exposes typed CRUD only; the learning loops themselves (hierarchical
 *  shrinkage, cold-start replacement, conservative/regression-protected adaptation) are a later,
 *  service-layer task - explicitly out of scope here. */
export function createLearningRepository(db: SqliteConnection) {
  async function getAlgorithmWeightByFactor(
    factorName: AlgorithmFactorName,
  ): Promise<AlgorithmWeight | undefined> {
    const result = await db.execute('SELECT * FROM algorithm_weights WHERE factor_name = ?', [
      factorName,
    ]);
    const row = result.rows[0] as unknown as AlgorithmWeightRow | undefined;
    return row ? algorithmWeightRowToDomain(row) : undefined;
  }

  async function listAlgorithmWeights(): Promise<AlgorithmWeight[]> {
    const result = await db.execute('SELECT * FROM algorithm_weights');
    return (result.rows as unknown as AlgorithmWeightRow[]).map(algorithmWeightRowToDomain);
  }

  async function updateAlgorithmWeight(
    factorName: AlgorithmFactorName,
    patch: AlgorithmWeightWriteInput,
  ): Promise<AlgorithmWeight> {
    const update = buildUpdate(
      'algorithm_weights',
      algorithmWeightDomainToRow(patch) as Record<string, unknown>,
      'factor_name',
    );
    if (update) {
      await db.execute(update.sql, [...update.values, factorName] as Scalar[]);
    }
    const updated = await getAlgorithmWeightByFactor(factorName);
    if (!updated) {
      throw new NotFoundError('algorithm_weights factor', factorName);
    }
    return updated;
  }

  async function getEnergyPattern(
    patternType: PatternType,
    patternKey: string,
  ): Promise<EnergyPattern | undefined> {
    const result = await db.execute(
      'SELECT * FROM energy_patterns WHERE pattern_type = ? AND pattern_key = ?',
      [patternType, patternKey],
    );
    const row = result.rows[0] as unknown as EnergyPatternRow | undefined;
    return row ? energyPatternRowToDomain(row) : undefined;
  }

  async function createEnergyPattern(input: CreateEnergyPatternInput): Promise<EnergyPattern> {
    const { sql, values } = buildInsert(
      'energy_patterns',
      energyPatternDomainToRow(input) as Record<string, unknown>,
    );
    await db.execute(sql, values as Scalar[]);
    const created = await getEnergyPattern(input.patternType, input.patternKey);
    if (!created) {
      throw new NotFoundError('energy_patterns', `${input.patternType}:${input.patternKey}`);
    }
    return created;
  }

  async function updateEnergyPattern(
    patternType: PatternType,
    patternKey: string,
    patch: EnergyPatternWriteInput,
  ): Promise<EnergyPattern> {
    const update = buildUpdate(
      'energy_patterns',
      energyPatternDomainToRow(patch) as Record<string, unknown>,
      'pattern_type', // combined with the extra pattern_key predicate below
    );
    if (update) {
      await db.execute(`${update.sql} AND pattern_key = ?`, [
        ...update.values,
        patternType,
        patternKey,
      ] as Scalar[]);
    }
    const updated = await getEnergyPattern(patternType, patternKey);
    if (!updated) {
      throw new NotFoundError('energy_patterns', `${patternType}:${patternKey}`);
    }
    return updated;
  }

  async function getContextEffectiveness(
    contextName: string,
    taskType: string | null,
  ): Promise<ContextEffectiveness | undefined> {
    const result = await db.execute(
      taskType === null
        ? 'SELECT * FROM context_effectiveness WHERE context_name = ? AND task_type IS NULL'
        : 'SELECT * FROM context_effectiveness WHERE context_name = ? AND task_type = ?',
      taskType === null ? [contextName] : [contextName, taskType],
    );
    const row = result.rows[0] as unknown as ContextEffectivenessRow | undefined;
    return row ? contextEffectivenessRowToDomain(row) : undefined;
  }

  async function createContextEffectiveness(
    input: CreateContextEffectivenessInput,
  ): Promise<ContextEffectiveness> {
    const { sql, values } = buildInsert(
      'context_effectiveness',
      contextEffectivenessDomainToRow(input) as Record<string, unknown>,
    );
    await db.execute(sql, values as Scalar[]);
    const created = await getContextEffectiveness(input.contextName, input.taskType ?? null);
    if (!created) {
      throw new NotFoundError('context_effectiveness', input.contextName);
    }
    return created;
  }

  async function updateContextEffectiveness(
    contextName: string,
    taskType: string | null,
    patch: ContextEffectivenessWriteInput,
  ): Promise<ContextEffectiveness> {
    const update = buildUpdate(
      'context_effectiveness',
      contextEffectivenessDomainToRow(patch) as Record<string, unknown>,
      'context_name', // combined with the extra task_type predicate below
    );
    if (update) {
      const whereTaskType = taskType === null ? 'task_type IS NULL' : 'task_type = ?';
      const whereValues = taskType === null ? [] : [taskType];
      await db.execute(`${update.sql} AND ${whereTaskType}`, [
        ...update.values,
        contextName,
        ...whereValues,
      ] as Scalar[]);
    }
    const updated = await getContextEffectiveness(contextName, taskType);
    if (!updated) {
      throw new NotFoundError('context_effectiveness', contextName);
    }
    return updated;
  }

  return {
    getAlgorithmWeightByFactor,
    listAlgorithmWeights,
    updateAlgorithmWeight,
    getEnergyPattern,
    createEnergyPattern,
    updateEnergyPattern,
    getContextEffectiveness,
    createContextEffectiveness,
    updateContextEffectiveness,
  };
}

export type LearningRepository = ReturnType<typeof createLearningRepository>;
