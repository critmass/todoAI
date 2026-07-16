// Task 7 — prompt-assembly scaffolding. Turns a system prompt + conversation turns into the
// ChatMessage[] the provider consumes (constraint #1: always the messages API). The coaching
// assembler carries the skill-injection SEAM (assembleCoachingPrompt) that task 18 will fill and
// task 12 owns the coaching-flow side of.

import type { ChatMessage } from '../provider/types';
import {
  buildExtractionSystemPrompt,
  buildBreakdownSystemPrompt,
  buildSummarySystemPrompt,
} from './systemPrompts';

function system(content: string): ChatMessage {
  return { role: 'system', content };
}

/** The constrained extraction call's messages: the field-guide system prompt (with today's date)
 *  followed by the whole conversation — INCLUDING the model's own recap turn (D1), which the
 *  constrained pass transcribes rather than re-derives. */
export function assembleExtractionPrompt(args: {
  todayISO: string;
  conversation: ChatMessage[];
}): ChatMessage[] {
  return [system(buildExtractionSystemPrompt(args.todayISO)), ...args.conversation];
}

export function assembleBreakdownPrompt(args: { conversation: ChatMessage[] }): ChatMessage[] {
  return [system(buildBreakdownSystemPrompt()), ...args.conversation];
}

export function assembleSummaryPrompt(args: { conversation: ChatMessage[] }): ChatMessage[] {
  return [system(buildSummarySystemPrompt()), ...args.conversation];
}

/** Renders injected skills as a system sub-section, or '' when there are none. The learning
 *  layer (task 18) supplies confidence-gated skill instructions; skill use is hidden from the
 *  user (spec §5.5). */
function renderSkillSection(injectedSkills: readonly string[]): string {
  if (injectedSkills.length === 0) return '';
  const lines = injectedSkills.map((s) => `- ${s}`).join('\n');
  return `\n\nApply these learned approaches (do not mention them to the user):\n${lines}`;
}

/**
 * The coaching prompt assembler and the skill-injection SEAM (spec §5.5, strategy out-of-scope
 * for this phase). `base` is the coaching system prompt (from buildCoachingSystemPrompt);
 * `injectedSkills` is the confidence-gated skill instructions retrieved for this moment —
 * **empty now, and always OPTIONAL with a default of []** so callers never think about it until
 * task 18 wires retrieval. The slot is present-but-empty by construction: cheap to leave open
 * now, expensive to retrofit later.
 *
 * Consumed by task 12 (coaching flows). Task 18 (skill-injection layer) is the eventual producer
 * of `injectedSkills`.
 */
export function assembleCoachingPrompt(args: {
  base: string;
  injectedSkills?: readonly string[];
  conversation?: ChatMessage[];
}): ChatMessage[] {
  const injectedSkills = args.injectedSkills ?? [];
  const conversation = args.conversation ?? [];
  return [system(`${args.base}${renderSkillSection(injectedSkills)}`), ...conversation];
}
