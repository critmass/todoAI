# Task 27 Findings Report — spec fold-in (v2.2 → v2.3)

**Verdict: DONE.** Every item in the brief's change list is folded into
`docs/reference/ADHD_Task_Management_App_Specification_v2.3.md`; v2.2 is retained untouched. The
schema companion is also updated to a v2.3 snapshot
(`docs/reference/ADHD_Task_Management_App_Database_Schema_v2.3.sql`), with v2.2's `.sql` retained.
Documentation only — no code, no test changes, nothing in `src/` touched.

**Date:** 2026-07-19. **Branch:** `opus/batch-a-headless`, in parallel with tasks 25/33 (no overlap:
they work in `src/`, this pass worked only in `docs/reference/` plus the two eval/report files the
brief's Definition of Done names).

---

## 1. What changed

Every change-list item from `docs/briefs/spec_foldin_task_27.md` landed, section by section:

- **§2.3** — updated to drop context-fit from the scored-factor list and state the two-hard-filter
  boundary. *(Not explicitly named in the brief's change list — see §3 below for why it was
  touched anyway.)*
- **§4.1** — R7 parent lifecycle (kept, dependency-linked, held out of the pool, confirmed not
  auto-completed); the four task-28 fields (`duration_type`, `work_state`, `accumulated_minutes`,
  `last_worked_at`) with their exact semantics; floor-duration overrun-is-not-an-error statement;
  importance banding left untouched, as instructed.
- **§4.2** — R8's exemption list (`unscheduled`/`count` ungated) and `count`'s per-increment fold,
  stated without touching the unchanged recurrence-type table.
- **§4.5** — schema companion at 2.3.0 via migration 002, migration 003 flagged pending from task
  33, and the hand-maintained-vs-generated determination (§4 below).
- **§5.1** — weights table now 31/23/23/23, context/tools row removed with a pointer to the new
  hard-filter home; R6's exact smoothing formula, taken from `postreview_scoring_task_25.md`
  verbatim (not from code — R6 hasn't landed yet, see §5).
- **§5.2** — R1's exact curve taken from `src/scoring/score.ts:34-36` (`neglectCurve(weeks) = 1 +
  weeks`, confirmed landed); R8's exact accrual-gate formula and worked reference table taken
  verbatim from the source brief (not landed in code yet); task 28's three-way re-anchor taken
  from the design doc's own SQL comment; an explicit "start condition, not a cap" paragraph with
  the reasoning, per the brief's instruction to keep the reason.
- **§5.3** — the two-hard-pre-filter selection boundary (session-capability then
  dependency-blocked, both retaining rejects) stated as a preamble before the numbered algorithm;
  the deep-focus resume-claim step; extend's regenerate-not-shift rule and the ≥50-minute
  break-first rule.
- **§5.4** — the model-guess-waits-for-the-fold rule (censored-data reasoning kept); an explicit
  sentence tying R6's fixed prior to its future learned-prior replacement, added to this section
  specifically (not just §5.1) since the brief's change list named §5.4 separately.
- **§6.2** — Extend un-flagged from "proposed"; the exact tunable name and value
  (`EXTEND_QUANTUM_MINUTES = 25`) from the design doc; the guardrail explicitly marked open with
  its three options summarized, not resolved; a new **Park** bullet (see §3 below for why).
- **§7.2** — five-row table; `buried_task`'s timing/purpose and its sentinel re-trigger-prevention
  mechanism; `breakdown_complete`'s immediate timing and non-auto-completion; the
  recalibration-beats-breakdown-complete precedence rule recorded explicitly.
- **§8.1** — the "reached through retained rejects, not a separate scan" mechanism stated.
- **§8.2** — the four episode outcomes (completed/parked/skipped/abandoned) defined precisely,
  with "the app never abandons a task by inference" and park's skip-immunity stated structurally,
  not just as policy.
- **§8.7** — rewritten from "open" to "resolved," with a pointer to the design + report and the
  three genuinely-open items named (guardrail ruling; floor-typed breakdown subtasks; floor tuning
  policy) rather than implied settled.
- **§10** — principle 2 updated to describe Extend as the resolved inverse of the escape valve;
  principle 5 gained a one-clause pointer to the start-condition/cap distinction.
- **Revision note + "Changes in v2.3" section** — added at the top, following the existing v2.2
  convention; the v2.1/v2.2 revision history is untouched, per the "preserve the convention"
  constraint.

No section was renumbered or restructured. Sections not named by the change list (§3, §6.1, §6.3,
§6.4, §7.1, §7.3, §8.3–§8.6, §9, §11) are byte-identical to v2.2 except where a cross-reference to
§8.7 needed its "open item" language updated to "resolved" (§2.2, mechanically, one clause).

## 2. Formulas — sourced, not restated from memory

Per the brief's central rule, every formula in the new spec was copied from its authoritative
source, not from the brief's own summaries:

| Formula | Source | Landed in code? |
|---|---|---|
| `neglectCurve(weeks) = 1 + weeks` (R1) | `src/scoring/score.ts:34-36` | **Yes** (task 10, confirmed via `git log` — commit `ac5da48`) |
| `historicalSuccessFactor(rate, n) = (rate·n + 0.5·k)/(n+k), k=2` (R6) | `docs/briefs/postreview_scoring_task_25.md` §1 | **No** — `src/scoring/factors.ts:124-127` still has the pre-R6 hard branch (`n ≤ 0 → 0.5`, else raw rate) as of this pass |
| `accrualStart = anchor + gap(recurrence)`, `gap = period/(1+quota)` (R8) | `docs/briefs/postreview_scoring_task_25.md` §4 | **No** — `listActiveByNeglect` has no recurrence-aware gate yet |
| Three-way `MAX(created_at, last_completed_at, last_worked_at)` re-anchor (task 28) | `docs/design/multisession_task28_design.md` §5 (the SQL comment) | **No** — task 28 is design-only; `work_state`/`last_worked_at` columns don't exist (migration 003 pending) |
| 31/23/23/23 weights, context/tools filter (R3) | `src/scoring/factors.ts:21-26`, `src/scoring/filter.ts` | **Yes** (task 10) |

I confirmed the R6/R8/task-28 non-landed status directly: `docs/eval/task25_findings_report.md`
does not exist (`Glob` returned no match), `src/scoring/filter.ts` has no dependency-blocked
filter (only `filterBySessionCapability`, R3's), and `src/services/breakdown.ts`'s
`persistBreakdown` does not yet link the parent to its subtasks. This matters for anyone reading
the spec next to the code: **v2.3 describes the ruled target state for R6/R7/R8/task-28, not
what's running today.** I did not soften this in the spec itself (the spec's job is to describe
the target, same as v2.2 did for the tiering ladder before 4B was proven) — but it's worth stating
plainly here so a session picking up task 25 or 33 doesn't assume the spec fold-in means the code
landed too.

## 3. Where I went slightly beyond the literal change list, and why

Two small additions weren't named in the brief's per-section list but follow directly from items
that were:

1. **§2.3's overview paragraph.** It restated "importance, urgency, energy match, context fit,
   historical success" as the five *scored* factors — the exact retired composition §5.1 was
   fixed for. Leaving it would mean the spec contradicted itself between §2.3 and §5.1 one screen
   apart. Fixed to match §5.1/§5.3's two-filter language.
2. **§6.2's Park bullet.** The change list's §6.2 item only mentions Extend, but the task-28 design
   presents Extend and Park as two halves of the same end-of-block prompt ("Done · Keep going ·
   Pause for later · Something easier"), and §8.2's four-outcome requirement (explicitly in the
   change list) introduces Park as a first-class concept with no other natural home in the UI-flow
   section. Describing Extend's resolution without ever mentioning the affordance that shares its
   trigger point seemed more likely to mislead than to add scope creep, so I added one bullet.

Flagging both here per the "state what you noticed" instruction, since neither was explicitly
asked for.

## 4. Conflict between sources — resolved per the brief's own rule

**R8's mechanism changed between the two source documents that both claim to state it**, and this
is exactly the "where two disagree, the later one wins" case the brief anticipated:

- `docs/eval/task10_fable_review_report.md` (dated 2026-07-18, U6) proposes: don't accrue neglect
  while `next_due_at − now > URGENCY_HORIZON_DAYS`, i.e.
  `effective clock start = max(anchor, next_due_at − horizon)`.
- `docs/briefs/postreview_scoring_task_25.md` (§4, explicitly labeled "R8 — neglect accrual gate
  for recurring tasks (U6, **re-ruled**)") replaces this with a different mechanism entirely:
  `accrualStart = anchor + gap(recurrence)`, where `gap = period/(1+quota)` — no reference to
  `next_due_at` or a horizon constant at all.

These are not the same rule with different constants; they gate on different things (a due-date
horizon vs. an occurrence-spacing half-gap). The postreview brief's own heading marks this as a
deliberate re-ruling, not an oversight, so I took **only** the postreview brief's formula into
§5.2 and did not attempt to reconcile or mention the fable report's version in the spec body
(the spec should state the ruling, not its history) — but I'm recording the conflict here as
instructed.

## 5. Stale items noticed, not in the brief's list

- **`algorithm_weights`' seed data never got a migration.** Both the v2.2 reference `.sql` and
  `src/db/migrations/001_initial_schema.sql` seed this learned-weights table at the retired
  25/20/20/15/20 split with `context_fit` still a valid `factor_name`. R3 changed
  `src/scoring/factors.ts`'s actual `FACTOR_WEIGHTS` to 31/23/23/23 with `context_fit` removed
  entirely, but nothing has ever migrated the *table* that's supposed to persist learned weights
  for §5.4. This is dormant today (task 17, the consumer, doesn't exist yet) but it's a real
  latent inconsistency between two places the same fact lives. I flagged it in both the spec
  (§4.5) and the new schema snapshot's header/table comments rather than silently fixing it — this
  is a schema/migration decision (task 17 or a dedicated migration), not a docs fold-in call.
- **§2.2's cross-reference to §8.7** ("Long/open-ended work interacts with the §8.7 open design
  item") was stale the moment §8.7 resolved; updated to "is resolved" as a one-clause fix while
  passing through — not called out in the brief's per-section list but trivially in scope.
- **The coaching-trigger urgency plumbing (`src/services/coaching/triggers.ts`) is already ahead
  of its callers.** Migration 002 added the `buried_task`/`breakdown_complete` CHECK values and
  task 26 already wired `urgencyForTrigger` for both (confirmed by reading the file), but the
  actual conversation-generating callers are explicitly still task 19 (skill layer) and task 25
  (R7 implementation) per that file's own comments. The spec describes the *designed* trigger
  behavior (correct for a spec), but a reader should not infer from §7.2 alone that the coaching
  conversations themselves are wired up yet — only the queue plumbing is.

## 6. Is the reference `.sql` hand-maintained or generated?

**Hand-maintained.** Checked for a generation script (`Grep` across `.ts`/`.js`/`.json`/`.md` for
anything that writes to `docs/reference/*.sql` or reads `src/db/migrations/` to produce it) and
found none — every hit was a *reference to* the file from briefs/reports, not a generator. This is
also evidence-supported: the v2.2 snapshot predates and diverges from migration 002 (still shows
`skills.is_active DEFAULT TRUE`, no `learning_state`, no `skill_evidence.source`, the seven-value
`coaching_queue` CHECK) even though migration 002 landed and is tested (`docs/eval/task26_findings_report.md`)
before this pass started — a generated file would not have drifted that way.

Given that, I **updated it** rather than leaving a note: created
`docs/reference/ADHD_Task_Management_App_Database_Schema_v2.3.sql` (v2.2's file retained
untouched, mirroring the spec's own versioning convention) reflecting migration 002's six changes
exactly, with explicit comments marking (a) migration 003's columns as **not yet present** — task
28's `duration_type`/`work_state`/`accumulated_minutes`/`last_worked_at`/`tasks_progressed`/the two
new `interactions` enum values are pending from task 33, so I did not add them, and (b) the
`active_tasks_with_neglect` view as **stale/bypassed**, since it still computes the retired
`weeks²` curve via `POWER()` (unavailable on-device) and reflects none of R1/R8/task-28 — the real
computation lives in `listActiveByNeglect` in TypeScript, as the app has done since task 9. I left
the view's SQL unchanged rather than "fixing" it to match a curve it can't actually run, since
`POWER()` failing on-device means this view was already dead code before this pass and rewriting
it doesn't change that.

## 7. One naming deviation from the brief, and why

The brief's Definition of Done and read-first list both write the target filename with an
underscore (`ADHD_Task_Management_App_Specification_v2_3.md`, `..._v2_2.md`). The actual existing
file is `ADHD_Task_Management_App_Specification_v2.2.md` (period, matching the two-decimal
convention the file's own content uses throughout — "v2.2", "v2.1"). I named the new file
`ADHD_Task_Management_App_Specification_v2.3.md` (period) to match the real, existing convention
rather than the brief's apparent typo, and did the same for the schema snapshot. Flagging this as
the filename-level instance of "where sources disagree" — here it's the brief vs. the actual
repository convention, and I judged the repository's own established naming as authoritative over
what looks like a transcription slip in the brief.

## 8. Verification

- Every change-list item cross-checked against the new v2.3 file by re-reading each cited section
  after writing it.
- `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md` untouched (not re-read after the
  initial pass; no edit tool was ever invoked against it).
- No file under `src/` was read for editing purposes (only for sourcing exact formulas/state, per
  the brief's explicit permission to prefer code over documents where code exists).
- `git status`-relevant scope: this pass added two new files under `docs/reference/` and this
  report under `docs/eval/`; nothing else.
