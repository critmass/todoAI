# Task 27 — Spec fold-in (v2.2 → v2.3)

**Owner:** Sonnet (Haiku acceptable for the mechanical passes; prefer Sonnet — several items require reading two sources and reconciling them). **Headless. Documentation only — do not touch code.**

**Runs in parallel with tasks 25 and 33.** No file overlap: they work in `src/`, you work in `docs/reference/`. If you find yourself wanting to change code, stop — that's out of scope and belongs to another task.

## Why this exists

**The spec currently describes a system that no longer exists.** §5.1 still lists five weighted factors including context-fit; §5.2 still shows `(days/7)²`; §7.2 still shows three coaching triggers when there are now five; §8.7 is still an unresolved open item that has since been designed. Eight rulings (R1–R8) and two design deliveries have landed in reports and briefs but never in the spec — so anyone reading the spec fresh is being actively misled.

The goal is a **v2.3 spec that a new session could read as the single source of truth** without also having to reconstruct eight rulings from scattered reports.

---

## Source documents — the only places rulings live

Read all of these before editing. **Where two disagree, the later one wins, and note the conflict in your report.**

1. `docs/briefs/scoring_review_task_10.md` — R1–R5.
2. `docs/briefs/postreview_scoring_task_25.md` — R6, R7, R8 (stated in full).
3. `docs/eval/task10_fable_review_report.md` — U1/U2/U6 and the reasoning behind the rulings.
4. `docs/eval/task10_R1R2R3_implementation_report.md` — what R1–R3 actually became in code.
5. `docs/design/multisession_task28_design.md` + `docs/eval/task28_design_report.md` — the §8.7 resolution.
6. `docs/eval/task18_design_report.md` — the skill-layer design, for §5.5 and §4.5.
7. `docs/eval/task26_findings_report.md` — the schema changes that actually shipped.
8. `docs/briefs/orientation_for_opus.md` §4 — the constraints, which the spec must not contradict.

**Rule: do not restate any formula from memory or from this brief's summary of it.** Every formula below is given so you know *what to look for*; take the **exact** form from the source document or, better, from the code. A plausible-but-wrong formula in the spec is worse than no formula, because it will be trusted.

---

## The change list

### §4.1 Tasks
- Parent-after-breakdown lifecycle (**R7**): the parent is **kept**, gains `depends_on` edges to each subtask, and is confirmed by the user via a coaching conversation. It is never auto-completed.
- New fields from task 28's design: `work_state` (orthogonal to `status` — the task stays `status='active'` throughout), `duration_type` (`estimate | floor`), `accumulated_minutes`, `last_worked_at`. Take exact names and semantics from the design doc.
- `estimated_duration` remains `NOT NULL`; a **floor**-typed task stores the floor value there. State plainly that for a floor task the timer counts **up** and the boundary comes from the session block — so **an overrun is definitionally not an estimation error**.
- Importance banding and the two-level scales are **unchanged** — don't rewrite them.

### §4.2 Recurrence
Types are unchanged. Add how they compose with what's new: `unscheduled` and `count` are **not** subject to R8's accrual gate; `count` folds each increment's multi-sitting total separately; the completion primitives are untouched (constraint #7).

### §4.5 Schema companion
The companion is now at **2.3.0** via migration 002 (`learning_state`, `skills.is_active` default FALSE, `skill_evidence.source`, two new `coaching_queue` trigger types). Note that **migration 003 is pending from task 33** and will add 28's columns. If `docs/reference/*.sql` is a hand-maintained snapshot, update it; **if it's generated, don't hand-edit it — say so in your report instead.** Check before assuming.

### §5.1 Scoring
- Weights become **31 / 23 / 23 / 23** across importance, urgency, energy match, historical success. **The context-fit row is removed from the weighted sum** — R3 moved context and tools to a hard pre-filter.
- **R6**: historical success is smoothed rather than branching at the first observation — `(rate·n + 0.5·k)/(n + k)`, `k = 2`. Note it's the degenerate form of §5.4's shrinkage.
- Neglect remains a post-sum multiplier, never a summed weight.

### §5.2 Neglect
- **R1**: the square is gone. The curve is a swappable seam (`neglectCurve`), seeded linear. **Read the code for the exact seeded form.**
- **R8**: accrual doesn't start until a half-gap after the anchor, where the gap is `period / (1 + quota)` and quota defaults to 1 — so annual → 6 months, weekly → 3.5 days, 3×/week → 1.75 days. Anchor is `COALESCE(last_completed_at, created_at)`. **Not** applied to `unscheduled`, `count`, or one-offs (**one-offs accrue from creation** — that was ruled explicitly).
- **Task 28**: working a task **re-anchors** its clock (`last_worked_at` joins the anchor).
- **Say explicitly, in the spec, that these are start conditions and not caps** — growth after the start remains unbounded, nothing saturates. Constraint #5 is intact and two future readers will need to be told why.

### §5.3 Session planning
- The selection boundary now runs **two hard pre-filters** before either ranker (capability, then dependency-blocked), and **both retain their rejects**.
- One in-progress task may claim the deep-focus block (28's resume slot); everything else flows through the novelty pipeline unchanged.
- Extend regenerates the agenda tail rather than shifting it; break-first after a long stretch.

### §5.4 Numeric learning
Model-guess replacement waits for a **completed fold** — partial times are censored data and must not update the estimate. R6's fixed 0.5 prior is later replaced by a learned prior, same formula.

### §6.2 Task screen
**Extend** is no longer "proposed" — it's designed. +25-minute quanta (a named tunable), session end moves with it, tail regenerated. Note that the **guardrail policy (design §4.3) is an open ruling** and mark it as such rather than picking one.

### §7.2 Coaching — the table becomes FIVE rows
Existing three, plus:
- **`buried_task`** (R4) — buried out-of-context/tool tasks.
- **`breakdown_complete`** (R7) — fires **immediate** on the last subtask's completion, for the user's check-off.

Record the **precedence**: a 3-skip `session_recalibration` beats a `breakdown_complete` if both would fire.

### §8.1 / §8.2 Edge cases
- Dependency-blocked tasks reach "no available tasks" coaching **through the retained rejects**, not a separate scan.
- Add 28's four outcomes and keep them distinct: **paused** (in-episode), **parked** (episode ended, intent to resume), **skipped** (declined without work), **abandoned** (explicit disposition only). State plainly: **the app never abandons a task by inference**, and a park is not a skip — it writes no `skip_count` and cannot feed the 3-skip trigger.

### §8.7
No longer an open design item. Replace it with a short summary plus a pointer to `docs/design/multisession_task28_design.md`, and list **what genuinely remains open** (the guardrail ruling; floor-typed subtasks in the breakdown grammar; floor tuning policy) rather than implying everything is settled.

### §10 Design principles
Principle 2 currently says "escape valves everywhere (and, pending §8.7, a way to *keep going*)." That's resolved — update it.

---

## Constraints

- **Documentation only.** No code, no test changes.
- **Don't contradict orientation §4.** If the spec and the constraint list disagree, orientation wins and you flag it.
- **Don't renumber or restructure** sections that didn't change. This is a fold-in, not a rewrite; a reader should be able to diff v2.2 against v2.3 and see only real changes.
- **Preserve the revision-note convention** at the top: add a v2.3 note summarizing the changes, keep the prior ones for continuity.
- **Where a ruling has a *reason*, keep the reason.** The uncapped-neglect rationale and the `null` ≠ `unscheduled` warning exist because both are easy to "fix" into a bug.

## Definition of done

- `docs/reference/ADHD_Task_Management_App_Specification_v2_3.md` written; v2.2 retained.
- Every item in the change list addressed, or explicitly listed as skipped with a reason.
- Findings report at `docs/eval/task27_findings_report.md` covering: what changed, any **conflicts between sources** you found and how you resolved them, anything in the spec you noticed was stale that this brief didn't mention, and whether the reference `.sql` is hand-maintained or generated.
