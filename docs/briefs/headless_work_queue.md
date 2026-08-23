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
| ~~1~~ | ~~**53** Test-suite integrity audit~~ | Opus 5 | `test_audit_task_53.md` ✅ | 33 mutations, 15 survivors, 12 confirmed weak. Report: `docs/eval/test_audit_task53_findings.md`. | ✅ **DONE 2026-08-22** |
| ~~2~~ | ~~**54** Ladder salvage-rejection guard *(53 W1)*~~ | Opus 5 | `ladder_salvage_guard_task_54.md` ✅ | Guard added + **proven** to fail against the mutation (`"restored"` vs `"salvaged"`; 400 vs 0 rows). No production change. Report: `docs/eval/task54_findings_report.md`. | ✅ **DONE 2026-08-22** |
| ~~3~~ | ~~**17** Numeric learning loops — **Phase A**~~ | Opus 5 | `numeric_learning_task_17_phaseA.md` ✅ | Writer built (the live one-sided gap closed); 18 tests red before the code existed. Report: `docs/eval/task17_phaseA_findings_report.md`. | ✅ **PHASE A DONE 2026-08-22** |
| ~~3b~~ | ~~**55** Scoring assertion strength *(53 W2 + W5)*~~ | Opus 5 | *(folded into 17 Phase A)* | W2 pinned (`0.25` vs `0.35`); W5 **7/7** constants caught. | ✅ **DONE 2026-08-22** |
| 1 | **49** Widen circular-dep trigger | Opus | ⬜ *to write* | Migration to catch cycles of length ≥3 (today only length-2 is caught; a 3-cycle permanently filters every task in it). Needs the CHECK/trigger rebuild + prior-suite sweep. | 🔴 **NEXT** |
| 2 | **45** Deviation audit | Opus | `deviation_audit_task_45.md` ✅ | Audit builder decisions that changed a human ruling without sign-off; relabel orientation §5. Audit-only. | queued |
| 3 | **46** "Every N weeks" recurrence | Sonnet | ⬜ *to write* | Additive `interval` on the `scheduled` recurrence (JSON, no migration) + a UI control + an anchor date + one `period.ts` fn. | queued |
| 4 | **52** Extraction-guide budget pass | Sonnet | `extraction_guide_budget_task_52.md` ✅ | Reword line 45's stale "ONLY field you may guess" + trim `tool_requirements`/`context_tags` to recover the energy line's ~60 tokens. *(Edit is headless; no-regression confirmation rides on 31's eval.)* | queued |
| 5 | **47 + 51** `docs/reference/` pass | Sonnet | ⬜ *to write (one brief, both)* | Regenerate the schema snapshot (2 migrations + 007 stale) **and** fold the spec §8.4 backup amendment + `session_ended_early` into the spec — one pass, per the board's "pair" note. | queued |
| 6 | **17 Phase B** — the six §5.4 loops | Opus | ⬜ *to write* | Shrinkage, regression protection, rollback; consumes task 41's thermal sampler; owns the internal 2/4 band per task 50. **The big one — keep it its own pass.** | queued |
| 7 | **56** Planner assertion strength *(53 W3/W4/W6/W7/W9)* | Opus/Sonnet | ⬜ *to write* | Five planner guards that name a spec rule but don't measure it (the "at most two" limit, the 25% buffer, the difficulty gradient, the pre-deep break, the tie-break). | queued |
| 8 | **57** `capture/retention.ts` coverage *(53 W10)* | Sonnet | ⬜ *to write* | No test file at all; rotation can delete the **newest** day against the module's own rule. | queued |
| 9 | **58** Test-hygiene sweep *(53 W8/W11/W12)* | Sonnet | ⬜ *to write* | NUL-escape claim untested; `blockKindsAgree` is a `tsc`-only guard that reads as a jest one; the last-migration bump has no downstream fixture. | queued |

**Ordering rationale.** 53 and 54 are done (the audit, then its data-loss finding). 17 Phase A closed
the live one-sided scoring gap and took 55 with it. Remaining order puts **49** next (a latent bug that
can permanently starve tasks), then the **45** audit, then the Sonnet cleanups, with **17 Phase B** — the
six learning loops, the largest item left — kept as its own pass. **Pull Phase B forward on request;**
it is sequenced after the quick wins only because it is big, not because anything blocks it. Briefs for
the ⬜ rows are written just-in-time, before each launch, from the board rows + cited docs.

**Board is the source of truth for status;** this file is the running order. Update the Status column as
each lands, and strike a task when it's committed.
