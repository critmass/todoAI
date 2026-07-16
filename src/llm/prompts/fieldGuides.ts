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
  'Decide recurrence in this order — pick the FIRST that fits:',
  '1) Completing it once finishes it forever? → one-off (recurrence: null).',
  '2) Done after N total completions, ever (e.g. "review deck 10×")? → count (target N).',
  '3) Happens on fixed days? With a per-period quota alongside → scheduled_quota; otherwise → scheduled.',
  '4) A quota per period but no fixed days ("15/week, whenever")? → quota.',
  '5) Recurs indefinitely, no schedule and no quota (ongoing project, practice, "keep at it")? → unscheduled.',
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
  'Extract structured task data. Fill every field; use null where a value is unknown (except title, duration, and the arrays).',
  'Fields, in order:',
  '- title: short imperative name.',
  '- description: extra detail, or null.',
  '- estimated_duration_minutes: how long the TASK ITSELF takes. If the user did not say, guess a reasonable value and set duration_from_user=false; if they stated it, set duration_from_user=true.',
  '- due: null if no deadline; else a relative-date object — {"kind":"on_date","date":"YYYY-MM-DD"} | {"kind":"in_days","days":N} | {"kind":"weekday","day":"friday","which":"this"|"next"}. Transcribe what was said; do not do calendar math.',
  '- context_tags: 0–5 short tags for where/how it is done (home, office, phone, computer). Reuse existing tags; only coin a new one for a genuinely new context. No filler tags.',
  '- tool_requirements: 0–5 things needed, or empty.',
  '- energy: "low" | "med" | "high", or null if unclear.',
  '- importance_user: 1–10, or null if unstated. Do not invent one.',
  '- recurrence: see the tree below (LAST — decide it after everything above).',
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
