# Headless work queue — staged 2026-08-22

**What this is.** The ordered queue of **headless** tasks that are **not** blocked by device (`P`) work
and **not** gated by task 31 — the work that can proceed while the model-migration chain waits on the
corpus and while the device sessions are unscheduled. Staged at Jason's instruction, **task 53 at the
head.**

**How it runs (the discipline):** each task-subagent is launched from a **written brief** in
`docs/briefs/` with a **minimal spawn prompt** (point it at the brief; don't re-state the brief inline),
and **returns a report**. The coordinator **reviews + verifies each** (reads the report, re-runs
`jest`/`tsc`/`eslint`, reviews the diff), commits it, updates the board, **then launches the next** —
serial, because all subagents share one working tree and would collide if run in parallel. (Worktree
isolation could parallelize later; serial + review-between is the safe default now.) Per `CLAUDE.md`,
every code change is **test-first**.

**Excluded and why:** device-bound — 14 Phase B, 15, 32, 44 (device residue), 29, 30, and the `P`
halves of 19/22; 31-gated — 20, 38, 40; human / beta-gate — 21, 42, 43; a Jason ruling, not a subagent
task — 22.

## The queue

| # | Task | Model | Brief | Scope (one line) | Status |
|---|---|---|---|---|---|
| 1 | **53** Test-suite integrity audit | Opus | `test_audit_task_53.md` ✅ | Find existing tests that would pass even if the code were wrong (mutation heuristic). Audit-only. | 🟡 **launched** |
| 2 | **17** Numeric learning loops | Opus | ⬜ *to write* | Six learning loops + hierarchical shrinkage + regression/rollback; **owns the missing `completion_count`/`success_rate` writer** (task 44's seam). | queued |
| 3 | **49** Widen circular-dep trigger | Opus | ⬜ *to write* | Migration to catch cycles of length ≥3 (today only length-2 is caught; a 3-cycle permanently filters every task in it). Needs the CHECK/trigger rebuild + prior-suite sweep. | queued |
| 4 | **45** Deviation audit | Opus | `deviation_audit_task_45.md` ✅ | Audit builder decisions that changed a human ruling without sign-off; relabel orientation §5. Audit-only. | queued |
| 5 | **46** "Every N weeks" recurrence | Sonnet | ⬜ *to write* | Additive `interval` on the `scheduled` recurrence (JSON, no migration) + a UI control + an anchor date + one `period.ts` fn. | queued |
| 6 | **52** Extraction-guide budget pass | Sonnet | `extraction_guide_budget_task_52.md` ✅ | Reword line 45's stale "ONLY field you may guess" + trim `tool_requirements`/`context_tags` to recover the energy line's ~60 tokens. *(Edit is headless; no-regression confirmation rides on 31's eval.)* | queued |
| 7 | **47 + 51** `docs/reference/` pass | Sonnet | ⬜ *to write (one brief, both)* | Regenerate the schema snapshot (2 migrations + 007 stale) **and** fold the spec §8.4 backup amendment + `session_ended_early` into the spec — one pass, per the board's "pair" note. | queued |

**Ordering rationale.** 53 heads it (Jason). Then the two Opus items with real teeth — **17** (unblocks
the historical-success signal that scores every task off n=0) and **49** (a latent bug that can silently
starve tasks) — while that context is fresh. **45** (audit) next. Then the Sonnet cleanups: **46**, **52**,
and the combined **47+51** docs pass last. Briefs for the ⬜ rows get written just-in-time, before each
launch, from the detailed board rows + cited docs.

**Board is the source of truth for status;** this file is the running order. Update the Status column as
each lands, and strike a task when it's committed.
