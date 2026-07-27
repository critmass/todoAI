// Task 13 — typed errors for the episode lifecycle, matching src/db/errors.ts's style.

/** Thrown when an operation needs an open episode and there isn't one. Not an expected branch:
 *  callers that might legitimately have no episode (the launch recovery path, a timer read) get a
 *  nullable return instead. */
export class NoActiveEpisodeError extends Error {
  constructor(operation: string) {
    super(`No active episode for operation: ${operation}`);
    this.name = 'NoActiveEpisodeError';
  }
}

/** Thrown when park is requested before the episode timer has run 60 seconds (task 28 design
 *  §1.3). A bail inside the first minute is a SKIP and must go through the skip path — the two
 *  outcomes are not interchangeable, so this refuses rather than silently downgrading. */
export class ParkGateError extends Error {
  constructor(public readonly workedMs: number) {
    super(
      `Park is not available yet: the episode has run ${workedMs}ms of the required 60000ms. ` +
        'A bail inside the first minute is a skip.',
    );
    this.name = 'ParkGateError';
  }
}

/** Thrown when session runtime state is missing for a session the caller says is running. */
export class NoSessionRuntimeError extends Error {
  constructor(public readonly sessionId: string) {
    super(`No session runtime for session ${sessionId}: startSessionRuntime was never called`);
    this.name = 'NoSessionRuntimeError';
  }
}
