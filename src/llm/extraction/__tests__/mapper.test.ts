import * as fs from 'fs';
import * as path from 'path';
import { validate } from '../validator';
import { extractionToTaskWrite } from '../mapper';

interface SeedFixture {
  id: string;
  today: string;
  gold: {
    estimated_duration_minutes: { min: number; max: number };
    duration_from_user: boolean;
    due_resolved: string | null;
    energy: 'low' | 'med' | 'high' | null;
    importance_user: number | null;
    recurrence: unknown;
  };
}

function loadFixtures(): SeedFixture[] {
  const fixturePath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'eval',
    'extraction_fixtures_seed.jsonl',
  );
  return fs
    .readFileSync(fixturePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const fixtures = loadFixtures();
function fixtureById(id: string): SeedFixture {
  const found = fixtures.find((f) => f.id === id);
  if (!found) throw new Error(`fixture "${id}" not found`);
  return found;
}

// Hand-authored raw extraction objects a correct model transcription would produce for each
// seed case - the seed file's `gold` is in resolved/domain terms for due/duration, not the raw
// grammar-shaped input, so this is the "what the model should emit" half of each fixture.
const RAW_EXTRACTIONS: Record<string, Record<string, unknown>> = {
  'simple-scheduled-01': {
    title: 'take out trash',
    description: null,
    estimated_duration_minutes: 10,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: ['home'],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: { type: 'scheduled', days: ['tuesday'] },
  },
  'oneoff-null-01': {
    title: 'renew passport',
    description: null,
    estimated_duration_minutes: 60,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  },
  'trap-unsched-01': {
    title: 'work on novel',
    description: null,
    estimated_duration_minutes: 60,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: { type: 'unscheduled' },
  },
  'trap-unsched-02': {
    title: 'practice guitar',
    description: null,
    estimated_duration_minutes: 30,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: { type: 'unscheduled' },
  },
  'count-01': {
    title: 'review slide deck',
    description: null,
    estimated_duration_minutes: 30,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: { type: 'count', target: 10 },
  },
  'quota-01': {
    title: 'hit the gym',
    description: null,
    estimated_duration_minutes: 60,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: 'high',
    importance_user: null,
    recurrence: { type: 'quota', quota: 3, period: 'week' },
  },
  'sched-vs-schedquota-01': {
    title: 'take meds',
    description: null,
    estimated_duration_minutes: 2,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: 'low',
    importance_user: null,
    recurrence: { type: 'scheduled', days: ['monday', 'wednesday', 'friday'] },
  },
  'sched-vs-schedquota-02': {
    title: 'run',
    description: null,
    estimated_duration_minutes: 30,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: 'high',
    importance_user: null,
    recurrence: {
      type: 'scheduled_quota',
      quota: 3,
      period: 'week',
      days: ['monday', 'wednesday', 'friday'],
    },
  },
  'count-vs-quota-trap-01': {
    title: 'apply to jobs',
    description: null,
    estimated_duration_minutes: 45,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: { type: 'count', target: 20 },
  },
  'date-weekday-01': {
    title: 'call insurance company',
    description: null,
    estimated_duration_minutes: 15,
    duration_from_user: false,
    duration_type: 'estimate',
    due: { kind: 'weekday', day: 'friday', which: 'this' },
    context_tags: ['phone'],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  },
  'date-relative-01': {
    title: 'submit expense report',
    description: null,
    estimated_duration_minutes: 20,
    duration_from_user: false,
    duration_type: 'estimate',
    due: { kind: 'in_days', days: 14 },
    context_tags: ['computer'],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  },
  'date-absolute-01': {
    title: 'get car inspected',
    description: null,
    estimated_duration_minutes: 60,
    duration_from_user: false,
    duration_type: 'estimate',
    due: { kind: 'on_date', date: '2026-12-03' },
    context_tags: [],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  },
  'scope-trap-01': {
    title: 'schedule dentist appointment',
    description: null,
    estimated_duration_minutes: 10,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: ['phone'],
    tool_requirements: [],
    energy: 'low',
    importance_user: null,
    recurrence: null,
  },
  'vague-duration-01': {
    title: 'clean out email inbox',
    description: null,
    estimated_duration_minutes: 45,
    duration_from_user: false,
    duration_type: 'estimate',
    due: null,
    context_tags: ['computer'],
    tool_requirements: [],
    energy: null,
    importance_user: null,
    recurrence: null,
  },
  'floor-duration-01': {
    title: 'finish mixing mokradio episode',
    description: null,
    estimated_duration_minutes: 60,
    duration_from_user: true,
    duration_type: 'floor', // "at least an hour" open-ended work — the mokRadio case (task 28 §3.1)
    due: null,
    context_tags: [],
    tool_requirements: [],
    energy: 'high',
    importance_user: null,
    recurrence: null,
  },
  'complex-multiturn-01': {
    title: 'organize garage',
    description: null,
    estimated_duration_minutes: 120,
    duration_from_user: true,
    duration_type: 'estimate',
    due: null,
    context_tags: ['home'],
    tool_requirements: [],
    energy: 'high',
    importance_user: null,
    recurrence: null,
  },
};

describe('extractionToTaskWrite over the seed fixtures', () => {
  for (const [id, raw] of Object.entries(RAW_EXTRACTIONS)) {
    it(`${id}: maps duration, due, and scales correctly`, () => {
      const fixture = fixtureById(id);
      const valid = validate(raw, fixture.today);
      const { taskWrite } = extractionToTaskWrite(valid, fixture.today);

      const { min, max } = fixture.gold.estimated_duration_minutes;
      expect(taskWrite.estimatedDuration).toBeGreaterThanOrEqual(min);
      expect(taskWrite.estimatedDuration).toBeLessThanOrEqual(max);
      expect(taskWrite.durationSource).toBe(fixture.gold.duration_from_user ? 'user' : 'model_guess');
      expect(taskWrite.nextDueAt).toBe(fixture.gold.due_resolved);
    });
  }

  it('null importance/energy default to the internal mid-points (500 / 3), never emitted by the model', () => {
    const fixture = fixtureById('oneoff-null-01');
    const valid = validate(RAW_EXTRACTIONS['oneoff-null-01'], fixture.today);
    const { taskWrite } = extractionToTaskWrite(valid, fixture.today);
    expect(taskWrite.importance).toBe(500);
    expect(taskWrite.energyRequirement).toBe(3);
  });

  it('maps duration_type through: floor for open-ended work, estimate otherwise (task 28 §3.1)', () => {
    const floorFixture = fixtureById('floor-duration-01');
    const floor = extractionToTaskWrite(
      validate(RAW_EXTRACTIONS['floor-duration-01'], floorFixture.today),
      floorFixture.today,
    );
    expect(floor.taskWrite.durationType).toBe('floor');
    // a floor task keeps its estimated_duration — it holds the floor value, not a lie
    expect(floor.taskWrite.estimatedDuration).toBe(60);

    const estFixture = fixtureById('oneoff-null-01');
    const est = extractionToTaskWrite(
      validate(RAW_EXTRACTIONS['oneoff-null-01'], estFixture.today),
      estFixture.today,
    );
    expect(est.taskWrite.durationType).toBe('estimate');
  });

  it('a stated energy/importance projects through scales.ts (not the raw user-scale value)', () => {
    const fixture = fixtureById('quota-01');
    const valid = validate(
      { ...RAW_EXTRACTIONS['quota-01'], importance_user: 8 },
      fixture.today,
    );
    const { taskWrite } = extractionToTaskWrite(valid, fixture.today);
    expect(taskWrite.energyRequirement).toBe(5); // 'high' -> internal 5
    expect(taskWrite.importance).toBe(800); // user 8 -> internal 800
  });

  describe('recurrence: null vs unscheduled - the zero-tolerance boundary', () => {
    it('a true one-off (recurrence: null) maps to recurrence: undefined, no task_recurrence row', () => {
      const fixture = fixtureById('oneoff-null-01');
      const valid = validate(RAW_EXTRACTIONS['oneoff-null-01'], fixture.today);
      const { recurrence } = extractionToTaskWrite(valid, fixture.today);
      expect(recurrence).toBeUndefined();
    });

    it('an unscheduled task maps to the explicit {type:"unscheduled"} union member, not undefined', () => {
      const fixture = fixtureById('trap-unsched-01');
      const valid = validate(RAW_EXTRACTIONS['trap-unsched-01'], fixture.today);
      const { recurrence } = extractionToTaskWrite(valid, fixture.today);
      expect(recurrence).toEqual({ type: 'unscheduled' });
      expect(recurrence).not.toBeUndefined();
    });

    it('the second unscheduled trap also maps correctly', () => {
      const fixture = fixtureById('trap-unsched-02');
      const valid = validate(RAW_EXTRACTIONS['trap-unsched-02'], fixture.today);
      const { recurrence } = extractionToTaskWrite(valid, fixture.today);
      expect(recurrence).toEqual({ type: 'unscheduled' });
    });
  });

  it('maps all five recurrence types with correct field translation (days -> scheduledDays, count gets progress:0)', () => {
    const cases: Array<[string, unknown]> = [
      [
        'sched-vs-schedquota-02',
        {
          type: 'scheduled_quota',
          quota: 3,
          period: 'week',
          scheduledDays: ['monday', 'wednesday', 'friday'],
        },
      ],
      ['quota-01', { type: 'quota', quota: 3, period: 'week' }],
      ['sched-vs-schedquota-01', { type: 'scheduled', scheduledDays: ['monday', 'wednesday', 'friday'] }],
      ['trap-unsched-01', { type: 'unscheduled' }],
      ['count-01', { type: 'count', target: 10, progress: 0 }],
    ];
    for (const [id, expected] of cases) {
      const fixture = fixtureById(id);
      const valid = validate(RAW_EXTRACTIONS[id], fixture.today);
      const { recurrence } = extractionToTaskWrite(valid, fixture.today);
      expect(recurrence).toEqual(expected);
    }
  });
});
