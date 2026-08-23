// Task 7 — per-field natural-language guides (strategy D3.2: grammars constrain SHAPE, prose
// makes fields CORRECT; §3.3.2 — llama.cpp doesn't inject the schema, so the prompt must).
// These are FIRST DRAFTS: prompt quality on a 4B is empirical and can't be judged headless.
// They ship "pending on-device tuning" (Phase B), with two known tuning targets called out:
//   • the due:null miss (model omitting/mis-emitting the due union) — tighten the due guidance;
//   • junk tag elements (model inventing noise context_tags) — tighten the tag guidance.
// Budget (strategy §5.2): ≤ ~250 prompt tokens for the whole extraction guide including the
// recurrence tree + today's date. Keep every line earning its tokens.

/**
 * The recurrence decision tree (strategy §3.5 / D6). Goes in the extraction prompt NEAR-VERBATIM.
 * The ask-don't-guess policy is load-bearing: `null` (true one-off) and `unscheduled` (ongoing)
 * have OPPOSITE completion semantics, and a silent wrong guess corrupts data invisibly — so when
 * recurrence is ambiguous the model must ASK one short question, never default silently.
 */
export const RECURRENCE_DECISION_TREE = [
  'RECURRENCE — the field most often got wrong. Decide it deliberately.',
  'recurrence: null is NOT "unknown". It is a positive claim: this task is ONE-OFF — done once, gone forever. If the task repeats in ANY way, null is WRONG.',
  'First ask: does this happen more than once? If yes, it is never null. Then pick:',
  '- A total number of repetitions, then done ("10 times", "20 jobs", "5 sessions")? → count {target}. A stated number of repetitions is ALWAYS a count — even when a deadline is mentioned too ("review it 10 times before the exam" → count 10, not a one-off with a due date).',
  '- Named fixed days ("every Tuesday", "Mon/Wed/Fri")? → scheduled {days}. If they name days AND a per-period count ("3 times a week, aiming for Mon/Wed/Fri") → scheduled_quota {quota, period, days} — keep BOTH the count and the days.',
  '- A count per period with no named days ("3 times a week, whenever")? → quota {quota, period}.',
  '- Repeats indefinitely, no schedule, no total ("keep at it", "ongoing", "practice", "keep coming back to it")? → unscheduled. An open-ended project you never truly finish ("keep working on my novel") is unscheduled, NOT null.',
  'Only if completing it once truly finishes it forever → null.',
  'CRITICAL: null (one-off) and unscheduled (ongoing) are opposites — never confuse them. If it is genuinely unclear which, ASK one short question ("Is this a one-time thing, or something ongoing?") instead of guessing.',
].join('\n');

/**
 * The scope-to-observable-work rule (spec §7.1). The app can only time/verify in-app work, so an
 * external event becomes its *arrangement*: "Schedule dentist appointment", duration = the
 * arranging effort, not the appointment length.
 */
export const SCOPE_TO_OBSERVABLE_RULE =
  'Scope tasks to in-app work you can time. An external event (meeting, appointment, interview) ' +
  'becomes its arrangement — "Schedule coffee chat" — with a duration for the scheduling effort, ' +
  'not the event itself.';

/** The extraction field guide (strategy §4.1 key order = generation order). Compact by design. */
export const EXTRACTION_FIELD_GUIDE = [
  'Extract structured task data from what the user ACTUALLY said.',
  'Record only what the user said or clearly implied. Do NOT invent a value just to fill a field: null and [] are correct, expected answers — not failures. Guess only where a field explicitly says you may.',
  'Fields, in order:',
  '- title: short imperative name.',
  '- description: extra detail the user gave, or null.',
  '- estimated_duration_minutes: a REALISTIC estimate of how long THIS task itself takes. This and energy are the only two fields you may judge for yourself — think about the actual work (taking out the trash is 5, cleaning a garage is 120). Never emit a placeholder value.',
  '- duration_from_user: did the USER say how long it takes? Only true if their words contain a length ("an hour", "at least an hour", "20 minutes"). If the length is your own estimate → false. Most tasks → false.',
  '- duration_type: "floor" only when the work is open-ended with no real ceiling ("at least an hour", "a couple hours minimum", "work on it until done") — then estimated_duration_minutes is the MINIMUM. Otherwise "estimate". Most tasks → "estimate".',
  '- due: null unless the user gave a deadline; else {"kind":"on_date","date":"YYYY-MM-DD"} | {"kind":"in_days","days":N} | {"kind":"weekday","day":"friday","which":"this"|"next"}. Transcribe what was said; do not do calendar math. No deadline mentioned → null.',
  '- context_tags: where/how THIS task is done. Only tags that genuinely apply — usually 0–2, never every tag (trash is ["home"], not ["home","office","phone"]). Each: ONE plain lowercase phrase, no punctuation/fragments/non-English. Nothing fits → [].',
  '- tool_requirements: 0–5 real things; same element rules. Usually [].',
  '- energy: what it costs to get this done — making yourself START it and getting THROUGH it; take the higher. Higher if: no obvious first step, unpleasant, open-ended, a call or confrontation, hard focus, physically hard. low = just do it (trash, a text). med = needs a run-up or real effort (errands, an email thread). high = you psych yourself up for it, or need recovery after (gym, taxes, a hard conversation). ALWAYS pick one — never null.',
  '- importance_user: 1–10 ONLY if the user stated importance or priority. Otherwise null. Most tasks → null. Never default to 5.',
  '- recurrence: see the tree below.',
  '',
  RECURRENCE_DECISION_TREE,
  '',
  SCOPE_TO_OBSERVABLE_RULE,
].join('\n');

/** The breakdown field guide (strategy §4.2). The model emits an ordering flag, never per-subtask
 *  importance — code bands importance (spec §4.1). */
export const BREAKDOWN_FIELD_GUIDE = [
  'Break the task into 2–8 concrete subtasks, each a single observable step.',
  'Fields:',
  '- parent_task_id: given; echo it.',
  '- ordered: true only if the subtasks must be done in sequence (one depends on the previous). Otherwise false.',
  '- subtasks: each { title (short imperative), estimated_duration_minutes (guess if unstated → duration_from_user=false), duration_from_user }.',
  'Keep subtasks small and real; do not pad to reach a count.',
].join('\n');

/** The summary field guide (strategy §4.4). The model summarizes; code attaches ids/ratings. */
export const SUMMARY_FIELD_GUIDE = [
  'Summarize this interaction into a compact structured record. The raw conversation is discarded — this object is what survives.',
  'Fields:',
  '- summary_schema_version: always "1".',
  '- kind: the interaction type.',
  '- key_points: 1–3 short bullet strings capturing what mattered.',
  '- disposition: the outcome/decision in one line, or null.',
  '- energy_note: a brief note on the user\'s energy/mood, or null.',
  'Do not include names of tasks by id or invent ratings — code attaches those.',
].join('\n');
