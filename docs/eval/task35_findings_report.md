# Task 35 Findings Report — spec fold-in (v2.3 → v2.4)

**Verdict: DONE.** `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` exists and folds in
migration 004 (task 34), task 11's planner contracts, the extend amendment (Jason's 2026-07-20
ruling), and migration 005/task 13. v2.2, v2.3, and the `.sql` schema snapshots (v2.2/v2.3/v2.5) are
untouched — confirmed via `git status --short`, which shows only this report and the new spec file as
additions; nothing under `docs/reference/*v2.2*`, `*v2.3*`, or `*v2.5.sql*` was opened with an edit
tool. **File-disjoint by construction**, per the brief: everything touched lives under `docs/` (the
new spec, this report); nothing under `src/` was modified, only read for sourcing.

**Date:** 2026-07-31. Docs-only, headless.

---

## 1. What changed, section by section

- **Header / revision note** — new top-of-file revision note (v2.4) plus a dedicated
  **version-numbering note** explaining the brief's naming correction: spec version and
  `schema_metadata` version track different things and legitimately drift; the spec's sequence is
  v2.2 → v2.3 → v2.4 (unbroken), while the schema is at 2.6.0 on-device (migration 005) against a
  newest on-disk snapshot of 2.5.0. States plainly that this mismatch is expected and should not be
  "fixed" by a future reader — the brief's explicit instruction (§0 of the brief).
- **New "Changes in v2.4 (from v2.3)" section** — added above the existing "Changes in v2.3" list,
  following the same convention task 27 established; the v2.2/v2.3 change lists and the "Summary of
  Changes from v1" are retained verbatim below it, untouched.
- **§4.2** — one new paragraph: **task 36's time-driven recurrence behavior marked ruled-but-unbuilt**
  (see §3 below). Nothing else in §4.2 (the five-type table, the `null`/`unscheduled` distinction, the
  `count`+dependency composition, R8 exemptions) was touched.
- **§4.5** — rewritten. Migration 003 corrected from "pending" to **landed** (task 33); migration 004
  (task 34) — the `algorithm_weights` reconciliation to 31/23/23/23, `context_fit`'s unconditional
  deletion, the four survivors' `data_points_count = 0` reseed guard, and the drop of
  `active_tasks_with_neglect` — folded in with its full reasoning; migration 005 (task 13) described in
  prose (three session-runtime tables, epoch-ms columns, the `active_episode` singleton, `sessions`
  born `'abandoned'`) since **no new `.sql` snapshot ships with this pass** (brief's explicit
  instruction — the snapshot catch-up is task 34/27-lineage work, not task 35's).
- **§5.3** — rewritten to state the session planner is **landed** (task 11), with exact names pulled
  from `src/planning/`: `runSelectionBoundary`, `filterBySessionCapability`, `filterDependencyBlocked`
  (+ its R7-hold third argument, `pendingBreakdownCompleteTaskIds`), the `PlanAdjustment` seam (`v1
  passes nothing`), `blockKind` (`'countdown' | 'openBlock'`), `plannedMinutes()`, the placement-floor
  gross-vs-buffered distinction, and `replanRemaining`'s three callers (escape valve, break overrun,
  extend) with the regenerate-not-shift contract. The `nothing_fits`/`splitCandidate` first-class
  5-minute-session behavior is named explicitly, sourced from `planner.ts`.
- **§6.2** — the Extend bullet rewritten for the two-affordance split: the five-option end-of-block
  prompt, the `+5`-vs-`Keep going` comparison table (quantum, timer face, tail behavior, session-end
  behavior, `sessions.extended`, guardrail applicability), the uncapped-`+5` ruling and its reasoning,
  the `repeated_extension` trigger (both arms, the floor, the "data on `pattern_detected`, no
  migration" precision the brief asked for), the ruled §4.3 guardrail (option B, hyperfocus only, all
  three switches), and the task-13-§9.4 JS-timer-cannot-be-the-alarm finding as an explicit
  implementation constraint on task 24. The Timer bullet gained one clause noting the timer is now
  built and device-confirmed.
- **§8.2** — the "Timers are timestamp-based" paragraph expanded to state the engine is built and
  device-confirmed, name the three recovery directives (`resume_block` / `block_expired` /
  `session_over`), the bounded recovery-credit rule (with the 40-min-dead-on-a-25-min-block test
  number), and the born-`'abandoned'` crash-truthful design. Two new paragraphs: the alarm constraint
  (cross-referencing §6.2, not duplicating it) and session lapse (`pattern_detected` /
  `session_lapsed`, deduplicated). The backgrounding/pause paragraph gained the >20%-pause
  implementation detail (`pattern_detected` / `high_pause_ratio`) and the 70-second device test. The
  four-episode-outcomes bullet list is **untouched** (v2.3's text was already accurate). The break-
  overrun sentence gained a `replanRemaining` cross-reference.
- **§8.7** — rewritten. Header now reads "resolved (task 28), amended (extend split), and built (task
  13)"; pointers added to the amendment doc and the task 13 findings report alongside the original
  design doc. The extend-guardrail item **removed from the "genuinely open" list** (it's ruled now —
  moved into §6.2) and **replaced** with two open items surfaced by task 13's own report: overnight
  doze untested, and the close-ordering crash window. Floor-typed-subtasks-in-breakdown-grammar and
  floor-tuning-policy carry forward unchanged, still open, per the brief's explicit instruction not to
  invent resolution for open items.
- **§11** — new "Status as of this spec version" paragraph naming the landed task list (11, 13, 25,
  26, 27, 33, 34), the 23→24 critical path, and task 36 as new/headless/unbuilt. Two Phase-list lines
  touched to add "(built — task 11)" / "(built — task 13; migrations 003+005)" tags; one new Phase 2
  line for task 36 ("ruled but not yet built"). Nothing else in §11 changed.
- **§7.2 — deliberately untouched.** Per the brief's explicit precision instruction: `repeated_extension`
  and `long_extend` are `trigger_data.kind` values on the existing `pattern_detected` trigger type, not
  new `coaching_queue` trigger types, and no migration adds them. The five-row trigger table is
  byte-identical to v2.3; both new kinds are documented in §6.2/§8.2 instead, exactly where the brief
  pointed.
- **Everything else** — §1–§3, §4.1/§4.3/§4.4, §5.1/§5.2/§5.4/§5.5, §6.1/§6.3/§6.4, §7.1/§7.3,
  §8.1/§8.3–§8.6, §9, §10 (except principle 2's cross-reference, left as-is since it's still accurate at
  the principle level and the brief didn't name §10) are byte-identical to v2.3.

## 2. Formulas and names — sourced, not restated from memory

Per the brief's central rule, every name/formula newly added in this pass was pulled from source, not
from the brief's own summaries (the brief explicitly warns "pull the exact names and formulas from
`src/planning/` and the findings report — not from this brief's summary of them"):

| Item | Source | Landed? |
|---|---|---|
| `runSelectionBoundary`, `filterBySessionCapability`, `filterDependencyBlocked` order | `src/planning/planner.ts:95-112` | **Yes** (task 11) |
| `pendingBreakdownCompleteTaskIds` as filter 2's third argument | `src/planning/service.ts:17,48` | **Yes** (task 11) |
| `PlanAdjustment` type + `adjustPlan` hook, "v1 passes nothing" | `src/planning/service.ts:38,58,80` | **Yes** (task 11; deliberately unconsumed in v1) |
| `blockKind: 'countdown' \| 'openBlock'` | `src/planning/agenda.ts:20` | **Yes** (task 11) |
| `plannedMinutes(task, blockWorkMinutes)` formula (open-ended/in-progress/fresh cases) | `src/planning/plannedMinutes.ts:60-66` | **Yes** (task 11) |
| Placement floor compares gross block minutes, not buffered work minutes | `src/planning/plannedMinutes.ts:36-49` (comment + code) | **Yes** (task 11) |
| `replanRemaining`'s three callers + regenerate-not-shift | `src/planning/planner.ts:166-202` | **Yes** (task 11) |
| `DEEP_FOCUS_MIN_SESSION_MINUTES=45`, `DEEP_FOCUS_BLOCK_FRACTION=2/3`, `DEEP_FOCUS_OVERRUN_BUFFER=0.25`, `LONG_STRETCH_BREAK_FIRST_MINUTES=50`, `EASIER_MAX_ITEM_MINUTES=25`, `BREAK_MINUTES=5`, `DIFFICULTY_JITTER=1.5` | `src/planning/planner.ts:44-77` | **Yes** (task 11) |
| Migration 004's asymmetric guard (unconditional delete vs. `data_points_count=0` reseed) | `src/db/migrations/004_algorithm_weights_reconciliation.sql:31-40,82-111` | **Yes** (task 34) |
| `active_tasks_with_neglect` drop reasoning (`POWER()` unavailable on-device) | `src/db/migrations/004_algorithm_weights_reconciliation.sql:42-57` | **Yes** (task 34) |
| Migration 003 landed (task 28's six columns) | `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql:1-56` (header changelog) | **Yes** (task 33) |
| Three session-runtime tables, epoch-ms rationale, singleton `CHECK (id=1)` | `src/db/migrations/005_session_runtime.sql:1-136` | **Yes** (task 13) |
| `sessions.status` CHECK has no in-progress value; born `'abandoned'` | `docs/eval/task13_findings_report.md` §4 (cross-checked against `docs/reference/..._v2.5.sql:264`, which shows the CHECK itself, though not the born-`'abandoned'` write pattern — that's an application-level convention in `src/execution/episodeService.ts`, not a schema constraint) | **Yes** (task 13) |
| `SHORT_EXTENSION_MINUTES=5`, `EXTEND_QUANTUM_MINUTES=25`, guardrail switches, `REPEATED_EXTENSION_PRESS_COUNT=3`, `REPEATED_EXTENSION_ESTIMATE_FRACTION=0.5`, `REPEATED_EXTENSION_MINUTES_FLOOR=10`, `SELF_CARE_NUDGE_EVERY_QUANTA=2`, `LONG_EXTEND_BLOCK_MULTIPLE=2` | `src/execution/constants.ts` | **Yes** (task 13) |
| `repeated_extension`/`long_extend`/`high_pause_ratio`/`session_lapsed` as `trigger_data.kind` on `pattern_detected`, no migration | `src/execution/episodeService.ts` (four call sites) + `docs/reference/..._v2.5.sql:389-399` (confirms `pattern_detected` already a legal `trigger_type`, pre-existing) | **Yes** (task 13) |
| JS-timer-cannot-be-the-alarm finding, 38–45s late | `docs/eval/task13_findings_report.md` §9.4 | **Confirmed on hardware**, not yet acted on — task 24's to implement |
| Recovery-credit bound test (40 min dead / 25-min block → credits 25) | `docs/eval/task13_findings_report.md` §9.2 | **Yes**, device-confirmed |

I did not re-derive R1/R6/R8/task-28's re-anchor formulas (§5.1/§5.2) — those were already correctly
sourced and landed in v2.3 by task 27's pass, and the brief's fold-in list for this task doesn't name
§5.1/§5.2 as targets, so I left them untouched rather than re-verifying against current code (out of
scope; re-verifying every formula in a section not flagged for change would be scope creep beyond
what the brief asked for).

## 3. Task 36 — confirmed ruled-but-unbuilt, marked in §4.2 and §11

The brief predicted this ("task 36 is likely still unbuilt when you write") and it held: I checked
directly rather than trusting the brief's guess.

- `docs/eval/task36_findings_report.md` does not exist (`Glob` returned no match).
- No file matching `advanceRecurrence` exists anywhere under `src/` (`grep -rl` empty).
- `git log --oneline --all | grep -i "task 36"` returns nothing; `git log --oneline main..opus/batch-a-headless`
  is empty (the two branches are identical — `main` already has every headless task through 34 merged).
- `src/db/repositories/recurrence.ts` exists (the data-access layer task 36 will consume) but nothing
  in `src/services/` implements the period-rollover sweep the brief describes.

Marked in two places, per the brief's explicit instruction ("mark its §4.2 time-driven behavior as
ruled-but-unbuilt if so"):
- **§4.2** — a new paragraph immediately after the existing recurrence-behavior description, stating
  plainly that `completeTask` only does the completion-driven half, that nothing sweeps period
  boundaries yet, and what that means concretely (a `scheduled` task's `next_due_at` does not advance
  on its own; quota periods do not roll).
- **§11** — named in the new status paragraph and given its own Phase 2 bullet ("ruled but not yet
  built").

I did **not** touch `src/services/taskCompletion.ts`'s scope-line comment or any other code — this is
a docs-only pass, and the brief is explicit that file-disjointness from tasks 13/36 (which work in
`src/`) is what let task 27's precedent (and this task) run safely in parallel with device/code work.

## 4. Conflicts between documents

**None found rising to task 27's precedent (the R8-mechanism conflict between two documents that both
claimed to state the same ruling differently).** I checked specifically for this pattern across the
five source documents (task 34 report, task 11 report, task 13 report, the amendment, migration
005's own header) because the brief called it out as "the highest-value output of a pass like this."
Findings:

- **The amendment's guardrail ruling (option B) matches the original task-28 design's own
  recommendation** (v2.3 §8.7 already summarized the design's three options correctly, including
  which one was "recommended"; the amendment adopts that same option). Not a conflict — a ruling
  confirming a prior recommendation, not overriding a competing one.
- **Task 13's implementation of the guardrail threshold** (`longExtendThresholdCrossed`: fires when
  `hyperfocusQuanta × 25 > plannedMinutes × 1`, i.e., strictly beyond 2× the original block) matches
  the amendment's prose ("beyond 2× the original block") and task 13's own test comment ("exactly 2×
  is silent") — verified the arithmetic by hand rather than trusting either prose description in
  isolation, since this is exactly the kind of off-by-one a "beyond N×" description can hide. No
  discrepancy.
- **The migration-005-vs-006 numbering hazard flagged in migration 005's own header** ("task 36 may
  also want migration 005... whoever merges second renumbers to 006") is **not live** — task 36's own
  brief (`docs/briefs/recurrence_period_engine_task_36.md`, same date, 2026-07-20) already says "Task
  13 has landed... so if this task needs a migration it is 006 / schema 2.7.0." The hazard was
  pre-resolved by the two briefs coordinating on the same day, before I read either. Recorded here
  because it's exactly the shape of thing worth flagging, even though it resolved cleanly.
- **One near-miss, not a conflict, worth a note:** v2.3 §8.7's open-items list described the (then-open)
  extend guardrail as gating "only task 24's extend UI surface, not the data model, the migration, or
  the planner." Once task 13 actually built it, that framing turned out to be slightly optimistic —
  `active_episode.hyperfocus_quanta` and `active_episode.long_extend_enqueued` are real persisted
  columns that exist *because* the guardrail needs a durable count and a dedup flag (migration 005).
  This isn't two documents disagreeing (the v2.3 sentence was accurate when written, about a design
  that hadn't been built yet), just a prediction that didn't fully hold once implementation happened —
  v2.4 doesn't repeat the "UI surface only" claim anywhere.

## 5. What I verified directly rather than trusting a summary

- Read `src/planning/planner.ts`, `agenda.ts`, `plannedMinutes.ts`, `service.ts` in full for §5.3's
  names and constants, rather than relying on the task 11 findings report's prose alone (the report's
  own §1 line numbers, e.g. "planner.ts", were confirmed against the actual current file).
- Read `src/db/migrations/004_algorithm_weights_reconciliation.sql` and `005_session_runtime.sql` in
  full for §4.5, rather than relying on the task 34/13 reports' summaries.
- Read `src/execution/constants.ts` and `timer.ts` in full for the exact tunable names/values in §6.2,
  rather than trusting the amendment doc's prose (which predates the code and doesn't name
  `SHORT_EXTENSION_MINUTES` etc. — those names only exist in `src/execution/`).
- Read `src/execution/episodeService.ts` in full to confirm the `trigger_data.kind` values actually
  written (`repeated_extension`, `long_extend`, `high_pause_ratio`, `session_lapsed`) and that all four
  route through the pre-existing `pattern_detected` trigger type — confirmed against
  `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql`'s `coaching_queue.trigger_type`
  CHECK directly (nine values, `pattern_detected` among them, unchanged since migration 002) rather
  than assuming the amendment's prose claim ("this needs no migration") was still true after task 13
  landed.
- Ran `git log`/`git branch -a`/`grep` directly to confirm task 36's unbuilt status rather than trusting
  the brief's prediction at face value (§3 above).

## 6. Left open, stated plainly (per the brief's "do not invent resolution" instruction)

Carried forward from v2.3, untouched: the `which:"next"` weekday semantics (task 22), crisis-detector
coverage (task 21), the device envelope (task 30), the 8B/1.7B quant path (task 29), floor-typed
breakdown subtasks, and floor-tuning policy (task 17).

Newly surfaced by this pass, and left open in the spec rather than resolved:
- **Task 36's entire scope** (§4.2, §11) — ruled, not built.
- **Task 13's own residual items**, now visible in §8.7 since that section folds task 13 in: overnight
  doze untested (Phase B ran only a forced deep-idle proxy), and the episode-close-then-outcome-write
  ordering window (needs a real transaction across two repositories, not built).
- **Not added to the spec, but worth a line here:** task 13's report also flags that
  `completion_count`/`success_rate` have no writer anywhere in the codebase (so `historicalSuccessFactor`
  scores every task off a permanent `n=0`), and that the `PlanAdjustment` contract (§5.3) is stated but
  not validated against a hostile adjuster. Both are real and both predate this pass; I judged them
  out of scope for a docs fold-in whose brief named specific sections to update, and neither is
  something v2.3's existing text claims is otherwise — raising it here so it isn't lost, per task
  27's own precedent of surfacing stale/dangling items noticed in passing.

## 7. Files touched

- `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` — new
- `docs/eval/task35_findings_report.md` — new (this report)
- No other file modified. `docs/reference/*v2.2*`, `*v2.3*`, `*v2.5.sql*` untouched; nothing under
  `src/` touched.

## 8. Verification

- Re-read every modified section of the new v2.4 file after writing it, cross-checked against the
  brief's five fold-in items (a)–(e) and the "what NOT to do" list.
- `git status --short` shows exactly two new files, nothing modified or deleted.
- Confirmed §7.2's trigger table is byte-identical to v2.3 (diff by eye, five rows, no additions).
- Confirmed the version-numbering note and the "do not lengthen §7.2's list" instruction are both
  honored by construction — `repeated_extension`/`long_extend`/`high_pause_ratio`/`session_lapsed`
  appear only in §6.2/§8.2 prose, never in a `coaching_queue`-trigger-type list.
