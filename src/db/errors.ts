// Typed errors repositories raise instead of letting raw SQLite constraint failures bubble up.

/** task_recurrence's CHECK (recurrence_type = 'count') = (target_count IS NOT NULL) failed. */
export class RecurrenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceValidationError';
  }
}

/** The prevent_circular_dependencies trigger raised 'Circular dependency detected'. */
export class CircularDependencyError extends Error {
  constructor(taskId: number, dependsOnTaskId: number) {
    super(
      `Adding a dependency from task ${taskId} on task ${dependsOnTaskId} would create a circular dependency`,
    );
    this.name = 'CircularDependencyError';
  }
}

/** A repository lookup by id found nothing, where the caller expected a row to exist. */
export class NotFoundError extends Error {
  constructor(entity: string, id: string | number) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}
