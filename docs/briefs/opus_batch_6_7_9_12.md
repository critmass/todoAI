# Opus Batch Brief — Tasks 6, 7, 9, 12

**For:** an Opus session in todoAI. **Read `docs/briefs/orientation_for_opus.md` first** — it holds the confirmed facts, the module contracts, and the non-negotiable constraints this brief assumes and does not repeat.
**Spec of record:** `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md`. **Strategy of record (structured output/coaching):** `docs/briefs/structured_output_strategy_task_4.md`.

This is a coherent block: the on-device inference spine (6), the prompts that drive it (7), the scoring core (9), and the coaching system that ties them together (12). Below: the order to build in, then each task.

---

## Sequencing

1. **Start task 9 immediately, in parallel.** It's pure logic over the data layer — no LLM, no device, no dependency on 6/7. Getting it done early also unblocks the Fable review (task 10).
2. **Task 6 is the spine.** Build it to the point of a working, grammar-constrained, validated call before 7 and 12 lean on it. The **startup grammar-validation guard (constraint #3) is part of task 6, not an afterthought.**
3. **Task 7 after 6** — prompts need a real provider to iterate against; this is an empirical you-plus-Jason loop on the device (§7 below).
4. **Task 12 after 6 + 7** — and build its **skill-injection seam** (§12 below) even though the skill layer itself is later Fable work.
5. **Check-ins:** pause after task 6's first end-to-end constrained+validated call works (confirm the guard and the ladder behave), and hand task 9 to Fable for the composition review (task 10) once it's buildable.

Do **not** take the whole block in one gulp. Build 9 and 6 first; 7 and 12 follow from 6.

---

## Task 6 — `llama.rn` integration / `TernaryBonsaiProvider`

Implement the spec §3.6 `LLMProvider` interface as `TernaryBonsaiProvider` over `llama.rn` 0.12.5. This is the one seam every LLM-touching feature plugs into — the interface is also what keeps the parked fork (orientation §5) a contained future swap, so keep app logic strictly above it.

**Build:**
- **Model load + lifecycle** from the `com.todoai` path (crib the load pattern from `src/dev/*`, don't depend on it). Manage context, stream tokens.
- **Chat template via the `messages` API** (constraint #1) — this is the load path, not an option.
- **Grammar-constrained generation:** accept a grammar; for the dynamic surfaces (extraction's `context_tags`, resolution's task-id/tag slots, breakdown's parent id) build the concrete grammar via `buildGrammar` from `src/llm`. **Greedy (temp 0, top_k 1)** for constrained calls (constraint #4).
- **The generate → validate → retry → fallback ladder (strategy D10):** call task 5's validators (`validateTaskExtraction`, etc.); on failure retry once; on second failure fall back to the "give me a moment" path. The validators and mappers already exist in `src/llm` — orchestrate them, don't reimplement.
- **The startup grammar-validation guard (constraint #3 — non-negotiable):** at init, compile *every* registered grammar, including each dynamic template via `buildGrammar` against representative slot values. If any fail to parse, disable the grammar path and fall back to prompt-JSON + validation **before any user session**. A grammar must never first-parse in front of a user — process death is uncatchable and defeats the D10 ladder.
- **Thermal + health (§3.5):** monitor thermal state, reduce context / defer background work when hot (`currentThermalHeadroom()`); track load time, tok/s, battery delta.
- **Tier seam only (orientation §5):** implement `activeTier()` returning `'4B'`; scaffold the selection point but wire only the 4B. No degradation logic for models that don't exist yet.
- Keep `MockLLMProvider` viable (the interface must stay mockable for tests and for task 9/others that don't need a real model).

**Out of scope:** native tool-calling (resolution is a union grammar — constraint #8); the fork/Q2_0/GPU; the full tiering ladder; backup/restore (task 14).

**Done when:** a grammar-constrained, chat-templated call returns validated structured output on the S23 FE; the startup guard is proven to catch a deliberately-broken grammar and fall back; thermal/health metrics are recorded. **This is the natural point to re-run task 5's Stage 2/3 through the real provider and confirm the numbers hold.**

---

## Task 7 — System-prompt engineering (task input + coaching)

Design the system prompts and natural-language field guides for each surface. Grammars constrain *shape*; prompts are what make the model fill fields *correctly* (strategy D3.2 — the schema isn't auto-injected). This is an **empirical loop**: draft → Jason runs on-device → observe → adjust. Budget for iteration; it doesn't close on the first draft.

**Build prompts for:**
- **Task extraction** with the **recap-then-constrain flow (strategy D1):** elicit a brief unconstrained recap of what the model understood, *then* the constrained object — this is what dodges the "cornered small model emits valid-but-wrong" failure. Describe every field in words.
- **Recurrence: ask, don't guess (strategy D6).** The prompt must make the model *ask* when recurrence is ambiguous rather than silently pick — especially the `null`-one-off vs `unscheduled` distinction, which have opposite completion semantics.
- **Scope to in-app-observable work (§7.1):** "schedule the coffee chat," not "attend the meeting" — the app can only time what happens in-app.
- **Breakdown, summary,** and the **coaching** system prompts (tone below).
- **Coaching tone + safety (§7.3):** supportive not clinical; reframe "failure" as data; never scold/rank/guilt; the reviewed crisis-sensitivity path (distress → care + pointer to human support, not the small model improvising).

**Use the real Q1c signal as your first tuning targets.** Stage 2 surfaced two concrete model-quality artifacts on the 4B: (a) it chose `due:null` despite a date in the prompt (needs explicit date-interpretation grounding), and (b) it emitted junk `context_tags` array elements (needs tag/tool guidance). These are exactly what the recap turn and field guides exist to fix — start there.

**Out of scope:** the grammars/validators themselves (task 5, done); the skill instructions injected at runtime (task 18).

**Done when:** across the seed fixtures on-device, extraction hits a solid valid-and-*correct* rate (not just valid — that's already 4/4), recurrence ambiguity produces a question rather than a wrong guess, and coaching prompts produce supportive, on-scope, disposition-reaching conversations.

---

## Task 9 — Scoring implementation (§5.1–5.2)  *(independent — start now)*

Pure logic over the data layer. No LLM. Fully unblocked.

**Build:**
- **Weighted sum** over the five factors (importance 25% / urgency 20% / energy match 20% / context fit 15% / historical success 20% — the seeded `algorithm_weights`), then **× the uncapped neglect multiplier.** Neglect is a post-sum multiplier, **not** a summed weight.
- **Consume `tasks.listActiveByNeglect()`** for the neglect input — it already gives the uncapped `neglectMultiplier` computed in TS (orientation §3). **Never cap it** (constraint #5).
- **Derived urgency:** compute effective urgency from `next_due_at` at scoring time (constraint: not stored). `urgency_level` is an optional base sensitivity only.
- **Scoring uses the full internal importance (1–1000)** — including subtask sub-band values — never the user 1–10 projection.
- **Energy match / context fit** against the session's energy check-in and context; **weighted shuffle within context groups** for novelty (spec §2.3, §5.3).
- Respect the completion primitives (orientation §3): dispositioning a task means choosing `recordUnscheduledCompletion` vs one-off close by **checking its recurrence type first** — that policy lives here/service-layer, not in the repo.

**Out of scope:** session *planning* (§5.3 — deep-focus allocation, energy ramp — that's task 11); the numeric learning loops (§5.4 — task 17). Just the scoring function and its inputs.

**Then:** hand it to **Fable for the composition review (task 10)** — the interaction of uncapped neglect × importance banding (floor 100) × derived urgency × learned weights is exactly the many-parts math that produces pathological orderings no one notices until the list feels wrong. That review is cheap insurance on a core.

**Done when:** given a task pool, it produces a defensible ranking; neglect provably lifts long-ignored tasks without a cap; unit tests cover the factor math and the neglect multiplier; Fable's review pass is scheduled.

---

## Task 12 — Coaching flows + resolution dispatch (§7.2)

Depends on 6 + 7. Wire the three coaching triggers to conversations that reach a concrete disposition.

**Build:**
- **The three triggers** (spec §7.2), mapped onto the existing `coaching_queue` (task 2) via its `urgency` tier:
  - any single skip → queued **next_start**;
  - 3 skips within a session → **immediate** in-session recalibration ("what are you actually up for right now");
  - app unopened 5+ days → **next_open** re-orientation.
- **Resolution as a grammar-constrained union (constraint #8, strategy D8):** the coach emits a validated `coaching_resolution` union (via task 5's grammar/`validateCoachingResolution`); **the app dispatches** the chosen action to repository calls — `modify_task`/`eliminate_task`/`defer_task`/`break_down_task` (staged follow-up)/`no_change`. Not native tool-calling.
- **Disposition respects the completion primitives** (orientation §3): eliminating/deferring/completing an `unscheduled` vs one-off task uses the correct primitive — check recurrence type.
- **Coaching safety (§7.3):** the reviewed crisis-sensitivity path, not small-model improvisation.

**The skill-injection seam (build this now, even though task 18 is later Fable work):** the coaching (and planning) prompt assembly must have an **explicit, documented injection point** where task 18 will insert retrieved skills — a clear function/section like `assembleCoachingPrompt({ base, injectedSkills = [] })`, with `injectedSkills` empty for now and a comment naming task 18 as its consumer. This is a cheap hook now and an expensive retrofit later; leaving it is the whole reason this instruction exists.

**Out of scope:** the skill library/retrieval/distillation itself (task 18); session planning (task 11); the numeric learning loops (task 17).

**Done when:** each trigger opens the right conversation at the right moment; resolutions dispatch correctly through the repositories via the validated union; the skill-injection seam exists and is documented; the crisis path is in place.

---

## Standing reminders (from the orientation doc — do not drop)

- Everything above the `LLMProvider` interface must stay backend-agnostic (keeps the parked fork a contained future swap).
- The startup grammar guard (task 6) is non-negotiable — it's what makes this build's grammar quirks a caught startup condition instead of a crash.
- When a spec/strategy point is ambiguous — especially anywhere near the `null`/`unscheduled` boundary or the uncapped-neglect fail-safe — stop and ask rather than guessing. Work in small, reviewable commits, one task at a time.
