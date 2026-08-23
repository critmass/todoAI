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
| ~~4~~ | ~~**49** Widen circular-dep trigger~~ | Opus 5 | `circular_dependency_trigger_task_49.md` ✅ | Migration 008 / 2.9.0. Verified on **four** SQLite builds incl. op-sqlite's own amalgamation. Prior-suite sweep: 12 suites red, all updated. | ✅ **DONE 2026-08-22** |
| ~~5~~ | ~~**52** Extraction-guide budget pass~~ | Sonnet | `extraction_guide_budget_task_52.md` ✅ | Enumeration fixed; trim ≈−11 tokens not ~60 (disclosed — the protected example is the real cost). | ✅ **DONE 2026-08-22** |
| ~~6~~ | ~~**57** `capture/retention.ts` coverage~~ | Sonnet | `capture_retention_coverage_task_57.md` ✅ | 10 tests; both mutations proven red. Avoided the `sizeOnDisk: () => 0` fake trap. | ✅ **DONE 2026-08-22** |
| 1 | **46** "Every N weeks" recurrence | Sonnet | ⬜ *to write* | Additive `interval` on the `scheduled` recurrence (JSON, no migration) + a UI control + an anchor date + one `period.ts` fn. | queued |
| 2 | **56** Planner assertion strength *(53 W3/W4/W6/W7/W9)* | Opus/Sonnet | ⬜ *to write* | Five planner guards that name a spec rule but don't measure it (the "at most two" limit, the 25% buffer, the difficulty gradient, the pre-deep break, the tie-break). | queued |
| 3 | **58** Test-hygiene sweep *(53 W8/W11/W12)* | Sonnet | ⬜ *to write* | NUL-escape claim untested; `blockKindsAgree` is a `tsc`-only guard that reads as a jest one; the last-migration bump has no downstream fixture. | queued |
| 4 | **47 + 51** `docs/reference/` pass | Sonnet | ⬜ *to write (one brief, both)* | Regenerate the schema snapshot (2 migrations + 007 stale) **and** fold the spec §8.4 backup amendment + `session_ended_early` into the spec — one pass, per the board's "pair" note. | queued |
| 5 | **17 Phase B** — the six §5.4 loops | Opus | ⬜ *to write* | Shrinkage, regression protection, rollback; consumes task 41's thermal sampler; owns the internal 2/4 band per task 50. **The big one — keep it its own pass.** | queued |
| 6 | **45** Deviation audit | Opus | `deviation_audit_task_45.md` ✅ | Audit builder decisions that changed a human ruling without sign-off; relabel orientation §5. Audit-only. | queued |

**Ordering rationale.** **Wave 1 (49, 52, 57) is DONE** — run in parallel in isolated worktrees, merged
one at a time with the suite re-run between. Parallelism worked: the three were genuinely file-disjoint
and the patch applied clean. **Wave 2 is 46 / 56 / 58 / 47+51** (also mutually disjoint). **17 Phase B**
runs alone — it overlaps 58 in `src/scoring`. **45 sits at the tail by Jason (2026-08-22).** Briefs are
written just-in-time before launch.

**Board is the source of truth for status;** this file is the running order. Update the Status column as
each lands, and strike a task when it's committed.
