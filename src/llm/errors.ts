// Typed error validators raise instead of letting a raw zod issue list bubble up untranslated.
// Style mirrors src/db/errors.ts.

/** A constrained generation failed zod parsing or a cross-field rule (D10). `surface` is the
 *  schema name (e.g. 'task_extraction.v1'); `issues` are one-line, human-readable failure
 *  reasons - task 6's retry ladder quotes the first one verbatim in its corrective-retry
 *  system-note ("Your previous output failed validation: <first error, one line>"). */
export class LlmOutputValidationError extends Error {
  readonly surface: string;
  readonly issues: string[];

  constructor(surface: string, issues: string[]) {
    super(`${surface} output failed validation: ${issues.join('; ')}`);
    this.name = 'LlmOutputValidationError';
    this.surface = surface;
    this.issues = issues;
  }
}
