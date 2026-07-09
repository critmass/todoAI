import * as fs from 'fs';
import * as path from 'path';
import { resolveDue, type DueSpec } from '../dueSpec';

interface SeedFixture {
  id: string;
  today: string;
  gold: { due_resolved: string | null };
}

function loadFixtures(): SeedFixture[] {
  const fixturePath = path.join(__dirname, '..', '..', '..', '..', 'docs', 'eval', 'extraction_fixtures_seed.jsonl');
  const lines = fs.readFileSync(fixturePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line));
}

function fixtureById(fixtures: SeedFixture[], id: string): SeedFixture {
  const found = fixtures.find((f) => f.id === id);
  if (!found) throw new Error(`fixture "${id}" not found in extraction_fixtures_seed.jsonl`);
  return found;
}

describe('resolveDue reproduces the seed fixture date cases', () => {
  const fixtures = loadFixtures();

  it('date-weekday-01: "by Friday" from Wednesday 2026-07-08 -> this Friday', () => {
    const fixture = fixtureById(fixtures, 'date-weekday-01');
    const spec: DueSpec = { kind: 'weekday', day: 'friday', which: 'this' };
    expect(resolveDue(spec, fixture.today)).toBe(fixture.gold.due_resolved);
  });

  it('date-relative-01: "in two weeks" -> days:14', () => {
    const fixture = fixtureById(fixtures, 'date-relative-01');
    const spec: DueSpec = { kind: 'in_days', days: 14 };
    expect(resolveDue(spec, fixture.today)).toBe(fixture.gold.due_resolved);
  });

  it('date-absolute-01: "December 3rd" transcribed with the current year, no rollover needed', () => {
    const fixture = fixtureById(fixtures, 'date-absolute-01');
    const spec: DueSpec = { kind: 'on_date', date: '2026-12-03' };
    expect(resolveDue(spec, fixture.today)).toBe(fixture.gold.due_resolved);
  });
});

describe('resolveDue edge cases', () => {
  it('null spec resolves to null (no due date)', () => {
    expect(resolveDue(null, '2026-07-08')).toBeNull();
  });

  it('on_date rolls forward one year when the naive same-year date has already passed', () => {
    // "January 5th" said in July 2026 - the model transcribes the current year (2026), but
    // Jan 5 2026 is already in the past, so resolveDue must roll it to 2027.
    const spec: DueSpec = { kind: 'on_date', date: '2026-01-05' };
    expect(resolveDue(spec, '2026-07-08')).toBe('2027-01-05');
  });

  it('on_date does not roll forward when the date is today', () => {
    const spec: DueSpec = { kind: 'on_date', date: '2026-07-08' };
    expect(resolveDue(spec, '2026-07-08')).toBe('2026-07-08');
  });

  it('on_date does not roll forward when the date is later this year', () => {
    const spec: DueSpec = { kind: 'on_date', date: '2026-08-01' };
    expect(resolveDue(spec, '2026-07-08')).toBe('2026-08-01');
  });

  it('weekday "next" adds a full week past "this"', () => {
    const thisFriday = resolveDue({ kind: 'weekday', day: 'friday', which: 'this' }, '2026-07-08');
    const nextFriday = resolveDue({ kind: 'weekday', day: 'friday', which: 'next' }, '2026-07-08');
    expect(thisFriday).toBe('2026-07-10');
    expect(nextFriday).toBe('2026-07-17');
  });

  it('weekday "this" on the current weekday resolves to today (0 days ahead)', () => {
    // 2026-07-08 is a Wednesday.
    expect(resolveDue({ kind: 'weekday', day: 'wednesday', which: 'this' }, '2026-07-08')).toBe(
      '2026-07-08',
    );
  });

  it('weekday wraps correctly when the target day is earlier in the week than today', () => {
    // From Wednesday, "this Monday" means the Monday already passed within this 7-day window
    // is NOT selected - 'this' always looks forward (0-6 days ahead), landing on next Monday.
    expect(resolveDue({ kind: 'weekday', day: 'monday', which: 'this' }, '2026-07-08')).toBe(
      '2026-07-13',
    );
  });

  it('in_days crosses a month boundary correctly', () => {
    expect(resolveDue({ kind: 'in_days', days: 30 }, '2026-07-08')).toBe('2026-08-07');
  });

  it('in_days at the lower bound (1) and upper bound (365)', () => {
    expect(resolveDue({ kind: 'in_days', days: 1 }, '2026-07-08')).toBe('2026-07-09');
    expect(resolveDue({ kind: 'in_days', days: 365 }, '2026-07-08')).toBe('2027-07-08');
  });
});
