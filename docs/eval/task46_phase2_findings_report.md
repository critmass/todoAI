# Task 46 Phase 2 — the recurrence editor (findings report)

**Status: complete, uncommitted.** 🔴 **All four scheduled repeat modes are now reachable end to
end** — dropdown → draft → `draftToWrite` → `recurrenceRepository` → a real `task_recurrence` row —
and that chain is asserted against real SQLite, not argued (§6).

| Gate | Baseline (5a45279) | After |
|---|---|---|
| `npx jest` | 1128 tests / 92 suites | **1199 tests / 93 suites** (+71 tests, +1 suite), all green |
| `npx tsc --noEmit` | clean | clean |
| `npx eslint .` | 0 errors / 56 warnings | **0 errors / 56 warnings** (identical pre-existing `src/dev/` set) |

Raw `npx jest` counts are the true ones; the baseline was re-measured in this worktree at 1128 / 92
before a line was touched. LF line endings verified on every touched file (`.gitattributes`).

### Files touched (5 modified, 1 added)

| File | What |
|---|---|
| `src/app/tasks/taskDraft.ts` | three new kinds, four new draft fields, `draftFromRecurrence` / `recurrenceFromDraft` (both now exported), the clearing patch, the grid helpers, validation, list summaries |
| `src/app/components/index.tsx` | new `Dropdown`; `SelectChip` gains an optional `accessibilityLabel` |
| `src/app/screens/RecurrenceEditor.tsx` | the ruled top-line dropdown and the two grids |
| `src/app/tasks/__tests__/taskDraft.test.ts` | +41 tests — the mappings, round-trip fidelity, the clearing rule, validation, the grids |
| `src/app/tasks/__tests__/taskLibraryController.test.ts` | +6 tests — reachability end to end, against real SQLite |
| `src/app/screens/__tests__/RecurrenceEditor.test.tsx` | **new suite**, 24 tests — the dropdown and what each option reveals |

**No schema, no migration, no engine change.** `src/services/recurrence/` and `src/types/domain.ts`
are byte-for-byte untouched — nothing in this phase wanted them changed, which is itself a small
vote of confidence in the shape phase 1 landed on.

---

## 1. The dropdown, and why it needs no native dependency

`Dropdown` in `src/app/components/index.tsx`, beside `SelectChip`:

- a **`Pressable`** showing the current option's label and a caret;
- opening React Native's **core `Modal`** (`transparent`, `animationType="fade"`), containing a
  full-screen backdrop `Pressable` and a `ScrollView` sheet of option rows;
- generic over the value (`<T extends string>`), so it is reusable — several other screens are chip
  rows that could adopt it later, which is **not** in scope here and was not done.

**It needs no native dependency because it is ordinary React Native.** `@react-native-picker/picker`
would be a new native module — a full rebuild, and another run at the documented `.cxx` codegen trap
(task 24 §9.6). `Modal` and `Pressable` ship with React Native and are already linked into the
existing build, so this task stayed headless: **no device build was needed and none was done.**

Guarded by `RecurrenceEditor.test.tsx` → *"🔴 needs no native dependency — no picker package is
installed"*, which reads `package.json` and asserts no dependency has "picker" in its name. That is
a real regression detector for the constraint, not a comment about it. `package.json` and
`package-lock.json` are unmodified.

The menu's open/closed flag is the one piece of `useState` in `components/index.tsx`. It is local UI
state, not application state, and deliberately does **not** live in the draft.

**Accessibility:** the closed control's visible text is the current *value*, which never says what
the value is a value of — so it carries `accessibilityLabel="How often this repeats"`. Each option
row carries its own label and `accessibilityState={{ selected }}`; the backdrop is "Close menu".

## 2. The draft mappings

`RecurrenceKind` goes from six to nine, in Jason's ruled order:

| Dropdown option | Kind | `recurrenceFromDraft` emits |
|---|---|---|
| One-time | `once` | `undefined` (no row — constraint #7) |
| **Weekly** | `schedule` | `{type:'scheduled', scheduledDays}` — 🔴 **no `repeat` key at all** |
| **Every N weeks** | `schedule_interval` | `… repeat:{mode:'interval', weeks}` |
| **Weeks of the month** | `schedule_ordinal` | `scheduledDays: []`, `repeat:{mode:'ordinal', cells, months?}` |
| **Dates** | `schedule_dates` | `scheduledDays: []`, `repeat:{mode:'dayOfMonth', days, months?}` |
| Quota / Quota + days / Ongoing / N times total | unchanged | unchanged |

New draft fields, all strings-or-arrays like their neighbours: `weekInterval`, `ordinalCells`
(`OrdinalCell[]`), `monthDays` (`number[]`), `monthInterval`.

Two mappings are exported and named, because the round trip is the thing worth asserting:
`draftFromRecurrence(recurrence) → RecurrenceDraft` and `recurrenceFromDraft(draft) → Recurrence |
undefined`. `RecurrenceDraft` is the `Pick<TaskDraft, …>` of exactly the fields the mapping reads, so
the identity can be stated without dragging a title and a duration through it. `draftFromTask` and
`draftToWrite` are now thin wrappers over the pair, so the editor and the round trip cannot drift.

**Validation** (`validateDraft`), surfaced through the existing `validation.errors` mechanism and
rendered as the same `Caption` in the same place as the old ones:

| Mode | Rule | Message |
|---|---|---|
| Every N weeks | at least one weekday (shares the existing `days` error) | "Pick at least one day." |
| Every N weeks | interval a whole number ≥ 1 | "Every how many weeks?" |
| Weeks of the month | at least one ticked cell | "Tick at least one box." |
| Dates | at least one ticked date | "Pick at least one date." |
| both month modes | stride a whole number ≥ 1 | "Every how many months?" |

Guarded by `taskDraft.test.ts` → *"validation asks for what each new mode actually needs"* (six
tests, including one that a weekly task is **not** asked for an interval, a cell or a date).

**List summaries.** `describeRecurrence` now names the mode — "Every 3 weeks on Tue", "1st Mon, Last
Fri each month", "Day 1, 15 every 2 months" — because without it a Dates task reads "Every week" in
the task list, which is simply false. The weekly wording is unchanged and pinned by both the task 24
test and a new one (*"still describes a legacy weekly row exactly as it always did"*).

## 3. 🔴 The round-trip proof

`taskDraft.test.ts` → **"🔴 round-trip fidelity — opening a task and saving it untouched changes
nothing"**, six fixtures × three assertions each, plus four singles:

| Fixture | |
|---|---|
| a legacy weekly schedule with **no `repeat` key** | `{type:'scheduled', scheduledDays:['monday','friday']}` |
| every 3 weeks, on Tuesdays | `interval` |
| a **mixed** grid: 1st Mon + 3rd Wed + last Fri | `ordinal`, three cells |
| every 3 months, with a **literal 5th** | `ordinal` + `months: 3` |
| the 1st and the 15th | `dayOfMonth` |
| the 31st, every 2 months | `dayOfMonth` + `months: 2` |

Each one is asserted three ways: `recurrenceFromDraft(draftFromRecurrence(r))` **equals `r`**; the
result passes `recurrenceRepeatIssue` (the very predicate the repository refuses to write against);
and the whole editor path `draftFromTask → draftToWrite` returns it unchanged. Plus:

- *"🔴 adds NO repeat key to a legacy weekly row — not even `{mode:'everyWeek'}`"* — asserts
  `'repeat' in saved === false` **and** `Object.keys(saved) === ['scheduledDays','type']`, so the
  key cannot creep back as an explicit-but-equal value;
- *"normalises an EXPLICIT everyWeek back to the absent-key shape, as the repository does"*;
- *"normalises an explicit `months:1` to absent"* — the same one-canonical-shape rule, since
  `period.ts` reads `repeat.months ?? 1` (§7, judgement call 2);
- *"opens each mode as its own dropdown option rather than as plain Weekly"*.

And at the database level, `taskLibraryController.test.ts` → **"🔴 opening a legacy weekly task and
saving it untouched leaves the row alone"**: seeds a real row, opens it in the controller, saves
without touching anything, and asserts the raw `recurrence_pattern` **string** is byte-for-byte what
it was and still does not contain "repeat". That is the assertion that speaks directly to the three
real recurring tasks in the live alpha DB.

**Proved to detect a regression, not merely to pass.** Mutating `recurrenceFromDraft`'s Weekly case
to emit `{mode:'everyWeek'}` turns **five** tests red, including all three 🔴 ones and task 24's own
pre-existing *"scheduled survives the editor unchanged"*. Worth recording what did **not** go red:
the raw-bytes DB test stayed green, because `recurrenceToPattern` normalises an explicit `everyWeek`
away on write. The repository is a second line of defence — but only the draft-level tests catch the
draft-level bug, which is exactly why the brief asked for them there.

## 4. 🔴 The clearing rule

`recurrenceKindPatch(kind)` is what the dropdown sends: `{kind}` for a weekday-driven option, and
`{kind, scheduledDays: []}` for the two month-driven ones. It is a pure function in `taskDraft.ts`,
so the screen stays presentational and the rule is testable without rendering.

Belt **and** braces: `recurrenceFromDraft` also emits `scheduledDays: []` for those two kinds
whatever the draft still holds. A UI slip therefore cannot get past both, and no path from this
editor can hand the repository a month-driven repeat carrying weekdays.

Five tests, at three levels:

| Level | Test |
|---|---|
| the patch | `taskDraft.test.ts` → *"clears the weekdays when the user picks Weeks of the month"* / *"… picks Dates"* / *"KEEPS the weekdays for Every N weeks"* |
| **the brief's scenario** | `taskDraft.test.ts` → *"🔴 weekdays picked under Weekly, switched to Dates, then SAVED — succeeds"* — validation clean, the emitted recurrence exact, and `recurrenceRepeatIssue(...)` null |
| the belt and braces | `taskDraft.test.ts` → *"belt and braces: a draft that still carries stale weekdays emits none anyway"* |
| the render | `RecurrenceEditor.test.tsx` → *"🔴 clears the weekdays in the very patch that picks a month-driven mode"* — the real `Dropdown`'s `onSelect` produces `{kind:'schedule_dates', scheduledDays:[]}` |
| **end to end** | `taskLibraryController.test.ts` → *"🔴 a weekly task switched to Dates in the editor SAVES — the repository does not reject it"* — real SQLite, seeded weekly row with two weekdays, saved as Dates |

**Also proved to detect a regression.** Removing the clearing from both writers turns five tests
red, one at each level, and the end-to-end one fails as `save()` returning **false** — i.e. the
user's save is refused and the controller publishes the repository's error. That is precisely the
failure the brief said would land in the user's face.

## 5. What is asserted vs eyeball-only

**Asserted** (24 render tests, `react-test-renderer`, no device):

- the top line is **one** `Dropdown` whose options are exactly `RECURRENCE_KINDS` in the ruled order;
- the dropdown shows only the current label until opened; opening renders React Native's `Modal`
  with every option; choosing one reports it and closes; the backdrop closes without choosing;
- the region beneath re-shapes: One-time → one field and no chips; Weekly → seven weekday chips, no
  field; Every N weeks → seven chips **and** the interval field (typing patches `weekInterval`);
  Ongoing → nothing but its caption;
- **Weeks of the month is 42 cells and nothing else** — the count, the "1st…Last" row labels, the
  "Su…Sa" column headers, and explicitly that there is **no weekday chip row feeding the grid**
  (that would be the cross product the phase 1 amendment removed);
- ticking one cell emits exactly one `{ordinal, weekday}`; a ticked cell renders selected; a second
  tap removes it; **5th and Last are separate cells** (ticking 5th Wednesday beside last Wednesday
  gives two);
- Dates is 31 checkboxes, "Day 1"…"Day 31", ticking patches `monthDays`; the month stride field
  appears in **both** month-driven modes and patches `monthInterval`;
- both grids show their validation message when empty;
- the pre-task-46 kinds are untouched: Quota's field + three period chips, Quota + days' 3 + 7
  chips, N times total's progress line.

**Eyeball-only — nothing below is asserted, and none of it was seen on a device:**

- every visual property: colours, the sheet's fade, the caret glyph, the tick glyph in a ticked
  cell, spacing, and whether the grids *look* like grids;
- **the fit of seven columns on a real phone.** Arithmetic rather than observation: 30 (row label)
  + 7×36 + 7 gaps of 4 = 310, inside the editor's 32pt of page padding = 342 on a 360pt screen.
  `Row` wraps rather than clips, so the failure mode is ugly, not broken — but a 36pt cell is under
  the 44pt touch-target guideline, and **whether the grid is comfortable to tap is the one thing
  only a device settles.** Task 23's review said the same of the original weekday chips.
- `Modal` behaviour on a real device: the hardware back button (`onRequestClose` is wired but only
  fires natively), keyboard avoidance, and the number-pad keyboard over the sheet.

## 6. 🔴 Are all four modes reachable end to end?

**Yes.** Stated plainly, and asserted rather than argued — `taskLibraryController.test.ts` drives
the **real controller** and the **real repositories** against **real SQLite**:

| Test | Proves |
|---|---|
| *"writes 'every N weeks' as a real interval repeat"* | a `{mode:'interval', weeks:2}` row exists after a save |
| *"writes 'weeks of the month' as the ticked cells, and only those"* | two cells in, **two** cells out — not the four a cross product would have written |
| *"writes 'dates' as days of the month, with a stride"* | `{mode:'dayOfMonth', days:[1,15], months:2}` |
| *"re-opens each saved mode as itself, so a second save is a no-op"* | reopening gives `kind:'schedule_ordinal'` and `monthInterval:'3'`, and re-saving leaves the stored pattern byte-for-byte identical |
| *"🔴 a weekly task switched to Dates in the editor SAVES"* | the mode switch the engine could have rejected |

The full chain is: `TaskEditorScreen` (already wired into `App.tsx`) → `RecurrenceEditor` →
`onChange` → `taskLibraryController.change` → `draftToWrite` → `recurrenceFromDraft` →
`recurrenceRepository.create/update` → `task_recurrence`. Phase 1's "task 14 state" warning —
a finished engine nothing calls — **no longer applies**: `taskDraft.ts` now constructs every one of
the four `repeat` modes, and a test reads each one back out of a database.

One reachability gap remains and is **out of scope, flagged not fixed**: the LLM extraction mapper
(`src/llm/extraction/mapper.ts:35`) still emits `{type:'scheduled', scheduledDays}` and can never
produce a `repeat`. A task captured by voice/chat can only be weekly; the editor is the only way to
reach the other three. Nothing in the brief asked for the mapper, and its grammar and validator
would both need extending — a separate task if Jason wants "every other Tuesday" to survive capture.

## 7. Test-first (`CLAUDE.md`)

**Followed for every behavioural change, with one stated exception below.**

- The **draft layer** was written test-first: 39 of the 60 tests in `taskDraft.test.ts` failed
  before a line of implementation, headline failure verbatim:

  ```
  ● task 46 phase 2 … › 🔴 round-trip fidelity … › a legacy weekly schedule with NO repeat key survives the editor unchanged
    TypeError: (0 , _taskDraft.draftFromRecurrence) is not a function
        at expect(recurrenceFromDraft(draftFromRecurrence(recurrence))).toEqual(recurrence);
  ```

  The other failures were the same shape (`toggleMonthDay is not a function`, …) plus the two
  genuine expectation failures — the nine ruled labels, and `"Every 3 weeks on Tue"` received as
  `"Every Tue"`.

- The **editor and the dropdown** were written test-first too: all 24 tests in the new
  `RecurrenceEditor.test.tsx` were written before either component existed, and 23 of them failed
  with *"Element type is invalid … but got: undefined"* (no `Dropdown` yet) or on the old chip-row
  editor's counts. The one that passed immediately is the no-picker-dependency guard, which is a
  constraint test, not a behaviour test.

- 🔴 **Stated, not silent — the six end-to-end controller tests (§6) were written AFTER the draft
  layer was green.** They pin reachability through real SQLite rather than driving a change, and
  every behaviour they cover was itself driven test-first one level down. To show they are real
  regression detectors and not decoration, both 🔴 rules were **mutated and watched fail** (§3, §4):
  five tests red per mutation, spread across all three levels, including these end-to-end ones.

- No other carve-outs. Every behavioural change in this phase is covered.

---

## 8. Deviations from human decisions

**Three, all small, all cheap to overrule.**

1. **The "every N months" stride is offered for *Weeks of the month* as well as *Dates*.** The
   ruled table (brief §1) lists it only against Dates. I gave it to both because: the engine
   carries `months?` on `ordinal` and `dayOfMonth` alike; brief §4 lists "the month stride" as a
   single shared draft field; phase 1's own Phase-2 list called for a stride "shared by `ordinal`
   and `dayOfMonth`"; and without it a stored `{mode:'ordinal', months:3}` could not round-trip —
   the editor would silently rewrite it to every month, which is the exact class of silent change
   §5 of the brief exists to prevent. **To overrule: delete `{monthIntervalField}` from the
   `schedule_ordinal` branch of `RecurrenceEditor.tsx`** (one line); the draft field can stay and
   the round trip survives.

2. **No inline "Repeats:" caption beside the dropdown.** Jason's sketch shows `Repeats: [ … ▼ ]`,
   but `TaskEditorScreen` already prints the section label **"How often"** immediately above this
   control, so a second label would have been a duplicate on an ADHD-minimal surface. The screen
   reader still gets it: the dropdown's `accessibilityLabel` is "How often this repeats". **To
   overrule:** either add a `<Label>Repeats</Label>` in the editor or rename the section.

3. **`describeRecurrence` was extended to name the new modes in the task list.** The brief scoped
   the work to the draft mappings and the editor and did not mention the list. I extended it
   because the alternative is a Dates task whose list summary reads "Every week" — false, and
   visible on the first screen after saving. The weekly wording is untouched and pinned.

**Three judgement calls nobody ruled on, flagged so they can be overruled cheaply:**

1. **Switching *out of* a month mode does NOT clear the cells or the dates** (only switching *into*
   one clears `scheduledDays`, which the engine requires). Nothing reads them in another mode, so
   they are invisible rather than stale, and keeping them means a user who looks at Weekly and
   changes their mind still has their grid. Phase 1's report suggested clearing both ways; the
   engine only enforces the one.
2. **A month stride of `1` is stored by absence**, exactly as `everyWeek` is: `period.ts` reads
   `repeat.months ?? 1`, so `months: 1` and no `months` are the same schedule, and one canonical
   on-disk shape is better than two. A stored explicit `months: 1` therefore normalises to absent
   on save — semantically identical, and no such row exists anywhere today.
3. **`weekInterval` defaults to "2" and `monthInterval` to "1"** in a new draft. 1 week would be
   plain "Weekly", which is its own option, so the interval mode starts at the smallest value that
   means anything different — unlike `quota`/`target`, which start empty because they have no
   sensible default.

**Explicitly NOT done, as instructed:** no engine change, no schema change, no migration, no new
native dependency, no `git commit`. `src/services/recurrence/`, `src/types/domain.ts`, `package.json`
and `package-lock.json` are all untouched.
