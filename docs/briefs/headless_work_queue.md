# Headless work queue — staged 2026-08-22

**What this is.** The ordered queue of **headless** tasks that are **not** blocked by device (`P`) work
and **not** gated by task 31 — the work that can proceed while the model-migration chain waits on the
corpus and while the device sessions are unscheduled. Staged at Jason's instruction, **task 53 at the
head.**

**How it runs (the discipline):** each task-subagent is launched from a **written brief** in
`docs/briefs/` with a **minimal spawn prompt** (point it at the brief; don't re-state the brief inline),
and **returns a report**. The coordinator **reviews + verifies each** (reads the report, re-runs
`jest`/`tsc`/`eslint`, reviews the diff), commits it, and updates the board. **Waves run in parallel
using `isolation: "worktree"`** — each agent gets its own checkout, so the constraint is no longer the
shared tree but (a) file-disjointness at merge time and (b) how many reports the coordinator can verify
properly in one batch. A review pile-up is how unread "sounded all green" reports have hurt this project
before, so waves are kept small. Per `CLAUDE.md`, every code change is **test-first**.

**Excluded and why:** device-bound — 14 Phase B, 15, 32, 44 (device residue), 29, 30, and the `P`
halves of 19/22; 31-gated — 20, 38, 40; human / beta-gate — 21, 42, 43; a Jason ruling, not a subagent
task — 22.

## The queue

| # | Task | Model | Brief | Scope (one line) | Status |
|---|---|---|---|---|---|
| ~~1~~ | ~~**53** Test-suite integrity audit~~ | Opus 5 | `test_audit_task_53.md` ✅ | 33 mutations, 15 survivors, 12 confirmed weak. Report: `docs/eval/test_audit_task53_findings.md`. | ✅ **DONE 2026-08-22** |
| ~~2~~ | ~~**54** Ladder salvage-rejection guard *(53 W1)*~~ | Opus 5 | `ladder_salvage_guard_task_54.md` ✅ | Guard added + **proven** to fail against the mutation (`"restored"` vs `"salvaged"`; 400 vs 0 rows). No production change. Report: `docs/eval/task54_findings_report.md`. | ✅ **DONE 2026-08-22** |
| ~~3~~ | ~~**17** Numeric learning loops — **Phase A**~~ | Opus 5 | `numeric_learning_task_17_phaseA.md` ✅ | Writer built (the live one-sided gap closed); 18 tests red before the code existed. Report: `docs/eval/task17_phaseA_findings_report.md`. | ✅ **PHASE A DONE 2026-08-22** |
| ~~3b~~ | ~~**55** Scoring assertion strength *(53 W2 + W5)*~~ | Opus 5 | *(folded into 17 Phase A)* | W2 pinned (`0.25` vs `0.35`); W5 **7/7** constants caught. | ✅ **DONE 2026-08-22** |
| 1 | **49** Widen circular-dep trigger | Opus | `circular_dependency_trigger_task_49.md` ✅ | Migration 008 to catch cycles of length ≥3 (today only length-2 is caught; a 3-cycle permanently filters every task in it via U1). ⚠ A trigger is DROP/CREATE — **no table rebuild** (the board row over-broadened constraint #12); the prior-suite sweep still applies. | 🟡 **WAVE 1 — launched** |
| 2 | **52** Extraction-guide budget pass | Sonnet | `extraction_guide_budget_task_52.md` ✅ | Reword line 45's stale "ONLY field you may guess" + trim `tool_requirements`/`context_tags` to recover the energy line's ~60 tokens. *(Edit is headless; no-regression confirmation rides on 31's eval.)* | 🟡 **WAVE 1 — launched** |
| 3 | **57** `capture/retention.ts` coverage *(53 W10)* | Sonnet | `capture_retention_coverage_task_57.md` ✅ | No test file at all; rotation can delete the **newest** day against the module's own rule. | 🟡 **WAVE 1 — launched** |
| 4 | **46** "Every N weeks" recurrence | Sonnet | ⬜ *to write* | Additive `interval` on the `scheduled` recurrence (JSON, no migration) + a UI control + an anchor date + one `period.ts` fn. | queued |
| 5 | **56** Planner assertion strength *(53 W3/W4/W6/W7/W9)* | Opus/Sonnet | ⬜ *to write* | Five planner guards that name a spec rule but don't measure it (the "at most two" limit, the 25% buffer, the difficulty gradient, the pre-deep break, the tie-break). | queued |
| 6 | **58** Test-hygiene sweep *(53 W8/W11/W12)* | Sonnet | ⬜ *to write* | NUL-escape claim untested; `blockKindsAgree` is a `tsc`-only guard that reads as a jest one; the last-migration bump has no downstream fixture. | queued |
| 7 | **47 + 51** `docs/reference/` pass | Sonnet | ⬜ *to write (one brief, both)* | Regenerate the schema snapshot (2 migrations + 007 stale) **and** fold the spec §8.4 backup amendment + `session_ended_early` into the spec — one pass, per the board's "pair" note. | queued |
| 8 | **17 Phase B** — the six §5.4 loops | Opus | ⬜ *to write* | Shrinkage, regression protection, rollback; consumes task 41's thermal sampler; owns the internal 2/4 band per task 50. **The big one — keep it its own pass.** | queued |
| 9 | **45** Deviation audit | Opus | `deviation_audit_task_45.md` ✅ | Audit builder decisions that changed a human ruling without sign-off; relabel orientation §5. Audit-only. | queued |

**Ordering rationale.** 53, 54 and 17 Phase A are done. **Wave 1 (49, 52, 57) runs in PARALLEL** in
isolated git worktrees — verified mutually file-disjoint (migrations / llm-prompts / capture-tests),
and a worktree checkout does not contain the untracked stale `.claude/worktrees/` duplicate, so agents
there read the true jest number directly. **45 moved to the tail by Jason (2026-08-22).** Wave 2 is
46 / 56 / 58 / 47+51 (also mutually disjoint); **17 Phase B runs alone** — it overlaps 58 in
`src/scoring` and contends with 49 for migration 008. Briefs are written just-in-time before launch.

**Board is the source of truth for status;** this file is the running order. Update the Status column as
each lands, and strike a task when it's committed.
