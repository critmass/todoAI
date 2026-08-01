# Task 36 Findings — Recurrence period engine (the time-driven half of §4.2)

**Status: complete.** The engine is built, wired at both seams, and covered by an injected-clock
test suite. Full suite green — **711 → 794 tests** — with `tsc --noEmit` clean and `eslint .` at
**0 errors** (56 warnings, all the pre-existing `react-native/no-inline-styles` ones in `src/dev/`
that task 13 and task 24 also reported). Migration **006 / schema 2.7.0**, with the prior-suite
sweep done.

**Commits, logically separate:**

| Commit | What |
|---|---|
| `178e6c6` | make the three source-drift guards line-ending agnostic (the pre-existing red baseline) |
| `a1647cf` | migration 006 — `last_period_shortfall`, the `reset_date` CHECK, + prior-suite sweep |
| `e0a7c36` | `src/services/recurrence/` — the sweep and its calendar arithmetic |
| `310e890` | the missed-quota boost, derived at scoring time |
| `47e93d4` | wiring at app open + session start; `taskCompletion.ts`'s scope line updated |

**Read from source, not from the brief, as instructed** — and it caught three things (§2). Task 35's
fold-in landed mid-session (`59aee1f`, spec v2.4); §4.2 there says the same thing v2.3 did plus a
"ruled but not yet built" note naming this task, so nothing in it changed the work.

---

## 0. The baseline was red before this task touched anything

Seven tests in three files were failing on a clean checkout: the "the embedded copy is
byte-identical to its source file" guards in `schemaDrift.test.ts`, `grammarText.test.ts` and
`extractionGrammarText.test.ts`.

It is an environment-dependent bug in the guards, not drift. ECMAScript normalizes CRLF to LF inside
a template literal at parse time, so on a Windows checkout with `core.autocrlf=true` (this repo
stores LF; the working tree gets CRLF) the `.sql`/`.gbnf` on disk is CRLF while the constant
generated from it is LF — for **every** migration and grammar, regardless of content. Byte-exact
equality is unreachable there.

Both sides are now normalized before comparing. The guard's real job — catching content drift
between a generated copy and its source — is untouched; only line-ending style, which the `.ts`
physically cannot carry, is now out of scope. Fixed first and separately so the rest of this task's
changes were legible against a green tree.

---

## 1. What landed

**`src/services/recurrence/`** — the engine. Headless, no clock of its own, no UI.

- **`period.ts`** — the calendar arithmetic. Pure functions over a `CalendarDate` (`'YYYY-MM-DD'`):
  `addDays`, `addPeriod` (day/week/calendar-month, clamping 31 Jan + 1 month to 28 Feb),
  `weekdayOf`, `nextOccurrenceOnOrAfter` / `nextOccurrenceAfter`, `rollBoundaryPast`,
  `localCalendarDate`, `calendarDateOfTimestamp`.
- **`advance.ts`** — `advanceRecurrence(deps, today)`, the idempotent sweep, plus `sweepDateFrom`
  for callers holding an epoch-ms clock. Returns what moved (`{ today, scanned, advanced[] }`),
  which is what the idempotency tests assert against.

**Data layer.** Migration 006 (§4), and three additions to the recurrence repository:
`listSweepable()` (the sweep's single joined read), `setResetDate()` (first seeding),
`rollPeriod()` (the time-driven counterpart to `incrementPeriodProgress`'s completion-driven
write). `recurrence.update()` now also restarts period accounting — see §6.

**Scoring.** `listActiveByNeglect` carries a `MissedQuota` fact per pool item off the join it
already does; `missedQuotaBoost` / `boostedImportanceFactor` in `src/scoring/factors.ts` derive the
§4.2 boost from it; `scoreTask` applies it.

**Wiring.** `runLaunchSequence` (app open) and `sessionController.begin()` (session start).

**Behaviour, per type:**

| Type | `next_due_at` | Period |
|---|---|---|
| `scheduled` | next scheduled weekday on/after today; strictly after today when today's occurrence is already completed | none — see §2.1 |
| `quota` | **untouched** — "15/week, whenever" has no day it is due on | rolls; progress zeroed; shortfall recorded |
| `scheduled_quota` | as `scheduled` | as `quota` |
| `unscheduled`, `count`, one-off | **never touched** | none |

### Files touched (for merge auditability)

*New:* `src/services/recurrence/{period,advance,index}.ts`,
`src/services/recurrence/__tests__/{period,advance}.test.ts`,
`src/db/migrations/006_recurrence_period.{sql,ts}`,
`src/db/migrations/__tests__/006_recurrencePeriod.test.ts`, this report.

*Changed:* `src/db/migrations/index.ts`; `src/db/repositories/{recurrence,tasks}.ts`;
`src/types/{db,domain}.ts`; `src/scoring/{factors,score}.ts`; `src/services/taskCompletion.ts`
(comment only); `src/app/{App.tsx,appServices.ts,launch.ts}`;
`src/app/session/sessionController.ts`.

*Test files touched that belong to other tasks* — expected, per brief §5 and task 34 §4:
`src/db/migrations/__tests__/{002,003,004,005,index,schemaDrift}` (version sweep + the new drift
case), `src/llm/grammar/__tests__/grammarText.test.ts`,
`src/dev/__tests__/extractionGrammarText.test.ts` (§0), and six fixture files that build a
`TaskWithNeglect` literal and now set `missedQuota: null`
(`src/scoring/__tests__/{score,filter,noveltyEntropy}.test.ts`,
`src/planning/__tests__/{planner,service}.test.ts`, `src/execution/__tests__/tail.test.ts`,
`src/llm/breakdown/__tests__/mapper.test.ts`), plus `src/app/__tests__/launch.test.ts` and
`src/app/session/__tests__/sessionController.test.ts` for the new dependency and its tests.

---

## 2. Where the source disagreed with the brief

The brief said to read the repositories from source and not trust its own summaries. Three findings.

### 2.1 `scheduled` is not period-bearing in the built data model

Brief §2.2 asks for period rollover on "`quota`, `scheduled_quota`, **and period-bearing
`scheduled`**", and the spec's §4.2 table does mark `scheduled` as "Period? Yes".

In the code there is no such thing. `Recurrence`'s `scheduled` member carries `scheduledDays` and
nothing else — no `period`, no `quota` — and `completeTask` routes `scheduled` to
`recordUnscheduledCompletion`, which never touches `current_period_progress`. So for a `scheduled`
task there is no quota to compare against, no progress to zero, and nothing a rollover could reset.

**Decision: `scheduled` gets no `reset_date` and never rolls.** Its period *is* its schedule, and
`next_due_at` is where that lives. Writing it a boundary would be inventing a period the type does
not have, which is the same class of error constraint #7 exists to prevent. Migration 006's CHECK
deliberately still *permits* a `reset_date` on `scheduled` (only `unscheduled`/`count` are refused),
so if a future ruling gives `scheduled` a real period, the schema is already open to it.

### 2.2 The schema did **not** enforce `reset_date IS NULL` for `unscheduled`/`count`

Brief §2 states "the schema enforces `reset_date IS NULL` for them". It did not. Migration 001 wrote
the rule as a trailing comment on the column (`reset_date DATETIME, -- NULL for 'unscheduled' and
'count'`) and nothing checked it. It cost nothing while no code wrote the column at all — but this
task ships its first writer, so it is now a real CHECK (§4). The brief's claim is true as of 006.

### 2.3 `reset_date` had no writer anywhere, and no defined meaning

Not a conflict so much as a hole the brief implies is filled. `reset_date` has existed since 001 and
nothing has ever written it; `recurrenceToRow` does not even include it. So "rolling `reset_date`"
was not "advance an existing value" but "define what it means and write it for the first time".

**Defined:** the local calendar date on which the **current period ends, exclusive**. The running
period is `[reset_date − one period, reset_date)`; the sweep rolls when `today >= reset_date`. Date,
not datetime, and local, not UTC (§3d). `next_due_at` already carries the same `'YYYY-MM-DD'` shape
from every writer (`resolveDue`, the editor), so this is the established format, not a new one.

---

## 3. The (a)–(e) decisions

### (a) Where the sweep runs, and idempotency

**One `advanceRecurrence(deps, today)` sweep, at app open and at session start** — the brief's
recommendation, adopted. Two orderings inside that are load-bearing:

- **App open:** the sweep runs *after* `recoverOpenEpisode` (the one non-negotiable ordering in
  `launch.ts` — the crash signal is reconciled before anything reads state) and *before* the branch
  that returns early on a recovery. Sweeping after that return would mean the user who relaunches
  straight into a recovered session never gets swept, and that is precisely the user most likely to
  have been away. Pinned by a test asserting the call order is `['recovery', 'sweep']`, and by one
  asserting a stale due date is repaired on a launch that ends in a recovery.
- **Session start:** in `begin()`, before anything reads the pool and well before planning (which
  happens at `setContexts`). The app can sit open for days; the agenda must be built against today's
  dates. It sits in its own `guard`, so a failed repair pass costs today's dates rather than the
  user's session, and it logs — a Phase B finding in task 24 was a disposition failing silently.

**Idempotency is structural, not tested-in.** Every write is conditional on a comparison the write
itself makes false: a due date already ≥ today is left alone, and `rollBoundaryPast` reports
`periodsElapsed: 0` when the boundary is still ahead. The triple-call test the brief asks for is
there (`three calls in the same second produce exactly one advancement`), plus one that repeats
*after* a real roll — the more interesting case, since a naive re-derivation would compute a fresh
shortfall from the freshly-zeroed progress and record a full miss on every launch.

The sweep is **one query plus one write per changed task**. A no-op sweep is a single `SELECT`.

### (b) Is the missed-quota boost stored or derived? — **Derived**

**Derived at scoring time; `tasks.importance` is never written.** The brief's recommendation, and I
agree with its reasoning: a stored boost corrupts the user's own 1–10 projection (constraint #6) and
collides with the 1–99 subtask band under each hundred, where a parent at 700 with subtasks at
701–799 has no room for a silent bump. Urgency is the precedent — spec §4.1 says derived, not stored
— and the boost is now derived in the same function that derives urgency, from data the same read
already carries.

**But one thing must be stored, and this is the part the brief does not say:** a rollover *zeroes*
`current_period_progress`, so after the roll nothing remembers whether the period that just closed
was met. The boost is derived; the **fact** it derives from has to be persisted. Hence
`last_period_shortfall` (migration 006) — "last week you missed two of three", a fact, not a policy.
Change the boost formula tomorrow and no stored data is wrong.

**The shape**, which is a decision the brief left open:

```
boost   = MISSED_QUOTA_BOOST_MAX × (shortfall / quota)      // 0 … 0.25
factor  = f + (1 − f) × boost                                // f = importanceFactor(importance)
```

- `f + (1−f)·boost`, not `f·(1+boost)`, so the factor **cannot leave [0,1]**. That keeps the neglect
  multiplier the only unbounded term in the score, which is the invariant `factors.ts` rests on —
  and unlike multiply-then-clamp it still moves a high-importance task instead of silently refusing
  to at the top of the range.
- **The boost is 0 once the current period's quota is met.** §4.2 boosts the occurrences *remaining*
  in the new period; when there are none, a task that has already done its three this week should
  not be pushed up the list because it missed last week.
- **25% of the remaining headroom is deliberately small.** A fully missed quota moves the base score
  by at most `0.31 × 0.25 × (1−f)`. One week of neglect *doubles* the entire score
  (`neglectCurve = 1 + weeks`). §5.2 is the fail-safe; §4.2 is a nudge, and the orders of magnitude
  should say so. `MISSED_QUOTA_BOOST_MAX` is a named tunable seam like the neglect curve, with the
  ratio pinned by a test.

### (c) Catch-up semantics after a long absence

**Reset to the current period, one period's shortfall, no accumulated debt** — as ruled. Worth
recording is that catch-up is **not a special case anywhere in the code**: every task's state is
computed *from* `today`, never by replaying the days between, so a three-week absence runs the exact
same path as an ordinary morning. There is no backlog to fabricate because there is no loop that
could fabricate one.

**The one thing the ruling did not settle, and my decision on it.** When several periods elapse at
once, *which* period's shortfall is recorded? Three candidates:

1. the **sum** (three missed weeks at 3/week = 9) — this is guilt stacking, forbidden by name;
2. the **last** period, which was untouched, so a full miss (= quota);
3. the period the engine **actually observed** — the one that was open when it last ran.

**I chose (3).** (2) is defensible — it is literally "the immediately preceding period" — but it
infers failure from an absence. The user was not there; that is not evidence of anything, and
treating it as data fabricates exactly the backlog brief §2.4 forbids. It also hands a returning
user a *maximum* boost on **every** quota task simultaneously, at the precise moment spec §6.1's
5-day re-orientation conversation is trying to disposition stale tasks gently — the brief's own
"your sweep must not have already made that conversation confusing" test. (3) is gentler, is the
only shortfall ever measured, and still discriminates between tasks (by how far along each was).

**On the re-orientation flow specifically:** the sweep leaves it a *cleaner* conversation, not a
confused one. Before, every recurring task the user returned to read overdue or dateless; now each
reads "due on its next occurrence", with the neglect clock — untouched by this engine — carrying the
"you have not done this in three weeks" signal that the conversation is actually about. Note the
re-orientation trigger still cannot fire: it needs a `last_opened_at` watermark that does not exist
(task 26 / `learning_state`). Nothing here changes that, in either direction.

### (d) Timezone and DST

**Device-local midnight**, as recommended, implemented as a hard split: an instant becomes a local
calendar date **exactly once**, at the edge (`localCalendarDate`), and every step after that is
day/month arithmetic on that date.

That split *is* the DST answer. A local day is 23 or 25 hours twice a year, so anything that adds
`7 × 24 h` to an instant lands an hour off, and twice a year that hour crosses midnight and puts the
occurrence on the **wrong day**. Calendar arithmetic cannot have that bug — a week is seven days
whatever the days were worth in hours. Internally the dates ride on UTC-midnight `Date` objects used
purely as a calendar, never as instants (the same technique `dueSpec.ts` uses).

**Written down rather than discovered in March**, with tests: a weekly period spanning US
spring-forward (2027-03-14) and fall-back (2027-11-07) and the EU dates (2027-03-28, 2027-10-31)
advances exactly seven calendar days; the transition day is an ordinary day to every helper; a daily
period crosses both without skipping or repeating a day; a scheduled Sunday task lands on 2027-11-07
and then 2027-11-14. One test pins what the naive millisecond arithmetic would have produced, as
documentation of the hazard. Two sweep-level DST cases run the same crossings through real SQLite.

**Monthly clamping** is the one place a judgment was needed: 31 Jan + 1 month is 28 Feb, not 3 March
(which is what `setUTCMonth` alone gives, walking a monthly boundary further into the next month
every February). The clamp is one-way — a boundary that clamps to the 28th continues from the 28th
rather than springing back to the 31st. Acceptable because this is a period boundary, not a calendar
appointment, and no user-visible date depends on it. Tested and commented at the site.

**The one real timezone weakness is not DST**, it is `last_completed_at`: SQLite's
`CURRENT_TIMESTAMP` is UTC, and the sweep compares its date part against a device-local date. For a
user far enough from UTC, "was today's occurrence completed?" can be a day out for one sweep. Both
directions are benign (a task reads due today for one extra day, or advances one occurrence early)
and self-correct on the next sweep. Documented at the function; a real fix is a writer change on
someone else's column (§7).

### (e) Interaction with R8's accrual gate

**They compose by not overlapping — the gate does not read the data this engine maintains.** The
brief expected "that gate is reading live data for the first time"; from the source, it is not.

`neglectAccrualGapDays(recurrence)` reads `period` and `quota` **out of the recurrence definition**
(the pattern JSON), which no sweep writes. The anchor is
`MAX(created_at, last_completed_at, last_worked_at)` — three completion/work-driven columns, none of
which a sweep writes either. `reset_date`, `current_period_progress` and `last_period_shortfall` are
read by nobody in the neglect path. So a period rolling **cannot** move the gate, in either
direction. Pinned by a test: `weeksNeglected` is identical before and after three periods roll at
once.

That is the good outcome, and it is worth stating why: it means this engine cannot pause, cap, or
saturate neglect accrual (constraint #5) even by accident. There is a separate negative test that no
sweep write lands on any of the three anchor columns.

**What *did* change is urgency, and it is bigger than the brief suggests.** The brief describes
`scheduled` tasks reading "perpetually due-or-overdue". Both halves of the pool were wrong, in
opposite directions:

- A task created through the **chat/extraction** path could get a real date from `resolveDue`, which
  then never advanced → `urgencyFactor` returned **1.0 forever**.
- A task created through the **editor** gets `nextDueAt: null` for every recurring kind
  (`taskDraft.ts` says so explicitly, deferring to task 36) → `urgencyFactor` returned the base
  sensitivity floor (≤ 0.15) and **never** rose, however overdue the task actually was.

Either way urgency — 23% of the score — carried no information for recurring tasks: it was pinned at
one end or the other by construction. It now varies truthfully. Pinned by a test that walks a
scheduled task from stale-overdue through due-today to next-week.

---

## 4. Migration 006 / schema 2.7.0

Task 13 took 005 / 2.6.0, so this is **006 / 2.7.0**, as brief §5 requires and as 005's own header
predicted ("whoever merges second renumbers").

It **rebuilds `task_recurrence`** — SQLite has no `ALTER TABLE ... ALTER COLUMN`, and the new CHECK
needs one; the new column rides along because the rebuild has to happen anyway. `rebuildsTables:
true`, so the runner does the `PRAGMA foreign_keys` dance around it.

1. **`last_period_shortfall INTEGER NOT NULL DEFAULT 0 CHECK (>= 0)`** — the fact §3b derives from.
2. **`CHECK (recurrence_type NOT IN ('unscheduled','count') OR reset_date IS NULL)`** — 001's
   comment, made structural (§2.2). The copy **sanitizes** rather than asserts: any stale value on
   those two types becomes NULL, because failing an upgrade on the user's own database is the worse
   outcome. Only reachable via a hand-written row today, but it costs one `CASE`.
3. **No backfill of `reset_date`.** Period seeding stays in one idempotent, tested code path (the
   engine) instead of a second one written in SQL that runs once and can never re-run.

Rebuild specifics checked against source, not assumed: no view selects from `task_recurrence` (all
four survivors checked; the fifth was dropped by 004); it is AUTOINCREMENT, so `sqlite_sequence` is
saved and restored and ids are preserved; **nothing references it with a foreign key**, so the
DROP+RENAME cannot orphan a child; `idx_task_recurrence_type` is recreated. The 006 suite covers
fresh install and a populated 2.6.0 upgrade, including the sqlite_sequence high-water case 002 found
(a deleted row must not have its id reused) and the sanitizing path.

**Prior-suite sweep done.** `runMigrations` walks forward, so 002–005's "latest version" assertions
were always assertions about the *newest* migration: nine assertions across five files moved to
2.7.0. 005's fresh-install test is renamed from "lands at 2.6.0 and records the migration name" to
"applies 005 and records the newest migration" — that name encoded the trap, exactly as 004's did
before task 13 renamed it. **Note for whoever writes 007:** with a forward-walking runner, only the
newest migration's own version bump is observable through `runMigrations`; each suite's job is its
*effects*.

---

## 5. What task 22 inherits — nothing, and deliberately so

Task 22 owns the meaning of the **word** "next" in "next Monday" (`which: 'next'` in a `DueSpec`,
resolved by `resolveDue` at extraction time; from a Thursday the 4B read it as 11 days out).

This engine does not touch `resolveDue`, does not read or write a `DueSpec`, and resolves no such
word. `nextOccurrenceOnOrAfter` answers a different question — "which day does this weekly schedule
land on next" — by plain arithmetic in a seven-day window, where "on or after today" and "strictly
after today" are two explicitly named functions rather than one ambiguous one. Stated in the module
header so a later reader does not mistake one for the other.

**Task 22 is neither easier nor harder for this.** Two things worth its attention when it lands:

1. **A second consumer of due dates now exists.** If 22 changes `resolveDue`, recurring tasks are
   unaffected — the sweep overwrites a stale date from the schedule anyway — but a *deferral* on a
   recurring task goes through `resolveDue` (§6) and is subject to whatever 22 decides.
2. **If 22 ever wants a shared weekday helper**, `period.ts`'s is UTC-calendar-based and
   deliberately unambiguous; `dueSpec.ts`'s is UTC too, so they agree. Neither imports the other,
   and that is fine — the duplication is four lines and the two answer different questions.

---

## 6. Interactions found with other subsystems

**`defer_task` on a recurring task (`src/services/coaching/dispatch.ts`).** Coaching writes
`next_due_at` directly. Two paths:

- *Deferring to a date* → the sweep leaves any due date that is today-or-later alone, so the
  deferral **survives**. Correct, and it is why the sweep repairs stale dates rather than
  recomputing every date.
- *Condition-based defer* ("when I hear back from X") → dispatch sets `next_due_at = null`. On a
  **`scheduled`** task the sweep will re-seed it to the next occurrence at the next app open,
  **quietly undoing the deferral's only visible effect.**

I did not fix this, because it cannot be fixed here: the engine cannot distinguish "cleared by a
deliberate deferral" from "never set", and "never set" is the editor's default for every recurring
task — the case it exists to seed. The deeper issue is that a nulled due date was never a real hold
in the first place (it does not remove a task from the pool; it only zeroes its urgency), and the
dispatch site already carries a `REVIEW(task 13+)` note saying the condition is not modelled. **A
real deferral needs a hold mechanism** — an external-dependency row, or the U1 filter — not an
absent date. Flagged here for whoever owns that; the impact today is one urgency factor on one
recurring task, not lost data.

**`recurrence.update()` (the editor's save path) now restarts period accounting.** Two reasons, one
of them mandatory: the mapper already zeroes `current_period_progress` on any update, so a recorded
shortfall against the *old* quota must go with it (a quota of 10 missed by 8 must not keep boosting
a task just redefined as "2× a week"); and a change **to** `unscheduled`/`count` must clear
`reset_date`, or 006's new CHECK would turn an ordinary editor save into a constraint failure. That
second one is a regression this migration would have introduced if I had not looked — worth naming.

**`TaskWithNeglect` gained a required field.** `missedQuota: MissedQuota | null` is required rather
than optional on purpose: the repository always populates it, and an optional field would make
`undefined` mean both "no quota" and "not populated" — the exact ambiguity `domain.ts`'s header
warns about for `recurrence` on `Task`. Six test fixtures now pass `missedQuota: null`.

**Incidental, pre-existing — since FIXED, see `docs/briefs/nul_byte_score_ts.md`:**
`src/scoring/score.ts` contained a literal **NUL byte** in `contextGroupKey`'s sentinel
(`return '\x00flexible'`, which reads as a leading space). It was functionally harmless — the value
is only ever compared with itself — but git classified the file as **binary**, so every diff of
`score.ts` showed as `Bin 8860 -> 9177 bytes` instead of reviewable lines. It predated this task
(present in `1280f25`; in fact present since `8903e74`, the file's first commit, which is why no
readable diff of it has ever existed). Left alone here rather than changed silently, since the
sentinel's whole point may have been a byte no real context tag can contain. That question was
later settled — the byte was accidental, but the collision-proofing is worth keeping — and the raw
byte is now written as the `\x00` **escape**: same runtime key, and the file is text again.

---

## 7. Consciously left open

1. **`last_completed_at` is UTC; the sweep's dates are local.** "Was today's occurrence completed?"
   can be a day out for one sweep for users far from UTC (§3d). Bounded, benign, self-correcting.
   The fix is a writer change on a column completion owns — record a local completion date, or hand
   the sweep the local-midnight instant instead of a date — and both cross the scope line, so
   neither belongs here.
2. **"Every N weeks" intervals are still not representable.** Orientation §9 hands the task-24
   editor's dropped interval control to this task, but brief §2's scope does not list it, and the
   brief wins for its own task. It is also not the schema change orientation calls it:
   `recurrence_pattern` is free-form JSON, so an `interval` field needs **no migration** — what it
   needs is a change to the `Recurrence` union, the editor, the extraction grammar and its mapper,
   and an anchor date to count intervals from. `period.ts` would need one new function.
   Deliberately not started; naming the real shape here so it is not re-scoped as a schema task.
3. **A `quota` task's occurrences are not spread across its period.** "15/week" rolls as a block; the
   engine does not decide *which days* those 15 should land on. Nothing asks it to (that is the
   planner's business), but a future "you have 4 left and 1 day" nudge would live here.
4. **No coaching is enqueued on a repeated miss.** §4.2 says "repeated misses feed coaching (§7.2)",
   and §7.2's table has no row for it — inventing a sixth trigger type is a spec change, not an
   implementation detail. `last_period_shortfall` is the signal a future trigger would read;
   deliberately not wired.
5. **Nothing has run on the phone.** Headless task, no `P`, as the brief specifies. Nothing here
   touches a native module or a screen, and it runs against the same `better-sqlite3` double the
   whole data layer is tested on — but it has never executed against op-sqlite. The one thing worth
   a glance in the next device session is the 006 rebuild on a real populated database.
6. **`is_currently_active` on `task_recurrence` still has no reader or writer.** Carried through the
   rebuild untouched. It is not this engine's — I never had to consult it — but it is now the only
   column on that table nothing uses.

---

## 8. Verification

- `npx jest` — **68 suites, 794 tests, all passing** (baseline 711, of which 7 were red for the
  reason in §0).
- `npx tsc --noEmit` — clean.
- `npx eslint .` — 0 errors, 56 warnings, all pre-existing `src/dev/` inline-style ones.
- New coverage: 22 pure calendar cases (incl. four DST crossings), 31 sweep cases against real
  SQLite with an injected clock (advancement per scheduled type, rollover for day/week/month, the
  idempotency triple-call, catch-up after three weeks, two DST crossings end to end, five negative
  tests that `unscheduled`/`count`/one-offs/completed/deleted tasks and the neglect anchor are
  untouched, four composition tests), 15 migration-006 cases, 8 boost cases, and 6 wiring tests
  across app open and session start.
