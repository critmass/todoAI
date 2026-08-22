# Task 53 — test-suite integrity audit: are tests confirming bad code?

**Brief written by the coordinator, 2026-08-22, by Jason's instruction.** The suite is the safety net
the whole project leans on — 973 tests / 86 suites. Most of them accreted **before** the test-first
policy (`CLAUDE.md`, 2026-08-22) existed, so nothing has ever checked whether a given test actually
protects against the failure it appears to guard. This task is that check. It is the complement to the
test-first policy: that governs *new* tests; this audits the *existing* ones.

## Role
You are an audit subagent. **Find-and-report**, like task 45 (the deviation audit) — you do **not** fix
tests wholesale here; confirmed weaknesses become their own follow-up tasks or rulings. You may run
`npx jest` and read code freely, and you may *temporarily* mutate code locally to demonstrate a test's
weakness (revert it — leave the tree clean). Do not commit.

## What "confirming bad code" means
A test that would **still pass if the code it covers were wrong.** Such a test reports coverage it
doesn't provide — worse than no test, because it manufactures false confidence. The gold-standard
counter-example is task 41's force-kill acceptance test: it was proven to fail when a buffering writer
was substituted, so it is a *demonstrated* regression detector, not an assumed one.

## The failure taxonomy — what to look for
1. **Vacuous / tautological.** Asserts a mock's own return value; asserts a value against itself
   computed the same way; asserts `expect(true)`; asserts a constant equals the literal it was set to.
2. **Passes against a stub.** Would the test pass if the implementation were replaced by a no-op or a
   hardcoded return? This is the **mutation heuristic** and it is the core method (see below).
3. **Subset / `toContain` / `must_include` that can't fail on over-production.** The task 20 lesson:
   `context_tags_must_include` is a subset check, so a model dumping the *entire* tag vocabulary passes
   every time. Any assertion that checks "contains X" without also bounding what else is present is
   blind to over-production.
4. **Snapshot / exact-match that ossifies an unvalidated output.** A gold nobody derived from a spec or
   ruling — just captured from a run and frozen. The 16-fixture answer-key class (task 50 §6a): the
   expected values were model-generated scaffolding, read later as ground truth.
5. **Over-mocked seams whose double diverges from the real thing.** The `better-sqlite3` double stands
   in for op-sqlite; task 41's force-kill exercises the **Node** writer, not the **Kotlin** one (its
   header says so). A test green against a double that behaves unlike production confirms the double,
   not the code. Flag where the divergence could hide a real bug (device-only behavior → hand to 32).
6. **Pins known-buggy or placeholder behavior as if correct** — with **no flag** saying so.

## The legitimate exception — do not flag these as failures
A test that **deliberately** pins a known bug **with an explicit flag** is correct and valuable:
`consistency.test.ts` asserts the length-2-only circular-dependency trigger bug **on purpose** (task
49, the fix is its own task). These are the *opposite* of the problem — they document a known gap so it
can't regress silently. The audit finds the **unflagged** confirmers. List the flagged-known-bug tests
separately so the distinction is visible, but do not "fix" them.

## Method — the mutation heuristic, applied by blast radius
Do **not** read all 973 tests blindly. Prioritize the load-bearing suites, and for a sample of each ask
the mutation question — *if I broke the code this covers in a plausible way, would this test catch it?*
Where cheap, **demonstrate** it: mutate the code, run the suite, see whether it goes red (then revert).
Priority order (highest blast radius first):
- `src/scoring/` (`score.ts` composition, `factors.ts` — the most-reviewed, once-unreadable file);
- `src/planning/` (the selection boundary — the two pre-filters + ranker, reject-set retention);
- `src/execution/` (the timer/episode state machine, crash recovery);
- `src/db/migrations/` + `runtime` (the forward-sweep discipline — a migration test that silently
  became an assertion about a later migration);
- `src/services/backup/` (the ladder + the task 14 wiring gate) and `src/capture/`;
- `src/llm/` (the extraction validators, the grammar rule-name lint, the drift guards).

## Boundary with other tasks
- **Eval-oracle quality is NOT yours.** The 16-fixture bank, the `must_include` KPI, the corpus golds
  — their validity is task 20 / 31 / 40's domain. If you encounter an eval-fixture problem, **flag it
  and hand it over**; don't re-litigate it here. (You *may* cite them as the motivating pattern.)
- Overlaps nothing in task 45 (that audits human-decision deviations, a different axis).

## Deliverable
`docs/eval/test_audit_task53_findings.md` — a triage table, each test/suite sorted into:
- **Confirmed weak / misleading** — with the specific mechanism ("would pass if X were wrong / against
  a no-op / on over-production") and, where you demonstrated it, the mutation that didn't turn it red.
- **Pins a known bug, correctly flagged** — listed, left alone.
- **Fine** — spot-checked, real detector.
Plus a recommended remediation per weak test (strengthen the assertion / add a mutation check / delete
the tautology / replace the frozen snapshot with a derived gold). Rank by blast radius.

🔴 **Audit only — remediations become their own tasks or rulings.** And when a fix *is* applied later,
it is **test-first** (`CLAUDE.md`): strengthen the test so it **fails against the bad code first**,
prove it fails for the right reason, *then* it is a real guard. A "fix" that leaves the test still
passing against the mutation has fixed nothing.

## Model
**Opus**, and the **audit methodology / mutation-heuristic design is Opus-5-worthy** — this is the
negative-control class the handoff (§8) already flagged for task 20: a merely-good pass reads a vacuous
test and calls it fine, which is the exact failure being hunted. Opus 5 for the method + the
highest-blast-radius suites; ordinary Opus/Sonnet for breadth.

## Read first
1. This brief; `CLAUDE.md` (the test-first bar this measures against).
2. `docs/coordinator_handoff_todoAI.md` §4 (working habits) and the task 45 brief (`deviation_audit_task_45.md`) as the audit-format precedent.
3. The motivating cases: `docs/eval/task41_findings_report.md` (the demonstrated-detector standard), the task 20 row / standing note on `must_include`, `docs/design/energy_definition_task50.md` §6a (the model-generated answer key).
