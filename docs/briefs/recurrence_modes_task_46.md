# Task 46 (expanded) — four scheduled recurrence modes

**Brief written by the coordinator, 2026-08-24.** 🔴 **Scope expanded by Jason (2026-08-24)** from the
original "every N weeks" handoff to **four modes**. Phase 1 (this brief) is the **engine**; Phase 2 is
the **editor UI** and is committed, not optional — see §7.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.** No device work.

## 1. What is being added

The `scheduled` recurrence carries **weekdays only** today, so three very ordinary patterns are
unrepresentable: "every other Wednesday", "1st & 3rd Wednesday", and "the 15th". Add all of them as an
**additive JSON field** on the existing `scheduled` member.

```ts
type Ordinal = 1 | 2 | 3 | 4 | 'last';

| { type: 'scheduled'; scheduledDays: Weekday[];
    repeat?:
      | { mode: 'everyWeek' }                                      // default — today's behaviour
      | { mode: 'interval'; weeks: number }                        // every N weeks, on scheduledDays
      | { mode: 'ordinal'; ordinals: Ordinal[]; months?: number }  // 1st & 3rd Wed, every N months
      | { mode: 'dayOfMonth'; days: number[]; months?: number }    // the 1st & 15th, every N months
  }
```

🔴 **NO MIGRATION.** `recurrence_pattern` is free-form JSON (`CHECK (json_valid(...))` only), so this is
additive. ⚠ **Do NOT add a new `recurrence_type` value** — that column has
`CHECK (recurrence_type IN ('scheduled_quota','quota','scheduled','unscheduled','count'))`, and changing
a CHECK on an existing column triggers constraint #12's full DROP+RENAME rebuild. Staying inside
`scheduled` avoids that entirely.

**Why an explicit `mode` discriminant** rather than inferring from which field is present: distinguishing
states by absence is the shape that already cost this project real pain (`null` vs `unscheduled`,
constraint #7 — two absent-ish states with *opposite* semantics). An explicit tag also gives
`period.ts`'s switch compile-time exhaustiveness, so a fifth mode later cannot silently fall through.

## 2. Rulings already made (build to these)

| Question | Ruled |
|---|---|
| Anchor for `interval` / `months` strides | **Task creation date.** Fixed cadence, no drift, and **no date-picker** — the app has none and this deliberately does not introduce one. |
| `'last'` as an ordinal | **Yes, include it.** "Last Friday" is common and differs from "4th" in five-weekday months. |
| Backward compatibility | 🔴 **`repeat` absent MUST mean `everyWeek`** — identical to today's behaviour. Jason's alpha DB has **3 real recurring tasks** with no `repeat` field. **Pin this with a test against the existing row shape.** |

## 3. Edge cases — decide, implement, and state your choice in the report

- **`dayOfMonth` 29/30/31 in short months.** Recommendation: **clamp to the month's last day** (so "the
  31st" fires 28 Feb) rather than skipping the month — a skipped rent reminder is the worse failure.
  Implement the clamp, and say so explicitly; it is a product-visible choice.
- **`ordinal` 5th** does not exist — that is what `'last'` is for; ordinals are 1–4 plus `'last'`, and
  `'last'` must equal the 4th in four-weekday months and the 5th in five-weekday months.
- ⚠ **The one modelling compromise, named rather than hidden:** `dayOfMonth` does not use
  `scheduledDays` at all. **Require `scheduledDays: []` in that mode and enforce it in the validator plus
  a test**, so the dead field cannot quietly carry stale data. *(The honest alternative — a new
  `recurrence_type` — costs a CHECK rebuild; the coordinator judged that not worth it here. If you think
  that is wrong, say so in the report rather than doing it.)*

## 4. The engine work

- **`src/types/domain.ts`** — extend the `Recurrence` union as above. It is the **authoritative**
  vocabulary (orientation §3), so the type must make illegal states unrepresentable where it can.
- **`src/services/recurrence/period.ts`** — the arithmetic. The existing seams are
  `nextOccurrenceOnOrAfter(from, days)` and `nextOccurrenceAfter(from, days)`; extend or wrap them so
  every mode resolves through **one** entry point that switches exhaustively on `mode`. Keep the
  module's existing character: **pure local-calendar arithmetic, DST-correct, no UTC-ms date math.**
- **`src/services/recurrence/advance.ts`** — the sweep dispatches at `:140`
  (`recurrence.type === 'scheduled' || 'scheduled_quota'`). The new modes must roll `resetDate` and
  `last_period_shortfall` correctly. For `ordinal`/`dayOfMonth` the natural period is the **month** and
  the natural quota is the **number of occurrences per month**.
- **Constraint #5 is load-bearing here:** R8's accrual gate is `anchor + period/(1+quota)`. Confirm the
  new modes feed it sensibly (1st & 3rd → month/3 ≈ 10 days) and 🔴 **prove the neglect anchor is
  untouched** — task 36 proved this for the existing types and the property must survive.

## 5. The test that pins the distinction permanently

🔴 **"Every other Wednesday" and "1st & 3rd Wednesday" are NOT the same schedule and they drift apart** —
a fortnightly stride ignores month boundaries, while `ordinal` resets monthly, so you periodically get a
three-week gap between the 3rd and the next 1st. **Write a test that runs both across several months and
asserts they produce different dates.** That converts a fact people habitually get wrong into a guarded
one. It is the single most valuable test in this task.

## 6. Test-first (`CLAUDE.md`)
Every mode gets its failing test before its implementation. Beyond §5, cover at minimum: the
backward-compatibility default (§2), the short-month clamp, `'last'` in four- vs five-weekday months, a
month stride crossing a year boundary, and DST transitions in each mode. **Name the guarding test for
each behaviour in your report.**

## 7. Phase 2 exists and is not optional

Phase 1 ships an engine with **no way for a user to reach it**. 🔴 **That is precisely the state task 14
sat in** — a complete, tested backup ladder invoked by nothing, which took a later task to wire and left
two capabilities looking shipped while unreachable. **Say plainly in your report that these modes are
unreachable until Phase 2**, and list exactly what the editor needs: a mode selector after weekday
selection, an interval stepper, ordinal chips (1st/2nd/3rd/4th/Last), a day-of-month multi-select, and a
month-stride stepper — all reusing the existing `SelectChip` primitive. **Do not build the UI here.**

## 8. Constraints
- No migration, no schema change, no new `recurrence_type` value.
- Constraint #5 (uncapped neglect; anchor untouched), #6 (scales), #7 (`null` ≠ `unscheduled`).
- Don't change existing behaviour for any current recurrence type — the three live alpha tasks must
  behave identically.

## 9. Verify
Baseline **1038 tests / 89 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. Raw `npx jest` now
reports the true number (worktrees were removed 2026-08-22) — no subtraction.

## 10. Deliverable
Engine + tests (uncommitted) + `docs/eval/task46_phase1_findings_report.md`: the type shape as built,
each mode's arithmetic and its guarding tests, your edge-case choices (§3) stated as choices, the drift
test from §5, proof the neglect anchor is untouched, what Phase 2 must build, and a section titled
exactly **"Deviations from human decisions"** (empty is valid — write it out).

## 11. Read first
1. This brief. 2. `src/types/domain.ts` (the `Recurrence` union + its comment on why it is discriminated).
3. `src/services/recurrence/period.ts` and `advance.ts`; `docs/eval/task36_findings_report.md`.
4. `src/db/migrations/001_initial_schema.sql:89-107` (the CHECK you must not touch) and
`006_recurrence_period.sql`. 5. Spec v2.4 §4.2. 6. `CLAUDE.md`; orientation §3, §4.
