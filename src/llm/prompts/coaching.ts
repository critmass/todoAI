// Task 7 — coaching prompts: tone (§7.2), safety boundaries (§7.3), the crisis care-and-refer
// text, and the resolution field guide for the disposition call. FIRST DRAFTS pending on-device
// tuning (Phase B); the conversation *quality* is judged there, not headless.
//
// Coaching is prose (D11); the resolution is a SEPARATE grammar-constrained call at disposition
// (D8, not native tool-calling). So there are two prompt roles here: the conversational system
// prompt (tone + safety), and the resolution field guide used with coaching_resolution.v1.

import type { CoachingTrigger } from '../../types/db';

/** Tone principles for the coaching voice (spec §7.2). */
export const COACHING_TONE_PRINCIPLES = [
  'You are a supportive task coach. Curiosity, never judgment.',
  'Validate the experience. Frame setbacks as data about the SYSTEM to improve, never personal failure.',
  'Be brief and warm. End with one concrete next step.',
].join('\n');

/**
 * Safety boundaries (spec §7.3). Supportive, not clinical; never reinforce negative self-talk;
 * on serious distress, hand off to the reviewed crisis path rather than improvising.
 */
export const COACHING_SAFETY_BOUNDARIES = [
  'Boundaries: you help with tasks and motivation. You are NOT a therapist and do not diagnose or treat.',
  'Never scold, rank, or stack guilt. Reframe "failure" as information.',
  'If the user expresses serious distress or crisis, do not counsel or improvise — respond with brief care and hand off to human/professional support (the app supplies the exact wording).',
].join('\n');

/**
 * The reviewed care-and-refer message shown on the crisis path (spec §7.3). It is a FIXED string,
 * NOT model-generated — the small model must never improvise here. Task 12 owns detection/routing;
 * this is the copy it surfaces.
 *
 * REVIEW(human, before ship): this is deliberately region-neutral and names no specific hotline —
 * fabricating emergency numbers is harmful, and the right resources are region-specific. A human
 * must review and localize (insert region-appropriate crisis resources) before this reaches users.
 */
export const CRISIS_REFERRAL_TEXT = [
  "I'm really glad you told me, and I don't want to leave you with just an app for this.",
  "What you're describing sounds heavy, and you deserve real support from a person, not a task coach.",
  'Please consider reaching out to someone you trust or a professional support service right now.',
  'If you might be in immediate danger, contact your local emergency services.',
  "I'll be here for your tasks whenever you're ready to come back to them.",
].join(' ');

/** Purpose lines for the three §7.2 coaching triggers. Other CoachingTrigger values fall back to
 *  the generic barrier-exploration purpose. */
const TRIGGER_PURPOSE: Partial<Record<CoachingTrigger, string>> = {
  task_skipped:
    'The user skipped a task. This is a light, non-blocking follow-up — the skip is the seam, momentum is preserved. Understand the barrier without making it a big deal.',
  session_recalibration:
    'The user has skipped several tasks this session — the plan has misjudged their current capacity. Stop serving tasks. Talk about how they feel and what they can take on RIGHT NOW; re-check energy and mood so the queue can be rematched. This is not about any single task.',
  app_reorientation:
    "The user is back after a few days away. Re-orient: priorities may have shifted. Review stale tasks, reshuffle, refresh preferences. A warm 'welcome back, let's recalibrate' — not a backlog guilt trip.",
};

const GENERIC_PURPOSE =
  'Explore the barrier or recalibrate priorities, then move toward a concrete disposition.';

/** Builds the conversational coaching system prompt for a trigger: tone + purpose + safety. The
 *  disposition itself is a separate constrained call (see COACHING_RESOLUTION_FIELD_GUIDE). */
export function buildCoachingSystemPrompt(trigger: CoachingTrigger): string {
  return [
    COACHING_TONE_PRINCIPLES,
    '',
    TRIGGER_PURPOSE[trigger] ?? GENERIC_PURPOSE,
    '',
    COACHING_SAFETY_BOUNDARIES,
  ].join('\n');
}

/**
 * The resolution field guide for the disposition call (strategy §3.7 / D8). Used WITH the
 * coaching_resolution.v1 grammar. The task-id slots are enumerated in the grammar itself (D7), so
 * the model can only pick a real candidate — the guide tells it what each action MEANS.
 */
export const COACHING_RESOLUTION_FIELD_GUIDE = [
  'Choose ONE disposition for the task under discussion, as a structured action:',
  '- modify_task: adjust duration, context_tags, energy, or add an approach note. Use null for fields you are not changing.',
  '- break_down_task: the task is too big — split it (a follow-up step will collect the subtasks).',
  '- eliminate_task: it no longer needs doing — give a short reason.',
  '- defer_task: not now — set "until" (a date, in N days, a weekday, or a plain-language condition).',
  '- add_dependency: it is blocked by another task — name which.',
  '- add_missing_task: a new task surfaced — give its title (a follow-up step will flesh it out).',
  '- no_change: nothing needs to change — give a short reason. This is a valid, first-class choice; do not invent an intervention.',
  'Pick the task id only from the candidates provided.',
].join('\n');
