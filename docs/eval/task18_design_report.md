# Task 18 Design Report — the skill-injection learning layer, designed

**Question:** `docs/briefs/skill_layer_task_18.md` asked for the design deliverable for spec
§5.5 — skill semantics + matching, injection policy, distillation prompt(s) + output grammar,
confidence-update rules as concrete formulas, and lifecycle/scheduling — concrete enough for
Opus to implement in task 19, building on (not redesigning) the v2.2 schema tables and the
task-12 injection seam.

**Verdict: DELIVERED.** The full design is at
[`docs/design/skill_layer_task18_design.md`](../design/skill_layer_task18_design.md) — all five
cores, with pseudocode, exact formulas with worked reference points, two complete prompt texts,
and two complete GBNF grammars obeying the Q1c rule-name constraint and the task-6
startup-guard/lint discipline. This report is the session paper trail: the decisions and their
why, the schema gaps flagged, and the open items handed to tasks 11/19. Design only — no code
was written or changed this session.

**Date:** 2026-07-17. **Branch:** `opus/batch-a-headless` (docs only).

**Read first:** the design doc itself; then
[`docs/briefs/skill_layer_task_18.md`](../briefs/skill_layer_task_18.md) (the ask) and
[`Q1c_findings_report.md`](Q1c_findings_report.md) (the grammar constraints the output
grammars are written under).

---

## 1. The load-bearing decisions (and why)

**Matching: flat AND, closed vocabulary, unknown-fails.** The combinatorial risk was diagnosed
as *expressiveness* creep, not evaluation cost (the library is capped at 35 active / 100 total,
so evaluation is trivial). Condition rows AND together; no OR between rows; disjunction only via
the `in` op or a second skill. A condition whose snapshot field is `undefined` fails — skills
fire only on affirmatively-true preconditions, which prevents context-free firing before the
first energy check-in. Conflicts resolve by deterministic subsumption (specific beats general);
the remaining conflict class is prevented at distillation rather than detected at injection.

**Confidence: a recomputable function, not an accumulator.** The crux formula is
`conf = Ceff / (Ceff + 2·Xeff + 3)` over evidence rows time-decayed at a 45-day half-life.
Decay, rollback, and §8.5 long-absence staleness all fall out of the one formula — there is no
separate rollback mechanism because the 2× contradiction weighting *is* it. The bad-day guard is
structural: dedup and passive corroboration are the same mechanism (a re-derived candidate
becomes a corroboration row instead of a duplicate), so activation requires the pattern to be
independently re-derived from later, non-overlapping evidence windows spanning ≥2 distinct days.
A freshly-activated skill dies on its first contradiction (0.40 → 0.29).

**The oscillation trap, closed.** A *working* skill removes the friction that birthed it, which
would starve re-derivation and cause work → decay → relapse cycling. So fired-skill outcomes
(coached task completes vs. re-skips within 14 days; session finishes vs. collapses) form a
second evidence channel that sustains skills that actually work. Corollary: friction re-derived
over an *active* skill's conditions counts as contradiction (the remedy fired and didn't help) —
but only if `learning_data.skillsFired` shows it actually fired in those incidents.

**Distillation: code-first, one judgment per call.** Friction grouping, digest rendering, dedup,
and outcome judgment are all deterministic code. The 4B makes exactly one grammar-constrained
judgment per call — one candidate or `null`, with abstaining prompted as the common, correct
answer. Over-generality is killed in the grammar itself: the first condition is grammatically
forced to be situational, so an "always break everything down" skill is impossible to emit;
`context_tag` values are slot-enumerated from tags actually present in the evidence group, so
contexts can't be hallucinated.

**Injection: latency-tiered.** At ~200 ms/injected token, the cap keys to urgency — 1 skill on
`immediate` coaching, 2 otherwise (second needs score ≥ 0.55), 3 at planning — rendered through
the existing `assembleCoachingPrompt` seam unchanged, best-first, at the end of the system
prompt.

**Timezone trap, closed.** The situation snapshot (local time-of-day bucket, energy, contexts,
task type) is persisted into `interactions.learning_data` at interaction write, so the distiller
and attribution pass never re-derive local time from the UTC `interactions.timestamp`.

## 2. Schema gaps flagged (design doc §7)

1. `skills.is_active DEFAULT TRUE` contradicts born-inactive — layer sets it explicitly;
   recommend a default-flip migration as defense-in-depth.
2. New tiny `learning_state (key, value)` table needed for watermarks + tunables — the one
   genuine schema addition.
3. Optional nullable `skill_evidence.source ('distiller'|'outcome')` for audit; the math
   doesn't need it.
4. `fireable_skills` view is index-only (lossy GROUP_CONCAT, no scope filter) — conditions must
   come from `listConditions()`. Guidance, not a schema change.
5. `coaching_queue`'s CHECK constraint lacks task 10's R4 buried-task trigger — when that
   migration lands, extend the grammar's `trigVal`, the snapshot type, and the friction-incident
   definition.
6. `learning_data` JSON shape (`snapshot` + `skillsFired`) needs an internal `"v":1` version
   field, mirroring the summary-schema-version discipline.

## 3. Open items handed off

- **Task 11 dependency:** `assemblePlanningPrompt` is specified, but whether planning-scope
  skills have a live consumer depends on whether session planning makes any LLM call. If task 11
  lands fully deterministic, planning skills fire only via recalibration/escape-valve coaching
  until one exists.
- **Task 19 Phase B:** both new grammars (`skill_distill.v1`, `skill_refine.v1`) need one
  on-device pass under the fresh-context discipline before being trusted — same bar every other
  grammar met. Headless implementation + `MockLLMProvider` tests cover everything else.
- **Deliberate v1 cuts** (design doc §8): no LLM in matching/dedup/outcome judgment, no semantic
  conflict detection, no instruction rewriting post-activation, attribution smearing accepted
  under the ≤2 cap. Each is a conscious 4B-smallness trade, not an oversight.

## 4. One-line call

**DELIVERED** — task 19 can implement from
[`docs/design/skill_layer_task18_design.md`](../design/skill_layer_task18_design.md) without
further design input; the only sequencing watch-items are the R4 migration (task 10) and the
planning-call question (task 11).
