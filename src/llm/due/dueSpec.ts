// DueSpec union + resolveDue (strategy D5): the model transcribes a relative-date expression,
// code resolves it to an ISO date against the device clock. Dates are computed in UTC
// throughout - these are pure calendar dates (no time-of-day), and UTC keeps day-arithmetic
// free of local-timezone/DST drift.
import type { Weekday } from '../../types/domain';

export type DueSpec =
  | null
  | { kind: 'on_date'; date: string } // 'YYYY-MM-DD'; see resolveDue's on_date branch for how the year is handled
  | { kind: 'in_days'; days: number } // 1..365
  | { kind: 'weekday'; day: Weekday; which: 'this' | 'next' };

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatISODate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Resolves a DueSpec to an ISO date string against `todayISO`, or null for `spec === null`
 * (no due date). Assumes `spec` has already passed schema/validator checks (D10) - this is a
 * pure mapping function, not a validator.
 *
 * `on_date`'s year handling is the one non-obvious piece: the model transcribes using the
 * current year (given to it as a literal in the prompt, not computed - "December 3rd" becomes
 * `date: "2026-12-03"` when today is in 2026), so this is transcription, not date math. What
 * *is* code's job (D5's "year inference") is noticing when that naive same-year date has
 * already passed relative to `today` and rolling it forward one year - e.g. "January 5th" said
 * in July 2026 comes in as "2026-01-05" and must resolve to "2027-01-05".
 */
export function resolveDue(spec: DueSpec, todayISO: string): string | null {
  if (spec === null) return null;
  const today = parseISODate(todayISO);

  switch (spec.kind) {
    case 'on_date': {
      const target = parseISODate(spec.date);
      if (target.getTime() < today.getTime()) {
        const rolled = new Date(target.getTime());
        rolled.setUTCFullYear(rolled.getUTCFullYear() + 1);
        return formatISODate(rolled);
      }
      return formatISODate(target);
    }
    case 'in_days':
      return formatISODate(addDays(today, spec.days));
    case 'weekday': {
      const todayDow = today.getUTCDay();
      const targetDow = WEEKDAY_INDEX[spec.day];
      let daysAhead = (targetDow - todayDow + 7) % 7;
      if (spec.which === 'next') {
        daysAhead += 7;
      }
      return formatISODate(addDays(today, daysAhead));
    }
  }
}
