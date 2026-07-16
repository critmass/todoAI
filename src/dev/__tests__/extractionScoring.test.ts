// The Task 7 tuning loop keys every decision off these verdicts, so the oracle itself is tested.

import {
  isJunkTag,
  normalizeTitle,
  recurrenceEquals,
  scoreExtraction,
  summarize,
  type ExtractionFixture,
} from '../extractionScoring';
import { EXTRACTION_FIXTURES } from '../extractionFixturesData';

const FIXTURE: ExtractionFixture = {
  id: 'simple-scheduled-01',
  source: 'synthetic',
  today: '2026-07-08',
  turns: [{ role: 'user', content: 'I need to take out the trash' }],
  clarify_answers: [],
  gold: {
    title: ['take out trash', 'take out the trash'],
    estimated_duration_minutes: { min: 5, max: 15 },
    duration_from_user: false,
    due_resolved: null,
    energy: null,
    importance_user: null,
    context_tags_must_include: ['home'],
    recurrence: { type: 'scheduled', days: ['tuesday'] },
    clarify_ok: [],
  },
  critical: ['recurrence'],
  notes: '',
};

const GOOD_EXTRACTION = {
  title: 'Take out the trash',
  description: null,
  estimated_duration_minutes: 10,
  duration_from_user: false,
  due: null,
  context_tags: ['home'],
  tool_requirements: [],
  energy: null,
  importance_user: null,
  recurrence: { type: 'scheduled', days: ['tuesday'] },
};

describe('normalizeTitle', () => {
  it('ignores case, surrounding punctuation, and whitespace variance', () => {
    expect(normalizeTitle('  Take Out   The Trash. ')).toBe('take out the trash');
  });
});

describe('isJunkTag', () => {
  it('flags the junk shapes seen on-device', () => {
    expect(isJunkTag('],')).toBe(true);
    expect(isJunkTag(':every_tuesday')).toBe(true);
    expect(isJunkTag(':time')).toBe(true);
    expect(isJunkTag(':lack of trash')).toBe(true);
  });

  it('accepts real tags, including multi-word ones', () => {
    expect(isJunkTag('home')).toBe(false);
    expect(isJunkTag('trash can')).toBe(false);
    expect(isJunkTag('Computer')).toBe(false);
  });
});

describe('recurrenceEquals', () => {
  it('never equates null (one-off) with unscheduled (ongoing) — opposite completion semantics', () => {
    expect(recurrenceEquals(null, { type: 'unscheduled' })).toBe(false);
    expect(recurrenceEquals({ type: 'unscheduled' }, null)).toBe(false);
    expect(recurrenceEquals(null, null)).toBe(true);
  });

  it('treats scheduled days as a set, not a sequence', () => {
    expect(
      recurrenceEquals(
        { type: 'scheduled', days: ['friday', 'monday', 'wednesday'] },
        { type: 'scheduled', days: ['monday', 'wednesday', 'friday'] },
      ),
    ).toBe(true);
  });

  it('distinguishes the confusable union members', () => {
    expect(recurrenceEquals({ type: 'count', target: 10 }, { type: 'count', target: 20 })).toBe(false);
    expect(
      recurrenceEquals({ type: 'quota', quota: 3, period: 'week' }, { type: 'scheduled_quota', quota: 3, period: 'week', days: ['monday'] }),
    ).toBe(false);
    expect(
      recurrenceEquals({ type: 'scheduled', days: ['monday'] }, { type: 'scheduled_quota', quota: 3, period: 'week', days: ['monday'] }),
    ).toBe(false);
  });
});

describe('scoreExtraction', () => {
  it('scores a fully-correct extraction', () => {
    const result = scoreExtraction(GOOD_EXTRACTION, FIXTURE);
    expect(result.criticalCorrect).toBe(true);
    expect(result.fullyCorrect).toBe(true);
    expect(result.criticalFailures).toEqual([]);
    expect(result.junkTags).toEqual([]);
  });

  it('fails the critical recurrence field on the exact miss the device produced', () => {
    // The real task-6 Check A output: valid, validator-passing, but recurrence null despite
    // "every Tuesday", plus colon-junk in both array fields.
    const result = scoreExtraction(
      {
        ...GOOD_EXTRACTION,
        estimated_duration_minutes: 60,
        context_tags: ['trash', ':every_tuesday'],
        tool_requirements: ['trash can', ':time'],
        importance_user: 5,
        recurrence: null,
      },
      FIXTURE,
    );
    expect(result.criticalCorrect).toBe(false);
    expect(result.criticalFailures).toEqual(['recurrence']);
    expect(result.junkTags).toEqual([':every_tuesday', ':time']);
    // context_tags missing the required 'home', duration out of range, importance invented
    const wrong = result.fields.filter((f) => f.verdict === 'wrong').map((f) => f.field);
    expect(wrong).toEqual(
      expect.arrayContaining(['recurrence', 'context_tags', 'estimated_duration_minutes', 'importance_user']),
    );
  });

  it('resolves the model DueSpec through the real resolver before comparing', () => {
    const dateFixture: ExtractionFixture = {
      ...FIXTURE,
      id: 'date-weekday-01',
      gold: { ...FIXTURE.gold, due_resolved: '2026-07-10', context_tags_must_include: [] },
      critical: ['due_resolved'],
    };
    // today 2026-07-08 is a Wednesday; "this friday" → 2026-07-10
    const ok = scoreExtraction(
      { ...GOOD_EXTRACTION, due: { kind: 'weekday', day: 'friday', which: 'this' } },
      dateFixture,
    );
    expect(ok.fields.find((f) => f.field === 'due_resolved')?.verdict).toBe('correct');

    // the known target: due:null despite a date in the prompt
    const missed = scoreExtraction({ ...GOOD_EXTRACTION, due: null }, dateFixture);
    expect(missed.criticalCorrect).toBe(false);
    expect(missed.criticalFailures).toEqual(['due_resolved']);
  });
});

describe('summarize', () => {
  it('aggregates the KPI and per-field failure counts', () => {
    const good = scoreExtraction(GOOD_EXTRACTION, FIXTURE);
    const bad = scoreExtraction({ ...GOOD_EXTRACTION, recurrence: null }, FIXTURE);
    const summary = summarize([good, bad], 3, 2);
    expect(summary).toMatchObject({
      total: 3,
      validCount: 2,
      criticalCorrectCount: 1,
      fullyCorrectCount: 1,
      fieldFailures: { recurrence: 1 },
    });
  });
});

describe('generated fixture data', () => {
  it('mirrors the seed file: 16 fixtures, each with gold + critical fields', () => {
    expect(EXTRACTION_FIXTURES).toHaveLength(16);
    for (const f of EXTRACTION_FIXTURES) {
      expect(f.id).toBeTruthy();
      expect(f.critical.length).toBeGreaterThan(0);
      expect(f.gold).toBeDefined();
      expect(Array.isArray(f.gold.title)).toBe(true);
    }
  });

  it('carries the null-vs-unscheduled trap pair the loop exists to protect', () => {
    const oneOff = EXTRACTION_FIXTURES.find((f) => f.id === 'oneoff-null-01');
    const ongoing = EXTRACTION_FIXTURES.find((f) => f.id === 'trap-unsched-01');
    expect(oneOff?.gold.recurrence).toBeNull();
    expect(ongoing?.gold.recurrence).toEqual({ type: 'unscheduled' });
  });
});
