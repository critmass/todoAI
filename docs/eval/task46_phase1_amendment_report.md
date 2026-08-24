# Task 46 Phase 1 amendment — `ordinal` becomes (ordinal, weekday) CELLS

**Status: amendment complete, uncommitted, and the four modes are STILL unreachable by a user** —
this changes one mode's shape, not its reachability. Phase 2 (the editor) remains outstanding, and
§6 below says what the amendment changes about what Phase 2 must build.

| Gate | Baseline (b238649) | After |
|---|---|---|
| `npx jest` | 1121 tests / 92 suites | **1128 tests / 92 suites** (+7 tests, no new suites), all green |
| `npx tsc --noEmit` | clean | clean |
| `npx eslint .` | 0 errors / 56 warnings | 0 errors / 56 warnings (identical set) |

Raw `npx jest` counts are the true ones — this worktree contains no nested worktree, and the
baseline was re-measured here at 1121/92 before a line was touched.

### Files touched (8, all modified; no new files, no new suites)

| File | What |
|---|---|
| `src/types/domain.ts` | `Ordinal` gains a literal `5`; new `OrdinalCell`; `ordinal` carries `cells`; the `scheduledDays` rule unified into one predicate |
| `src/services/recurrence/period.ts` | `ordinalDatesInMonth` resolves cells; the month scan gets a real horizon |
| `src/db/repositories/tasks.ts` | `scheduledCycle` — occurrences per month is now `cells.length` |
| `src/services/recurrence/__tests__/period.repeat.test.ts` | the arithmetic, the 🔴 tests, the drift test, DST |
| `src/services/recurrence/__tests__/advance.repeat.test.ts` | the sweep, per mode |
| `src/types/__tests__/recurrenceRepeat.test.ts` | on-disk shape, round trip, validator |
| `src/db/repositories/__tests__/recurrence.test.ts` | write-side enforcement at both writers |
| `src/db/repositories/__tests__/tasks.test.ts` | R8's gate for the new count |

`advance.ts` needed **no change**: it already passes `scheduledDays` + `repeat` + `anchor` into the
one entry point, and `ordinal` simply stops reading the first of those.

---

## 1. 🔴 Confirmed before the shape changed: nothing has ever written an `ordinal` repeat

Checked directly rather than taken from the Phase 1 report. **Exactly two places in the codebase
construct a `scheduled` recurrence, and neither can emit a `repeat` at all** — the field is not
optional-and-sometimes-set, it is unreachable:

- `src/app/tasks/taskDraft.ts:240` — `return { type: 'scheduled', scheduledDays: [...draft.scheduledDays] };`
- `src/llm/extraction/mapper.ts:35` — `return { type: 'scheduled', scheduledDays: spec.days };`

A repo-wide grep for `repeat` outside `src/types/domain.ts`, `src/services/recurrence/` and the
tests returns only `repeated_extension` / `repeated_failures` (unrelated columns) and comments.
`src/app/screens/RecurrenceEditor.tsx` touches `draft.scheduledDays` and nothing else. So:

- **no migration** (`recurrence_pattern` is still free-form JSON, `CHECK (json_valid(...))` only),
- **no data at risk** — there is no row, in the alpha DB or anywhere, whose pattern contains
  `"mode":"ordinal"`,
- and the old cross-product spelling is now treated as junk on read (§4), which costs nothing
  because nothing ever wrote it.

**The three live alpha rows are untouched by all of this.** They have no `repeat` key, and Phase 1's
three-place backward-compatibility pinning is unchanged and still green: `recurrenceRepeat.test.ts` →
*"reads a row with NO repeat key as the schedule it has always been"* / *"writes a plain weekly
schedule back in exactly that shape"* / *"normalises an EXPLICIT everyWeek to the same absent-key
shape"*, and `advance.repeat.test.ts` → *"sweeps exactly as it did before: no repeat key means every
week"* / *"keeps advancing weekly week after week, never fortnightly"*.

---

## 2. The shape, as built

```ts
/** One ROW of the editor's 6×7 grid (1st, 2nd, 3rd, 4th, 5th, Last). */
export type Ordinal = 1 | 2 | 3 | 4 | 5 | 'last';        // literal 5 ADDED

/** One ticked box: a column (weekday) and a row (ordinal). EACH CELL IS ONE OCCURRENCE. */
export type OrdinalCell = { ordinal: Ordinal; weekday: Weekday };

  | { mode: 'ordinal'; cells: OrdinalCell[]; months?: number }   // 1st Mon + 3rd Wed; every N months
```

`OrdinalCell` is a name for the brief's inline `Array<{ ordinal: Ordinal; weekday: Weekday }>` —
structurally the identical type, named because `period.ts` and the tests both take it as a
parameter. Nothing else in the union moved: `everyWeek`, `interval` and `dayOfMonth` are byte-for-byte
what Phase 1 shipped, and `repeat` absent still means `everyWeek`.

**A strict superset, as promised.** `[1,3] × [Wednesday]` becomes two cells; the mixed grid the
product could not express becomes two cells that share neither ordinal nor weekday.

### Where the change is load-bearing downstream

- **`period.ts`** — `ordinalDatesInMonth(index, cells)`: per cell, take that weekday's dates in the
  month and index by the ordinal (`'last'` → the final one). Sorted, de-duplicated, and it never
  reads `scheduledDays`.
- **`tasks.ts`** — occurrences per month is now literally `Math.max(1, cells.length)` rather than
  `ordinals.length × weekdays`. R8's gate is unchanged in form (`cycle / (1 + occurrences)`) and every
  pre-existing number in the table is unchanged; the new fact is that a mixed grid counts correctly:
  1st Monday + 3rd Wednesday is 30 / (1 + **2**) = 10 d, where the product would have said 4 and
  gated at 6 d. Guarded by `tasks.test.ts` → *"ordinal is a MONTHLY cycle: 1st & 3rd Wednesday is
  30 / (1 + 2) ≈ 10 d"*, which now carries all three cases.

---

## 3. 🔴 The test that matters most: `5` and `'last'` are different, in both shapes of month

`period.repeat.test.ts` → **"🔴 a literal 5th and 'last' are DIFFERENT ordinals, across both shapes
of month"** — one test, both month shapes, so neither half can be deleted without the other going
red. Fixture: **August 2026 has FOUR Wednesdays** (5, 12, 19, 26); **September 2026 has FIVE**
(2, 9, 16, 23, 30).

```
five-Wednesday month : 5th → 2026-09-30      'last' → 2026-09-30     (identical — hence the confusion)
four-Wednesday month : 5th → does not fire   'last' → 2026-08-26     (the whole month is skipped)

'last', six occurrences : Aug 26, Sep 30, Oct 28, Nov 25, Dec 30, Jan 27
5th,   four occurrences : Sep 30, Dec 30, Mar 31, Jun 30
```

The August assertion is made as a whole-month set — `inMonth(fifth, '2026-08')` is `[]`, not merely
"the next occurrence is later" — so "does not fire at all" is asserted as absence, not inferred.

**Watched fail first, for the right reason.** Against the cross-product implementation the very
first assertion failed as:

```
● ordinal … › 🔴 a literal 5th and 'last' are DIFFERENT ordinals, across both shapes of month
  expect(received).toBe(expected)
  Expected: "2026-09-30"
  Received: null
      at expect(nextScheduledOnOrAfter('2026-09-01', fifth)).toBe('2026-09-30');
```

(null, because the old code read the weekday from an empty `scheduledDays` and had no notion of a
5th at all — the validator rejected `5` outright.)

### The horizon a literal `5` forced — a judgement call, stated as one

`nextMonthlyOccurrence` used to try **three** on-months, on the reasoning that "two always suffice,
the third is belt-and-braces". That is true of `dayOfMonth` and of ordinals 1–4 and `'last'`, all of
which name a date in *every* on-month. **A literal `5` does not** — up to four consecutive months can
lack a fifth Wednesday at a monthly stride, and with a month stride the wait is far longer ("the 5th
Sunday of February, every 12 months" has a real worst case of **forty years**, which I measured
rather than guessed). So the scan is now bounded at **600 on-month attempts**, counted in *attempts*
rather than calendar months so the horizon scales with the stride (50 years monthly, 600 yearly) while
the work stays bounded. Past it the answer is `null` — the same "this schedule names no occurrence"
the empty cases already give, never a fabricated date. Guarded by *"a literal 5th on a month stride
waits as long as it has to, rather than giving up"* (quarterly 5th-Wednesday from Aug 2026 → the
first on-month with a fifth Wednesday is **May 2028**, eight on-months out — a three-attempt scan
answers "never").

---

## 4. The new mixed-cell case, and the rest of the ordinal coverage

| Behaviour | Guarding test (`period.repeat.test.ts` unless noted) |
|---|---|
| 🔴 **1st Monday + 3rd Wednesday is TWO occurrences a month, not four** | *"🔴 mixes cells freely: 1st Monday + 3rd Wednesday is TWO occurrences a month, not four"* — asserts the **whole month** for Aug/Sep/Oct 2026 (`['2026-08-03','2026-08-19']`, …) and names the two dates the cross product used to invent (1st Wednesday 5 Aug, 3rd Monday 17 Aug) as absent |
| the same case through the real sweep | `advance.repeat.test.ts` → *"a mixed grid sweeps to exactly the ticked cells: 1st Monday, then 3rd Wednesday"* — due 3 Aug, completed, then **19 Aug and not 17 Aug** |
| 1st & 3rd Wednesday still resets monthly | *"resets every month: the 1st and 3rd Wednesday of each one"* (unchanged expectations, new shape) |
| `'last'` = the 4th in a four-weekday month | *"'last' equals the 4th in a four-Wednesday month"* |
| `'last'` = the 5th in a five-weekday month, where 4 is not | *"'last' equals the FIFTH in a five-Wednesday month, where the 4th does not"* |
| two cells naming the same date fire once | *"collapses two cells that name the same date instead of firing twice"* (4th + last in August; 5th + last in September) |
| ticking order is irrelevant | *"sorts a month's ticked cells into date order, whatever order they were ticked in"* |
| month strides, across a year boundary | *"strides whole months, crossing a year boundary"* |
| the weekday comes from the cell, never from `scheduledDays` | *"takes its weekday from the CELL, never from scheduledDays"* — a stray list produces an identical sequence |
| an empty grid invents nothing | *"names no occurrence when no cell is ticked"* (with and without a stray `scheduledDays`) |
| DST | *"ordinal picks the same Sunday whether or not the clocks changed that day"* — 2nd + last Sunday of March 2027 are the US and EU transition days themselves |
| round trip on disk | `recurrenceRepeat.test.ts` → *"survives write-then-read unchanged"*, now including a three-cell mixed grid with a literal `5` and a `months` stride |
| no new `recurrence_type` | `recurrenceRepeat.test.ts` → *"does not add a recurrence_type value"*; `recurrence.test.ts` → *"stores and reads back … without a new recurrence_type"* (its ordinal case is now a mixed grid) |
| junk degrades to weekly, never throws | `recurrenceRepeat.test.ts` → *"degrades an unreadable repeat to weekly"* — now also covers **the Phase 1 cross-product spelling** (`{"mode":"ordinal","ordinals":[1,3]}`, no cells), an out-of-range `ordinal: 6`, a `weekday: "someday"`, and legal cells carrying stale weekdays |
| R8's gate | `tasks.test.ts` → *"ordinal is a MONTHLY cycle …"* (three cases incl. the mixed grid) |
| constraint #5, idempotency, absence, no period accounting | `advance.repeat.test.ts` → the four `it.each(modes)` blocks, unchanged in intent, with the ordinal row re-shaped |

### 🔴 The drift test's intent is preserved exactly

`period.repeat.test.ts` → **"'every other Wednesday' is NOT '1st & 3rd Wednesday'"** — all three
tests, all three assertions, unchanged in every particular. The only edit is the ordinal spec's
spelling (`ordinals: [1,3]` + `scheduledDays: ['wednesday']` → two cells, `scheduledDays: []`). The
sequences, the "first four are identical" claim, the `{14}`-vs-`{14,21}` gap sets and the 13-vs-12
count all still hold and still pass:

```
fortnightly : Aug 5, Aug 19, Sep 2, Sep 16, Sep 30, Oct 14, …
1st & 3rd   : Aug 5, Aug 19, Sep 2, Sep 16, Oct  7, Oct 21, …
```

---

## 5. The invariant, now one rule, still enforced at both writers

> **`scheduledDays` is used by `everyWeek` and `interval` only, and MUST be empty in `ordinal` and
> `dayOfMonth`.**

Implemented as a single predicate, `monthModeScheduledDaysIssue(mode, scheduledDays)`, called from
both month-driven branches of `recurrenceRepeatIssue` — so the two modes cannot drift apart, and the
message names the rule rather than the mode's local excuse. `recurrenceRepeatIssue` is still used in
**both directions**: `recurrenceRepository.create` **and** `update` refuse to write anything it
rejects (`requireValidRepeat`, unchanged), and `recurrencePatternToRecurrence` refuses to load it,
degrading to weekly. A hand-edited row with `mode:'ordinal'` and stray weekdays therefore reads back
as a plain weekly schedule rather than as a half-trusted ordinal one.

Guarded at three levels:

- the rule itself — `recurrenceRepeat.test.ts` → *"🔴 ONE RULE: scheduledDays belongs to everyWeek and
  interval, and must be empty in the two month modes"*, which asserts **both** month modes are
  rejected and **both** week modes are still accepted with weekdays;
- the writers — `recurrence.test.ts` → *"🔴 refuses an ordinal recurrence that still carries weekdays,
  on create AND on update"* (nothing written on create; the stored row untouched by the rejected
  update), beside Phase 1's equivalent for `dayOfMonth`;
- the reader — the stale-weekday row in the *"degrades an unreadable repeat to weekly"* list.

The other ordinal legality rules moved with the shape: a non-array or empty `cells`, a cell that is
not an object, an ordinal outside `1–5 | 'last'`, a weekday that is not a weekday, and a non-positive
`months` are each rejected with a message that says what a cell is. Cell validation uses `findIndex`,
not `find`, so a literal `undefined` in the array is caught rather than read as "nothing wrong".

---

## 6. What this changes for Phase 2 (the editor is still the missing half)

🔴 **The four modes remain unreachable by a user.** Nothing constructs a `repeat` — not
`taskDraft.ts`, not `RecurrenceEditor.tsx`, not `mapper.ts` — so Phase 1's "task 14 state" warning
stands unchanged and this must still not be recorded as "recurrence modes shipped".

Two items on Phase 1's Phase-2 list are now **superseded** (recorded here, not back-edited into that
report):

- **"ordinal chips — 1st / 2nd / 3rd / 4th / Last, multi-select" is replaced by the 6×7 grid**:
  columns Sunday–Saturday, rows 1st / 2nd / 3rd / 4th / **5th** / Last, each ticked cell emitting one
  `{ ordinal, weekday }`. The grid is the *only* control for this mode — there is no weekday row
  feeding it.
- **Switching into `ordinal` must clear `scheduledDays`**, exactly as switching into `dayOfMonth`
  already must (§5). Both throw `RecurrenceValidationError` at the user if the UI ignores it.

Worth surfacing in the UI copy: **the 5th row and the Last row are not the same thing**, and a user
who ticks "5th Wednesday" will see nothing in a month with four. That is the requested behaviour, but
it is the one cell in the grid whose meaning a user can get wrong.

---

## 7. Verification

- `npx jest` — **1128 tests / 92 suites**, all green (baseline 1121 / 92; +7 tests, no new suites).
- `npx tsc --noEmit` — clean.
- `npx eslint .` — **0 errors, 56 warnings**, the same pre-existing `src/dev/` set as the baseline.
- **Test-first, per `CLAUDE.md`.** Every changed and new assertion was written first and **watched
  fail against the cross-product implementation**: `30 failed, 107 passed` across the five affected
  suites, and every one of the 30 failures was ordinal-related — the `everyWeek`, `interval` and
  `dayOfMonth` tests stayed green throughout, which is itself the evidence that those semantics were
  not touched. The headline failure is quoted verbatim in §3. **No carve-outs taken** — every change
  here is behavioural and every one is covered.
- **Uncommitted**, as instructed. 8 files modified, 0 added.
- Housekeeping: the patch scripts wrote CRLF into seven files; `.gitattributes` mandates LF in the
  working tree (`* text=auto eol=lf`, added precisely because a Windows tool once rewrote 220 files),
  so they were converted back to LF before verification. `git diff --stat` shows only the real
  changes: **+444 / −127** across the eight files.

---

## 8. Deviations from human decisions

**None.**

Everything ruled in the amendment brief was built as ruled: `cells` replacing the cross product,
`Ordinal` gaining a literal `5` alongside `'last'`, one test proving the two differ across both
shapes of month, the mixed-cell case, the drift test's intent preserved exactly, the unified
`scheduledDays` invariant enforced at both writers, no migration, no new `recurrence_type`, no change
to `everyWeek` / `interval` / `dayOfMonth`, `repeat` absent still meaning `everyWeek` with Phase 1's
three-place pinning intact, and `period.ts` still pure local-calendar arithmetic with no UTC-ms date
math.

**Two things the amendment forced that nobody ruled on, flagged so they can be overruled cheaply:**

1. **The 600 on-month scan horizon** (§3). The old three-attempt scan is *incorrect* for a literal
   `5` — it would answer "never" for any schedule whose next fifth weekday is more than three
   on-months away — so a horizon had to be chosen. 600 attempts is generous enough to cover the
   forty-year worst case at a yearly stride and cheap enough to be uninteresting. If the coordinator
   prefers a different number, it is a one-line change with the reasoning already in the comment.
2. **`OrdinalCell` as a named exported type** rather than the brief's inline
   `Array<{ ordinal: Ordinal; weekday: Weekday }>`. Structurally the identical type; named because
   `ordinalDatesInMonth` and the tests both take it as a parameter and an inline literal would be
   repeated seven times.

**Phase 1's own recorded deviation is carried forward untouched and was not re-litigated here:** the
new modes still do not roll `reset_date` / `last_period_shortfall`, because nothing increments
`current_period_progress` for a `scheduled` task and a monthly roll would record a permanent
fabricated shortfall (Phase 1 report §9). Its guarding test still runs once per mode
(*"%s: still no period accounting — reset_date stays null"*) and still passes with the re-shaped
ordinal row.
