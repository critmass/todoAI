// Task 7 — the correctness oracle for the on-device prompt-tuning loop.
//
// Q1c established that *valid* is solved (4/4 JSON, 4/4 validator-passing) — task 6 re-confirmed
// it through the real provider. Task 7's target is *correct*: right fields, right recurrence type,
// right due date. This module turns a fixture's `gold` block (docs/eval/extraction_fixtures_seed.jsonl)
// into a per-field verdict, so "valid-AND-correct" can be tracked as a KPI across prompt edits
// instead of eyeballed.
//
// Pure and unit-tested on purpose: every tuning decision keys off these verdicts, so a scorer bug
// would silently corrupt the whole loop. Deliberately NOT task 20's eval harness — this is the
// minimum oracle the tuning loop needs.

import { resolveDue, type DueSpec } from '../llm';

export interface ExtractionGold {
  title: string[];
  estimated_duration_minutes: { min: number; max: number };
  duration_from_user: boolean;
  due_resolved: string | null;
  energy: string | null;
  importance_user: number | null;
  context_tags_must_include: string[];
  recurrence: unknown;
  /** Fields where a clarifying QUESTION is an acceptable answer instead of a value (D6). Not used
   *  when scoring the constrained call (the fixture's clarify_answers are fed in as turns); it is
   *  the ask-don't-guess probe's oracle. */
  clarify_ok: string[];
}

export interface ExtractionFixture {
  id: string;
  source: string;
  today: string;
  turns: Array<{ role: 'user'; content: string }>;
  clarify_answers: string[];
  gold: ExtractionGold;
  /** Zero-tolerance fields. The headline KPI is "all critical fields correct". */
  critical: string[];
  notes: string;
}

export type Verdict = 'correct' | 'wrong';

export interface FieldResult {
  field: string;
  verdict: Verdict;
  expected: unknown;
  actual: unknown;
  critical: boolean;
}

export interface ScoreResult {
  id: string;
  /** All CRITICAL fields correct — the headline "correct" KPI. */
  criticalCorrect: boolean;
  /** Every scored field correct (a stricter, secondary number). */
  fullyCorrect: boolean;
  fields: FieldResult[];
  criticalFailures: string[];
  /** Array elements that look like model noise rather than real tags (the known junk-tag target). */
  junkTags: string[];
}

/** Normalizes a title for comparison: lowercase, collapse whitespace, drop surrounding
 *  punctuation. Gold supplies several acceptable phrasings; this only removes cosmetic variance. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;:]+$/g, '')
    .trim();
}

/**
 * A tag/tool element that looks like model noise rather than a real value. Q1c saw the literal
 * `"],"`; the task-6 run saw colon-prefixed junk (`":every_tuesday"`, `":time"`). Real tags are
 * short lowercase words/phrases, so anything with punctuation or a non-letter start is junk.
 */
export function isJunkTag(tag: string): boolean {
  return !/^[a-z][a-z0-9 -]{0,29}$/.test(tag.toLowerCase().trim());
}

function sameDays(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const norm = (xs: unknown[]) => [...xs.map((x) => String(x).toLowerCase())].sort();
  const [x, y] = [norm(a), norm(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Compares two RecurrenceSpec values. Day ORDER is insignificant (a set), everything else is
 * exact. `null` (true one-off) and `{type:'unscheduled'}` are opposites and never compare equal —
 * that boundary is the whole reason this field is zero-tolerance (orientation §3, constraint #7).
 */
export function recurrenceEquals(actual: unknown, expected: unknown): boolean {
  if (expected === null || actual === null) return actual === expected;
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  if (a.type !== e.type) return false;

  switch (e.type) {
    case 'unscheduled':
      return true;
    case 'count':
      return a.target === e.target;
    case 'quota':
      return a.quota === e.quota && a.period === e.period;
    case 'scheduled':
      return sameDays(a.days, e.days);
    case 'scheduled_quota':
      return a.quota === e.quota && a.period === e.period && sameDays(a.days, e.days);
    default:
      return false;
  }
}

/** The extraction shape this scorer reads (a validated task_extraction.v1 object). */
interface ExtractionLike {
  title?: unknown;
  estimated_duration_minutes?: unknown;
  duration_from_user?: unknown;
  due?: unknown;
  context_tags?: unknown;
  tool_requirements?: unknown;
  energy?: unknown;
  importance_user?: unknown;
  recurrence?: unknown;
}

/**
 * Scores one validated extraction against its fixture's gold. Assumes the object already passed
 * the task-5 validator (validity and correctness are tracked separately — an invalid output never
 * reaches here).
 */
export function scoreExtraction(extraction: ExtractionLike, fixture: ExtractionFixture): ScoreResult {
  const { gold, critical } = fixture;
  const isCritical = (field: string) => critical.includes(field);
  const fields: FieldResult[] = [];

  const push = (field: string, verdict: Verdict, expected: unknown, actual: unknown) =>
    fields.push({ field, verdict, expected, actual, critical: isCritical(field) });

  // title — any gold phrasing, normalized
  const actualTitle = typeof extraction.title === 'string' ? extraction.title : '';
  const titleOk = gold.title.some((t) => normalizeTitle(t) === normalizeTitle(actualTitle));
  push('title', titleOk ? 'correct' : 'wrong', gold.title, extraction.title);

  // estimated_duration_minutes — inclusive gold range
  const dur = extraction.estimated_duration_minutes;
  const durOk =
    typeof dur === 'number' &&
    dur >= gold.estimated_duration_minutes.min &&
    dur <= gold.estimated_duration_minutes.max;
  push('estimated_duration_minutes', durOk ? 'correct' : 'wrong', gold.estimated_duration_minutes, dur);

  // duration_from_user
  const dfuOk = extraction.duration_from_user === gold.duration_from_user;
  push('duration_from_user', dfuOk ? 'correct' : 'wrong', gold.duration_from_user, extraction.duration_from_user);

  // due_resolved — resolve the model's DueSpec through the real resolver (D5: model transcribes,
  // code resolves), then compare the resolved calendar date.
  let actualDueResolved: string | null = null;
  try {
    actualDueResolved = resolveDue((extraction.due ?? null) as DueSpec, fixture.today);
  } catch {
    actualDueResolved = null;
  }
  const dueOk = actualDueResolved === gold.due_resolved;
  push('due_resolved', dueOk ? 'correct' : 'wrong', gold.due_resolved, actualDueResolved);

  // energy
  const energyOk = (extraction.energy ?? null) === gold.energy;
  push('energy', energyOk ? 'correct' : 'wrong', gold.energy, extraction.energy ?? null);

  // importance_user — gold is null throughout ("do not invent one")
  const impOk = (extraction.importance_user ?? null) === gold.importance_user;
  push('importance_user', impOk ? 'correct' : 'wrong', gold.importance_user, extraction.importance_user ?? null);

  // context_tags — must include every required tag
  const tags = Array.isArray(extraction.context_tags) ? extraction.context_tags.map(String) : [];
  const tagsLower = tags.map((t) => t.toLowerCase().trim());
  const tagsOk = gold.context_tags_must_include.every((t) => tagsLower.includes(t.toLowerCase()));
  push('context_tags', tagsOk ? 'correct' : 'wrong', gold.context_tags_must_include, tags);

  // recurrence — the zero-tolerance one
  const recOk = recurrenceEquals(extraction.recurrence ?? null, gold.recurrence);
  push('recurrence', recOk ? 'correct' : 'wrong', gold.recurrence, extraction.recurrence ?? null);

  // Junk noise across BOTH array fields (tracked, not scored — the validator legally allows it).
  const tools = Array.isArray(extraction.tool_requirements) ? extraction.tool_requirements.map(String) : [];
  const junkTags = [...tags, ...tools].filter(isJunkTag);

  const criticalFailures = fields.filter((f) => f.critical && f.verdict === 'wrong').map((f) => f.field);

  return {
    id: fixture.id,
    criticalCorrect: criticalFailures.length === 0,
    fullyCorrect: fields.every((f) => f.verdict === 'correct'),
    fields,
    criticalFailures,
    junkTags,
  };
}

export interface RunSummary {
  total: number;
  validCount: number;
  criticalCorrectCount: number;
  fullyCorrectCount: number;
  junkTagCount: number;
  /** Per-field wrong-counts across the run — shows which field to tune next. */
  fieldFailures: Record<string, number>;
}

/** Aggregates per-fixture scores into the run KPI. `validCount` is passed in because invalid
 *  outputs never produce a ScoreResult. */
export function summarize(scores: ScoreResult[], total: number, validCount: number): RunSummary {
  const fieldFailures: Record<string, number> = {};
  for (const s of scores) {
    for (const f of s.fields) {
      if (f.verdict === 'wrong') fieldFailures[f.field] = (fieldFailures[f.field] ?? 0) + 1;
    }
  }
  return {
    total,
    validCount,
    criticalCorrectCount: scores.filter((s) => s.criticalCorrect).length,
    fullyCorrectCount: scores.filter((s) => s.fullyCorrect).length,
    junkTagCount: scores.reduce((n, s) => n + s.junkTags.length, 0),
    fieldFailures,
  };
}
