# ADHD Task Management App — Specification v2.2

> **Revision note.** Builds on v2.1. This version folds in the first real on-device spike findings and a batch of test-data corrections. Headline changes: (1) **quantization format corrected** — Ternary Bonsai is **Q2_0** (native, PrismML-fork only) or **TQ1_0** (community repack, mainline-compatible); the earlier "Q1_0" was the *older 1-bit* Bonsai family, not this model. (2) The **8B-first tiering ladder is re-anchored on empirical reality** — only the 4B has a working mainline quant today, llama.rn gives no usable GPU path for these formats, so CPU-only 4B is the proven, shippable default and 8B/1.7B are contingent tiers (open roadmap decision). (3) **Recurrence expanded from one implied shape to five explicit types plus one-off**, with the `null` vs `unscheduled` and new `count` semantics pinned down. (4) Smaller corrections: coach-guessed durations, shared importance for unordered siblings, scope-to-observable-work. (5) A new **open design item** for multi-session / hyperfocus work. Everything still runs on-device; nothing sensitive leaves the device.

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
User-initiated "work mode," three default lengths: **Quick** (≤10 min), **Moderate** (≤45 min), **Deep Focus** (≥1 hr). The generated plan is hidden from the user (§6). Algorithm in §5.3. (Long/open-ended work interacts with the §8.7 open design item.)

### 2.3 Intelligent task selection
Multi-factor scoring (importance, urgency, energy match, context fit, historical success) with an uncapped neglect multiplier (§5.2). Weighted shuffling *within* context groups keeps progression without predictability — novelty is motivating for ADHD.

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

Deterministic, auditable effects while the conversation stays natural. (Note: a dependency on a `count`-type task automatically means "depends on N completions" — see §4.2.)

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
- estimated_duration    (minutes, NOT NULL — coach guesses when unspecified)
- duration_source       ('user' | 'model_guess')     ← new in v2.2
- actual_duration_history[]        (for learning; cumulative for multi-session — §8.7)
- average_actual_duration          (cached)
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

### 4.3 Interactions (unified)
One table for all interaction types (`work_session`, `coaching_conversation`, `task_input`, `energy_checkin`, `pattern_recognition`, `task_completion`, `task_skip`), each carrying: timestamp, optional session id, start/end energy, `conclusions[]`, `learning_data`, an **AI-generated `conversation_summary`** (grammar-constrained, versioned; raw transcript never stored), duration, completion status, contexts used, optional feedback rating.

### 4.4 Data-storage strategy (privacy-aware)
- **Raw conversations are transient** — in memory during a session, never persisted. Only **grammar-constrained structured summaries** are written (always valid objects).
- **Version the summary schema** — `summary_schema_version`; learning reads through an adapter.
- **Tiered retention** — detailed recent data (30–90 days) plus long-term rolled-up summaries; consolidation at 100+ entries *and* ≥1 week.

### 4.5 Database Schema: applied in the companion file
Companion: `ADHD_Task_Management_App_Database_Schema_v2.2.sql`. Net changes from v2.1:
1. **`tasks.duration_source`** ('user' | 'model_guess') added (§4.1).
2. **`task_recurrence.recurrence_type`** discriminator added (the five values), plus **`target_count`** for `count` (§4.2). `current_period_progress` doubles as the running counter for `count` (with `reset_date` NULL and no period reset).
3. **Neglect view** stays **uncapped**; documented that `unscheduled` completion updates `last_completed_at` (resetting neglect) without setting status `completed`.
4. **`schema_metadata`** model/format strings corrected (4B default; TQ1_0 mainline / Q2_0 fork).
5. Everything from v2.1 (skill tables, `summary_schema_version`, `parent_task_id`, neglect excluded from summed weights) carries forward.

---

## 5. Algorithm Implementation

### 5.1 Scoring
Weighted sum, then multiplied by the neglect term:

| Factor | Default weight |
|-------|----------------|
| Importance | 25% |
| Urgency (derived from `next_due_at`) | 20% |
| Energy match | 20% |
| Context fit | 15% |
| Historical success rate | 20% |

`final_score = weighted_sum × neglect_mult` (§5.2). Neglect is **not** one of the summed weights.

### 5.2 Neglect factor (uncapped — a deliberate fail-safe)
Guarantees that *every* task eventually surfaces for a decision, so nothing rots silently.

- **Curve:** `neglect_mult = (days_neglected / 7)^2` — **unbounded by design.**
- **Applied:** as a multiplier on the final weighted score; because it grows without limit, a perpetually out-ranked task will eventually climb high enough to force a decision. **Capping would reintroduce the exact failure mode the mechanism prevents.**
- **Resets:** on completion, or on a coaching intervention that dispositions the task. For **`unscheduled`**-recurrence tasks, completion resets the neglect clock but **does not close** the task (§4.2). For **`count`** tasks, the neglect clock is fine to reset on each incremental completion while the task stays open until `target`.
- **Long-absence flatness** is handled by the **5-day re-orientation coaching** (§7.2), not by capping the math.

### 5.3 Session-planning algorithm
1. **Deep-focus allocation** — reserve end-of-session time for 1–2 major tasks when long enough; **25% overrun buffer**.
2. **Context-aware grouping** — group by context; within a group, weighted-shuffle toward a difficulty gradient.
3. **Progressive arrangement** — order context groups as an energy ramp toward deep focus.
4. **Break / self-care** — natural breaks at context switches; no breaks inside a deep-focus block.
5. **On-demand fallback (escape valve)** — regenerate with lower energy, shorter estimates, easier contexts. Surfaced in the task UI (§6.2). *(Its inverse — "extend" for hyperfocus — is the §8.7 open item.)*

### 5.4 Numeric learning
Six retained loops (factor-weight, time-estimation, energy-pattern, context-effectiveness, break/self-care, learning parameters). Provisions for a **single-user** regime:

- **Sparsity / cold-start via hierarchical shrinkage.** Start each cell from a global prior; specialize only once a cell has its own data; otherwise fall back to the parent level.
- **Model-guessed durations start cold.** A `duration_source = 'model_guess'` estimate has **zero real observations**; replace it off the *first* actual completion rather than waiting for the specialized-weight bar. A `'user'` estimate is trusted more but still refined.
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
- **Timer** (dominant, large)
- **Pause** (interruptions)
- **Exit** (small)
- **Escape valve** (small, always available) — "give me something easier"; regenerates an easier agenda (§5.3.5).
- **Extend** — *proposed, §8.7 open item* — the escape valve's inverse: keep going past the planned length when hyperfocus hits, rather than a hard stop at the estimate.

**Between tasks:** quick rating, energy check, optional break, optional "read notes," then "start task."

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

### 7.2 Coaching conversations — three distinct triggers

| Trigger | Timing | Purpose |
|--------|--------|---------|
| **Any single skip** | Queued for **next start** | Non-blocking follow-up. The skip is the seam; momentum preserved. Optional one-word reason chip. |
| **3 skips within one session** | **Immediate**, at the third skip | The app has misjudged current capacity. Stop serving tasks; talk about how the user feels and what they can take on **right now**; re-check energy/mood, re-match the queue. Not about any single task. |
| **App unopened 5+ days** | At **next open**, before dashboard | Re-orientation: priorities may have shifted; review stale tasks, reshuffle, refresh preferences. |

Notes: the 3-skip conversation is an escape-valve *cousin* (the app inferring "wrong tasks" from behavior rather than being told). All three map onto `coaching_queue` with distinct trigger rows and an `urgency` tier.

**Coaching goals:** understand the barrier (or recalibrate capacity/priorities), then a concrete disposition — modify / break down / eliminate / defer — via tool call (§3.4).

**Tone principles:** curiosity not judgment; validate the experience; frame as *system* improvement; end with a concrete next step.

### 7.3 Coaching Safety & Boundaries
- **Supportive, not clinical** — helps with tasks and motivation; not therapy, no diagnosis; not a substitute for professional support.
- **No reinforcement of negative self-talk** — "failure" reframed as data; never scold, rank, or stack guilt.
- **Crisis-sensitivity** — serious distress is met with care and a pointer to appropriate human/professional support via a short, reviewed path, not the small model's improvisation.

---

## 8. Edge Cases

### 8.1 Task selection
**No available tasks — dependency issues.** Causes: out-of-context, external blockers, missing/removed/circular dependencies. **Universal response: a coaching session** tailored to the cause. *Preventive:* add dependencies at creation, dependency-impact check before deletion, batch-remove chains.

**Energy mismatch.** Offer a break; suggest eating near a meal; hydration/movement; re-check energy; exit gracefully if still low. (3 skips here independently trigger §7.2 recalibration.)

**Context mismatch.** Context change, context-flexible variant, on-the-spot task, or deferral.

### 8.2 Work-session
**Timers are timestamp-based.** Store end-time; compute remaining from wall clock. On crash, timer keeps running against stored end-time; on relaunch, open to the right screen. (Multi-session accumulation and "extend" are the §8.7 open item.)

**Pausing / backgrounding.** Normal, not abandonment. Track pause time; **>20% paused** queues coaching.

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

### 8.7 OPEN DESIGN ITEM — multi-session work & hyperfocus extension
*Not yet settled. Flagged for a design pass (cross-cutting, easy to get subtly wrong) per the build-allocation doc — Opus/Fable design work, not a one-line fix.*

For tasks in the "long/uncertain" zone (roughly ≥1 hr, where precise estimation stops being meaningful for ADHD), the app needs two capabilities the current model doesn't cleanly support:

- **Work across multiple sessions.** A task can be worked, **paused (not skipped/abandoned)**, and resumed later without reading as incomplete or a failure. `actual_duration_history` must accumulate **cumulative** time toward a *single* completion, not log several separate short tasks.
- **Extend mid-session (hyperfocus).** When a session is going well, continue past the planned length rather than a hard stop — an **"extend"** affordance, the inverse of the escape valve.

**Proposed direction (for review, not settled):**
- An **open-ended duration mode** so overruns aren't estimation errors and pauses aren't failures (relates to `duration_source` and the "at least an hour" floor-not-ceiling problem).
- A carried-forward **in-progress state** distinct from completed/skipped, so cumulative time rolls up correctly.
- Surface **Extend** alongside the escape valve (§6.2).
- Resolve interactions with session planning (a partially-done open-ended task re-entering the plan) and with `count`-type tasks.

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
2. **Escape valves everywhere** — always a graceful way out (and, pending §8.7, a way to *keep going*).
3. **Coaching over forcing** — understand and adapt; never pressure or shame.
4. **Privacy-first** — local by default; cloud only opt-in and disclosed; learning is fully local.
5. **Everything surfaces eventually** — the uncapped neglect factor guarantees no task hides forever.
6. **Coarse at the surface, fine underneath** — two-level importance/energy scales.
7. **Determinism where it counts** — constrained output and tool-based actions.
8. **Invisible learning** — the app quietly gets better; skills are never shown.
9. **Honest about the hardware** — architecture tracks what actually runs on real devices, not vendor benchmarks.

---

## 11. Development Priorities

**Open roadmap decision (drives Phase 1 shape):** **ship 4B-first now** on the stock toolchain, or **invest in the PrismML fork build (Stage B)** to unlock real 8B/Q2_0 + Vulkan GPU before shipping? The spike makes 4B-first the low-risk path; Stage B is the way to genuine 8B-first but is a native-build commitment against a moving fork.

**Phase 1 (MVP)**
- Core task management + conversational input (grammar-constrained extraction, chat-template correct).
- Simple scoring with the uncapped neglect factor; the five recurrence types.
- Basic session planning + escape valve.
- Ternary Bonsai 4B via stock `llama.rn`, thermal-aware loop; tiering ladder scaffolded (rungs added as quants land).
- The three coaching triggers.

**Phase 2 (Learning)**
- Numeric learning loops (§5.4) with hierarchical shrinkage, regression protection, model-guess cold-start.
- The local skill-injection layer (§5.5).
- Full context-grouped planning; tool-call resolution actions.
- **Resolve §8.7** (multi-session / hyperfocus) — design pass then build.

**Phase 3 (Polish)**
- UI/UX refinement, performance/thermal tuning; Stage-B fork build for 8B/GPU if pursued; iOS parity.
- **Calendar sync** (§7.1) to close the scheduled-vs-happened loop.

**Out of scope (possible future).** Cloud slow-loop (weight adaptation) behind the §6.4 boundary and a fine-tune-friendly model, not Ternary Bonsai. Accountability/community, gamification, richer analytics — gated on the privacy model.
