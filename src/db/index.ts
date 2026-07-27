// Barrel export for the data layer. App startup should call
// `await runMigrations(getConnection())` once before using any repository.
export { getConnection, openConnection, setConnection, type SqliteConnection } from './connection';
export { getCurrentSchemaVersion, runMigrations } from './migrations';
export { CircularDependencyError, NotFoundError, RecurrenceValidationError } from './errors';

export * from './repositories/tasks';
export * from './repositories/recurrence';
export * from './repositories/dependencies';
export * from './repositories/interactions';
export * from './repositories/sessions';
export * from './repositories/coaching';
export * from './repositories/skills';
export * from './repositories/learning';
export * from './repositories/runtime';

import { getConnection } from './connection';
import { createCoachingRepository } from './repositories/coaching';
import { createDependenciesRepository } from './repositories/dependencies';
import { createInteractionsRepository } from './repositories/interactions';
import { createLearningRepository } from './repositories/learning';
import { createRecurrenceRepository } from './repositories/recurrence';
import { createRuntimeRepository } from './repositories/runtime';
import { createSessionsRepository } from './repositories/sessions';
import { createSkillsRepository } from './repositories/skills';
import { createTasksRepository } from './repositories/tasks';

export interface Repositories {
  tasks: ReturnType<typeof createTasksRepository>;
  recurrence: ReturnType<typeof createRecurrenceRepository>;
  dependencies: ReturnType<typeof createDependenciesRepository>;
  interactions: ReturnType<typeof createInteractionsRepository>;
  sessions: ReturnType<typeof createSessionsRepository>;
  coaching: ReturnType<typeof createCoachingRepository>;
  skills: ReturnType<typeof createSkillsRepository>;
  learning: ReturnType<typeof createLearningRepository>;
  runtime: ReturnType<typeof createRuntimeRepository>;
}

let sharedRepositories: Repositories | null = null;

/** Every repository wired to the shared connection, created lazily on first use (so importing
 *  this module never touches the native op-sqlite module by itself - see connection.ts). */
export function getRepositories(): Repositories {
  if (!sharedRepositories) {
    const db = getConnection();
    sharedRepositories = {
      tasks: createTasksRepository(db),
      recurrence: createRecurrenceRepository(db),
      dependencies: createDependenciesRepository(db),
      interactions: createInteractionsRepository(db),
      sessions: createSessionsRepository(db),
      coaching: createCoachingRepository(db),
      skills: createSkillsRepository(db),
      learning: createLearningRepository(db),
      runtime: createRuntimeRepository(db),
    };
  }
  return sharedRepositories;
}
