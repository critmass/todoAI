# ADHD Task Management App — Specification v2.3

> **Revision note.** Builds on v2.2. This version folds eight scoring/coaching rulings (R1–R8) and two design deliveries into the spec — nothing here is a new decision; all of it was already ruled or designed in prior sessions and is being recorded so the spec stops describing a retired composition. Headline changes: (1) **§5.1 scoring weights** move to **31/23/23/23** (importance/urgency/energy/historical) with **context/tools removed as a summed factor** and reinstated as a **hard pre-filter** at the selection boundary (R3); historical success is now a **smoothed** rate, not a raw ratio with a cliff at the first observation (R6). (2) **§5.2's neglect curve drops the square** for a swappable **linear seed** (R1), and gains an explicit **accrual-start gate** for recurring tasks (R8) — both are *start conditions*, never caps; the uncapped fail-safe (constraint #5) is unchanged and the spec now says so at each site, on purpose. (3) **§5.3/§8.1's selection boundary runs two hard pre-filters**, not one — session-capability and dependency-blocked — both retaining their rejects. (4) **§4.1/§4.2 gain a parent-task lifecycle after breakdown** (R7): the parent is kept, dependency-linked to its subtasks, and confirmed by the user via an immediate coaching conversation rather than auto-completed. (5) **§7.2's coaching table grows from three rows to five** — `buried_task` (R4) and `breakdown_complete` (R7) — with the precedence rule recorded. (6) **§8.7 is resolved**, not open: multi-session work, parking, floor-typed open-ended duration, and hyperfocus Extend are designed (task 28); what's still genuinely open is named explicitly rather than implied to be settled. (7) **§4.5's schema companion moves to 2.3.0** via migration 002; migration 003 (task 28's columns) is pending, not yet landed. Nothing here touches §3 (model/inference), which is untouched by this pass.

---

## Changes in v2.3 (from v2.2)

- **§2.3 / §5.1 Scoring weights (R3, R6)** — context/tools is no longer a summed factor; it is a hard pre-filter before scoring (freed 15% redistributed to 31/23/23/23 across importance/urgency/energy/historical). Historical success is a smoothed rate (R6), not a raw ratio that cliffs at the first observation.
- **§5.2 Neglect curve (R1, R8)** — the squared curve is retired for a linear seed behind a swappable seam, still uncapped; recurring tasks get an explicit accrual-start gate (a start condition, not a cap); task 28 adds a re-anchor on genuine work.
- **§5.3 / §8.1 Selection boundary (R2/U1, R3)** — two hard pre-filters, not one, both retaining rejects: session-capability, then dependency-blocked. One in-progress task may claim first refusal on the deep-focus block (task 28).
- **§4.1 / §4.2 Parent-task lifecycle (R7)** — the parent is kept after breakdown, dependency-linked to its subtasks, held out of the pool, and confirmed via coaching rather than auto-completed. New task-28 fields: `work_state`, `duration_type`, `accumulated_minutes`, `last_worked_at`.
- **§7.2 Coaching triggers — three rows become five** — `buried_task` (R4) and `breakdown_complete` (R7), plus the precedence rule when both would fire.
- **§8.2 Episode outcomes (task 28)** — parked is formally distinguished from paused/skipped/abandoned; the app never abandons a task by inference.
- **§8.7 Resolved** — multi-session work & hyperfocus extension is designed, not open; what's still genuinely open is named (the extend guardrail; floor-typed subtasks in the breakdown grammar; floor tuning policy).
- **§4.5 Schema companion → 2.3.0** via migration 002 (skill-layer schema gaps); migration 003 (task 28's columns) is pending, not yet landed.
- **§6.2 / §10** — Extend is no longer "proposed"; principle 2 updated accordingly.

*(The v2.2 changes — quantization correction, tiering re-anchor, five recurrence types, two-level scales, the open §8.7 item as it stood then — all carry forward; that section and the "Summary of Changes from v1" below are retained for continuity and untouched by this pass.)*

---

## Changes in v2.2 (from v2.1)

- **Quantization / runtime reality (§3.1, §3.2, §9)** — Q1_0 → Q2_0 (fork) / TQ1_0 (mainline repack); CPU-only is the Android baseline via stock `llama.rn` (its OpenCL path covers only Adreno + Q4_0/Q6_K; no Vulkan); real 4B throughput numbers added; the PrismML fork is named as the "Stage B" path to Q2_0 + Vulkan.
- **Tiering re-anchored (§3.1)** — 4B is the validated default *today*; 8B-first remains the target but is **gated** on an 8B quant that runs (a TQ1_0 8B repack, or the fork build). Marked as an open roadmap decision (§11).
- **Chat-template requirement (§3.2/§3.3)** — the model must be prompted via the `messages` API so `llama.rn` applies its embedded chat template; raw completion strings break output. This is a precondition for the structured-output work.
- **Recurrence types (§4.2)** — five explicit types (`scheduled_quota`, `quota`, `scheduled`, `unscheduled`, `count`) plus `null` one-off, with a `type` discriminator and clarified completion semantics.
- **Estimated duration (§4.1, §5.4)** — always populated (coach guesses when the user doesn't say); a `duration_source` flag lets learning replace a model guess off the *first* real completion.
- **Importance banding (§4.1)** — sub-band orders subtasks only when ordering matters; unordered siblings **share** a value.
- **Scope boundary (§7.1)** — tasks are scoped to in-app-observable work (schedule the meeting, don't try to time the meeting).
- **Open design item (§8.7)** — multi-session work + hyperfocus "extend," flagged for a design pass, not resolved here.
- **Android storage gotcha (§8.5)** — models must live in app-private external storage, not shared storage.

*(The v2.1 changes — 8B-first ladder concept, three coaching triggers, uncapped neglect, two-level scales, local skill-injection layer — all carry forward. The "Summary of Changes from v1" below is retained for continuity.)*

---

## Summary of Changes from v1

**Model & inference** — On-device model changed from Llama 3.2 3B to **Ternary Bonsai** (8B / 4B / 1.7B, 1.58-bit); runtime committed to **llama.cpp via `llama.rn`**; tiering ladder; thermal a first-class concern.
**Structured output** — **GBNF grammar-constrained decoding** for all structured extraction/summaries; coaching resolutions as **tool calls**.
**Coaching triggers** — three distinct escalations (any skip → next start; 3 skips in a session → immediate recalibration; app unopened 5+ days → re-orientation).
**Neglect factor** — **uncapped by design** (the fail-safe that guarantees everything surfaces).
**Two-level scales** — importance (user 1–10 / internal 100–1000) and energy (user low/med/high / internal 1–5), coarse at the surface, fine underneath.
**Learning layer** — fully-local, no-LoRA skill-injection loop (library + retrieval-injection + idle-window distillation), hidden and confidence-gated.
**Privacy & safety** — explicit local-first / opt-in-cloud boundary; coaching safety subsection.

---

## 1. Project Overview

**Primary audience.** Initially personal use, later the broader ADHD community.

**Core problem.** Executive-function load — difficulty *staying* on task and *choosing* an appropriate task. The app absorbs the decision-making so the user spends willpower on doing, not deciding.

**Solution.** An AI-mediated task manager balancing importance, urgency, energy, context, and self-care, adapting to the individual over time. A single conversational surface handles both task capture and supportive coaching.

**Design posture.** Offline-first, local-first, privacy-first. On-device inference is the durable default, with optional (opt-in, disclosed) cloud escalation reserved for a hard minority of cases.

---

## 2. Core Functions

### 2.1 Conversational task input
Natural-language capture; the model extracts structured metadata through adaptive questioning (short for simple tasks, thorough for complex). Same chat surface as coaching; each conversation instance is independent. **All extraction is grammar-constrained** (§3.3).

### 2.2 Adaptive work-session planning
User-initiated "work mode," three default lengths: **Quick** (≤10 min), **Moderate** (≤45 min), **Deep Focus** (≥1 hr). The generated plan is hidden from the user (§6). Algorithm in §5.3. (Long/open-ended work is resolved — §8.7.)

### 2.3 Intelligent task selection
Multi-factor scoring (importance, urgency, energy match, historical success) over a pool that has already passed two hard pre-filters — session capability (context/tools) and dependency-blocked (§5.3) — with an uncapped neglect multiplier (§5.2). Weighted shuffling *within* context groups keeps progression without predictability — novelty is motivating for ADHD.

### 2.4 Dynamic time management
Learns from performance to adjust durations; extends estimates on low-energy days, tightens on high-performance days; inserts a warm-up task before deep-focus work.

### 2.5 AI task coach
Supportive, problem-solving conversations for task difficulty. Triggers, tone, and flow in §7.2. Goals: offer modifications (time / context / approach), explore elimination, or break a task into subtasks.

### 2.6 Performance learning
Two complementary halves (§5.4 + §5.5): *numeric* learning (factor weights, time/energy/context priors) and *behavioral* learning (the local skill library). Both conservative and regression-protected.

### Deferred to later iterations
Explicit energy-level tracking, richer context awareness, habit stacking, progress visualization, emergency mode, calendar sync (§7.1), and a dependencies *UI* (dependencies exist in the data model already).

---

## 3. Model & Inference Architecture

### 3.1 Model: Ternary Bonsai (PrismML) — 4B proven, 8B-first as the gated target
Ternary Bonsai is a family of 1.58-bit language models (weights ∈ {−1, 0, +1}, group-wise quantization, shared FP16 scale per 128-weight group), Apache 2.0. ~9× memory reduction versus 16-bit.

| Variant | On-device footprint | Status after the spike |
|--------|--------------------|------------------------|
| **8B**  | ~1.75 GB | **Gated.** Best coaching quality *if* it can run — but no mainline-compatible (TQ1_0) repack exists yet, and CPU-only throughput is likely borderline (see below). Needs the fork build or an 8B repack. |
| **4B**  | ~0.86 GB | **Validated default.** TQ1_0 repack loads and runs on stock `llama.rn`, produces good output; this is the shippable tier today. |
| **1.7B** | ~0.37 GB | **Contingent fallback.** No TQ1_0 repack found yet; would need one, or the fork. |

**First real datapoint (one device, CPU-only).** 4B TQ1_0 on a Samsung Galaxy S23 FE (Snapdragon 8 Gen 1, 8 GB): load 1–4 s; throughput ~8.5 tok/s burst → **~5.2 tok/s steady state**, and crucially it **plateaus** (holds 5.2 flat for 4+ min of a 15-min run) rather than degrading further. Thermal drop peak→steady ~39%, but it stabilizes. This is the realistic baseline, not a floor to be optimized away — see §3.2 on why GPU offload isn't currently available.

**What this does to "8B-first."** The v2.1 policy — start at 8B, degrade down — is not executable today: (a) there is no working 8B build on the stock toolchain, and (b) extrapolating from the 4B, an 8B would run at roughly half the throughput (~2.5–3 tok/s CPU-only on comparable hardware — *unmeasured, to be tested*), which is borderline for fluid multi-turn coaching. So:

- **Today:** the ladder effectively **starts at 4B**. 8B and 1.7B are contingent tiers pending quantization that runs.
- **The policy stands as the target:** if the fork build (Q2_0 + Vulkan, §3.2) or an 8B/1.7B TQ1_0 repack lands, restore genuine 8B-first with downward degradation.
- **Runtime tiering is still a runtime health check** (memory, thermal, observed tok/s), tier locked per session except on hard failure — that design is unchanged; only the *available rungs* are currently fewer.

> **Open roadmap decision (§11):** ship 4B-first now, or invest in the PrismML fork build to unlock real 8B/Q2_0 + GPU first? This is a genuine fork with real effort on each side.

### 3.2 Runtime: llama.cpp via `llama.rn` (corrected)
- **Quantization formats** — Ternary Bonsai's **native** format is **Q2_0**, which lives only in **PrismML's fork** (`PrismML-Eng/llama.cpp`, still under active development; Vulkan support was added there recently). A community **TQ1_0** repack targets a ternary format already in **mainline** llama.cpp and works with **stock `llama.rn`** — *this is what the spike actually tested (4B), and it produced good output.* (**Not** Q1_0 — that's the older 1-bit Bonsai family, and the earlier spec was wrong on this point.)
- **Two build stages**: **Stage A (today)** — stock `llama.rn` 0.12.5 (prebuilt, no native build) + TQ1_0 4B. **Stage B (if pursued)** — build against PrismML's fork for native Q2_0 (all three sizes) and Android **Vulkan** GPU. Stage B is a real native-build commitment against a moving fork.
- **Android acceleration reality** — `llama.rn`'s documented Android backends are **CPU** and an **OpenCL** path limited to **Adreno GPUs and only Q4_0/Q6_K** data types — neither TQ1_0 nor Q2_0 qualifies. No Vulkan backend is documented for `llama.rn` on Android. **CPU-only is the realistic baseline** for these formats on stock `llama.rn`; GPU offload requires Stage B. (This corrects v2.1's "Vulkan/OpenCL/Hexagon maturing" optimism.)
- **Chat template is mandatory** — Ternary Bonsai is instruction-tuned; it must be prompted via the **`messages: [{role, content}]` API** so `llama.rn` applies the model's embedded chat template (its built-in Jinja parser). Raw strings to `completion()` produce repetition loops and invalid output. This is a precondition for §3.3.
- **iOS/Metal** — untested for these formats in this spike; Metal via `llama.rn` remains the expected iOS path but is unproven for TQ1_0/Q2_0.
- **Not chosen**: ExecuTorch and LiteRT-LM don't support the ternary format.
- **Binding**: `llama.rn` (JSI-first, requires the New Architecture; Expo is ruled out — native code required). Loads GGUF, streams tokens, exposes GBNF grammars and tool calling.

### 3.3 Structured output via grammar-constrained decoding
The app depends on the model emitting **valid structured data** for extraction, summaries, and tool calls. Structure is enforced with **GBNF grammars** (llama.cpp constrained decoding). **Precondition:** the chat template must be applied (§3.2) — without it, output is broken before a grammar can help. The spike confirmed the 4B produces *syntactically valid JSON* once templated, but with **inconsistent shape** across prompts when no grammar is applied — exactly the gap GBNF closes.

1. **Every** structured output is produced under a grammar derived from the target JSON schema (≈100% valid JSON, better field accuracy).
2. **Describe the schema in the prompt too** — llama.cpp constrains tokens but doesn't inject the schema; the model needs a natural-language field description to fill values *correctly*, not just *validly*.
3. **Guard against semantic drift** — hard constraints can push a small model toward locally valid but semantically wrong continuations; prefer *draft-then-constrain* for higher-stakes extractions.
4. **Fail fast** — schema-validity is a KPI (valid@1); on downstream-validation failure, retry once, then fall back to the "give me a moment" path (§8.3). *(The valid@1 / field-correct bar is not yet measured — only 4 illustrative prompts have been run, without grammars.)*

### 3.4 Function/tool calling for coaching actions
Coaching *outcomes* are tool calls, not parsed prose. Coach tool set:
- `modify_task(task_id, {duration?, context_tags?, energy_requirement?, approach_notes?})`
- `break_down_task(task_id, subtasks[])`
- `eliminate_task(task_id, reason)`
- `defer_task(task_id, until | condition)`
- `add_dependency(task_id, depends_on)` / `add_missing_task(...)`

Deterministic, auditable effects while the conversation stays natural. (Note: a dependency on a `count`-type task automatically means "depends on N completions" — see §4.2. A dependency on a broken-down parent's subtasks is created automatically at breakdown time — see §4.1.)

### 3.5 Thermal & performance management
Heat is the binding constraint. The app:
- Monitors thermal state (`ProcessInfo.thermalState` on iOS; Android equivalent) and **reduces context length / defers background work** when hot — also an input to the §3.1 tiering ladder. The spike's plateau behavior (throughput stabilizing rather than collapsing) is encouraging but device-specific.
- Prefers short, bounded generations in the task loop; runs heavy work (summary consolidation, skill distillation) **opportunistically in idle, cool windows**.
- Tracks per-session **model load time, tokens/sec, battery delta** as health metrics.

### 3.6 LLM provider interface
Retained; tier and backend swappable.

```typescript
interface LLMProvider {
  generateResponse(messages: ChatMessage[], opts?: {   // messages API — chat template applied (§3.2)
    grammar?: GBNFGrammar;
    tools?: ToolSpec[];
    maxTokens?: number;
  }, context?: ConversationContext): Promise<LLMResponse>;

  isAvailable(): boolean;
  getCapabilities(): LLMCapabilities;      // { grammar, tools, contextWindow }
  estimateTokens(text: string): number;
  currentThermalHeadroom(): 'ok' | 'reduce' | 'defer';
  activeTier(): '8B' | '4B' | '1.7B';
}
```

**Implementations**: `TernaryBonsaiProvider` (llama.rn; tier-aware, 4B today), `MockLLMProvider` (testing), future `CloudProvider` (opt-in escalation, §6.4).

---

## 4. Data Model

### 4.1 Tasks
```
- id, title, description
- importance            (internal 1–1000; see two-level scale below)
- estimated_duration    (minutes, NOT NULL — coach guesses when unspecified; for a
                          duration_type='floor' task, holds the FLOOR value, not a ceiling)
- duration_source       ('user' | 'model_guess')     ← new in v2.2
- duration_type         ('estimate' | 'floor', default 'estimate')     ← new in v2.3 (task 28, §8.7)
- actual_duration_history[]        (for learning; exactly ONE entry per completion, the total
                          minutes worked toward it across all sittings — §5.4, §8.7)
- average_actual_duration          (cached; mean of the history entries)
- work_state            ('none' | 'in_progress', default 'none')     ← new in v2.3; orthogonal
                          to `status` (§8.2, §8.7)
- accumulated_minutes   (minutes worked toward the current completion, not yet folded)     ← new in v2.3
- last_worked_at        (nullable; neglect re-anchor point — §5.2)     ← new in v2.3
- energy_requirement    (internal 1–5; see two-level scale below)
- average_energy_cost   (−4.0 … 4.0, learned)
- context_tags[]        (home, office, phone, computer, …)
- tool_requirements[]
- status                (active, completed, archived, deleted)
- created_at, updated_at
- completion_count, skip_count, skip_reasons[]
- success_rate          (completion / (completion + skip))
- last_completed_at
- next_due_at           (from recurrence or one-time deadline)
- dependencies[] / blocks[]        (via join table)
- parent_task_id        (nullable; set for subtasks)
```

**Every task has an estimated duration.** `estimated_duration` is `NOT NULL` and the timer is core (§6.2). When the user doesn't supply one, the coach **guesses** a reasonable value rather than omitting it. **`duration_source`** marks whether the value came from the user or the model, so the numeric-learning loop (§5.4) can replace a model guess off the *first* real completion instead of waiting for the normal confidence bar.

**Parent-task lifecycle after breakdown (R7).** Breaking a task down does not close the parent. Persisting a breakdown adds real `task_dependencies` edges — **parent `depends_on` each subtask** — not just an importance-band offset; this holds the parent out of the ranked pool for the whole life of the chain, via the dependency-blocked pre-filter (§5.3). When the **last** subtask completes, the parent unblocks and an **immediate** `breakdown_complete` coaching conversation (§7.2) asks the user to confirm the work is actually done — **the app never auto-completes the parent.** Until that conversation resolves, the parent stays held out of the pool (the same dependency-blocked filter, keyed on a pending `breakdown_complete` row, rather than a new task state). *Confirmed done* completes the parent through the correct completion primitive for its recurrence type (constraint #7); *not actually done* resolves via `add_missing_task`, which re-blocks the parent with a new subtask and the chain continues. If the parent is itself a subtask of a grandparent, its completion may unblock a second `breakdown_complete` — that confirmation queues rather than firing as a second simultaneous immediate.

**Open-ended (`floor`-typed) duration (task 28, §8.7).** `estimated_duration` stays `NOT NULL` for a floor-typed task — it holds the **floor** value ("at least an hour" → 60), never a ceiling. The timer for a floor task counts **up**, not down; the boundary that ends a work stretch comes from the session's block sizing (a planning quantity, §5.3), not from the task itself — so **an overrun is definitionally not an estimation error.** `duration_type` is orthogonal to `duration_source` (a floor can be user-stated or coach-guessed) and is **declared, never inferred** from magnitude alone — a user-estimated 90-minute task is still an estimate. One practical consequence needs no stored-field change: an *estimate*-typed task whose `accumulated_minutes` reaches its `estimated_duration` is treated as a floor for planning purposes only (§5.3).

**`work_state` (task 28, §8.7).** A second axis, orthogonal to `status`: a task being worked across multiple sittings stays `status='active'` the entire time — there is no separate `'in_progress'` *status* value, because every existing pool query already reads `status='active'`, and a new status value would risk in-progress tasks silently vanishing from any query not updated to include it. `work_state` (`'none' | 'in_progress'`) tracks whether there's an open, partially-worked stretch toward the *current* completion; see §8.2 for the episode outcomes that set it, and §5.4 for how accumulated minutes fold into learning at completion.

**Two-level scales (a named design choice, not an inconsistency).**
- **Importance.** User-facing **1–10** maps to internal **100–1000** in steps of 100. The **1–99 band beneath each hundred** orders **subtasks within a parent's band** — but **only when ordering matters** (one subtask depends on / sequences before another). A parent at 700 has subtasks in 701–799 *when they need an order*; **sibling subtasks with no ordering relationship share the same value** within the band — don't manufacture distinctions. The internal value is the real number used everywhere in scoring; **1–10 is purely an input/display projection.**
- **Energy.** User-facing **low / med / high** maps to internal **1 / 3 / 5**. Internal **2 and 4 are reserved for the app's behavioral discounting** off learned `average_energy_cost`, correcting the match without contradicting the user's own vocabulary. Surface for §5.4 energy-cost learning.

**Urgency is derived, not stored static.** Effective urgency is computed at scoring time from `next_due_at` plus an optional base sensitivity. `urgency_level` (1–5) is an optional *base* input only.

### 4.2 Recurrence — five types plus one-off
Recurrence has five distinct shapes plus the true one-off. v1/v2.1 conflated these; they carry genuinely different completion semantics and are distinguished by a **`type` discriminator**.

| Type | Quota? | Fixed schedule? | Period? | Completion semantics | Example |
|---|---|---|---|---|---|
| `scheduled_quota` | Yes | Yes | Yes | quota within a period, on fixed days; resets each period | "3×/week on Mon/Wed/Fri" |
| `quota` | Yes | No | Yes | quota within a period, any days; resets each period | "15/week, whenever" |
| `scheduled` | No | Yes | Yes | recurs on a fixed schedule | "Every Tuesday" |
| `unscheduled` | No | No | No | **reopens on completion**; resurfaces via the uncapped neglect multiplier only; never period-resets | ongoing novel/creative project |
| `count` | No | No | No — **N total, ever** | increments a counter per completion; flips to done (closing + unblocking dependents) only at `target` N | "review deck 10× before exam" |
| *(null)* | — | — | — | true one-off; completing closes it permanently | "renew passport" |

**Critical: `null` ≠ `unscheduled`.** Both look period-less, but:
- `null` → completing the task **closes** it; it does not reopen.
- `unscheduled` → completing the task **resets its neglect clock but keeps it `active`**; it returns to the pool and resurfaces purely through neglect (§5.2). Never give it a fake period/quota to force recurrence, and never mark it `completed`.

Getting these wrong breaks any indefinitely-recurring, non-scheduled task: as `null` it would wrongly archive after one completion; forced into `quota`/`scheduled_quota` it would get a fake period it doesn't have.

**`count` composes with dependencies for free.** A `count` task doesn't report done until it reaches `target` N. So an ordinary dependency (`add_dependency`, "depends on X being done") pointed at a count task **already means "depends on N completions of X"** — no separate "depends-on-N" concept is needed. The count type's completion semantics carry the gating.

**Example (quota):**
```json
{ "type": "quota", "quota": 15, "period": "week" }
```
**Example (count):**
```json
{ "type": "count", "target": 10 }
```
**Behavior:** for period types, missed occurrences **reset** (no guilt stacking) and a missed quota gives remaining occurrences in the period an **importance boost**; repeated misses feed coaching (§7.2). `unscheduled` and `count` have no period and no reset_date.

**Composing with R8's accrual gate and task 28 (§5.2, §8.7).** `unscheduled` and `count` are **not** subject to R8's neglect accrual gate: `unscheduled`'s neglect *is* its entire resurfacing mechanism, and `count` has no period to gate against. `count` folds each increment's multi-sitting total **separately** — a park-then-resume within one increment accumulates toward that increment only, and each increment's completion writes its own single `actual_duration_history` entry (§5.4, §8.7). None of this changes the six-way completion-primitive dispatch (constraint #7); the fold happens before dispatch, identically for every recurrence type.

### 4.3 Interactions (unified)
One table for all interaction types (`work_session`, `coaching_conversation`, `task_input`, `energy_checkin`, `pattern_recognition`, `task_completion`, `task_skip`), each carrying: timestamp, optional session id, start/end energy, `conclusions[]`, `learning_data`, an **AI-generated `conversation_summary`** (grammar-constrained, versioned; raw transcript never stored), duration, completion status, contexts used, optional feedback rating.

### 4.4 Data-storage strategy (privacy-aware)
- **Raw conversations are transient** — in memory during a session, never persisted. Only **grammar-constrained structured summaries** are written (always valid objects).
- **Version the summary schema** — `summary_schema_version`; learning reads through an adapter.
- **Tiered retention** — detailed recent data (30–90 days) plus long-term rolled-up summaries; consolidation at 100+ entries *and* ≥1 week.

### 4.5 Database Schema: applied in the companion file
Companion (v2.2 baseline): `ADHD_Task_Management_App_Database_Schema_v2.2.sql`. **A v2.3 snapshot, `ADHD_Task_Management_App_Database_Schema_v2.3.sql`, is now current**, reflecting schema version **2.3.0** as applied by migration 002 (`src/db/migrations/002_skill_layer_schema.sql`). Net changes from v2.2 (migration 002 — the skill-layer schema gaps from the task 18 design, §5.5):
1. New table **`learning_state (key, value, updated_at)`** — watermarks + tunables for the skill-injection layer; no repository yet, task 19 owns access.
2. **`skills.is_active`** default flips `TRUE` → `FALSE` (born-inactive defense-in-depth); existing rows keep their actual stored value, only the default for future inserts changes.
3. **`skill_evidence.source`** — optional nullable `('distiller' | 'outcome')` provenance column.
4. **`coaching_queue.trigger_type`** CHECK gains **`'buried_task'`** (R4) and **`'breakdown_complete'`** (R7) — the §7.2 table's fourth and fifth rows land here.
5. `learning_data` JSON gains a documented internal `"v":1` convention (mirroring `summary_schema_version`) — a code-level convention, not a schema change.
6. `fireable_skills` is documented as an **index only** — its `GROUP_CONCAT`'d conditions are lossy; real condition matching reads `skillsRepository.listConditions()`.

**Migration 003 is pending** (task 33) and will add task 28's columns (§8.7): `tasks.duration_type` / `work_state` / `accumulated_minutes` / `last_worked_at`, `sessions.tasks_progressed`, and two new `interactions` enum values (`interaction_type='task_progress'`, `completion_status='progress'`). **Not yet landed as of this spec version** — §4.1/§8.2 describe the *design* task 28 delivered; the schema catches up when migration 003 lands.

Everything from v2.2 (`duration_source`, the five recurrence types + `target_count`, the uncapped neglect view, corrected `schema_metadata` strings, skill tables, `summary_schema_version`, `parent_task_id`, neglect excluded from summed weights) carries forward.

**The reference `.sql` file is hand-maintained, not generated** — confirmed for this pass; no build step regenerates it from `src/db/migrations/`. It was updated as part of this fold-in to reflect migration 002 (see the findings report, `docs/eval/task27_findings_report.md`, for exactly what changed and one stale item found but not fixed: `algorithm_weights`' seed data still lists `context_fit` at the retired 25/20/20/15/20 split — no migration has ever touched that table, so the reference file mirrors real applied state, not the aspirational R3 weights).

---

## 5. Algorithm Implementation

### 5.1 Scoring
Weighted sum, then multiplied by the neglect term:

| Factor | Default weight |
|-------|----------------|
| Importance | 31% |
| Urgency (derived from `next_due_at`) | 23% |
| Energy match | 23% |
| Historical success rate | 23% |

`final_score = weighted_sum × neglect_mult` (§5.2). Neglect is **not** one of the summed weights.

**Context/tools moved out of the weighted sum (R3).** A task the user cannot physically do right now (wrong context, a missing tool) is **unrankable**, not merely down-weighted — so `context_tags`/`tool_requirements` are now a **hard pre-filter** at the selection boundary (§5.3), applied *before* scoring, not one of the summed factors above. The freed 15% (from the prior 25/20/20/15/20 split) redistributes evenly across the remaining four factors. The filter **retains its rejects** — §8.1's "no available tasks" coaching and the `buried_task` trigger (§7.2, R4) both read them.

**Historical success is smoothed, not a raw ratio (R6).** The prior hard branch (`n = 0 → 0.5` prior, else the raw completion/(completion+skip) rate) let one data point swing the factor from 0 to 1 on a 23%-weighted term. It is replaced by a smoothed blend:

```
historicalSuccessFactor(rate, n) = (rate·n + 0.5·k) / (n + k),   k = 2
```

The `n = 0` case falls out of the same expression (→ 0.5) rather than being a separate branch; a first skip lands at 0.33, a first completion at 0.67, converging to the raw rate as evidence accumulates. This is the **degenerate form of §5.4's hierarchical shrinkage** — task 17 later replaces the prior's *source* (the fixed 0.5 → a learned global/parent prior), not the formula; `k` stays a named constant so 17 can reach it.

Neglect remains a post-sum multiplier, never a summed weight.

### 5.2 Neglect factor (uncapped — a deliberate fail-safe)
Guarantees that *every* task eventually surfaces for a decision, so nothing rots silently.

- **Curve (R1):** the squared curve is retired. Neglect is computed through a swappable seam, `neglectCurve(weeks)`, seeded **linear**: `neglectCurve(weeks) = 1 + weeks`. The `+1` is a **floor**, not a cap — a brand-new task (`weeks ≈ 0`) scores on merit (× 1) instead of being zeroed. The curve is a deliberately swappable seam (√weeks, `weeks/N`, etc. are one-line alternatives if real usage shows the tail too soft or hard) — **but every alternative must stay unbounded above.** **Capping would reintroduce the exact failure mode the mechanism prevents.**
- **Applied:** as a multiplier on the final weighted score; because it grows without limit, a perpetually out-ranked task will eventually climb high enough to force a decision.
- **Resets:** on completion, or on a coaching intervention that dispositions the task. For **`unscheduled`**-recurrence tasks, completion resets the neglect clock but **does not close** the task (§4.2). For **`count`** tasks, the neglect clock is fine to reset on each incremental completion while the task stays open until `target`.
- **Long-absence flatness** is handled by the **5-day re-orientation coaching** (§7.2), not by capping the math.

**Accrual-start gate for recurring tasks (R8) — a start condition, not a cap.** For recurring tasks, the clock does not begin accruing at the anchor itself but at a gap past it, sized to the recurrence's own occurrence spacing — a task that isn't due yet shouldn't already be screaming for attention:

```
accrualStart = anchor + gap(recurrence)
anchor       = COALESCE(last_completed_at, created_at)

gap(scheduled | scheduled_quota | quota) = period / (1 + quota)      // quota defaults to 1
gap(unscheduled | count | none)          = 0
```

Reference points: an annual `scheduled` task gaps 182.5 days (6 months); a weekly `scheduled` task gaps 3.5 days; a 3×/week `quota` task gaps 1.75 days; a 15/week `quota` task gaps ~10.5 hours. The `(1 + quota)` denominator collapses to exactly "half the period" at `quota = 1` — there is no separate halving step. **Not gated:** `unscheduled` (neglect *is* its entire resurfacing mechanism), `count` (no period to gate), and **one-offs**, which accrue from `created_at` exactly as before — a deliberate ruling, with no horizon fallback.

**State this plainly, because it is easy to "fix" into a bug: `accrualStart` and the `+1` floor are both *start conditions*, never ceilings.** Growth after either start remains completely unbounded — nothing about R1 or R8 saturates the term at any point. Constraint #5 (uncapped neglect) is fully intact; anything that makes the neglect term stop growing, or grow toward a limit, is the violation R1/R8 do *not* commit.

**Re-anchor on genuine work (task 28, §8.7).** Working a task — a recorded progress episode — re-anchors its neglect clock: the effective anchor becomes the latest of `created_at`, `COALESCE(last_completed_at, created_at)`, and `COALESCE(last_worked_at, created_at)`. An hour of real attention is at least as strong a "decision" as the coaching intervention that already resets the clock above, so it resets the clock the same way — and then grows unbounded from there, exactly like every other case. This composes with R8: when both apply, `accrualStart = anchor′ + gap(recurrence)`, where `anchor′` is the three-way max. A task can only avoid the fail-safe by being *repeatedly, genuinely worked* — which is a surfacing loop, not a way to hide.

### 5.3 Session-planning algorithm

**Selection boundary (before either ranker runs).** The neglect-annotated active pool passes through **two hard pre-filters**, in order, before `scoreTasks` or `rankWithContextNovelty` ever sees it. Both follow the same partition-and-retain contract — `eligible` / `rejected`, with rejects carrying enough detail to explain why:
1. **Session capability (R3)** — context/tools the current session doesn't have (§5.1).
2. **Dependency-blocked (R2/U1)** — tasks with unmet dependencies. Without this filter, ordered subtask chains (R2) are sequence-safe under strict `scoreTasks` ranking but **not** under the novelty shuffle, whose weighted sampling treats the chain's fan-out offset (≈0.2–0.4% of `finalScore`) as noise and serves the steps in near-random order. Keeping blocked steps out of the pool entirely is the fix — no amount of offset tuning substitutes for it.

Both filters retain their rejects, not discard them: §8.1's "no available tasks" coaching and R4's `buried_task` scan (§7.2) both read filter 1's rejects; filter 2's rejects are what makes "dependency issues" in §8.1 a concrete mechanism rather than a described-but-unbuilt case. Only the pool that survives **both** filters reaches either ranker.

1. **Deep-focus allocation** — reserve end-of-session time for 1–2 major tasks when long enough; **25% overrun buffer**. **One in-progress task** (`work_state='in_progress'`) may claim **first refusal on this block**, picked by most recent `last_worked_at`, before ordinary allocation runs (task 28, §8.7) — continuity value decays with time away, so the freshest thread gets the claim; older parked tasks are already championed by their growing neglect multiplier through the ordinary shuffle. Sessions with no deep-focus block (Quick, short Moderate) make no resume claim.
2. **Context-aware grouping** — group by context; within a group, weighted-shuffle toward a difficulty gradient.
3. **Progressive arrangement** — order context groups as an energy ramp toward deep focus.
4. **Break / self-care** — natural breaks at context switches; no breaks inside a deep-focus block. A stretch **≥50 minutes** (an extended work block, task 28) places a break **first** in whatever agenda follows it.
5. **On-demand fallback (escape valve)** — regenerate with lower energy, shorter estimates, easier contexts. Surfaced in the task UI (§6.2). **Extend** (§6.2, §8.7) uses the same underlying primitive: when an extended work stretch finally ends, the remaining agenda is **regenerated for whatever session time is left — not shifted, not shrunk in place.** A shifted tail is stale (the energy ramp and context grouping it was arranged for no longer hold), and the plan is hidden from the user anyway, so there is no "but I saw the list" cost. Tasks that fall out of a regenerated tail were never promised and carry no guilt — identical to the escape valve's own rule.

### 5.4 Numeric learning
Six retained loops (factor-weight, time-estimation, energy-pattern, context-effectiveness, break/self-care, learning parameters). Provisions for a **single-user** regime:

- **Sparsity / cold-start via hierarchical shrinkage.** Start each cell from a global prior; specialize only once a cell has its own data; otherwise fall back to the parent level. §5.1's R6 historical-success smoothing is this same idea's degenerate one-parameter form, applied early: this loop later replaces R6's **fixed** 0.5 prior with a **learned** global/parent prior, in the *same formula* (`k` stays the named constant) — it replaces the prior's source, not the shape of the blend.
- **Model-guessed durations start cold.** A `duration_source = 'model_guess'` estimate has **zero real observations**; replace it off the *first* actual completion rather than waiting for the specialized-weight bar. A `'user'` estimate is trusted more but still refined.
- **Model-guess replacement waits for a completed fold (task 28, §8.7).** A task worked across several sittings toward one completion accrues in `accumulated_minutes`; partial times are **censored data** — you only know the task took *at least* N minutes so far — and must never update a stored estimate mid-flight. The estimate updates exactly once, off the single folded total (`accumulated_minutes` + final episode) written at completion, for every recurrence type.
- **Conservative, protected adaptation.** ≥10–15 points before adjusting a *specialized* weight; small increments; regression protection with rollback.

Energy-cost signal drives the internal **2 and 4** energy levels (§4.1).

### 5.5 Behavioral learning — local skill-injection layer (no LoRA, no cloud)
Adapted from **MetaClaw's fast loop only** — inference-time skill loop, no weight-training loop. Pure local prompt-engineering on the loaded Ternary Bonsai model: **no cloud, no LoRA, no data leaving the device.**

The *behavioral* half of learning alongside the *numeric* half (§5.4): weights tune **which** tasks get chosen; skills tune **how** the coach talks and **what** remedies it reaches for.

**Three local components:** (1) a **skill library** in SQLite — versioned, grammar-constrained records of trigger conditions + a behavioral instruction; (2) **retrieval + injection** of matching skills into the prompt at coaching/planning time; (3) **idle-window distillation** ("evolver") that synthesizes/sharpens skills from accumulated friction in cool/idle windows.

**Two commitments:** skill use is **hidden from the user**; firing is **confidence-gated** (confidence grows on corroboration, decays on contradiction; a bad-day skill can't harden into a rule before corroboration; low-confidence skills are held back).

---

## 6. User Interface Flows

### 6.1 App launch
```
App Open →
  ├─ 5+ days since last open?  → Re-orientation coaching (recalibrate priorities)
  ├─ Pending coaching queued?  → Coach chat (takes priority)
  ├─ First run?                → Onboarding → Dashboard
  └─ Otherwise                 → Dashboard
```
The 5-day re-orientation runs first — a "welcome back, recalibrate" conversation whose content includes the §8.5 housekeeping.

### 6.2 Dashboard & task execution
**Dashboard — four options:** Add Tasks · Start Work Session · See Metrics · Settings.

**Work-session flow:**
```
Start Work Session → length select → energy check-in (low/med/high) →
tier health check + plan generated (both hidden) → tools checklist →
  ├─ all tools present → first task
  └─ missing tools → offer first non-deep-focus task + rebuild with available tools →
task execution loop → session summary → dashboard
```

**Minimal task screen (stay out of the way):**
- Task **title** (prominent)
- **Timer** (dominant, large) — counts **down** to the estimate for an `estimate`-typed task, counts **up** for a `floor`-typed task or an extended stretch (§8.7).
- **Pause** (interruptions)
- **Exit** (small)
- **Escape valve** (small, always available) — "give me something easier"; regenerates an easier agenda (§5.3.5).
- **Extend** — **resolved (task 28, §8.7), no longer proposed.** "Keep going" past the planned length by `EXTEND_QUANTUM_MINUTES = 25` (a named tunable) per press; the current block's end moves with it, and the session's planned end moves too if the new block end crosses it. When the extended stretch ends (any outcome), the remaining agenda is **regenerated**, not shifted (§5.3). The **guardrail policy** — whether/how the app nudges self-care during a long extend chain — **is an open ruling** (task 28 design §4.3 presents three options and recommends one; not decided here). It gates only this affordance's UI surface, not the data model.
- **Park** — "pause for later," the escape valve's cousin for genuine progress rather than a wrong task: ends the current episode in the `progress` outcome (§4.1's `work_state`), retaining time already worked. **Never reads as a skip** — writes no `skip_count`, enqueues no coaching, cannot feed the 3-skip trigger (§7.2, §8.2). Offered only once the episode has run **≥60 seconds**; before that, ending early is an ordinary skip.

**Between tasks:** quick rating, energy check, optional break, optional "read notes," then "start task." A resumed (`work_state='in_progress'`) task's "read notes" slot includes its accumulated context.

### 6.3 Task input & coaching flows
```
Add Tasks → AI chat → (simple: quick add | complex: extended convo) →
  grammar-constrained extraction → task saved → dashboard

Coaching (triggered, §7.2) → AI chat → explore barrier / recalibrate →
  resolution via tool call: modify | break down | eliminate | defer | no change →
  return to prior context
```

### 6.4 Cloud escalation (opt-in)
Off by default, opt-in, disclosed. When enabled, the app states plainly what leaves the device (redacted structured context — never raw transcripts) and why. Default experience is fully local. Gate for any future cloud learning loop (§5.5).

---

## 7. Conversation Design

### 7.1 Task-input conversations
Adaptive questioning that scales with complexity. The model asks only for what it needs to fill the schema. Extraction is grammar-constrained (§3.3). Tone: supportive, efficient.

**Scope tasks to in-app-observable work.** The app can time and verify only what happens in-app. An external meeting/interview can't be observed, so scope the task to its *arrangement* — "**Schedule** coffee chat," with a duration reflecting the scheduling effort, not the meeting length. (A future **calendar-sync** could close the loop between "scheduled" and "actually happened," giving a real signal instead of an unverifiable self-report — Phase 3+, §11.)

**Simple task**
```
User: "I need to take out the trash"
AI:   "Got it! Recurring?"
User: "Yes, every Tuesday"
AI:   "Done — 'Take out trash', scheduled weekly on Tuesdays."
```

**Complex task**
```
User: "I need to organize my garage"
AI:   "Big one — let's shrink it. What's driving it: a deadline, or something
       you've been meaning to get to?"
User: "My partner has been asking for months."
AI:   "Got it. Realistically, how long could you give it in one sitting?"
       → continues until it has scope, energy, context, and a first subtask,
         then proposes a breakdown via break_down_task(). If the user can't
         give a time, the coach guesses one (duration_source = 'model_guess').
```

### 7.2 Coaching conversations — five distinct triggers

| Trigger | Timing | Purpose |
|--------|--------|---------|
| **Any single skip** | Queued for **next start** | Non-blocking follow-up. The skip is the seam; momentum preserved. Optional one-word reason chip. |
| **3 skips within one session** | **Immediate**, at the third skip | The app has misjudged current capacity. Stop serving tasks; talk about how the user feels and what they can take on **right now**; re-check energy/mood, re-match the queue. Not about any single task. |
| **App unopened 5+ days** | At **next open**, before dashboard | Re-orientation: priorities may have shifted; review stale tasks, reshuffle, refresh preferences. |
| **Buried out-of-context/tool task (R4)** | At **next open** by default (the due-soon variant may be escalated to **immediate** at enqueue) | A task the session-capability filter (§5.3, R3) makes *invisible* — it never appears while you're out of its context — is a different failure than absence. Scan the filtered-out set at app open; if a task there is **old** (start ~6 months, tunable) **or due soon** (start ~48 h, tunable), open a conversation about that set. The check is dumb; the conversation is smart — it explores rescoping to a reachable context, adding a "get ___ tool" prerequisite task, pausing a context for a few days, reminding next time in-context, deferring, or dropping. |
| **Breakdown complete (R7)** | **Immediate**, at the last subtask's completion | The parent's check-off: the user's knowledge of whether the work is actually done is freshest right then, and this lands on a win rather than interrupting one. Does **not** auto-complete the parent (§4.1). |

**Precedence.** If a 3-skip `session_recalibration` and a `breakdown_complete` would both fire immediately, **the recalibration wins** — the user is struggling; the celebration can wait one beat.

**`buried_task` re-trigger prevention.** A "remind me later" disposition on an **old**-branch buried task is gated behind a zero-minute sentinel task in the target context, rather than a snooze state — the sentinel completes (and surfaces the real tasks) the next time a session runs in that context. The sentinel itself is excluded from the buried-task scan (otherwise it would re-trigger the coaching it exists to suppress). This pause applies to the **old** branch only: a **due-soon** out-of-context task is **never** silently paused — its conversation must reach a real disposition (rescope / partial / reschedule / acknowledge). Paused tasks still surface in the 5-day re-orientation sweep as a backstop.

Notes: the 3-skip conversation is an escape-valve *cousin* (the app inferring "wrong tasks" from behavior rather than being told). All five map onto `coaching_queue` with distinct trigger rows and an `urgency` tier — `buried_task` and `breakdown_complete` landed via migration 002 (§4.5).

**Coaching goals:** understand the barrier (or recalibrate capacity/priorities), then a concrete disposition — modify / break down / eliminate / defer — via tool call (§3.4).

**Tone principles:** curiosity not judgment; validate the experience; frame as *system* improvement; end with a concrete next step.

### 7.3 Coaching Safety & Boundaries
- **Supportive, not clinical** — helps with tasks and motivation; not therapy, no diagnosis; not a substitute for professional support.
- **No reinforcement of negative self-talk** — "failure" reframed as data; never scold, rank, or stack guilt.
- **Crisis-sensitivity** — serious distress is met with care and a pointer to appropriate human/professional support via a short, reviewed path, not the small model's improvisation.

---

## 8. Edge Cases

### 8.1 Task selection
**No available tasks — dependency issues.** Causes: out-of-context, external blockers, missing/removed/circular dependencies. **Universal response: a coaching session** tailored to the cause, reached through the **retained rejects of the two hard pre-filters** (§5.3) — not a separate scan. *Preventive:* add dependencies at creation, dependency-impact check before deletion, batch-remove chains.

**Energy mismatch.** Offer a break; suggest eating near a meal; hydration/movement; re-check energy; exit gracefully if still low. (3 skips here independently trigger §7.2 recalibration.)

**Context mismatch.** Context change, context-flexible variant, on-the-spot task, or deferral.

### 8.2 Work-session
**Timers are timestamp-based.** Store end-time; compute remaining from wall clock. On crash, timer keeps running against stored end-time; on relaunch, open to the right screen. **Multi-session accumulation and "extend" are resolved** (§8.7) — see the four episode outcomes below and §4.1's `work_state`/`accumulated_minutes`/`last_worked_at`.

**Pausing / backgrounding.** Normal, not abandonment. Track pause time; **>20% paused** queues coaching. Distinct from *parking* below — a parked task has no running episode, so parked time is never counted as paused time.

**The four episode outcomes.** Every served task episode ends in exactly one:
- **Completed** — checked off; folds `accumulated_minutes` + the final episode's minutes into **one** `actual_duration_history` entry (§5.4), for every recurrence type.
- **Parked** (`work_state='in_progress'`) — the user made real progress and stopped on purpose, intending to resume. **Never a skip.** Writes no `skip_count`, enqueues no coaching, and cannot feed the 3-skip `session_recalibration` trigger (§7.2) — structurally, not by a policy check. Offered only once the episode has run **≥60 seconds** (before that, ending early is an ordinary skip). Time already worked is retained toward the next sitting.
- **Skipped** — served and declined without working it. Normal §7.2 skip semantics, unchanged.
- **Abandoned** — an *episode* or *session* ends without a user decision (crash, walked away). **The app never abandons a task by inference** — the only way an in-progress stretch is written off is an explicit coaching disposition (`eliminate_task`, or a `modify_task` that resets it). On relaunch, an open episode with no recorded outcome closes as `abandoned`, credits elapsed-minus-known-pause-time to `accumulated_minutes`, and sets `work_state='in_progress'` — **never a skip.** (The session itself may separately be recorded `abandoned`; session status and task `work_state` are independent.)

**Skips / early ends.** Per §7.2. Break overruns **repopulate** the agenda — no guilt. Very short sessions supported. If nothing fits, offer to split a task.

### 8.3 AI / technical failures
**Model fails to load.** Error + troubleshooting; in the tiering ladder a load failure steps down before giving up. **Chat-template misuse is a distinct failure mode** (§3.2): repetition loops / invalid output despite a healthy load — the header-only diagnostic (`loadLlamaModelInfo`) isolates load failures from format/template failures.
**Timeout during task input.** 1st/2nd: canned retry. 3rd: exit gracefully.
**Timeout during coaching.** Stack the topic; don't block the app.
**Failure mid-session → Safe Mode.** Finish without AI (timer, mark complete/incomplete, basic summary); queue what would have coached. New sessions require a passing AI health check.
**Model stuck in a loop.** Detect repetition → different approach → offer to skip. *(Grammar + bounded generations + correct chat templating reduce this class.)*

### 8.4 Database / corruption
**Recovery order:** `PRAGMA integrity_check` → salvage → restore from automatic backup → fresh start with import → full reset with consent. **Backup:** copy DB at session start; work on the copy; keep prior as backup; block session start if there's no space to copy. **Consistency:** validation removes dangling deps, breaks cycles, cleans orphans.

### 8.5 Accounts / data management / long absence
- **Model storage (Android gotcha):** models must be pushed to the **app-private external directory** (`/sdcard/Android/data/<package>/files/`), **not** shared storage (`/sdcard/Download/`), which fails to load silently.
- **Onboarding interruption:** resume from last step; offer "start over."
- **Model download failure at setup:** clear partials, retry with progress, explain storage/network needs.
- **Full data deletion:** multi-step irreversible confirmation; wipes tasks/history/patterns/preferences/skills.
- **Data export:** JSON of tasks, preferences, anonymized patterns/skills; redact sensitive conversation detail.
- **Unused 5+ days / months:** the 5-day re-orientation is the front door; auto-clear only past-due tasks; check for an updated model; offer clean restart if the DB is too outdated.
- **Stale learning data:** validate against current behavior; skill confidence decays; condense very old data.

### 8.6 Privacy / security
All data stays local; standard device security. Local-model access to on-device data is fine *because it stays on-device* — which is why any cloud escalation (§6.4) must be opt-in and disclosed.

### 8.7 Multi-session work & hyperfocus extension — resolved (task 28)
**No longer an open design item.** Full design: `docs/design/multisession_task28_design.md` (paper trail: `docs/eval/task28_design_report.md`).

**Summary.** A work episode can end **parked** (`work_state='in_progress'`, §4.1 — orthogonal to `status`, which stays `active` throughout) as well as completed/skipped/abandoned (§8.2). Minutes accrue in `accumulated_minutes` and fold into **exactly one** `actual_duration_history` entry per completion, for every recurrence type (§5.4). Open-ended work is `duration_type='floor'` (§4.1) — `estimated_duration` holds the floor value, the timer counts **up**, and the block boundary (a planning quantity, §5.3) is what ends the stretch, so an overrun is never an estimation error. **Extend** (§6.2) grows the stretch by `EXTEND_QUANTUM_MINUTES = 25` (named tunable); the session end moves with it if crossed; when the stretch ends, the agenda tail is **regenerated**, not shifted (§5.3). At most one in-progress task gets first claim on the deep-focus block, picked by most recent `last_worked_at` (§5.3). The neglect clock **re-anchors** to `last_worked_at` — a start condition, not a cap; growth after it is unbounded like every other case (§5.2, constraint #5).

**What genuinely remains open** (not resolved by this design — do not treat these as settled):
- **The extend guardrail** (design §4.3) — whether/how the app nudges self-care during a long chain of extends. Three options were presented: unlimited-and-quiet; a nudge every 2nd consecutive extend plus a gentle next-session coaching follow-up past 2× the original block (*recommended*); a hard soft-cap (*rejected by the recommendation* — "a wall wearing a cardigan"). Gates only task 24's extend UI surface, not the data model, the migration, or the planner.
- **Floor-typed subtasks in the breakdown grammar.** Cut from v1 to keep the 4B's breakdown output unchanged. An "at least an hour, in three pieces" breakdown is served today via ordinary subtasks plus a follow-up `modify_task`, or by the blown-estimate planning rule (§4.1: an estimate-typed task whose accumulated time exceeds its estimate is treated as a floor for placement, without any stored field changing). Revisit if a real breakdown demands native floor subtasks.
- **Floor tuning policy.** Whether learning ever raises a user-stated floor, or converts a stable floor to an estimate, is task 17's open call; v1 never auto-lowers a user-stated floor.

**Provenance:** surfaced in the "Finish mokRadio project" test (10-step chain, each subtask "at least an hour" as a floor).

---

## 9. Tech Stack

- **Platform:** React Native 0.86.x, New Architecture (required by `llama.rn`; Expo ruled out).
- **On-device model:** Ternary Bonsai. **4B (TQ1_0) is the validated default today**; 8B/1.7B contingent on a repack or the fork build. Native **Q2_0** is fork-only.
- **Inference:** `llama.rn` 0.12.5 (stock/prebuilt) → llama.cpp. **CPU-only on Android** for these formats (no usable GPU path in stock `llama.rn`); **Stage B** fork build unlocks Q2_0 + Vulkan. Chat-template via the `messages` API is mandatory. GBNF grammars + tool calling.
- **Database:** SQLite, local, offline-first, pre-session backup scheme (§8.4).
- **Learning:** fully local — numeric loops (§5.4) + local skill-injection layer (§5.5). No LoRA, no cloud training.

---

## 10. Design Principles

1. **Psychology-aware** — built around ADHD motivation (novelty, momentum, low friction).
2. **Escape valves everywhere** — always a graceful way out, and its resolved inverse: **Extend**, a way to *keep going* when a stretch is genuinely working (§6.2, §8.7).
3. **Coaching over forcing** — understand and adapt; never pressure or shame.
4. **Privacy-first** — local by default; cloud only opt-in and disclosed; learning is fully local.
5. **Everything surfaces eventually** — the uncapped neglect factor guarantees no task hides forever; its start conditions (R1's floor, R8's accrual gate, task 28's re-anchor) never become ceilings (§5.2).
6. **Coarse at the surface, fine underneath** — two-level importance/energy scales.
7. **Determinism where it counts** — constrained output and tool-based actions.
8. **Invisible learning** — the app quietly gets better; skills are never shown.
9. **Honest about the hardware** — architecture tracks what actually runs on real devices, not vendor benchmarks.

---

## 11. Development Priorities

**Open roadmap decision (drives Phase 1 shape):** **ship 4B-first now** on the stock toolchain, or **invest in the PrismML fork build (Stage B)** to unlock real 8B/Q2_0 + Vulkan GPU before shipping? The spike makes 4B-first the low-risk path; Stage B is the way to genuine 8B-first but is a native-build commitment against a moving fork.

**Phase 1 (MVP)**
- Core task management + conversational input (grammar-constrained extraction, chat-template correct).
- Scoring with the uncapped neglect factor (§5.1/§5.2) and the two-pre-filter selection boundary (§5.3); the five recurrence types.
- Basic session planning + escape valve.
- Ternary Bonsai 4B via stock `llama.rn`, thermal-aware loop; tiering ladder scaffolded (rungs added as quants land).
- The five coaching triggers (§7.2).

**Phase 2 (Learning)**
- Numeric learning loops (§5.4) with hierarchical shrinkage, regression protection, model-guess cold-start.
- The local skill-injection layer (§5.5).
- Full context-grouped planning; tool-call resolution actions.
- Multi-session work & hyperfocus extension (§8.7) — designed; migration 003 + implementation land here.

**Phase 3 (Polish)**
- UI/UX refinement, performance/thermal tuning; Stage-B fork build for 8B/GPU if pursued; iOS parity.
- **Calendar sync** (§7.1) to close the scheduled-vs-happened loop.

**Out of scope (possible future).** Cloud slow-loop (weight adaptation) behind the §6.4 boundary and a fine-tune-friendly model, not Ternary Bonsai. Accountability/community, gamification, richer analytics — gated on the privacy model.
