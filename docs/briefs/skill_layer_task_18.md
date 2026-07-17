# Fable Brief — Task 18: Local skill-injection learning layer (design)

**For:** a Fable session. This is a **design deliverable** — Opus implements it (task 19). Produce a design concrete enough to build from, not principles.
**Authority:** spec §5.5 (the layer), §3.5 (idle/thermal windows), §5.4 (the numeric half + conservatism it shares), and the build-allocation F1 rationale. **Read those first.**
**Status:** unblocked — its dependencies (4 strategy, 7 prompts, 12 coaching) are all done and device-confirmed.

This is **the one genuinely novel core in the app** — there is no textbook implementation of a local, confidence-gated, LLM-distilled skill library. The subtle, compounding decisions live here, which is why it's reserved for you. Get them wrong and the app slowly, invisibly learns the wrong lessons about the user.

---

## What it is (spec §5.5)

The **behavioral** half of learning (the *numeric* half is task 17). A fully on-device loop adapted from **MetaClaw's fast loop only** — **no LoRA, no cloud, no weight training.** Three parts: a **skill library**, **retrieval + injection** at coaching/planning time, and **idle-window distillation** of new skills from friction. Skills are **hidden from the user** and **confidence-gated**. Numeric weights tune *which* tasks get chosen; skills tune *how* the coach talks and *what* remedies it reaches for — and capture qualitative, situation-specific knowledge that doesn't reduce to a weight.

## Hard constraints (these shape every decision)

- **Fully local, on the loaded 4B** (Ternary Bonsai, ~5 tok/s CPU-only). No cloud, no LoRA, nothing leaves the device.
- **The 4B must both PRODUCE skills (distillation) and APPLY them (injection) reliably.** Design for a small, slow model: grammar-constrained output, bounded, simple. Distillation is heavy → **idle/cool windows only** (§3.5, reusing the summary-consolidation windows). Injection adds tokens to *every* coaching call → keep it lean; every injected token costs ~200ms.
- **Structured + grammar-constrained** (task 5 discipline): skill records are produced under a GBNF grammar + zod validator. ⚠ **This build's grammar quirks apply** — no underscores in GBNF rule names, bounded ints via digit-width alternation, and any new grammar must pass the task-6 startup validation guard. (See `docs/eval/Q1c_findings_report.md`.)
- **Hidden from the user** (spec commitment): never surfaced as "here's what I learned about you." No UI. The system just quietly works better.
- **Confidence-gated** (spec + §5.4 conservatism): low-confidence skills are held back from firing; a skill distilled from a bad day or two **cannot harden into a rule** before corroboration.

## Existing scaffolding — build ON these, don't redesign them (flag gaps only)

**Schema (v2.2, already migrated) —**
- `skills`: `id, instruction TEXT, scope ('coaching'|'planning'|'both'), schema_version, confidence REAL [0..1], is_active BOOL, times_fired, times_corroborated, times_contradicted, created_at, last_updated, last_fired_at`.
- `skill_conditions`: `id, skill_id, condition_key (e.g. 'context_tag'|'time_of_day'|'energy_level'|'task_type'|'trigger'), condition_op ('eq'|'neq'|'in'|'gte'|'lte'), condition_value TEXT`.
- `skill_evidence`: `id, skill_id, interaction_id, evidence_type ('origin'|'corroboration'|'contradiction'), created_at`.
- View `fireable_skills`: skills where `is_active = TRUE`, conditions concatenated.
- *(Note the tension to resolve: `skills.is_active` defaults TRUE, but confidence-gating wants new skills born inactive. Your design says when `is_active` flips true — likely on crossing the confidence threshold — and distillation sets new skills inactive/low-confidence on birth.)*

**Injection seam —** task 12 built `assembleCoachingPrompt({ base, injectedSkills = [] })`; `injectedSkills` is currently always empty and **you are its consumer.** Planning has an analogous assembly point (or specify one).

**Friction sources already logged —** `interactions` (skips, early-ends, ratings, `conversation_summary`), `coaching_queue` triggers (`task_skipped`, `session_recalibration`, `app_reorientation`, and the new buried-task trigger R4), `tasks.skip_reasons`.

**Numeric-learning discipline to mirror (§5.4) —** ≥N corroborations before trusting a specialized signal, small steps, regression-protection/rollback on degradation.

## The design you must produce (the hard cores — where your reasoning earns its keep)

1. **Skill representation & matching.** What a skill concretely *is* beyond the schema row. How `skill_conditions` are evaluated against the current situation (context, time-of-day, energy, task type, active trigger) at injection time **without a combinatorial blowup** — the matching model, AND/OR semantics, how the fireable set is scored and ranked. The schema gives storage; you give the semantics.
2. **Retrieval + injection policy.** Given the fireable, condition-matched, confidence-passing set: how many skills inject, in what order, formatted how into the prompt via the seam so a 4B actually *follows* them? Conflict resolution when two skills disagree. Staying within the 4B's attention/latency budget.
3. **Distillation (the "evolver").** The prompt(s) that turn accumulated friction into new/sharpened skill records — runnable by the 4B, emitting grammar-valid skills. What friction is fed and how it's summarized; how a candidate skill is proposed and de-duplicated against existing ones; guards against the 4B producing garbage or over-general ("always break everything down") skills. Design the distillation prompt **and** the skill-output schema/grammar.
4. **Confidence math (the crux).** The exact update rule — how confidence grows on corroboration, decays on contradiction. **What counts as corroboration vs contradiction** (i.e., when/how `skill_evidence` gets written: a skill fired, and the outcome was good/bad — tie this to observable signals like completion vs re-skip). The firing threshold. The decay that lets a skill that stops predicting fade out. The corroboration floor that stops a two-bad-days skill from hardening.
5. **Lifecycle + idle scheduling.** Birth (inactive, low-confidence) → corroboration → active → possible decay → retirement/pruning of stale skills (§8.5). When distillation runs (idle + thermally-cool windows, §3.5). How this interacts with the stale-learning-data handling on long absence.

## Deliverable

A design doc Opus can implement in task 19: the skill semantics + matching algorithm, the injection policy, the distillation prompt(s) + output grammar/schema, the confidence-update rules **as concrete formulas/pseudocode**, and the lifecycle/scheduling. Call out any schema gap (a column the three tables lack). Where the 4B's smallness forces a simplification, say so and design for it rather than assuming a bigger model.

## Out of scope

- Implementation/wiring (task 19, Opus).
- The numeric learning loops (task 17).
- Any cloud/LoRA slow-loop — explicitly excluded by spec §5.5.
- Redesigning the schema tables or the injection seam (build on them; flag gaps only).
- UI (skills are hidden).
- Re-opening the scoring rulings (that's task 10).
