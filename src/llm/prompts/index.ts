// Barrel for the prompt layer (task 7). System prompts + per-field NL guides (drafts, pending
// on-device tuning in Phase B) and the assembly scaffolding, including the assembleCoachingPrompt
// skill-injection seam shared with task 12 (flow side) and task 18 (skill producer).
export {
  RECURRENCE_DECISION_TREE,
  SCOPE_TO_OBSERVABLE_RULE,
  EXTRACTION_FIELD_GUIDE,
  BREAKDOWN_FIELD_GUIDE,
  SUMMARY_FIELD_GUIDE,
} from './fieldGuides';

export {
  COACHING_TONE_PRINCIPLES,
  COACHING_SAFETY_BOUNDARIES,
  CRISIS_REFERRAL_TEXT,
  COACHING_RESOLUTION_FIELD_GUIDE,
  buildCoachingSystemPrompt,
} from './coaching';

export {
  weekdayName,
  buildExtractionSystemPrompt,
  buildExtractionRecapInstruction,
  buildBreakdownSystemPrompt,
  buildSummarySystemPrompt,
} from './systemPrompts';

export {
  assembleExtractionPrompt,
  assembleBreakdownPrompt,
  assembleSummaryPrompt,
  assembleCoachingPrompt,
} from './assemble';
