# Task 46 Phase 2 — the recurrence editor

**Brief written by the coordinator, 2026-08-24. The UI shape is RULED by Jason (2026-08-24) — build it,
don't redesign it.** Phase 1 + its amendment shipped a complete, tested engine that **no user can
reach**. This makes it reachable.

> **Do not back-edit** the Phase 1 brief or either Phase 1 report. Write a **new** report.

## 0. Role
Build subagent, headless, isolated worktree. Verify with `npx jest` / `npx tsc --noEmit` /
`npx eslint .`. **Do not `git commit`.** No device work — and nothing here should *need* a device build
(see §2).

## 1. The ruled design

A **top-line dropdown carrying every option**, with the region beneath re-shaping to the selection:

```
Repeats:  [ Weeks of the month            ▼ ]
          ┌─────────────────────────────────┐
          │ the 6×7 grid, or whatever the   │
          │ chosen option needs             │
          └─────────────────────────────────┘
```

**The dropdown's list, flat and in this order:** One-time · Weekly · Every N weeks · Weeks of the month
· Dates · Quota · Quota + days · Ongoing · N times total.

*(Jason's reasoning, so it isn't re-litigated: a form expanding by selection is completely ordinary; the
coordinator's earlier worry about controls appearing and disappearing was overprotective. A dropdown
also keeps the top line at one line however many options exist, where a chip row would wrap to three.)*

| Option | Reveals |
|---|---|
| One-time | the existing `YYYY-MM-DD` field |
| **Weekly** | weekday chips (exactly today's Schedule) |
| **Every N weeks** | weekday chips + `every [N] weeks` |
| **Weeks of the month** | the **6×7 grid** (§3) |
| **Dates** | the **31-cell grid** (§3) + `every [N] months` |
| Quota / Quota + days / Ongoing / N times total | exactly as today |

## 2. 🔴 The dropdown must be JS-only

Build it as a shared component (`src/app/components/index.tsx`, beside `SelectChip`): a `Pressable`
showing the current label, opening React Native's **core `Modal`** with the option list.

**Do NOT add `@react-native-picker/picker` or any native dependency.** A native module means a full
rebuild, and this project has a documented `.cxx` codegen trap that has bitten before (task 24 §9.6). A
JS-only control keeps this task headless and needs no device build at all. It is also reusable — several
other screens are chip-rows that could adopt it later, though that is **not** in scope here.

## 3. The two grids — Jason's exact specification

- **Dates:** a small calendar-style grid of **31 checkboxes**, tick the days you want.
- **Weeks of the month:** a **6×7 grid** — columns labelled **Sunday–Saturday**, rows labelled
  **1st, 2nd, 3rd, 4th, 5th, Last**. Each ticked cell is **one occurrence**: ticking *1st/Monday* and
  *3rd/Wednesday* means exactly those two. This is why Phase 1 was amended from a cross product to
  `cells` — do not reintroduce a row/column cross product.

`SelectChip` is already a toggle and is the natural cell; these are layout, not new primitives.

## 4. The draft layer

`src/app/tasks/taskDraft.ts` is where the work actually is. Today `RecurrenceKind` is
`'once' | 'schedule' | 'quota' | 'quota_schedule' | 'ongoing' | 'count'`, and `recurrenceFromDraft`
switches on it. You need:

- **Three new kinds** for the three new options (`schedule` becomes the "Weekly" label), and the draft
  fields they need — the interval, the ordinal cells, the month days, the month stride.
- **`recurrenceFromDraft`** emits the right `repeat`. ⚠ For **Weekly**, emit **no `repeat` at all** (not
  `{mode:'everyWeek'}`) — Phase 1 normalises `everyWeek` away precisely so an untouched weekly task
  serialises byte-for-byte to the pre-task-46 shape.
- **`draftFromRecurrence`** hydrates all four modes back for editing.
- **Validation** for each new mode (an interval ≥ 1, at least one cell / at least one date, a sane
  stride), surfaced the way the existing `validation.errors` are.

🔴 **Switching *into* Weeks-of-the-month or Dates MUST clear `scheduledDays`.** The engine enforces
`scheduledDays` empty in those modes at both writers — so if the editor leaves stale weekdays behind,
**the repository throws in the user's face on save.** The Phase 1 amendment flagged this explicitly.
Cover it with a test: pick weekdays under Weekly, switch to Dates, save, and assert it succeeds.

## 5. 🔴 The test that matters most: round-trip fidelity

**Opening an existing task and saving it without touching anything must not change its recurrence.**
Phase 1 pinned that a weekly schedule serialises key-for-key to the pre-46 shape, and Jason has **three
real recurring tasks in the live alpha DB**. Assert `draftFromRecurrence → recurrenceFromDraft` is the
identity for: a legacy weekly schedule with **no `repeat` key**, and each of the four modes. A
round-trip that quietly adds `{mode:'everyWeek'}` to every existing row would be a silent data
migration nobody asked for.

## 6. Constraints
- **Screens stay presentational** — `RecurrenceEditor` renders against props and imports no repo,
  service, `src/execution`, `src/planning`, or clock. All new state lives in the draft.
- No schema, no migration, no engine change. **If you find yourself wanting to change
  `src/services/recurrence/` or `src/types/domain.ts`, stop and report it** — the engine is settled and
  tested, and a UI need that seems to require an engine change is a finding worth surfacing.
- No new native dependency (§2).
- Follow the existing editor's idiom: `SelectChip`, `TextField`, `Stack`, `Row`, `Caption` for errors.

## 7. Test-first (`CLAUDE.md`)
Draft-layer behaviour (the mappings, the clearing rule, validation, round-trip) is straightforwardly
testable — write those tests first and watch them fail. For the presentational rendering, note honestly
in your report what you asserted and what is eyeball-only; the existing screens' test conventions are
your guide. **Name the guarding test for each behaviour.**

## 8. Verify
Baseline **1128 tests / 92 suites**, `tsc` clean, `eslint` 0 errors / 56 warnings. Raw `npx jest` now
reports the true number (worktrees were removed 2026-08-22) — no subtraction.

## 9. Deliverable
The editor + draft changes + the new dropdown component (uncommitted) +
`docs/eval/task46_phase2_findings_report.md`: the component as built and why it needs no native
dependency, the draft mappings, the round-trip proof, the clearing rule's test, what is asserted vs
eyeball-only, real verification numbers, and a section titled exactly **"Deviations from human
decisions"** (empty is valid — write it out). 🔴 **State plainly whether all four modes are now
reachable end-to-end** — that is the whole point of this phase.

## 10. Read first
1. This brief. 2. `docs/eval/task46_phase1_findings_report.md` §7 (what Phase 2 must build, incl. two
engine rules the UI must respect) and `docs/eval/task46_phase1_amendment_report.md`.
3. `src/app/screens/RecurrenceEditor.tsx`, `src/app/tasks/taskDraft.ts`,
`src/app/screens/contracts.ts`, `src/app/components/index.tsx`.
4. `src/types/domain.ts` (`Ordinal`, `OrdinalCell`, `ScheduledRepeat`). 5. `CLAUDE.md`; orientation §3.
