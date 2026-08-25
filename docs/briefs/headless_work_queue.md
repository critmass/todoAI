# Headless work queue — staged 2026-08-22, current as of 2026-08-24

**What this is.** The ordered queue of **headless** tasks that are **not** blocked by device (`P`) work
and **not** gated by task 31 — the work that can proceed while the model-migration chain waits on the
corpus and while the device sessions are unscheduled. Originally staged at Jason's instruction with task
53 at the head. ✅ **Struck rows below are done.** **The head is now whatever the first un-struck row
says** — read the table, not this paragraph, and keep the numbering contiguous when a task lands.

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
| ~~0~~ | ~~**Housekeeping** *(unnumbered)* — worktree cleanup + flake hunt~~ | Opus 5 | `housekeeping_worktrees_and_flake.md` ✅ | All 4 worktrees removed after a file-by-file containment proof — **raw jest is now the true 1026/88** (was 4842/416). **The flake REPRODUCED and was diagnosed** (order-dependent cross-realm `instanceof`) → **task 59**. `gc` blocked on a dropped stash of Jason's → Open rulings. Report: `docs/eval/housekeeping_2026-08-22_report.md`. | ✅ **DONE 2026-08-22** |
| ~~8~~ | ~~**56** Planner assertion strength~~ | Opus 5 | `planner_assertion_strength_task_56.md` ✅ | Five mutations now proven detectors; `planner.ts` untouched, no behaviour bugs found. Caught an impossible remedy in task 53's own recommendation. | ✅ **DONE 2026-08-22** |
| ~~9~~ | ~~**58** Test-hygiene sweep~~ | Sonnet | `test_hygiene_sweep_task_58.md` ✅ | W8 asserted + proven red; W11/W12 carve-outs stated. No behaviour change. | ✅ **DONE 2026-08-22** |
| ~~7~~ | ~~**59** Fix the realm-fragile assertion~~ | Opus 5 | `realm_error_assertion_task_59.md` ✅ | Boundary fix in `wrapDatabase`; `consistency.test.ts` never edited. **4/4 green under the consistency-LAST ordering that was 6/6 FAIL.** | ✅ **DONE 2026-08-22** |
| ~~10~~ | ~~**46** Recurrence modes — **Phase 1 (engine)**~~ | Opus 5 | `recurrence_modes_task_46.md` ✅ | Four modes, no migration; the drift test proves fortnightly ≠ 1st&3rd. **1121/92.** Report: `docs/eval/task46_phase1_findings_report.md`. | ✅ **PHASE 1 DONE 2026-08-24** |
| ~~11~~ | ~~**46 Phase 2** — the recurrence editor~~ | Opus 5 | `recurrence_editor_task_46_phase2.md` ✅ | Dropdown + 6×7 grid + 31-cell grid; **all four modes reachable end-to-end**, round-trip pinned byte-for-byte. **1199/93.** | ✅ **DONE 2026-08-24** |
| 1 | **17 Phase B** — the six §5.4 loops | Opus | ⬜ *to write* | Shrinkage, regression protection, rollback; consumes task 41's thermal sampler; owns the internal 2/4 band per task 50. **The big one — keep it its own pass.** | queued |
| 2 | **47 + 51** `docs/reference/` pass | Sonnet | ⬜ *to write (one brief, both)* | Regenerate the schema snapshot (2 migrations + 007 stale) **and** fold the spec §8.4 backup amendment + `session_ended_early` into the spec — one pass, per the board's "pair" note. | queued |
| 3 | **45** Deviation audit | Opus | `deviation_audit_task_45.md` ✅ | Audit builder decisions that changed a human ruling without sign-off; relabel orientation §5. Audit-only. | queued |

**Ordering rationale.** Two parallel waves (49, 52, 57, 58, 56, 59), the unnumbered housekeeping pass,
17 Phase A, and task 46 end to end (engine → amendment → editor) are all done. **Three left, all
headless and none blocked.** **17 Phase B** is the largest remaining item and runs alone — it overlaps
`src/scoring`. **47 + 51** is one `docs/reference/` pass. **45 sits at the tail by Jason.** Briefs are
written just-in-time before launch.

**Board is the source of truth for status;** this file is the running order. Update the Status column as
each lands, and strike a task when it's committed.
