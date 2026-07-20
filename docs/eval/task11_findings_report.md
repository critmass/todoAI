# Task 11 Findings — Session planning (spec §5.3)

**Status: complete.** The deterministic session planner landed on `opus/batch-a-headless` as
`src/planning/` (sizing, agenda vocabulary, planner core, async service edge); full suite +
`tsc --noEmit` + `eslint .` clean (531 tests, no regressions). Headless throughout — **no device
pass required** (see decision (a)). This closes the remaining headless stretch of the critical
path (11 → 13 → 24); everything after this needs Jason and the phone.

**Commits:**
- planner core — selection boundary, `plannedMinutes`, agenda arrangement, `replanRemaining`
- test suite + the fork-6 positional-entropy regression test

**Module shape:** `src/planning/plannedMinutes.ts` (design §3.2 sizing + placement floor),
`agenda.ts` (item types + tools-checklist helpers), `planner.ts` (selection boundary +
arrangement core, pure), `service.ts` (repository wiring + the LLM seam), `index.ts` (barrel).

---

## 1. The two must-be-right items, verified

**The selection boundary calls both hard pre-filters before either ranker, and the R7 hold is
now wired.** `runSelectionBoundary` (planner.ts) is the one place a pool enters planning:
`filterBySessionCapability` → `filterDependencyBlocked` → only then `scoreTasks` /
`rankWithContextNovelty`. Both reject sets are retained onto the returned `SessionPlan`
(`capabilityRejects` / `dependencyRejects`) for §8.1's "no available tasks" coaching and R4's
buried-task scan. `filterDependencyBlocked`'s **third argument is fed by
`pendingBreakdownCompleteTaskIds(coaching)`** in `service.ts` — the exact wiring task 25's
report §2 named as its consciously-open residual risk. Tested end-to-end: a parent with a
pending `breakdown_complete` row never reaches any plan and carries
`pendingBreakdownComplete: true` in its reject. U5 stays convention rather than type-enforced
(per the review's own call); the planner's header comment states the rankers require a
pre-filtered pool, and `runSelectionBoundary` is the enforcement in practice — nothing else in
`src/planning/` touches a ranker.

**The agenda item type carries block kind from day one.** `AgendaTaskItem.blockKind:
'countdown' | 'openBlock'` — countdown for live estimates (timer counts down `plannedMinutes`),
openBlock for floor-typed and blown-estimate tasks (timer counts up; `plannedMinutes` is the
block's gross boundary that raises the end-of-block prompt). This is 33's flagged
would-be-breaking-change to task 24, closed.

## 2. The (a)–(e) decisions

**(a) No LLM call in planning — ruled by Jason, with a seam kept.** Asked rather than
defaulted, per the brief. Jason chose **deterministic v1 plus a typed injection point**: the
planner itself is pure and reproducible, and `service.ts` exposes `PlanAdjustment` — an
optional async hook receiving the finished deterministic plan and returning the plan to use.
v1 passes nothing. Consequences stated plainly: **task 18's planning-scope skills have exactly
one legal consumer, this hook — task 19 must target `PlanAdjustment`, not a phantom
`assemblePlanningPrompt` seam inside the planner.** No LLM call means no device requirement;
task 11 carries no `P`.

**(b) Fork 3 honored — energy asymmetry lives in arrangement, not scoring.**
`energyMatchFactor` untouched. The "high energy can afford easy tasks" instinct is realized in
the §5.3.3 energy ramp: context groups are ordered by **ascending mean energy requirement**
toward the deep-focus block, so low-energy tasks (present in the ranked pool by design) fill
the ramp's front. Within a group, the difficulty gradient sorts by energy requirement plus a
±1.5 uniform jitter (`DIFFICULTY_JITTER`, on the internal 1–5 scale) — easier front, harder
back, with real run-to-run variation.

**(c) The shuffle is proven, and the proof is a permanent regression test.**
`src/scoring/__tests__/noveltyEntropy.test.ts`: 400 seeded re-rolls of
`rankWithContextNovelty` over a realistic 12-task/4-group pool. **Measured baseline: slot-1 ≈
1.92 bits, slot-2 ≈ 1.97, slot-3 ≈ 2.00** (max possible log₂ 12 ≈ 3.58); assertions floor at
1.0 bit so they catch collapse, not drift. The alarm condition (slot-1 entropy ≈ 0 with no
outlier) does not occur. Control case: adding a 30-week fail-safe climber gives it slot 1 in
~84% of rolls (slot-1 entropy ≈ 0.89 bits) — asserted as *correct* behavior, the §5.2
fail-safe dominating by design.

**(d) Very short sessions are first-class.** A 5-minute session with a fitting task plans it;
one where nothing fits returns `outcome: 'nothing_fits'` with a `splitCandidate` — the
highest-scoring eligible task, to be offered for **splitting via breakdown, never shortening**
(a floor task's floor is a minimum, not a suggestion). Tested both ways.

**(e) Break overruns repopulate.** `replanRemaining` is the one primitive with three callers
(escape valve, break overrun, extend — task 28 §4.2's third caller landed here). It
**regenerates** the tail for whatever time remains; nothing is shifted or shrunk in place, and
tasks that fall out were never promised (the plan is hidden). Zero remaining minutes → empty
planned agenda, caller goes to summary.

## 3. The task-33 §4 scope, item by item

- **`plannedMinutes`** — every fill/fit computation routes through it; nothing in the planner
  reads `estimated_duration` raw. All four §3.2 rows implemented and tested, including the
  blown-estimate → open-ended planning conversion (no stored field mutates).
- **Step 0 single-resume claim** — at most one `in_progress` task, most recent
  `last_worked_at`, first refusal on the deep-focus block; must be placeable and must have
  passed both hard filters (tested: a dependency-blocked parked task cannot claim). Quick and
  short-moderate sessions (no deep block) claim nothing; other in-progress tasks flow through
  the untouched novelty pipeline.
- **Block kind** — §1 above.
- **`replanRemaining` third caller + break-first** — a preceding stretch ≥
  `LONG_STRETCH_BREAK_FIRST_MINUTES` (50) opens the regenerated agenda with a break; the
  break's minutes are budgeted in the fill.
- **Placement floor** — floor-typed (and blown-estimate) tasks are only placeable in a block ≥
  their floor. The floor compares against **gross block minutes, not buffered work minutes**
  (decision recorded below).
- **Session-end mutability** — the planner never assumes a fixed end: `SessionPlan` carries
  the minutes it was generated for, and `replanRemaining` takes whatever remains; the movable
  end-time itself is task 13's timestamp store.

## 4. Decisions the brief left to me (recorded, with reasoning)

1. **Deep-focus block geometry.** Block = `2/3` of the session (rounded), reserved at the end,
   for sessions ≥ 45 minutes; plannable work inside it = block × 0.75 (the §5.3.1 buffer).
   2/3 was chosen so a **90-minute session yields a 60-minute block** — the smallest session
   hosting an "at least an hour" floor task. Consequence worth knowing: a 60-minute session's
   40-minute block cannot host a 60-floor task (correct — it cannot deliver the floor), and a
   45-minute moderate session only gets a deep block if a ≤30-minute floor task exists ("major"
   estimate tasks need ≥25 planned minutes but the 30-minute block offers only 22 of work). A
   45-minute moderate is effectively "short Moderate" unless open-ended work anchors it.
2. **The placement floor compares gross block minutes.** The 25% buffer absorbs *estimate
   overrun*; an open-ended task has no estimate to overrun — its block boundary is the plan. A
   60-minute block genuinely offers 60 minutes of open-ended work, so `block ≥ floor`, not
   `work ≥ floor`. (Otherwise a 60-floor task would need a 120-minute session, which reads as
   the app arguing with arithmetic.)
3. **Open-ended tasks live only in the deep-focus block.** An open block runs to its boundary
   by design; placed mid-ramp it would swallow the arrangement around it. Deep-focus is the
   session's designed home for open-ended work (end-of-session, break-free). An open block owns
   its whole block — it is always the first and only deep item; once a countdown item is
   placed, only countdown items follow. Consequence: escape-valve (easier) replans, which have
   no deep block, never serve open-ended tasks — consistent with "shorter estimates."
4. **Deep-focus picks use strict `scoreTasks` order; novelty lives in the front section.** The
   block is the session's centerpiece (1–2 *major* tasks, ≥ 25 planned minutes or open-ended);
   best-first determinism is the right behavior there, and the shuffle's job — novelty across
   the session's texture — is fully served by the front section's `rankWithContextNovelty`.
5. **Selection vs. arrangement are separate passes.** The novelty ranking decides *which*
   tasks make the cut when time is short (greedy fill in novelty order, with break minutes
   budgeted); the arrangement then re-orders the chosen set (context grouping → energy ramp →
   difficulty gradient). The ranker's group-by-max-score order governs selection priority; the
   ramp governs the agenda. Both spec behaviors are kept without fighting each other.
6. **Breaks.** `BREAK_MINUTES = 5` (named tunable; spec fixes placement, not length): at
   context-group switches and once before the deep-focus block, never inside it, none in quick
   sessions. Break time is budgeted during the fill, so an agenda never overruns its session
   because of its own breaks.
7. **Escape-valve semantics (§5.3.5).** Easier = effective energy one step down (scoring +
   gradient see the lowered check-in), only items ≤ `EASIER_MAX_ITEM_MINUTES` (25), no deep
   block, no resume claim, contexts unchanged ("same-or-easier" = never require a context the
   session didn't already have). The *caller* passes `excludeTaskIds` for the task being
   escaped from.
8. **Replans make no resume claim.** First refusal on the deep block is a session-START
   affordance (design §3.3 "per session"); mid-session, the freshest `last_worked_at` is
   usually the task the user just parked or escaped — auto-re-serving it would be hostile.
   It can still surface through the ordinary pipeline.
9. **`splitCandidate` = highest-scoring eligible task** — the task the user would most
   plausibly have worked; splitting routes through the existing breakdown flow (R7 then
   applies to the parent normally).
10. **The 25% buffer applies only where the spec puts it** (deep-focus sizing). Front-section
    items plan their raw estimate/remainder; adding a second session-wide buffer would
    double-buffer against §3.2's explicit "this design adds no second buffer."

## 5. Consciously left open

- **`precededByRecalibration` is not consumed here.** Planning does not touch coaching drain
  ordering (the drainer is task 12's surface); the flag remains the durable hook and the note
  stands — read it, never re-derive precedence from `created_at`.
- **U5 stays convention.** No type-level enforcement of the filter→rank seam (per the review's
  own low-severity call). The enforcement in practice is that `runSelectionBoundary` is the
  planner's only pool entry; a *future* caller ranking an unfiltered pool is still possible.
  If a second planning-adjacent consumer ever appears, revisit a branded-pool type.
- **`PlanAdjustment` contract is stated, not enforced.** The hook must not resurrect filtered
  tasks; nothing validates a hostile adjuster. Acceptable while its only intended consumer is
  task 19's skill layer; task 19 should add a validation wrapper if it wires an LLM here.
- **Break minutes are a guess (5).** Placement is spec'd, length is not; tune with usage.
- **The energy ramp orders groups by mean energy requirement** — a reasoned proxy (means are
  stable for small groups), not a ruled one. If real agendas feel mis-ramped, median or max
  are one-line swaps.
- **`sessions` persistence and the §6.2 UI flow are task 24's.** The planner returns the plan;
  writing the session row, the tools-checklist screen, and walking the agenda are the owning
  tasks' work. `planRequiredTools` / `firstWorkableWithTools` are provided as the §6.2
  primitives.
- **Not mine, still open (inherited):** the §4.3 extend-guardrail ruling (Jason; gates task
  24's surface only) and the task-32 device pass on 33's grammar change.
