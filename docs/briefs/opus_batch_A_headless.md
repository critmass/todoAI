# Opus Batch — Phase A: Headless build pass (NO phone required)

**For:** an Opus session in todoAI. **Read `docs/briefs/orientation_for_opus.md` first** — confirmed facts, module contracts, and the ten non-negotiable constraints live there and are not repeated here.
**Phase B companion:** `docs/briefs/opus_batch_B_device.md` — the on-device confirmation/tuning that finishes tasks 6, 7, and 12. **Do Phase A first;** B cannot confirm what A hasn't built.

**What this phase is.** Everything in tasks 6, 7, 9, and 12 that can be built and unit-tested with **no device in the loop**. Your test harness is `MockLLMProvider` — it stands in for the real model everywhere here.

**What "done" means in Phase A — read carefully:**
- **Task 9 is genuinely done** after this phase (it never needs a device).
- **Tasks 6, 7, 12 are NOT done** after this phase. Their code is written and unit-tested against the mock, but anything whose truth depends on the real 4B — a grammar actually parsing on-device, a prompt actually producing correct output, the startup guard actually catching an uncatchable crash — is **"believed done, pending Phase B."** This stack has surprised us twice at the parser level; do not mark these tasks complete on headless evidence. Leave them explicitly flagged for B.

Build order within A: **9 in parallel from the start** (independent), then **6** (the spine the mock-tests hang off), then **7** and **12** (which consume 6's shape).

---

## Task 9 — Scoring (§5.1–5.2) — fully completable here

Pure logic over the data layer, no LLM. See the batch detail:

- **Weighted sum** over the five seeded factors (importance 25 / urgency 20 / energy match 20 / context fit 15 / historical success 20), then **× the uncapped neglect multiplier** (post-sum, not a summed weight).
- **Consume `tasks.listActiveByNeglect()`** for neglect — it already returns the uncapped `neglectMultiplier` computed in TS (orientation §3). **Never cap it** (constraint #5).
- **Derived urgency** from `next_due_at` at scoring time (not stored). **Full internal importance (1–1000)** in scoring, never the 1–10 projection. **Energy match / context fit** against the session check-in; **weighted shuffle within context groups** for novelty.
- **Completion-primitive policy lives here:** dispositioning a task chooses `recordUnscheduledCompletion` vs one-off close by **checking recurrence type first** (orientation §3).

**Out of scope:** session planning (task 11), numeric learning (task 17).
**Done when:** defensible ranking from a task pool; neglect provably lifts long-ignored tasks uncapped; unit tests cover the factor math and the multiplier. **Then hand to Fable for the composition review (task 10)** — the uncapped-neglect × importance-banding × derived-urgency × weights interaction is exactly the many-parts math that hides pathological orderings.

---

## Task 6 — `TernaryBonsaiProvider`: build everything except on-device proof

Implement the spec §3.6 `LLMProvider` interface over `llama.rn` 0.12.5. Write all of it; test against the mock and against parse-simulation. Keep app logic strictly above the interface (it's what keeps the parked fork a contained future swap — orientation §5).

**Build (all headless):**
- **Model load/lifecycle + streaming** code (crib the load pattern from `src/dev/*`); the **`messages`/chat-template call path** (constraint #1).
- **Grammar-constrained call path:** accept a grammar; wire `buildGrammar` (from `src/llm`) for the dynamic surfaces (extraction `context_tags`, resolution task-id/tag slots, breakdown parent id); configure **greedy temp 0 / top_k 1** for constrained calls (constraint #4).
- **The D10 ladder:** generate → call task 5's validators (`validateTaskExtraction`, etc.) → on failure retry once → on second failure the "give me a moment" fallback. Orchestrate the existing validators/mappers; don't reimplement.
- **The startup grammar-validation guard — build the full logic here (constraint #3):** at init, iterate every registered grammar, compile each (including each dynamic template via `buildGrammar` against representative slot values), and on any failure disable the grammar path and fall back to prompt-JSON + validation before any session. **You can build and unit-test the registry/iteration/fallback-decision logic against the mock** (simulate a grammar that "fails to compile"). What you *cannot* verify headless is the real uncatchable-process-death behavior it defends against — that's B's job. Build it fully; flag it for on-device proof.
- **Thermal/health plumbing** (`currentThermalHeadroom()`, load-time/tok/s/battery-delta tracking) and the **`activeTier()` → `'4B'`** seam (scaffold the selection point; wire only 4B — no degradation logic for models that don't run).
- **Keep `MockLLMProvider` viable** — it's the test double for this whole phase and for task 9-adjacent code that shouldn't need a model.

**Unit-test (mock/simulation):** the ladder's retry/fallback decisions, the guard's compile-attempt-and-fallback logic (fed a simulated failing grammar), the tier seam, buildGrammar wiring.
**NOT verifiable here (→ Phase B):** a real grammar-constrained call returning on-device; the guard catching a real process-killer; the Stage 2/3 numbers through the real provider.

---

## Task 7 — System prompts: draft + scaffold (tuning is Phase B)

Opus writes strong first drafts blind; prompt *quality on a 4B* is empirical and can't be judged headless. So Phase A is the drafts and the assembly machinery, not the tuning.

**Build (headless):**
- **Draft the system prompts + per-field natural-language guides** (strategy D3.2 — grammars constrain shape, prose makes fields *correct*) for: extraction with the **recap-then-constrain flow (D1)**; the **recurrence ask-don't-guess** logic (D6 — must *ask* on ambiguity, never silently pick `null` vs `unscheduled`); **scope-to-observable-work** (§7.1); breakdown; summary; and coaching (tone + safety + crisis text, §7.3).
- **Build the prompt-assembly scaffolding** — including the `assembleCoachingPrompt({ base, injectedSkills = [] })` seam (coordinate with task 12, which owns that seam's coaching-flow side). Structural unit tests: assembly injects the right field descriptions, produces the expected message shape, leaves the skill slot empty-but-present.

**NOT verifiable here (→ Phase B):** whether these prompts actually produce correct output on the 4B. Ship them as **drafts pending on-device tuning**, with the two known targets noted for B (the `due:null` miss, the junk tag elements).

---

## Task 12 — Coaching flows + dispatch: build the wiring, seam, and safety structure

Depends on 6 and 7's shape (both available in this phase). Build the mechanism; the conversation *quality* is Phase B.

**Build (headless):**
- **The three triggers** (§7.2) mapped onto `coaching_queue`'s `urgency` tiers: single skip → `next_start`; 3-in-session → `immediate` recalibration; 5+ days unopened → `next_open` re-orientation.
- **Resolution dispatch:** validated `coaching_resolution` union (via `validateCoachingResolution`) → repository actions (`modify`/`eliminate`/`defer`/`break_down` staged/`no_change`), **respecting the completion primitives** (check recurrence type — orientation §3). This is grammar-union dispatch, **not native tool-calling** (constraint #8).
- **The skill-injection seam (build now):** the documented `assembleCoachingPrompt({ base, injectedSkills = [] })` hook, `injectedSkills` empty, a comment naming **task 18** as its consumer. Cheap now, expensive to retrofit.
- **Crisis-path structure** (§7.3): the reviewed care-and-refer path, not model improvisation.

**Unit-test (mock):** feed canned valid/invalid union objects through the dispatcher; assert each maps to the right repository call, that invalid triggers the retry/fallback, and that completion-primitive selection is correct per recurrence type. Assert each trigger enqueues the right `urgency`.
**NOT verifiable here (→ Phase B):** real coaching conversation quality; the union coming back valid from the actual 4B; live dispatch on-device.

---

## Reminders for this phase

- `MockLLMProvider` is your harness — build it out enough to simulate valid output, invalid output, and grammar-compile failure, since the ladder and guard logic are tested against exactly those.
- Everything above `LLMProvider` stays backend-agnostic.
- **Do not mark tasks 6, 7, or 12 done.** They exit Phase A as "built, unit-tested, believed correct, pending device confirmation." Only task 9 (and Fable's review of it) closes here.
- Small commits, one task at a time. Stop and ask near the `null`/`unscheduled` boundary or the uncapped-neglect fail-safe.
- Hand off to `opus_batch_B_device.md` when the headless build is in place and the mock tests are green.
