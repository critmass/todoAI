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

/** Inert detector: never triggers. Kept for tests that need the gate open, and as the explicit
 *  "no detection configured" value. NOT the default any more — see DRAFT_CRISIS_DETECTOR. */
export const noCrisisDetected: CrisisDetector = () => false;

/**
 * REVIEW(human, before ship): DRAFT crisis detector — deterministic, phrase-based, English-only.
 * A human must review, extend, and localise this (together with CRISIS_REFERRAL_TEXT) before it is
 * relied on. It is a floor, not a solution.
 *
 * WHY THIS EXISTS AT ALL, and why it is not the model's job (Task 7 Phase B, on-device evidence —
 * docs/eval/task7_phaseB_findings_report.md §9): given "I don't see the point in any of it anymore.
 * I don't really want to be here", the 4B did not recognise distress AT ALL. It reframed it as an
 * app-engagement problem and suggested a 10-minute task. The prompt's safety boundary had no
 * observable effect. So detection is deterministic and app-side, and the model is never asked.
 *
 * WHY IT DELIBERATELY OVER-TRIGGERS: the errors are asymmetric. A false positive shows a
 * care-and-refer message to someone who did not need it — jarring, and worth minimising, but not
 * dangerous. A false negative hands a person in crisis a task suggestion. When in doubt this fires.
 * (This reverses the earlier inline reasoning here that false positives "would themselves be
 * harmful": that holds for keyword guesses wired in blind, which is why nothing was wired before —
 * it does not hold for a reviewed, phrase-based gate whose only effect is to show care and stop.)
 *
 * KNOWN LIMITS (all for the human reviewer): English only; literal phrasing only — it will miss
 * indirect, metaphorical, or coded expressions, which are common; no negation handling ("I would
 * never hurt myself" triggers); no severity grading. Patterns are PHRASES, not bare words, so
 * everyday idioms ("dying to get this done", "this task is killing me") do not fire.
 */
const CRISIS_PATTERNS: readonly RegExp[] = [
  /\bkill(?:ing)?\s+my\s?self\b/,
  /\b(?:end|ending)\s+(?:my\s+life|it\s+all)\b/,
  /\b(?:want|wanna|wants)\s+(?:to\s+)?(?:be\s+)?(?:dead|die)\b/,
  /\bwish(?:ed|es)?\s+(?:i\s+(?:was|were)\s+)?(?:dead|gone)\b/,
  /\bdon'?t\s+(?:\w+\s+){0,2}want\s+to\s+(?:be\s+here|live|exist|wake\s+up|go\s+on)\b/,
  /\b(?:hurt|harm)(?:ing)?\s+my\s?self\b/,
  /\bself[-\s]?harm\b/,
  /\bbetter\s+off\s+(?:without\s+me|dead)\b/,
  /\b(?:no|not\s+any)\s+(?:reason|point)\s+(?:to|in)\s+(?:living|being\s+here|going\s+on)\b/,
  /\bnot\s+worth\s+living\b/,
  /\bsuicid(?:e|al)\b/,
  // Intransitive only: "I want to disappear" is a signal; "I want to disappear this task from my
  // list" is task-speak. The lookahead drops the transitive sense (caught by the idiom tests).
  /\bwant\s+to\s+(?:just\s+)?disappear\b(?!\s+(?:this|that|these|those|it|them|the|my|a|an)\b)/,
];

/** Normalises for matching: lowercase, curly→straight apostrophes, collapse whitespace. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

export const DRAFT_CRISIS_DETECTOR: CrisisDetector = (userText: string) => {
  const text = normalize(userText);
  return CRISIS_PATTERNS.some((p) => p.test(text));
};

/**
 * The gate the coaching flow calls BEFORE running the model. If the detector flags crisis, returns
 * the fixed care-and-refer response and the flow halts; otherwise null and the normal coaching turn
 * proceeds.
 *
 * Defaults to DRAFT_CRISIS_DETECTOR so that a caller who forgets to pass one is protected rather
 * than silently unprotected — the previous default (noCrisisDetected) meant every call site was a
 * no-op. Pass `noCrisisDetected` explicitly to open the gate in tests.
 */
export function checkCrisis(
  userText: string,
  detector: CrisisDetector = DRAFT_CRISIS_DETECTOR,
): CrisisResponse | null {
  return detector(userText) ? crisisResponse() : null;
}
