// Task 7 — system-prompt builders. Each stitches a field guide (./fieldGuides.ts) together with
// the run-time context (today's date + weekday for extraction). The recap instruction is the
// prose half of draft-then-constrain (D1): a warm restatement the user can correct BEFORE the
// constrained extraction call runs — a semantic-drift guard no grammar can provide.

import { EXTRACTION_FIELD_GUIDE, BREAKDOWN_FIELD_GUIDE, SUMMARY_FIELD_GUIDE } from './fieldGuides';

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The weekday name for a YYYY-MM-DD date, computed in UTC (matches dueSpec.ts's UTC calendar
 *  arithmetic). Cheap insurance in the prompt even though the model shouldn't need it for the
 *  relative-date union (D5). */
export function weekdayName(todayISO: string): string {
  return WEEKDAY_NAMES[new Date(`${todayISO}T00:00:00Z`).getUTCDay()];
}

/** The extraction constrained-call system prompt: the field guide + today's date and weekday
 *  (strategy §5.2). Field guide and grammar must move together (same PR) — a guide for schema v1
 *  against a v2 grammar is a drift generator. */
export function buildExtractionSystemPrompt(todayISO: string): string {
  return `Today is ${todayISO} (${weekdayName(todayISO)}).\n\n${EXTRACTION_FIELD_GUIDE}`;
}

/**
 * The prose recap instruction (D1). Streamed to the user as conversation; if the recap is wrong
 * the user corrects it before the structured call happens.
 *
 * ASKING IS FIRST-CLASS HERE (D6). An earlier draft said only "restate what you understood", which
 * on-device suppressed the clarifying question entirely (0/5 ambiguous inputs asked; it confidently
 * recapped "applying to 20 jobs is a one-time thing" — the exact silent wrong guess D6 exists to
 * prevent). The constrained call CANNOT ask — the grammar forces a full object — so this prose turn
 * is the only place a question can happen. If it doesn't ask here, the app guesses silently.
 */
export function buildExtractionRecapInstruction(): string {
  return [
    'If something material is genuinely unclear — above all whether the task is a one-off or something ongoing/repeating —',
    'ask ONE short, warm question about it and nothing else. Do not guess and do not restate.',
    'Only if everything material is clear, restate what you understood in one warm sentence so the user can confirm or correct it:',
    'the task, when it recurs (in plain words), how long it takes, and when it is due.',
    'Either way: no JSON here — just the one question or the one sentence.',
  ].join(' ');
}

export function buildBreakdownSystemPrompt(): string {
  return BREAKDOWN_FIELD_GUIDE;
}

export function buildSummarySystemPrompt(): string {
  return SUMMARY_FIELD_GUIDE;
}
