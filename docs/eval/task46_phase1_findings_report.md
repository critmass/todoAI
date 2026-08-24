# Task 46 Phase 1 Findings — four `scheduled` recurrence modes (the engine)

**Status: Phase 1 complete, uncommitted, and DELIBERATELY UNREACHABLE BY A USER.** The types, the
calendar arithmetic, the sweep dispatch, the R8 accrual gate and the write-side validator are built
and covered. **No editor UI was built** — that is Phase 2, and §7 below says exactly what it must
contain. See §8 for the "task 14 state" warning, stated plainly as the brief demands.

| Gate | Baseline | After |
|---|---|---|
| `npx jest` | 1038 tests / 89 suites | **1121 tests / 92 suites** (+83 / +3), all green |
| `npx tsc --noEmit` | clean | clean |
| `npx eslint .` | 0 errors / 56 warnings | 0 errors / 56 warnings (identical set) |

**No migration. No schema change. No new `recurrence_type` value.** `recurrence_pattern` is
free-form JSON (`CHECK (json_valid(...))` and nothing else), so the whole feature is additive inside
the existing `'scheduled'` type and constraint #12's DROP+RENAME rebuild is never approached. A test
asserts this directly rather than leaving it to inspection —
`recurrence.test.ts` → *"stores and reads back … without a new recurrence_type"* reads
`recurrence_type` straight out of SQLite for every mode.

### Files touched

| File | What |
|---|---|
| `src/types/domain.ts` | `Ordinal`, `ScheduledRepeat`, `repeat?` on `scheduled`; pattern read/write; `recurrenceRepeatIssue` |
| `src/services/recurrence/period.ts` | `ScheduleSpec` + `nextScheduledOnOrAfter` / `nextScheduledAfter` — the single exhaustive entry point |
| `src/services/recurrence/advance.ts` | sweep dispatch through the new entry point; `strideAnchor` |
| `src/services/recurrence/index.ts` | barrel exports |
| `src/db/repositories/recurrence.ts` | `requireValidRepeat` on `create` **and** `update` |
| `src/db/repositories/tasks.ts` | `scheduledCycle` — R8's gate for the new modes |
| `+ 3 new test files`, `+ 2 extended` | see §6 |

---

## 1. The type, as built

```ts
export type Ordinal = 1 | 2 | 3 | 4 | 'last';

export type ScheduledRepeat =
  | { mode: 'everyWeek' }                                     // identical to the field being absent
  | { mode: 'interval'; weeks: number }                       // every N weeks, on scheduledDays
  | { mode: 'ordinal'; ordinals: Ordinal[]; months?: number }  // 1st & 3rd Wed, every N months
  | { mode: 'dayOfMonth'; days: number[]; months?: number };   // the 1st & 15th, every N months

| { type: 'scheduled'; scheduledDays: Weekday[]; repeat?: ScheduledRepeat }
```

Unchanged from the brief. The explicit `mode` discriminant does the two jobs it was chosen for: it
keeps the union out of the `null`-vs-`unscheduled` failure shape (constraint #7 — states told apart
by absence), and it makes `nextScheduledOnOrAfter`'s switch exhaustive, so a fifth mode added later
fails to compile in `period.ts` rather than silently behaving weekly.

### Backward compatibility, pinned in three places

`repeat` absent **means** `everyWeek`. Jason's alpha DB has three live recurring rows with no
`repeat` key, and they must keep meaning what they have always meant:

1. **Read** — `recurrenceRepeat.test.ts` → *"reads a row with NO repeat key as the schedule it has
   always been"* parses the literal legacy JSON `{"scheduledDays":["monday","thursday"]}` and asserts
   the result has no `repeat` property at all (not `{mode:'everyWeek'}`) — so nothing downstream can
   begin to tell an old row from a new weekly one, because there is no difference to tell.
2. **Write** — *"writes a plain weekly schedule back in exactly that shape"* asserts the emitted JSON
   is key-for-key the pre-task-46 shape. **An explicit `{mode:'everyWeek'}` is normalised away on
   write** (*"normalises an EXPLICIT everyWeek to the same absent-key shape"*). This is a choice: the
   Phase 2 editor will always emit a mode, and without the normalisation, opening and saving an
   untouched weekly task would rewrite every live row into a new shape for no behavioural gain. One
   canonical on-disk spelling of "weekly", not two.
3. **Sweep** — `advance.repeat.test.ts` → *"a pre-task-46 row … sweeps exactly as it did before"* and
   *"keeps advancing weekly week after week, never fortnightly"* insert the legacy JSON directly with
   raw SQL and run the real sweep against a real SQLite engine.

---

## 2. Each mode's arithmetic, and the test that guards it

All of it stays inside `period.ts`'s existing character: **pure local-calendar arithmetic on
`'YYYY-MM-DD'`, no UTC-ms date math, no clock, no database.** The internal cursors remain UTC-midnight
`Date` objects used purely as a calendar, exactly as before, so a 23- or 25-hour day is structurally
invisible to every step.

| Mode | Arithmetic | Guarding tests (`period.repeat.test.ts` unless noted) |
|---|---|---|
| `everyWeek` | unchanged — delegates to the existing `nextOccurrenceOnOrAfter` | *"an ABSENT repeat behaves exactly as the old weekday-only schedule did"*; *"an EXPLICIT everyWeek is the same schedule, occurrence for occurrence"* |
| `interval` | seven-day blocks measured from the anchor; block `k` is on iff `k mod weeks == 0`; scan the on-block for a wanted weekday | *"fires on alternate weeks, counted from the task's creation date"*; *"skips an OFF week rather than firing in it"*; *"ignores month boundaries entirely"*; *"weeks: 1 collapses to plain weekly"*; *"handles a three-week stride and a multi-day schedule"*; *"changes phase when the anchor changes"* |
| `ordinal` | month index aligned to the anchor's month by `months`; within an on-month, the *n*th occurrence of each scheduled weekday, `'last'` resolved per weekday; sorted, de-duplicated | *"resets every month: the 1st and 3rd Wednesday of each one"*; *"'last' equals the 4th in a four-Wednesday month"*; *"'last' equals the FIFTH in a five-Wednesday month, where the 4th does not"*; *"sorts a multi-weekday, multi-ordinal month into date order"*; *"strides whole months, crossing a year boundary"* |
| `dayOfMonth` | same month striding; each named day clamped to the month's length; sorted, de-duplicated | *"fires on that date every month"*; *"handles several days a month, in date order"*; *"CLAMPS 29/30/31 …"*; *"collapses days that clamp onto the same date"*; *"strides whole months, crossing a year boundary"* |

Empty inputs never fabricate an occurrence — an empty weekday list, an empty ordinal list or an empty
day list returns `null`, matching what task 36 established for `scheduled` (*"still refuses to invent
a day when the schedule names none"*, plus a per-mode case in each block).

**Sweep-level coverage** (`advance.repeat.test.ts`, real SQLite, injected `today`): each mode seeds a
due date, advances past a completed occurrence, and crosses its own boundary — e.g. *"crosses into
the next month when the month's ordinals are spent"*, *"'last' follows the month, not a fixed week
number"* (Aug 26 → Sep 30, four- then five-Wednesday months), *"clamps the 31st into February rather
than skipping the month"*.

### DST

`period.repeat.test.ts` → **"DST transitions, in every mode"** — four tests, one per mode, against US
2027 (forward 14 March, back 7 November) and EU 2027 (28 March / 31 October), including cases where
the transition day *is* the occurrence: `interval` holds an exact 14-day stride across both;
`ordinal` picks the 2nd and last Sunday of March 2027 (the two transition days themselves);
`dayOfMonth` is unaffected because a calendar date has no hours to lose.

---

## 3. Edge cases — stated as choices, because they are product-visible

### 3.1 `dayOfMonth` 29/30/31 in short months → **clamp to the month's last day**

Implemented as recommended. "The 31st" fires **28 February 2027**, and **29 February 2028** in a leap
year. A skipped rent reminder is the worse failure; a reminder that arrives on the 28th is merely
early. Guarded by *"CLAMPS 29/30/31 to the last day of a short month rather than skipping it"* and, at
sweep level, *"clamps the 31st into February rather than skipping the month"*.

**A consequence that falls out of the clamp and needed its own decision:** "the 30th and the 31st"
would both clamp onto 28 February and fire *twice on one day*. The occurrence set is
de-duplicated, so it fires once — *"collapses days that clamp onto the same date instead of firing
twice"*.

### 3.2 `'last'` is an ordinal, and there is no 5th

`Ordinal = 1 | 2 | 3 | 4 | 'last'`. `'last'` is resolved **per weekday, per month**: it equals the 4th
in a four-weekday month and the 5th in a five-weekday month (August vs September 2026 for Wednesday —
the fixture pair the whole file is built around). Ordinals 1–4 always resolve, because every month
contains at least four of every weekday. `5` is rejected by the validator with a message that says
what to use instead.

### 3.3 The `interval` week convention — anchor-aligned blocks, not ISO Mon–Sun weeks

The ruling fixed the *anchor* (task creation) but not what a "week" is. Two readings were available:

- **ISO calendar weeks** (Mon–Sun) containing the anchor. Rejected: "every other Wednesday" set up on
  a Saturday would put the Wednesday of that calendar week in the past, so the first occurrence lands
  **eleven days** away.
- **Seven-day blocks measured from the anchor date itself** — chosen. The same task fires on the
  Wednesday **four days** later, then every fortnight. The rule is one sentence: *the first
  occurrence on or after the task's creation date is on; every occurrence a whole number of strides
  later is on.*

Guarded by *"changes phase when the anchor changes — that IS the creation-date anchoring"* and, at
sweep level, *"phases off the creation date, so two identically-defined tasks can differ"*.

### 3.4 The stride anchor on disk

`task_recurrence.created_at`, read through the existing `calendarDateOfTimestamp`. It is written once
at creation and untouched by `recurrenceRepository.update`, so **redefining a schedule does not
silently re-phase it**. Two caveats are documented at `strideAnchor`:

- **A null/unreadable `created_at` falls back to a fixed constant** (`1970-01-05`, a Monday), never to
  `today` — a stride phased from the sweep's own clock would re-phase on every run and destroy
  idempotency, which is the one property the whole sweep is built on.
- `created_at` is SQLite's **UTC** `CURRENT_TIMESTAMP` while these dates are device-local. For a user
  far from UTC the anchor can be one day out. The cost is bounded to a fixed one-day phase shift for
  the life of the task and **never a wrong weekday** — the weekday still comes from `scheduledDays`.
  Same caveat, same shape, as the one task 36 recorded for `last_completed_at`.

### 3.5 An unreadable `repeat` degrades to weekly rather than throwing

`recurrenceRepeatIssue` is used in **both** directions: the repository refuses to *write* anything it
rejects, and the pattern parser refuses to *load* it, falling back to weekly. So a hand-edited or
future-version row cannot make the app unopenable, and the fallback is precisely the behaviour that
row had before task 46 anyway. Guarded by *"degrades an unreadable repeat to weekly rather than
throwing on the user's own database"* (unknown mode, `weeks: 0`, a string instead of an object, and
an ordinal `5`).

---

## 4. The modelling compromise — enforced, not commented

`dayOfMonth` does not use `scheduledDays`. **`scheduledDays` must be empty in that mode**, checked by
`recurrenceRepeatIssue` and enforced by `requireValidRepeat` on `recurrenceRepository.create` **and**
`update`, so a mode switch in the Phase 2 editor cannot leave stale weekdays on disk for a later
reader to trust. Two tests: `recurrenceRepeat.test.ts` → *"🔴 rejects dayOfMonth carrying weekdays"*
(the rule) and `recurrence.test.ts` → *"🔴 refuses to store a dayOfMonth recurrence that still carries
weekdays"* (the enforcement, including that nothing is written).

**Asked for an opinion on the alternative (a new `recurrence_type` at the cost of a CHECK rebuild):
the coordinator's call is right, and I would make the same one.** The compromise costs one field that
is required empty and is refused at the only two writers — a rule the schema cannot state but the
repository can, and does, structurally. The alternative costs a full DROP+RENAME rebuild of
`task_recurrence` (constraint #12) on a live alpha database, plus a sixth type that every existing
`switch` over `Recurrence` must learn, for a schedule that is otherwise identical in behaviour to the
other three modes. The dead field is a documented, tested constraint; the rebuild is risk on the
user's real data. No deviation taken.

---

## 5. Constraint #5 — the neglect anchor is untouched, proved the way task 36 proved it

**Nothing in this task writes to the neglect clock's anchor.** `advance.repeat.test.ts` →
*"%s: never re-anchors the neglect clock (constraint #5)"* runs **once per mode** (everyWeek absent,
interval, ordinal, dayOfMonth): it snapshots the task, runs three sweeps months apart, and asserts
`createdAt`, `lastCompletedAt` and `lastWorkedAt` — the three-way anchor from R8 and task 28 — are
byte-identical afterward. That is the same assertion task 36 made, now made per mode so a future
mode's implementation cannot quietly acquire a write.

**The gate itself reads the DEFINITION, never period state.** `neglectAccrualGapDays` keeps its
formula, `cycle / (1 + occurrences)`; task 46 only supplies the two numbers, via the new
`scheduledCycle` helper:

| Definition | Cycle | Occurrences | Gap |
|---|---|---|---|
| Monday, weekly (absent or explicit `everyWeek`) | 7 d | 1 | **3.5 d** — the pre-task-46 value, unchanged |
| Every other Wednesday | 14 d | 1 | **7 d** |
| Tue+Thu, every 3 weeks | 21 d | 2 | **7 d** |
| **1st & 3rd Wednesday** | 30 d | 2 | **10 d** — the brief's §4 worked example |
| Last Mon + last Fri, every 2 months | 60 d | 2 | **20 d** |
| The 15th | 30 d | 1 | **15 d** |
| 1st & 15th, quarterly | 90 d | 2 | **30 d** |

Guarded by five tests in `tasks.test.ts` → *"neglectAccrualGapDays with task 46 repeat modes"*,
including *"never returns a gap that would gate accrual forever, however sparse the schedule"* — a
yearly reminder still starts accruing at 180 days and the value is finite. **It remains a start
condition, never a cap**; nothing added here saturates.

---

## 6. 🔴 The test the task exists for: "every other Wednesday" ≠ "1st & 3rd Wednesday"

`period.repeat.test.ts` → **"'every other Wednesday' is NOT '1st & 3rd Wednesday'"**, three tests,
both schedules anchored to the same Monday (3 Aug 2026) and run across six months:

```
fortnightly : Aug 5, Aug 19, Sep 2, Sep 16, Sep 30, Oct 14, Oct 28, Nov 11, …
1st & 3rd   : Aug 5, Aug 19, Sep 2, Sep 16, Oct  7, Oct 21, Nov  4, Nov 18, …
```

1. *"starts identically and then drifts apart — people habitually assume it never does"* asserts the
   sequences are unequal, that the **first four occurrences are identical** (which is exactly why the
   confusion is so durable), and names the divergence: September 2026's **fifth** Wednesday sends the
   fortnightly schedule to **30 Sep** while the ordinal one has spent its month and waits for **7 Oct**.
2. *"the ordinal schedule periodically leaves a THREE-week gap; the fortnightly one never does"*
   computes the gaps: the fortnightly set is exactly `{14}` and nothing else, the ordinal one contains
   both `14` and `21`.
3. *"over six months they do not even fire the same NUMBER of times"* — 13 vs 12 by 31 Jan 2027.

Before the implementation existed these failed at the import; after it they pass, and any future
"simplification" that folds the two modes into one shared helper turns all three red.

---

## 7. Phase 2 — what the editor must build

🔴 **These four modes are unreachable by a user today.** Nothing constructs a `repeat`: not
`src/app/tasks/taskDraft.ts`, not `src/app/screens/RecurrenceEditor.tsx`, not the LLM extraction
mapper (`src/llm/extraction/mapper.ts` still emits `{type:'scheduled', scheduledDays}` and nothing
more). The engine is complete, tested, and invoked by nobody. **That is precisely the state task 14
sat in** — a finished backup ladder that nothing called, which took a later task to wire and left two
capabilities looking shipped while unreachable. Phase 1 must not be recorded as "recurrence modes
shipped".

Phase 2 needs, all reusing the existing `SelectChip` primitive:

- a **mode selector** shown after weekday selection (Every week / Every N weeks / Specific weeks of the month / Days of the month);
- an **interval stepper** for `weeks` (≥ 1);
- **ordinal chips** — 1st / 2nd / 3rd / 4th / Last, multi-select;
- a **day-of-month multi-select**, 1–31;
- a **month-stride stepper** for `months` (≥ 1), shared by `ordinal` and `dayOfMonth`.

Two engine facts the UI must respect, both already enforced on write and therefore both capable of
throwing a `RecurrenceValidationError` at the user if the UI ignores them:

- **Switching to `dayOfMonth` must clear `scheduledDays`** (§4), and switching away must clear `days`.
- **`everyWeek` is the default**, and selecting it is the same as selecting nothing — the editor
  should show a weekly task as "Every week" without needing a stored value.

A third thing worth putting in front of the user in the editor: because strides anchor to the
creation date, the copy should say *when the first occurrence lands* ("first: Wed 5 Aug"), since
there is no date-picker to make that visible any other way.

---

## 8. Verification

- `npx jest` — **1121 tests / 92 suites**, all green (baseline 1038 / 89). No worktree subtraction:
  raw counts are the true ones.
- `npx tsc --noEmit` — clean.
- `npx eslint .` — **0 errors, 56 warnings**, the same pre-existing `src/dev/` set as the baseline.
- Test-first throughout: every mode's tests were written and **watched fail** (39 failures across the
  two pure suites at the `nextScheduledOnOrAfter is not a function` / round-trip level, then 18 more
  across the three DB-backed ones) before a line of `period.ts` was written. **No carve-outs taken —
  every change in this task is behavioural and every one is covered.**
- **Uncommitted**, as instructed. 8 files modified, 3 test files added.

### New / extended test files

| File | New? |
|---|---|
| `src/services/recurrence/__tests__/period.repeat.test.ts` | new — the arithmetic, the drift test, DST |
| `src/services/recurrence/__tests__/advance.repeat.test.ts` | new — the sweep, backward compat, constraint #5 |
| `src/types/__tests__/recurrenceRepeat.test.ts` | new — on-disk shape, round trip, validator |
| `src/db/repositories/__tests__/recurrence.test.ts` | extended — write-side enforcement |
| `src/db/repositories/__tests__/tasks.test.ts` | extended — R8's gate per mode |

---

## 9. Deviations from human decisions

**One.**

**The new modes do not roll `reset_date` / `last_period_shortfall`, and `scheduled` still has no
period.** Brief §4 says *"The new modes must roll `resetDate` and `last_period_shortfall` correctly.
For `ordinal`/`dayOfMonth` the natural period is the month and the natural quota is the number of
occurrences per month."* I implemented the second sentence (it is where R8's gate gets its numbers —
§5, and the brief's own 1st & 3rd → 10 days example lands there exactly) but **deliberately did not
implement the first**, because doing so would have introduced a bug:

- `scheduled` has never been period-bearing (task 36 report §2.1) and **nothing anywhere increments
  `current_period_progress` for it** — `recurrenceRepository.incrementPeriodProgress` refuses the type
  by design, since a `scheduled` task has no quota to count against.
- So a monthly roll would compute its shortfall as `quota − 0` **every single month**, recording a
  permanent maximum miss against a task the user may be completing faithfully.
- That fabricated fact is exactly the kind §4.2 forbids ("missed occurrences reset — no guilt
  stacking"), and it is stored on the column the missed-quota importance boost is derived from.

It is currently inert — `missedQuotaFromEntity` returns `null` for anything that is not `quota` or
`scheduled_quota`, so no boost would fire today — but writing a permanent false shortfall into the
user's database and relying on a downstream `if` to ignore it is the invisible-corruption shape
constraint #7 exists to prevent. Making it correct instead would mean giving `scheduled` a progress
writer, i.e. quota accounting for a type that has no quota — a much larger change than task 46, and
one nobody asked for.

Guarded rather than merely asserted in prose: `advance.repeat.test.ts` →
*"%s: still no period accounting — reset_date stays null"*, run once per mode, sweeps twice months
apart and asserts `resetDate` is null, `lastPeriodShortfall` is 0 and `currentPeriodProgress` is 0.
`scheduled_quota` is untouched and still seeds and rolls its own period exactly as before
(*"scheduled_quota is untouched by any of this — it carries no repeat and stays weekly"*).

**If the coordinator disagrees, the change is small and localised** (a `rollQuotaPeriod` call in
`advanceOne` with `quota = occurrences per month`), but it should come with a decision about what
increments the progress it would be measured against.

Everything else — no migration, no new `recurrence_type`, `repeat` absent = `everyWeek`, strides
anchored to task creation, `'last'` included and month-relative, the `dayOfMonth` clamp, requiring
`scheduledDays` empty in `dayOfMonth`, and not building the UI — was built exactly as ruled.
