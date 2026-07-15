# Orientation — todoAI project state (for Opus, and any session picking this up cold)

**Purpose.** This is the front-of-context map for the build phase. Read it before touching code. It says what exists, what's proven, what's load-bearing, and what's decided — so you build *with* the grain of five prior sessions instead of reinventing conventions or re-opening settled questions. It is the durable companion to the per-task briefs in `docs/briefs/`.

**How to use it.** Read this, then the batch brief for your assigned tasks (`opus_batch_6_7_9_12.md`), then the specific spec/strategy sections each task cites. Do not start from the build-allocation matrix alone — it says *what and in what order*, not *how this codebase does things*.

---

## 1. Confirmed facts (the ground truth everything now stands on)

These are established, most of them the hard way, on real hardware. Treat them as settled.

- **Grammar-constrained decoding works, and it's essentially free.** Q1 is closed GREEN (`docs/eval/Q1c_findings_report.md`). The real `task_extraction.v1` grammar fired over all seed fixtures: **4/4 valid JSON, 4/4 validator-passing**, at **~3% throughput overhead** (7.98 vs 8.20 tok/s constrained vs unconstrained). The §3.3 structured-output strategy is validated end-to-end on-device. This was the single largest open risk under the whole build; it is now a foundation, not a hope.
- **Stock path, 4B only.** `llama.rn` 0.12.5 (prebuilt, no native build) + Ternary-Bonsai-4B (TQ1_0 community repack). This is the *only* tier that runs today; there is no working 1.7B or 8B build. The PrismML fork (native Q2_0 + Vulkan GPU, the path to real 8B) is **parked behind the `LLMProvider` interface** as a someday-if-ever project — see §5.
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
| **6** | **`llama.rn` integration / `TernaryBonsaiProvider`** | **← frontier (this batch)** |
| **7** | **System-prompt engineering (task input + coaching)** | **this batch** |
| **9** | **Scoring implementation (§5.1–5.2)** | **this batch (independent — start now)** |
| **12** | **Coaching flows + resolution dispatch (§7.2)** | **this batch** |
| 10 | Fable review of scoring composition | after 9 |
| 8, 13–17, 19 | tiering / data-resilience / timer / learning / skill integration | later |
| 18 | Skill-injection layer (Fable) | later — leave its seam in 12 (see batch brief) |
| 20 | Eval harness | later (parallel track) |

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

Task **9 is independent** — pure logic over the data layer, no LLM — so it can start immediately and in parallel. Task **6 is the spine**: it unblocks **7** (prompts need a working provider to iterate against) and **12** (coaching needs the provider + prompts). **Fable reviews task 9's composition (task 10)** once it's buildable. Full sequencing and per-task detail are in the batch brief.
