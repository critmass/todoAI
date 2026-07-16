# Orientation — todoAI project state (for Opus, and any session picking this up cold)

**Purpose.** This is the front-of-context map for the build phase. Read it before touching code. It says what exists, what's proven, what's load-bearing, and what's decided — so you build *with* the grain of five prior sessions instead of reinventing conventions or re-opening settled questions. It is the durable companion to the per-task briefs in `docs/briefs/`.

**How to use it.** Read this, then the batch brief for your assigned tasks (`opus_batch_6_7_9_12.md`), then the specific spec/strategy sections each task cites. Do not start from the build-allocation matrix alone — it says *what and in what order*, not *how this codebase does things*.

---

## 1. Confirmed facts (the ground truth everything now stands on)

These are established, most of them the hard way, on real hardware. Treat them as settled.

- **Grammar-constrained decoding works, and it's essentially free.** Q1 is closed GREEN (`docs/eval/Q1c_findings_report.md`). The real `task_extraction.v1` grammar fired over all seed fixtures: **4/4 valid JSON, 4/4 validator-passing**, at **~3% throughput overhead** (7.98 vs 8.20 tok/s constrained vs unconstrained). The §3.3 structured-output strategy is validated end-to-end on-device. This was the single largest open risk under the whole build; it is now a foundation, not a hope.
- **Stock path, 4B only.** `llama.rn` 0.12.5 (prebuilt, no native build) + Ternary-Bonsai-4B (TQ1_0 community repack). This is the *only* tier that runs today; there is no working 1.7B or 8B build. The PrismML fork (native Q2_0 + Vulkan GPU, the path to real 8B) is **parked behind the `LLMProvider` interface** as a someday-if-ever project — see §5.
- **The provider and the startup guard are confirmed on-device** (`docs/eval/task6_phaseB_findings_report.md`). A grammar-constrained, chat-templated call returns validated output through the real `TernaryBonsaiProvider` + D10 ladder (first attempt, 4/4 fixtures), grammar overhead is **1.00x** (nil), and the guard **catches** a deliberately-broken grammar, disables the grammar path, and leaves the app alive. Two things that report retracts, so they aren't re-litigated: **GBNF `#` comments parse fine on this build** (grammar is passed as authored — do NOT add a comment strip; it would truncate a `#`-bearing slot value), and **the underscore break is *catchable***, so the guard's proof covers catchable parse failures — against a truly uncatchable death its defense is still only its pre-session *timing*.
- **The data layer runs on hardware, and `POWER()` does not.** Confirmed 2026-07-16 (`docs/eval/task12_phaseB_findings_report.md` §1), the first time `src/db/` had ever executed on the phone: op-sqlite opens, migrations apply (schema 2.2.0), `PRAGMA foreign_keys` is genuinely ON, and repositories round-trip. `SELECT POWER(2,2)` fails outright ("no such function"), so `listActiveByNeglect`'s TypeScript-side multiplier is **required** — don't "simplify" it back to the `active_tasks_with_neglect` view. Two live safety facts: **the 4B cannot detect distress** (it answered suicidal ideation with a productivity tip), so crisis detection is deterministic and app-side and must never be handed to the model; and a **`#`-comment strip must never be added** to the provider's grammar path (see §4's constraint #3 note).
- **Hardware reality.** CPU-only on Android (llama.rn's OpenCL path doesn't cover ternary formats; no Vulkan). ~5.2 tok/s steady state on the S23 FE (Snapdragon 8 Gen 1, 8 GB), throttling ~39% peak→steady but *plateauing*, not collapsing. Heat is the binding constraint, not RAM. Design for this envelope, not vendor benchmarks.
- **The device:** Samsung Galaxy S23 FE, model at `/sdcard/Android/data/com.todoai/files/`. Bare RN 0.86.0, New Architecture, Android-only. Windows dev host. See `README_build.md`.

## 2. Build status

| Task | What | State |
|---|---|---|
| 0 | Core dependency spike (model loads/runs) | ✅ done (4B on one device) |
| 1 | Dev env + toolchain | ✅ done; `README_build.md` |
| 2 | SQLite migrations + data-access layer | ✅ done; `src/db/` |
| 3 | TypeScript types (row/domain/scales) | ✅ done; `src/types/` |
| 4 | Structured-output strategy + eval design (Fable) | ✅ done; `docs/briefs/structured_output_strategy_task_4.md` |
| 5 | Schemas, GBNF grammars, validators, mappers | ✅ done; `src/llm/` |
| Q1 | Does grammar-constrained decoding work on-device? | ✅ **GREEN**; `docs/eval/Q1*_findings_report.md` |
| 6 | `llama.rn` integration / `TernaryBonsaiProvider` | ✅ **done** — confirmed on-device; `docs/eval/task6_phaseB_findings_report.md` |
| 7 | System-prompt engineering (task input + coaching) | ✅ **done** — tuned on-device; `docs/eval/task7_phaseB_findings_report.md` |
| 9 | Scoring implementation (§5.1–5.2) | ⚠ **status unconfirmed** — no task-9 findings report on file; verify it's built and that Fable review (10) is done |
| 12 | Coaching flows + resolution dispatch (§7.2) | ✅ **done** — confirmed on-device; `docs/eval/task12_phaseB_findings_report.md`. **2 human-review gates open** (crisis detector coverage, `CRISIS_REFERRAL_TEXT` localisation) |
| 10 | Fable review of scoring composition | after 9 |
| 8, 13–17, 19 | tiering / data-resilience / timer / learning / skill integration | later |
| 18 | Skill-injection layer (Fable) | later — leave its seam in 12 (see batch brief) |
| 20 | Eval harness | later (parallel track) |
| 21 | Crisis detector review + referral localization (human) | 🔴 **beta gate** — draft detector active & gate-first; §8, §9 |
| 22 | `which:"next"` weekday semantics decision | ⚠ decision, any target; §8, §9 |
| 23 | UI/UX design (interaction + visual system) | ⬜ **new** — not started; beta gate for polish, high-leverage to start early; §9 |
| 24 | Product UI implementation (real screens) | ⬜ **new** — not started; **functional pass is required for personal ship** (only dev screens exist today); §9 |

**Ship gating for everything above is in §8; the new tasks (21–24) are detailed in §9.**

## 3. Module map — what exists and its contract

**`src/types/`** — the shared vocabulary.
- `db.ts` — enums (string-literal unions) + raw `Row` types mirroring columns exactly.
- `domain.ts` — camelCase entities; **the `Recurrence` discriminated union is authoritative**; a true one-off has **no** recurrence (undefined), which is *not* `{type:'unscheduled'}`. `rowToDomain`/`domainToRow` mappers.
- `scales.ts` — `userToInternalImportance` / `internalToUserImportance` (1–10 ↔ 100–1000), `userToInternalEnergy` / `internalToUserEnergy` (low/med/high ↔ 1/3/5). **Always project through these; never write a user-facing value into `importance`/`energy_requirement`.** Internal energy 2 and 4 are app-assigned (behavioral discounting), never user-entered.

**`src/db/`** — persistence. Repositories return **domain** types, not rows.
- `connection.ts` — opens the DB, sets `PRAGMA foreign_keys = ON` per connection.
- `repositories/` — `tasks`, `recurrence`, `dependencies`, `interactions`, `sessions`, `coaching`, `skills`, `learning`. Typed CRUD + the reads each surface needs.
- **`tasks.listActiveByNeglect()`** returns `TaskWithNeglect[]` — the active pool with an **uncapped** `neglectMultiplier` (`weeksNeglected ** 2`) **computed in TypeScript** (op-sqlite's Android SQLite has no `POWER()`; the `active_tasks_with_neglect` view is bypassed for that reason). This is the neglect input task 9 consumes. **Never cap it** (spec §5.2 fail-safe).
- **`tasks.recordUnscheduledCompletion(id)`** vs `update(id,{status:'completed'})` — these are the two *different* completion primitives. `unscheduled` recurrence resets the neglect clock but stays active; a one-off closes. The repo exposes both as primitives; **deciding which applies (by checking the recurrence type) is service-layer work — yours, in tasks 9/12.**
- `errors.ts` — typed error style (`NotFoundError`, etc.). Match it.

**`src/llm/`** — structured output (task 5). Static artifacts + pure functions; **grammars confirmed working**. Barrel (`src/llm/index.ts`) exports:
- Validators: `validateTaskExtraction`, `validateTaskBreakdown`, `validateCoachingResolution`, `validateSummary` (each runs zod + cross-field rules, throwing `LlmOutputValidationError`).
- Mappers: `extractionToTaskWrite`, `breakdownToSubtaskWrites`/`subtaskImportance`, `resolveDue`.
- Grammar tooling: `buildGrammar` (+ `escapeGbnfLiteral`) for dynamic-slot templates, `boundedIntRule`/`boundedStringRule`/`literalAlternationRule`/etc. primitives, `SCHEMA_PATHS`.
- **Rule-name lint:** `src/llm/grammar/__tests__/ruleNaming.test.ts` enforces `/^[a-zA-Z][a-zA-Z0-9]*$/` on every grammar rule name (see constraint #2). Don't add a rule with an underscore; the test will catch you, but know why.

**`src/dev/`** — throwaway spike screens (Q1 harnesses, probes). Not production. You may crib the `llama.rn` load pattern from them; do not depend on them. (Note: the original `BonsaiSpikeScreen.tsx` no longer exists; `DateStrProbeScreen`/`RuleNameProbeScreen`/`Q1GrammarSpikeScreen` do.)

**`docs/`** — `briefs/` (per-task), `eval/` (Q1 findings + fixtures), `reference/` (spec v2.2, schema v2.2).

## 4. Non-negotiable constraints (violating any of these is a real bug)

1. **Chat template is mandatory.** Prompt via the `messages: [{role,content}]` API so `llama.rn` applies the model's embedded template. Raw strings to `completion()` produce repetition loops and garbage — this is not optional and no grammar rescues it.
2. **No underscores in GBNF rule names.** This build's llama.cpp lexer (`is_word_char`) excludes `_`; an underscore silently breaks the parse. Lint-enforced. It's a **build quirk, not GBNF semantics** — don't "fix" the workaround. (JSON keys may contain underscores freely; only *rule names* are affected.)
3. **Never first-parse a grammar in front of a user.** A malformed grammar can kill the process *uncatchably* (no JS error, no tombstone — observed in Q1), which D10's retry ladder cannot recover from. **Task 6 must compile every registered grammar — including dynamic ones via `buildGrammar` against representative slot values — at startup, and fall back to prompt-JSON + validation before any user session if any fail.** This converts an uncatchable crash into a caught startup condition. Non-negotiable.
4. **Constrained generation is greedy (temp 0, top_k 1).** Matches strategy D9 and keeps output reproducible. Bounded fields (task 5) are what stop greedy decoding from looping.
5. **Uncapped neglect.** `neglectMultiplier` grows without bound by design (spec §5.2) — it's the fail-safe that guarantees every task eventually surfaces. Never cap it.
6. **Two-level scales.** Importance stored 1–1000, energy 1–5; go through `scales.ts`; never persist a user-facing value.
7. **`null`/one-off ≠ `unscheduled`.** Opposite completion semantics; use the right repo primitive (see §3).
8. **Coaching resolution is a grammar-constrained union, NOT native tool-calling** (strategy D8, overriding spec §3.4's "tool call" language). The model emits a validated union object; *the app* dispatches it to repository actions. `break_down_task`/`add_missing_task` are stubs that trigger a staged follow-up call, and `no_change` is a first-class action.
9. **`PRAGMA foreign_keys = ON`** every connection (already handled in `connection.ts` — don't undo it).
10. **Model storage:** app-private external dir only (`/sdcard/Android/data/com.todoai/files/`).

## 5. Settled decisions (do not re-open without a new explicit call)

- **Model path:** stock `llama.rn` + 4B. The fork/Q2_0/Vulkan/8B is parked *behind the `LLMProvider` interface* — its whole value is that adopting it later stays quarantined to the native layer. Build the tier-selection *seam* (§3.6 `activeTier()`), but wire only the 4B; the "tiering ladder" has one real rung today. Do **not** build degradation logic for models that can't run.
- **Cloud:** local-only. No cloud escalation in scope; the interface allows a future opt-in `CloudProvider`, disclosed, but that's not this phase.
- **iOS:** deferred until public deployment with a profit model. Android-only.
- **Expo:** ruled out (native code required).
- **Learning:** fully local skill-injection (task 18, Fable), no LoRA, no cloud training. Task 12 leaves it a seam; it is not built now.

## 6. Read-these-first, in order

1. This doc.
2. `docs/briefs/opus_batch_6_7_9_12.md` (your work order).
3. `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md` — §3 (model/inference/interface), §5 (scoring/neglect), §7 (coaching), the sections your tasks cite.
4. `docs/briefs/structured_output_strategy_task_4.md` — for anything touching structured output/coaching resolution (D1 recap, D8 union, D10 validate→retry ladder).
5. The actual code contracts in §3 above — read `src/llm/index.ts`, `src/types/domain.ts`, `src/types/scales.ts`, and the repository you're consuming, before writing against them.
6. `docs/eval/Q1c_findings_report.md` — so the grammar constraints in §4 are grounded, not cargo-culted.

## 7. How this batch fits

Task **9 is independent** — pure logic over the data layer, no LLM — so it can start immediately and in parallel. Task **6 is the spine**: it unblocks **7** (prompts need a working provider to iterate against) and **12** (coaching needs the provider + prompts). **Fable reviews task 9's composition (task 10)** once it's buildable. Full sequencing and per-task detail are in the batch brief. *(6, 7, 12 are now done — see §2. The live frontier is the ship-gating in §8 and the new tasks in §9.)*

## 8. Ship targets and their gates

Three targets, each a higher bar than the last. An item **gates** a target if that target can't ship until the item is resolved. Deferring is fine *only if* the item is pinned to the gate that actually blocks it — the list below is that pinning.

**Personal** — audience: Jason only (the developer, who knows the app's limits).
- *Bar:* the core loop is usable by someone who understands what it does and doesn't do.
- *Needs:* a working end-to-end loop (add task → work session → task execution with the timer → coaching) behind **functional product UI (task 24, minimal)** — which **does not exist yet**; today only `src/dev/` screens exist. The confirmed backend (6/7/12 + data layer, and 9 pending confirmation) is in place.
- *Does NOT need:* crisis review, designed/polished UI, thermal management, tiering, 8B, or a device-envelope definition. (The draft crisis gate is already active, so even personal runs protected.)

**Beta** — audience: a small external test group (people who are not Jason).
- *Bar:* safe and coherent for a stranger.
- *Gates that activate here:*
  - **Crisis detector review + `CRISIS_REFERRAL_TEXT` localization (task 21) — HARD gate.** The moment a non-Jason user can install it, "the developer knows the limits" stops protecting anyone. Human-reviewed, not a code task.
  - **Designed UI/UX (task 23) + polished screens (task 24).** Strangers need real interaction/visual design, not functional dev screens.
  - **Device-envelope definition.** Testers won't all have an S23 FE; the one-rung 4B path needs a stated minimum spec (RAM / chipset / OS) before hand-off. (The prep item open since the original spike.)
  - **Verification residue cleared** (§9): `add_dependency`/`add_missing_task` dispatch exercised on-device; the D1 recap→constrain flow measured.

**General** — audience: the public.
- *Bar:* robust across devices, polished, scalable.
- *Gates beyond beta:*
  - **Real tiering + 8B**, if pursued — the fork / Q2_0 / Vulkan decision (spec §11).
  - **Real thermal management** (below) — required once tiering or heat-sensitive background work is live.
  - Full data-lifecycle hardening (export / deletion / corruption recovery), richer analytics, and whatever else the privacy model gates.

**Two deferrals recorded, each pinned to its real trigger:**
- **Crisis review → beta gate.** Safe to defer for personal *only* because the sole user is the developer and a deterministic draft gate is already active and gate-first. Isolated: it lives behind the `checkCrisis` → `runCoachingResolution` short-circuit and changes no interface, so appending it breaks nothing. Do not let it cross into beta unresolved.
- **Thermal sampler → stays a stub** until **whichever lands first**: the 8B/4B/1.7B tiering (task 8, itself gated on the quants existing) *or* the heat-sensitive idle-window background loops (tasks 17/18). It has **zero live consumers today** (one model rung, no background loops). Interim throttle signal: assume ~3 s cold-start and treat the **8.3→5.8 tok/s cold-to-warm drift** as the proxy. Left uncoupled, this would silently ship a heat-blind background loop later — hence the pin.

## 9. New tasks (21–24) + verification residue

**Task 21 — Crisis detector review + referral localization** *(beta gate; human-owned)*
Finalize the `DRAFT_CRISIS_DETECTOR` (committed, gate-first, over-triggers by design — a false positive shows care, a false negative hands a person in crisis a task). Two human judgments, not code: **(a) coverage** — phrase-matching will miss indirect/coded expressions, which are the common form; decide whether it's sufficient for beta or needs a richer approach; **(b) `CRISIS_REFERRAL_TEXT`** — localize it and decide referral content (it names no hotline by design; fabricating an emergency number is itself harmful). Blocks beta. Evidence: task 7 §9, task 12 §9.

**Task 22 — `which:"next"` weekday semantics** *(decision; any target; small)*
Lives in shared `resolveDue`/DueSpec (task 5's contract), so it affects **every** date the app resolves — extraction and deferral alike. From a Thursday, the 4B emitted `which:"next"` for "next Monday" → 11 days out, when most people mean 4. Decide: define `which:"next"` as "the coming one" in `resolveDue`, **or** teach both guides to prefer `which:"this"` for a bare "next <weekday>". Then apply + add a fixture. Evidence: task 12 §5.

**Task 23 — UI/UX design** *(beta gate for polish; high-leverage to start early)*
The product's interaction + visual design — which the task list never had: it assumed "implement screens *from a design*" with no task producing the design. ADHD-specific, not generic: minimal decision load, timer-dominant execution screen, prominent escape valve, novelty without chaos, low-friction capture. *Input:* spec §6 (the functional flows already exist). *Output:* an interaction spec + visual design system (color/type/spacing tokens, component set) that task 24 consumes. The design *thinking* is the high-value part (use the frontend-design skill; Opus or a human designer); producing components from a settled design is Sonnet. Can start now in parallel — cheap early, expensive to retrofit.

**Task 24 — Product UI implementation** *(functional pass gates PERSONAL; designed pass gates beta)*
There is **no product UI yet** — only `src/dev/` screens. The real surface (dashboard, add-task chat, work-session setup, **task-execution screen with the dominant timer**, coaching chat, metrics, settings) must be built for the app to be usable at all. A **minimal functional** pass is what personal ship actually requires; the **designed** pass (consuming task 23) is a beta gate. This is where task 13 (timestamp-based timer) and the confirmed 6/7/9/12 backend finally surface to a user. Sonnet builds screens once the design (23), or at least the flow, is settled.

**Verification residue** *(believed-done — confirm before leaning on it):*
- `add_dependency` / `add_missing_task` resolution dispatch — **unexercised on-device** (task 12 §4). Fold into the next device session.
- The **D1 recap→constrain flow** — still **unmeasured**; task 7 §7 suggests it may close the last extraction gap (the `quota`-drops-days case the recap understood but the constrained pass re-derived wrong). Wire recap→constrain and re-measure.
