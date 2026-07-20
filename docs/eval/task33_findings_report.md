# Task 33 Findings — Migration 003 + multi-session work headless core

**Status: complete.** The headless surface of the task-28 design landed on `opus/batch-a-headless`;
full suite + `tsc --noEmit` + `eslint` clean (482 tests, no regressions). This is the migration, the
type surface, one repository primitive, the completion fold, the neglect-anchor merge, and one
grammar field — exactly the five deliverables the design report §4 scoped to this task. The
planner/timer/UI retrofit (design §10, tasks 11/13/24) is explicitly NOT here.

**Commits:**
- `7c51595` — migration 003 + types + recordProgressEpisode + fold + anchor merge
- `5d09c21` — task_extraction.v1 `duration_type` grammar field

**Scope decision (recorded up front):** the user framed task 33 as "adds last_worked_at as a third
anchor input," but task 27's findings and spec v2.3 both define task 33 as *migration 003 = the task
28 columns*. `last_worked_at` is inert without the column (migration) and without a writer
(`recordProgressEpisode`), so I implemented the coherent headless unit the design report §4 lists,
and left the planner/timer/UI touches to their owning tasks. The escalated §4.3 extend-guardrail
ruling gates only task 24's UI — migration, primitives, and this anchor proceed without it (design
report §3).

---

## 1. What landed

- **Migration 003 (v2.3 → v2.4, `rebuildsTables`).** `tasks` gains `duration_type`, `work_state`,
  `accumulated_minutes`, `last_worked_at` (plain ADD COLUMNs — CHECK + NOT NULL DEFAULT verified on
  this build); `sessions` gains `tasks_progressed`; `interactions` is rebuilt to widen two CHECKs
  (`interaction_type += 'task_progress'`, `completion_status += 'progress'`), following 002's
  verified rebuild discipline (sqlite_sequence save/restore, index recreation, `foreign_key_check`
  asserted empty). No view reads `interactions`, so there is no drop-view step. `.ts` is
  byte-generated from `.sql`; drift + a full 003 test (fresh + populated-2.3.0 paths) cover it.
- **Type surface** kept honest with the schema: `db.ts` enums (`DurationType`, `WorkState`, widened
  `InteractionType`/`CompletionStatus`) + row columns; domain `Task`/`Session` + mappers.
- **`tasks.recordProgressEpisode(id, minutes)`** — the park primitive: accumulates minutes, stamps
  `last_worked_at`, marks `in_progress`, never writes `skip_count` or touches `success_rate`, stays
  `status='active'`.
- **`completeTask` fold** — one choke point before recurrence dispatch folds
  `accumulated_minutes + episodeMinutes` into one `actual_duration_history` entry, recomputes the
  average, resets accumulated/work_state; identical across all six branches (constraint #7
  untouched).
- **The anchor merge** (§2 below).
- **`duration_type` grammar field** in `task_extraction.v1` (+ json, validator, mapper, guide,
  fixtures, both byte-identical embedded copies).

---

## 2. The anchor merge — I owned both sides

Task 25's R8 landed the accrual gate against a two-way anchor `COALESCE(last_completed_at,
created_at)`; task 33 extends that same expression in `listActiveByNeglect` to the three-way scalar
`MAX(created_at, last_completed_at, last_worked_at)` (design §5). The composed rule is:

```
weeksNeglected = max(0, (now - accrualStart) / 7)
accrualStart   = MAX(created_at, COALESCE(last_completed_at,created_at), COALESCE(last_worked_at,created_at))
                 + neglectAccrualGapDays(recurrence)
```

Both halves are **start conditions, not caps** (constraint #5): working a task re-anchors its clock,
then neglect grows linearly and without bound; the R8 gap only shifts *when* accrual begins. A
parked task accrues from the moment it was last worked and must resurface — it can only stay quiet
by being worked again, which is a surfacing loop, not hiding. This is stated at the site in the
`listActiveByNeglect` doc comment so no refactor drifts it into a ceiling.

Implementation notes:
- `MAX(a,b,c)` is SQLite's **scalar** max (three arguments), a core function — NOT the POWER()-class
  math extension, so it is safe on op-sqlite (design §5 confirms). The `POWER()`-free elapsed
  arithmetic stays in SQL; the R8 gate still subtracts in TypeScript.
- NULL safety: `last_completed_at`/`last_worked_at` are wrapped in `COALESCE(…, created_at)`, and
  `created_at` has a non-null DEFAULT, so no argument to `MAX` is ever NULL (a NULL arg would
  propagate). Covered by a test ("a NULL last_worked_at falls back to the other anchors").

**Did 25's brief and 28's design disagree?** No. The merge was purely sequential — 25 wrote the
two-way anchor + gate, 33 widened the anchor to three-way and left the gate subtraction intact. One
`listActiveByNeglect` function, landed once, correctly, with no seam.

---

## 3. Decisions the design didn't fully pin

1. **A zero-work completion adds no `actual_duration_history` entry.** Design §2.1 says "append
   total"; taken literally, a coaching check-off (episodeMinutes omitted → 0) with no accumulated
   time would append a `0`, biasing `average_actual_duration` low with a false "0-minute task"
   observation. I guard `total > 0`: no work recorded → no observation (censored/no-data ≠ a 0), but
   parked state is still cleared. This upholds the design's own invariant ("one entry equal to the
   total minutes worked") more faithfully than a literal append would. Tested explicitly.
2. **Migration version is 2.4.0**, not 2.3.0 — 002 already set schema_metadata to 2.3.0, so 003 must
   bump monotonically for the runner's `isNewerVersion` logic. Spec version (v2.3, which describes
   these columns as "pending") and schema_metadata version legitimately differ.
3. **`duration_type` is a required extraction field** (enum, not nullable) — the grammar always
   emits `estimate` or `floor`, matching the design's `durationType ::= "estimate" | "floor"`. The
   guide defaults it to `estimate` and reserves `floor` for genuinely open-ended work.
4. **The pre-existing `floor-duration-01` seed fixture (the mokRadio "finish mixing" case) is marked
   `'floor'`** — it is the design's "one 'at least an hour' case," and it was already the natural
   home for it.

---

## 4. Not built here (by design — the retrofit bill, §10)

Left to the owning tasks, against this now-landed contract:
- **Task 11:** `plannedMinutes`, the single-resume deep-focus claim, the countdown/openBlock agenda
  item type, `replanRemaining`'s extend caller + break-first rule, the placement floor.
- **Task 13:** count-up timer for floor/extend, episode accounting, crash/relaunch recovery
  (`abandoned` + credit, never a skip), block/session end-time mutation, pause-% over the episode.
- **Task 24:** the four-outcome end-of-block prompt, the 60-second park gate, the extend control +
  guardrail surface, progress-reads-as-a-win microcopy, session summary framing.
- **Task 17:** consumes the folded per-completion totals; the `accumulated ≥ estimate` early-signal
  seam is named but does nothing in v1.

---

## 5. Consciously left open

- **Device pass on the grammar change (task 32).** `duration_type` widens `task_extraction.v1`; every
  grammar change needs its Phase-B on-device pass. The change is additive and the startup guard
  compiles it, but it is unverified on real hardware.
- **The §4.3 extend guardrail ruling (Jason).** A / B(recommended) / C — still owed. Gates only task
  24's extend surface; nothing here depends on it.
- **Floor-typed subtasks in the breakdown grammar** — cut from v1 (design §9) to keep the 4B's
  breakdown output unchanged; the mokRadio shape is served via breakdown + `modify_task`, or the
  blown-estimate planning rule task 11 will add. Revisit when a real breakdown demands floors.
- **Partial-duration learning** — no partial observation is written mid-flight; the fold is the only
  write point. Seam named for task 17 (design §2.3).
- **`active_tasks_with_neglect` view** left as-is in 003 (it still uses POWER() and is unread by
  code); task 27's schema fold-in refreshes it. The live anchor change is in `listActiveByNeglect`.
