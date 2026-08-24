# Task 46 Phase 1 amendment — ordinal becomes (ordinal, weekday) cells

**Brief written by the coordinator, 2026-08-24, ruled by Jason the same day.** A small, surgical
amendment to the engine that landed in `b238649`. **Read `docs/briefs/recurrence_modes_task_46.md`
and `docs/eval/task46_phase1_findings_report.md` first** — this changes one mode's shape, nothing else.

> **Do not back-edit** the Phase 1 brief or its report. Write a **new** report.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.**

## 1. Why (the UI drove this, and it is a real mismatch)

Jason has specified the editor's ordinal control as a **6×7 grid of checkboxes** — columns
**Sunday–Saturday**, rows **1st, 2nd, 3rd, 4th, 5th, Last** — where each ticked cell is one
occurrence.

Phase 1 shipped a **cross product**: `{ mode: 'ordinal'; ordinals: Ordinal[] }` combined with the
member's top-level `scheduledDays: Weekday[]`. That can express *1st & 3rd Wednesday*, but it
**cannot** express *1st Monday + 3rd Wednesday* — `[1st,3rd] × [Mon,Wed]` yields **four** occurrences,
not the two ticked. The grid would have to fill in cells the user did not check, which is worse than
useless.

## 2. The change

```ts
export type Ordinal = 1 | 2 | 3 | 4 | 5 | 'last';   // literal 5 ADDED

| { mode: 'ordinal'; cells: Array<{ ordinal: Ordinal; weekday: Weekday }>; months?: number }
```

- **A strict superset.** Everything the cross product could express is still expressible; nothing is
  lost.
- 🔴 **No migration, and no data risk at all: nothing has ever written an `ordinal` repeat.** Phase 1
  is hours old and the modes are unreachable — no editor, no draft, no extraction mapper constructs a
  `repeat` (Phase 1's report verified this). Confirm it yourself, then change the shape freely.

**`Ordinal` gains a literal `5`, and `'last'` stays.** They are different and both are wanted:
- **literal `5`** fires only in months that *have* a 5th of that weekday, and simply does not fire in
  months that don't;
- **`'last'`** always fires — equal to the 4th in a four-weekday month and the 5th in a five-weekday one.

## 3. The invariant, now simpler

With the weekday carried inside each cell, `scheduledDays` is unused in `ordinal` mode — exactly as it
already is in `dayOfMonth`. **Extend the existing enforced invariant** (`recurrenceRepeatIssue`, checked
on both `create` and `update`) so it reads as one clean rule:

> `scheduledDays` is used by **`everyWeek` and `interval` only**, and MUST be empty in `ordinal` and
> `dayOfMonth`.

Keep it enforced at both writers, as Phase 1 did — not merely documented.

## 4. Tests

Amend the existing ordinal tests to the new shape, and **add the one that pins the distinction this
change introduces**:

🔴 **`5` vs `'last'` must be proven different.** In a month whose Wednesdays number five, `5` and
`'last'` resolve to the **same** date; in a month with four, `5` **does not fire at all** while
`'last'` lands on the 4th. One test across both month shapes. This is the assertion that stops someone
later "simplifying" one into the other.

Also keep green, updating to the new shape where needed:
- **The drift test** (Phase 1 §5) comparing interval vs ordinal — it is the most valuable test in the
  task; preserve its intent exactly.
- The **mixed-cell case the amendment exists for**: `1st Monday + 3rd Wednesday` produces exactly two
  occurrences a month, not four. That case was previously *unrepresentable*, so it is new coverage.
- Constraint #5 per mode (neglect anchors untouched), and the `scheduledCycle` feed into R8 — with
  cells, the occurrences-per-month count is simply `cells.length`.

**Test-first:** write each new/changed assertion, watch it fail against the current cross-product
implementation, then implement. Name the guarding test for each behaviour.

## 5. Constraints
- No migration, no schema change, no new `recurrence_type` value.
- Do not touch `everyWeek`, `interval`, or `dayOfMonth` semantics.
- `repeat` absent still means `everyWeek` — Phase 1's three-place backward-compatibility pinning must
  survive unchanged (the live alpha rows still matter).
- Keep `period.ts`'s character: pure local-calendar arithmetic, DST-correct, no UTC-ms date math.

## 6. Verify
Baseline **1121 tests / 92 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings.

## 7. Deliverable
The amendment (uncommitted) + `docs/eval/task46_phase1_amendment_report.md`: the shape as built, the
`5`-vs-`'last'` test output, confirmation that nothing had written an ordinal repeat, the updated
invariant, real verification numbers, and a section titled exactly **"Deviations from human
decisions"** (empty is valid — write it out).

## 8. Read first
1. This brief. 2. `docs/briefs/recurrence_modes_task_46.md` + `docs/eval/task46_phase1_findings_report.md`.
3. `src/types/domain.ts` (`Ordinal`, `ScheduledRepeat`, the `scheduled` member and its comment),
`src/services/recurrence/period.ts` (`nextScheduledOnOrAfter`), `advance.ts`,
`src/db/repositories/recurrence.ts` (`recurrenceRepeatIssue`). 4. `CLAUDE.md`.
