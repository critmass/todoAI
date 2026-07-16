// Task 12 — crisis-path STRUCTURE (spec §7.3). Serious distress is met with a short, reviewed
// care-and-refer path — NOT the small model's improvisation. The structure guarantees that when
// crisis is flagged, the app surfaces a FIXED, human-reviewed message and SHORT-CIRCUITS the
// normal coaching/resolution flow (no model resolution call runs).
//
// Detection is deliberately a pluggable seam, not built here: §7.3 forbids improvising, so
// detection must be a conservative, REVIEWED mechanism (Phase B / human review) — not keyword
// guesses wired in blind, and never the 4B deciding on its own. The default detector returns
// false (never falsely triggers); a reviewed detector is injected when one exists.

import { CRISIS_REFERRAL_TEXT } from '../../llm/prompts/coaching';

export interface CrisisResponse {
  kind: 'crisis';
  /** The fixed, human-reviewed care-and-refer copy (prompts/coaching.ts). Never model-generated. */
  text: string;
  /** Signals the flow to stop here — do not run the coaching model or a resolution call. */
  halt: true;
}

/** The care-and-refer response surfaced on the crisis path. */
export function crisisResponse(): CrisisResponse {
  return { kind: 'crisis', text: CRISIS_REFERRAL_TEXT, halt: true };
}

/** A reviewed crisis detector. Given the user's latest message(s), returns whether the crisis
 *  path should engage. Conservative by contract; the real implementation is a reviewed concern. */
export type CrisisDetector = (userText: string) => boolean;

/** Default detector: never triggers. Replaced by a reviewed detector before crisis routing is
 *  relied on in production (spec §7.3). Keeping it inert headless avoids false positives that
 *  would themselves be harmful. */
export const noCrisisDetected: CrisisDetector = () => false;

/**
 * The gate the coaching flow calls before running the model. If the (reviewed) detector flags
 * crisis, returns the fixed care-and-refer response and the flow halts; otherwise null and the
 * normal coaching turn proceeds.
 */
export function checkCrisis(
  userText: string,
  detector: CrisisDetector = noCrisisDetected,
): CrisisResponse | null {
  return detector(userText) ? crisisResponse() : null;
}
