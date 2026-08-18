// Typed error validators raise instead of letting a raw zod issue list bubble up untranslated.
// Style mirrors src/db/errors.ts.

/** A constrained generation failed zod parsing or a cross-field rule (D10). `surface` is the
 *  schema name (e.g. 'task_extraction.v1'); `issues` are one-line, human-readable failure
 *  reasons - task 6's retry ladder quotes the first one verbatim in its corrective-retry
 *  system-note ("Your previous output failed validation: <first error, one line>"). */
export class LlmOutputValidationError extends Error {
  readonly surface: string;
  readonly issues: string[];
  /**
   * The raw completion text that failed.
   *
   * TASK 41 WIDENED THIS, AND IT IS A PRODUCT FIX RATHER THAN A CAPTURE FIX. `runAttempt`
   * (`provider/ladder.ts`) catches this error, retries, and the malformed generation — brief §1's
   * "single most diagnostic artifact the system produces" — is discarded; `LadderResult.error`
   * then propagates out to `resolveCoaching` and `chatController` completely uninspectable. Task
   * 37's grammar hole (a bare "," passing as a schema-valid title) needed a dedicated six-model
   * spike to find, and with the payload attached it is one log line the first time it fires.
   * Capture is ONE consumer of that, not the reason for it.
   *
   * Optional so that every existing construction site compiles unchanged (amendment §9: task 37
   * may tighten `validateTaskExtraction` in parallel, and it must not be blocked by this).
   */
  readonly payload?: string;

  constructor(surface: string, issues: string[], payload?: string) {
    super(`${surface} output failed validation: ${issues.join('; ')}`);
    this.name = 'LlmOutputValidationError';
    this.surface = surface;
    this.issues = issues;
    this.payload = payload;
  }

  /** A copy carrying the raw text. `runAttempt` calls this at the catch, where the raw text is in
   *  scope and the error is not yet — the validators themselves never see the completion string
   *  they were handed a parsed value from. */
  withPayload(raw: string): LlmOutputValidationError {
    const enriched = new LlmOutputValidationError(this.surface, this.issues, raw);
    enriched.stack = this.stack;
    return enriched;
  }
}
