# Task 18 Design — Local Skill-Injection Learning Layer (spec §5.5)

**Status:** design deliverable, ready for Opus to implement as task 19.
**Authority:** spec §5.5 (the layer), §3.5 (idle/thermal windows), §5.4 (conservatism to mirror), §8.5 (stale data / long absence), task 18 brief (`docs/briefs/skill_layer_task_18.md`).
**Builds on (does not redesign):** schema v2.2 `skills` / `skill_conditions` / `skill_evidence` / `fireable_skills`, the `assembleCoachingPrompt` seam ([assemble.ts](../../src/llm/prompts/assemble.ts)), the grammar discipline (no underscores in rule names — Q1c; startup guard — task 6; slot substitution — `buildGrammar`).

---

## 0. TL;DR — the shape of the design

A **skill** is a conditional behavioral rule: *"when the situation looks like X, coach differently in way Y."* Conditions are a flat AND of key/op/value predicates over a small closed vocabulary; the instruction is one bounded sentence. Skills are born **inactive at confidence 0** from idle-window distillation, and **cannot fire until the same pattern has been independently re-derived from later, non-overlapping evidence on at least two distinct days**. Confidence is a **deterministic, recomputable function of the evidence table** (a time-decayed, contradiction-penalized ratio), not a mutable accumulator — so decay, rollback, and long-absence staleness all fall out of one formula. Distillation is a **code-first pipeline**: deterministic friction grouping and digest rendering, with the 4B making exactly one small, grammar-constrained, abstain-allowed judgment per call. Injection is capped at 1–3 skills, rendered through the existing seam.

The three compounding risks the brief names, and where each is killed:

| Risk | Killed by |
|---|---|
| Matching blowup | Flat AND semantics + closed key vocabulary + tiny library caps (§1.3, §5.4) |
| 4B can't produce/apply skills | One-candidate-per-call distillation with a `null` branch, slot-enumerated condition values, ≤120-char instructions, ≤3 injected (§2, §4) |
| Bad-day skill hardens | Born inactive at conf 0; activation requires re-derivation across windows on ≥2 distinct days; contradictions weighted 2×; freshly-activated skills die on one contradiction (§3) |

---

## 1. Skill semantics & matching

### 1.1 What a skill *is*

Beyond the `skills` row, a skill is a **conditional prediction with an attached behavioral instruction**:

> *In situations satisfying ALL of my conditions, the coach behaves per my instruction, and doing so co-occurs with better observable outcomes (completions instead of re-skips, sessions that finish instead of collapsing).*

Both halves matter. The conditions define **when it fires**; the prediction defines **how it is scored** (corroboration = the prediction held; contradiction = it didn't — §3.1). The instruction is a single imperative sentence ≤120 chars, phrased "When/If X, do Y" (e.g. `When energy is low in the evening, offer the 10-minute version of the task instead of deferring it.`). It is written by the distiller, frozen once the skill activates (§4.6), and injected verbatim as a bullet through the seam.

### 1.2 The situation snapshot

All matching is against a `SituationSnapshot` built **by code** at each coaching/planning entry point — the model never evaluates conditions:

```typescript
interface SituationSnapshot {
  trigger: CoachingTrigger | 'planning';   // coaching_queue trigger type, or 'planning' at session-plan time
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night' | undefined;  // LOCAL time: 05–12 / 12–17 / 17–22 / 22–05
  energyLevel: 1 | 2 | 3 | 4 | 5 | undefined;   // latest check-in this session; undefined if none yet
  contextTags: string[];                    // effective context: session context ∪ focal task's tags
  taskType: 'recurring' | 'one_time' | 'count' | 'long_uncertain' | undefined;  // focal task, if any
}
```

- `timeOfDay` buckets deliberately replace clock arithmetic — no gte/lte over times, no midnight wraparound, and the 4B only ever has to name a bucket.
- `taskType` is derived by code: recurrence set → `recurring`; count-type → `count`; est. duration ≥ 60 min or open-ended (§8.7) → `long_uncertain`; else `one_time`.
- **The snapshot is persisted** into `interactions.learning_data` as `{"snapshot": {...}}` at interaction write (see §6.1). This is the single source of situational truth for the distiller and the attribution pass — critically, it captures **local** time-of-day at the moment it happened, so nothing downstream ever re-derives buckets from the UTC `interactions.timestamp`.

### 1.3 Condition semantics — flat AND, no blowup

The combinatorial risk here is **expressiveness** creep (nested boolean trees, free-text predicates), not evaluation cost — the library is capped small (§5.4) and evaluation is N×K cheap predicate checks. So the semantics are deliberately flat:

> **All `skill_conditions` rows of a skill are AND-ed. There is no OR between rows.** Disjunction is expressed only (a) within a single row via the `in` op (condition_value = JSON array string), or (b) as two separate skills.

Closed key vocabulary v1 (exactly the schema's examples — anything else fails validation):

| `condition_key` | Snapshot field | `eq` | `neq` | `in` | `gte` / `lte` |
|---|---|---|---|---|---|
| `context_tag` | `contextTags` (a set) | value ∈ set | value ∉ set | any listed value ∈ set | — |
| `time_of_day` | `timeOfDay` | = | ≠ | membership | — (buckets are unordered) |
| `energy_level` | `energyLevel` | = | ≠ | membership | numeric compare |
| `task_type` | `taskType` | = | ≠ | membership | — |
| `trigger` | `trigger` | = | ≠ | membership | — |

**Unknown fails.** If the snapshot field a condition needs is `undefined` (no energy check-in yet, no focal task), the condition is **not satisfied** and the skill does not match — uniformly, for every op including `neq`. A skill only fires when its preconditions are affirmatively true. This is the conservative choice and it is load-bearing: it prevents context-free firing early in a session before check-ins exist.

The distiller only ever emits `eq`/`neq`/`gte`/`lte` (§4.5); `in` is supported by the matcher for hand-seeded or future skills but never produced by the 4B — one less thing for it to format.

### 1.4 Matching + ranking algorithm

```
retrieveSkills(snapshot, scope: 'coaching'|'planning', maxN):
  skills ← skillsRepo.fireable()                       // is_active = TRUE only
           filtered to skill.scope ∈ { scope, 'both' }
  matched ← []
  for skill in skills:
    conds ← skillsRepo.listConditions(skill.id)        // NOT the view's GROUP_CONCAT column — it's lossy
    if every cond satisfied by snapshot (table §1.3):
      matched.push({ skill, conds })

  // Subsumption filter (the main conflict class — general rule vs. situational exception):
  // canonicalize each condition set as sorted "key|op|value" strings; if A's set is a strict
  // subset of B's and both matched, DROP A. The more specific skill knows this situation better.
  matched ← dropStrictSubsets(matched)

  // Score: confidence, nudged toward specificity. Bounded (nConds ≤ 3), monotone in both.
  score(s) = s.skill.confidence × (1 + 0.1 × (s.conds.length − 1))

  return top maxN by score desc, tiebreak last_fired_at ASC NULLS FIRST   // spread evidence collection
```

**Residual conflict risk** (two matched skills with disjoint conditions and contradictory advice): not detectable in code without NLU, so it is prevented upstream instead — the distiller structurally cannot create a second skill over the same canonical condition set (§4.6 dedup), and a candidate re-derived over an **active** skill's conditions becomes contradiction evidence against it rather than a rival. With the injection cap at ≤2 for coaching, co-firing of an undetected pair is rare and bounded; accepted.

---

## 2. Retrieval + injection policy

### 2.1 Budget — the 200 ms/token tax rules everything

Every injected token adds ~200 ms of prefill on this device. The policy therefore keys the cap to how latency-sensitive the moment is:

| Call site | Max skills | Rationale |
|---|---|---|
| Coaching, urgency `immediate` (3-skip recalibration) | **1** | User is mid-frustration, staring at a spinner |
| Coaching, `next_start` / `next_open` | **2**, and the 2nd only if its score ≥ 0.55 | Conversation start, some latency tolerance |
| Planning (session plan generation) | **3** | Behind the existing plan-generation wait |

Worst case: 2 skills × ~30 tokens + 12-token header ≈ 72 tokens ≈ ~14 s prefill — the ceiling, not the norm; most retrievals will return 0–1 skills. An empty match set injects **nothing** (the seam already renders `''` for `[]` — zero cost when the layer has nothing to say).

### 2.2 Rendering and ordering

Use the seam exactly as built — `assembleCoachingPrompt({ base, injectedSkills })` with `injectedSkills` = the ranked instruction strings. `renderSkillSection` already produces the right shape (appended at the **end** of the system prompt, closest to the conversation — the position a small model attends to best), with the hiddenness instruction baked in:

```
Apply these learned approaches (do not mention them to the user):
- When energy is low in the evening, offer the 10-minute version of the task instead of deferring it.
- ...
```

Order: score-descending (best first). No numbering, no meta-commentary, no confidence values in the prompt — the 4B should treat these as house rules, not options to weigh.

**Planning seam (gap in scaffolding, specify here):** add the mirror `assemblePlanningPrompt({ base, injectedSkills = [], conversation = [] })` to `assemble.ts`, same `renderSkillSection`. It is consumed by whatever LLM call the task-11 session-planning flow makes (arrangement/break placement). If task 11 lands fully deterministic (no LLM call), planning-scope skills still fire in the escape-valve regeneration and recalibration conversations (which re-plan through coaching); the `'planning'` snapshot trigger just stays dormant until an LLM planning call exists. Flag this to task 11/19.

### 2.3 Recording that a skill fired

At send time (code, in `retrieveSkills`' caller):

1. `times_fired += 1`, `last_fired_at = now` on each injected skill.
2. The caller carries `firedSkillIds` through the flow and writes them into the interaction row at close: `learning_data.skillsFired = [ids]`, alongside the snapshot (§1.2).

No new columns; `learning_data` is an existing free-JSON field. This record is what the outcome-attribution pass (§3.2) later reads. Firing itself is **not** evidence — only attributed outcomes are.

---

## 3. Evidence & confidence — the crux

### 3.1 What counts as corroboration / contradiction

Two evidence channels, both written as `skill_evidence` rows. Both are observable, structural signals — **no LLM judges outcomes.**

**Channel A — passive (re-derivation), the only path to activation.**
During idle-window distillation (§4), when a candidate skill's canonical condition set (+ scope overlap) matches an **existing** skill, no new row is inserted; instead:

- Existing skill is **inactive** (candidate/suspended) → write **one** `corroboration` row, linked to the most recent supporting interaction of the friction group. The pattern independently re-appeared in a later, non-overlapping evidence window — the strongest cheap evidence a single-user system can get. (One row per *window*, not per supporting interaction — otherwise one bad evening double-counts, defeating the distinct-day floor in §3.4.)
- Existing skill is **active** → the friction *persisted despite the remedy*. Check `learning_data.skillsFired` across the group's interactions: if the skill actually fired during ≥1 of those incidents, write **one `contradiction` row** (the remedy was applied and the friction recurred). If it never fired (crowded out by the injection cap, or conditions matched but retrieval didn't pick it), write a **corroboration** — the pattern is still real; the remedy is simply untested here.

**Channel B — active (fired-outcome), what sustains a working skill.**
The attribution pass (idle window, pure code) walks interactions since its watermark that carry `skillsFired`, and resolves each against later data:

- *Coaching-scope firing about focal task T:* T's **next attempt within 14 days** completed → `corroboration`; T re-skipped or abandoned → `contradiction`; no attempt in the window → **no row** (neutral — absence of data is not evidence).
- *Planning-scope firing for session S:* S ends with completion ratio ≥ 0.6 of served tasks and no `session_recalibration` trigger → `corroboration`; recalibration fired during S, or S `ended_early` with ratio < 0.4 → `contradiction`; otherwise neutral.
- All skills fired in the same interaction receive the same evidence row (attribution smearing is accepted — the injection cap of ≤2 bounds it, and small evidence weights absorb the noise; this is the §5.4 "small increments" discipline in behavioral form).

Channel B is why a *successful* skill doesn't starve: once a skill works, the friction that birthed it stops recurring (so Channel A dries up), but the skill keeps firing and its tasks keep completing — Channel B keeps refreshing its evidence. Without this, the layer would oscillate: skill works → friction gone → skill decays → friction returns.

Each evidence row's **effective timestamp** is the linked interaction's snapshot time when present, else the row's `created_at`.

### 3.2 The confidence function

**Confidence is not a mutable accumulator. It is a cache of a deterministic function of the evidence table**, recomputed at every evidence write and every idle window:

```
w(e)   = 0.5 ^ (ageDays(e) / 45)          // exponential decay, 45-day half-life
Ceff   = Σ w(e)  over corroboration rows
Xeff   = Σ w(e)  over contradiction rows   // origin rows contribute nothing — birth is not evidence

confidence = Ceff / (Ceff + 2·Xeff + 3)
```

Three constants, each doing one job:

- **Prior pseudo-count `K = 3`** — the pessimistic prior. Zero evidence → confidence 0 (matches the schema default). Confidence approaches 1 only asymptotically under sustained corroboration.
- **Contradiction weight `2`** — asymmetry: trust is lost twice as fast as it is gained. Mirrors §5.4's regression-protection stance; there is no separate rollback mechanism because the formula *is* the rollback — contradictions immediately and disproportionately drag the score down.
- **Half-life `45 days`** — the fade-out for skills that stop predicting, and the §8.5 stale-learning-data answer. Both C and X decay, so a skill with old contradictions and fresh corroborations can genuinely recover.

All three go in `learning_state` (§7) as tunables, not code literals.

### 3.3 Reference points (worked)

| Evidence (undecayed) | confidence | State |
|---|---|---|
| birth (origin only) | 0.00 | candidate — cannot fire |
| C=1 | 0.25 | candidate |
| **C=2 (≥2 distinct days)** | **0.40** | **activates** |
| C=3 | 0.50 | active |
| C=4 | 0.57 | active |
| C=2, X=1 | 0.29 | **freshly-activated skill dies on its first contradiction** |
| C=4, X=1 | 0.44 | active — an established skill survives one bad outcome |
| C=4, X=3 | 0.31 | suspended |
| C=6, X=4 | 0.35 | suspension boundary — even a strong skill yields to sustained contradiction |
| C=3, no new evidence, +45 days | 0.33 | suspended by decay alone |
| C=3, no new evidence, ~+135 days | ≈0.11 | prunable |

### 3.4 Thresholds & the corroboration floor

```
θ_activate  = 0.40   AND corroboration rows spanning ≥ 2 distinct LOCAL calendar days
θ_suspend   = 0.35   (hysteresis band vs. 0.40 — no flapping at the boundary)
θ_prune     = 0.15   AND skill age > 30 days AND no evidence in last 30 days  → DELETE row (evidence cascades)
```

The floor, stated as the guarantee the spec demands: **a newly distilled skill has confidence 0 and cannot fire, ever, until its pattern has been re-derived from at least two later, non-overlapping evidence windows whose supporting incidents span at least two distinct days.** A skill born of one bad evening — or two bad days whose incidents all land in one window — stays inert. If the pattern was a fluke, nothing re-derives it; it sits at 0 and is pruned after 30+ days. Total incidents before any behavior change: ≥3 (origin group's ≥2, plus ≥1 per re-derivation window) — the behavioral analog of §5.4's "≥10–15 points before trusting a specialized signal," scaled to the sparser event rate.

---

## 4. Distillation — the evolver

### 4.1 Division of labor (the 4B-smallness rule)

Everything that *can* be code, *is* code. The 4B makes exactly one kind of judgment per call — "do these observations justify one rule, and if so which?" — under a grammar with an abstain branch. It never batches, never dedups, never judges outcomes, never evaluates conditions, never sees another skill's confidence.

### 4.2 Friction grouping (deterministic, code)

Inputs since `distillation_watermark` (plus a 30-day lookback for support), all structural: `interactions` (status, rating, `conversation_summary` key points, snapshot from `learning_data`), `coaching_queue` rows, `tasks.skip_reasons`, `interaction_tasks` joins.

- **Friction incident** := interaction with `completion_status ∈ {skipped, ended_early, abandoned}`, or `user_feedback_rating ≤ 2`, or a coaching_queue trigger row (incl. R4 buried-task once it lands).
- **Group keys**, in precedence order: same `task_id`; then (`trigger_type` × `time_of_day`); then (`trigger_type` × `context_tag`). An incident joins the first key it matches with ≥2 members.
- **Qualifying group**: ≥2 incidents total, ≥1 since the watermark.
- Rank groups by (incidents-since-watermark, total incidents, recency); take **top 3 max** per window.

### 4.3 Digest rendering (deterministic, code)

Per group, ≤ ~400 tokens, entirely from structured fields — raw transcripts don't exist (spec §4.4) and the summaries' key points are already grammar-bounded at ≤120 chars:

```
OBSERVATIONS — task "File quarterly taxes" (one_time, est. 90 min), 3 incidents:
- 2026-07-02 evening, energy 2, context [home]: skipped — "too tired to start it"
- 2026-07-06 evening, energy 2, context [home]: skipped — "wanted to but couldn't begin"
- 2026-07-09 morning, energy 4, context [home]: completed in 70 min
EXISTING RULES — output null if your rule would repeat one of these:
- When energy is low in the evening, offer the 10-minute version of the task instead of deferring it.
```

Time/energy/context come from the stored snapshot (never re-derived from UTC timestamps). "EXISTING RULES" lists active + candidate skills sharing ≥1 condition key-value with the group's attributes (bounded at 5).

### 4.4 The distillation prompt

System prompt (one per call, ~180 tokens):

```
You review a task-coaching app's private notes and decide whether ONE dependable
rule about this user is justified.

A rule tells the coach what to do differently in a specific situation. Example:
"When energy is low in the evening, offer the 10-minute version of the task
instead of deferring it."

Requirements:
- The rule must be supported by at least two separate incidents in OBSERVATIONS.
- It must name the specific situation (context, time of day, energy, or task kind).
  General advice that applies to everyone is not a rule.
- The instruction is ONE short sentence telling the coach what to DO, shaped
  "When <situation>, <action>."
- Do not use the words "always" or "never".
- If the observations are mixed, unclear, or already covered by EXISTING RULES,
  output null. Null is the common, correct answer — most observations do not
  justify a rule.
```

User message: the digest (§4.3). Output: grammar-constrained (§4.5), `maxTokens ≈ 120`, temperature 0. One candidate per call; ~1–2 min at ~5 tok/s dominated by prefill — bounded and window-friendly.

### 4.5 Output grammar — `skill_distill.v1.gbnf`

Obeys every device-proven constraint: **no underscores in rule names** (JSON keys keep theirs — Q1c: keys are string literals, untouched), proven `{m,n}` bounds, slot substitution via `buildGrammar`, registered in `buildGrammarRegistry` so the task-6 startup guard validates it (with dummy slot values, like extraction), auto-covered by the `ruleNaming` lint.

```gbnf
# skill_distill.v1.gbnf — distillation output: exactly one candidate skill, or null (abstain).
# RULE-NAME CONSTRAINT (Q1c): no `_` in any rule name below. JSON keys keep underscores.
# Slot: {{context_tags_known}} — condition values for context_tag are ENUMERATED from tags
# actually present in the evidence group, so the model structurally cannot invent a context.

root ::= "{\"candidate\":" candidate "}"
candidate ::= "null" | skillObj

# 1–3 conditions; the FIRST is forced situational (context/time/energy/task-kind) — a skill
# with zero conditions, or gated only on `trigger`, is an "always" rule and is grammatically
# impossible to emit.
skillObj ::= "{\"scope\":" scopeVal ",\"conditions\":[" situCond ("," anyCond){0,2} "],\"instruction\":\"" instrText "\"}"

scopeVal ::= "\"coaching\"" | "\"planning\"" | "\"both\""

situCond ::= ctxCond | todCond | energyCond | taskKindCond
anyCond  ::= situCond | trigCond

ctxCond      ::= "{\"key\":\"context_tag\",\"op\":" eqNeq ",\"value\":\"" {{context_tags_known}} "\"}"
todCond      ::= "{\"key\":\"time_of_day\",\"op\":" eqNeq ",\"value\":" todVal "}"
energyCond   ::= "{\"key\":\"energy_level\",\"op\":" numOp ",\"value\":\"" [1-5] "\"}"
taskKindCond ::= "{\"key\":\"task_type\",\"op\":" eqNeq ",\"value\":" taskKindVal "}"
trigCond     ::= "{\"key\":\"trigger\",\"op\":\"eq\",\"value\":" trigVal "}"

eqNeq ::= "\"eq\"" | "\"neq\""
numOp ::= "\"eq\"" | "\"lte\"" | "\"gte\""

todVal      ::= "\"morning\"" | "\"afternoon\"" | "\"evening\"" | "\"night\""
taskKindVal ::= "\"recurring\"" | "\"one_time\"" | "\"count\"" | "\"long_uncertain\""
trigVal ::= "\"task_skipped\"" | "\"session_recalibration\"" | "\"app_reorientation\"" | "\"session_ended_early\"" | "\"task_ended_early\"" | "\"repeated_failures\"" | "\"pattern_detected\""

instrText ::= jchar{12,120}
jchar ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
```

(`trigVal` must gain the R4 buried-task type when task 10's migration lands — cross-task flag, §7.)

Zod validator on top (D10 retry ladder applies as usual):
- key vocabulary/ops exactly as in the grammar (belt over suspenders);
- **at most one condition per key**, except `context_tag` (≤2, and only if ops differ or values differ);
- instruction must not contain `always` / `never` (case-insensitive) and must not start with a quote or dash;
- `energy_level` value parses to 1–5.

### 4.6 Insertion, dedup, and sharpening

Per validated candidate, in code:

1. **Canonicalize** the condition set: sorted `key|op|value` strings.
2. **Dedup against every existing skill** (active or not) with overlapping scope: identical canonical set → **do not insert**; apply the Channel-A evidence rule (§3.1). While the existing skill is still inactive, additionally **overwrite its instruction** with the new candidate's (the later derivation saw more incidents — last-writer-wins is the v1 "sharpening" of wording). Once active, the instruction is frozen.
3. Otherwise **insert**: `is_active = FALSE` (explicitly — never rely on the schema default, which is TRUE; §7), `confidence = 0`, `scope` from output, `schema_version = 'skill.v1'`; conditions into `skill_conditions`; one `origin` evidence row per supporting incident interaction.
4. **Birth cap:** ≤2 new skills per window; library caps enforced afterward (§5.4).

**Condition sharpening (refine pass)** — a skill with genuinely mixed evidence (`Ceff ≥ 3` and `Xeff ≥ 3` undecayed-count equivalent) is queued for one **narrow-or-retire** call in a later window, priority below new derivation:

```
This rule has worked in some situations and failed in others.
RULE: "<instruction>"   CONDITIONS: <rendered>
WORKED (3): <one line per corroborating incident — snapshot fields only>
FAILED (3): <one line per contradicting incident>
Choose: keep the rule as is; narrow it by ONE added condition that separates
WORKED from FAILED; or retire it if it looks simply wrong.
```

Grammar `skill_refine.v1.gbnf` (same primitives, same registration):

```gbnf
root ::= "{\"verdict\":" verdict "}"
verdict ::= "\"keep\"" | "\"retire\"" | "{\"narrow\":" anyCond "}"
# anyCond and its dependencies: identical rules to skill_distill.v1
```

Code applies the verdict: `retire` → `is_active = FALSE` and skip future refine queuing (it will decay to pruning); `narrow` → append the condition (validator: key not already present) and **zero out contradiction weighting going forward** by re-anchoring — concretely, write a `learning_state` note `refined_at` on the skill and have recompute ignore contradiction rows older than it (the old contradictions were the un-narrowed rule's fault). `keep` → nothing; refine won't re-queue for 30 days.

### 4.7 Garbage guards, summarized

- Over-generality: first condition grammatically forced situational; `always`/`never` lint; ≥2-incident support demanded in-prompt and structurally true of every group fed in.
- Hallucinated conditions: `context_tag` values slot-enumerated from the group's actual tags; every other value a closed enum.
- Spam: abstain branch is first-class and prompted as the common case; ≤3 groups/window; ≤2 births/window; dedup collapses repeats into evidence instead of rows.
- Bad instructions: length 12–120 grammar-bounded; even a garbage instruction that survives validation is born inert and dies unfired unless reality re-derives it twice.

---

## 5. Lifecycle & scheduling

### 5.1 State machine

```
                    distiller emits candidate
                              │
                              ▼
      ┌──────────── CANDIDATE (is_active=FALSE, conf 0) ────────────┐
      │   re-derivation corroborations (Channel A only)             │
      │        conf ≥ 0.40  AND  ≥2 distinct days                   │  conf < 0.15
      ▼                                                             │  + age > 30d
   ACTIVE (is_active=TRUE) — fires, gathers Channel B evidence      │  + 30d quiet
      │            ▲                                                ▼
      │ conf<0.35  │ conf ≥ 0.40 again (re-derivation or            PRUNED
      ▼            │ recovered outcomes)                            (DELETE; evidence
   SUSPENDED (is_active=FALSE, evidence retained) ──────────────►   cascades)
```

`is_active` is exactly the fire/don't-fire bit, flipped only by these threshold crossings; the richer state is derivable from (`is_active`, `confidence`, evidence). Pruned skills are deleted outright — if the pattern is real it will be re-derived from scratch, which is the desired cold restart for stale patterns.

### 5.2 The learning window

Piggybacks on the §3.5 idle/cool machinery shared with summary consolidation. **Open** when all hold: model already resident (run right after a session's summary work, avoiding a load cycle) or otherwise loaded for idle work; `currentThermalHeadroom() === 'ok'`; app idle (dashboard, no interaction in flight); battery > 30% or charging. **Abort** the window (finish or cancel the in-flight call, advance no further) the moment headroom leaves `'ok'` or the user interacts.

Work order inside a window:

1. **Code-only passes — always run, even when no LLM budget exists** (they're milliseconds): outcome attribution (§3.1-B) from `attribution_watermark`; confidence recompute + threshold transitions for every skill; pruning + cap enforcement.
2. Summary consolidation (other owner) takes precedence for LLM budget — skills read summaries, so it feeds this layer.
3. Distillation calls (§4.2–4.6), ≤3 groups.
4. At most one refine call (§4.6).

Budget: ≤3 constrained calls or 5 min wall-clock, whichever first. Watermarks (`attribution_watermark`, `distillation_watermark` in `learning_state`) advance **per completed unit** — a group whose call was aborted is left before the watermark and re-runs next window.

### 5.3 Long absence (§8.5)

Nothing special is needed, by construction: at the 5-day re-orientation, run pass 1 (code-only recompute) **before** retrieval for the re-orientation coaching itself. The 45-day half-life has already devalued everything stale; skills below θ_suspend stop firing on their own. This *is* the "skill confidence decays" line of §8.5.

### 5.4 Caps

- **35 active skills** max (over-cap: suspend lowest-confidence),
- **100 rows** total (over-cap: prune lowest-confidence inactive),
- ≤2 births/window, ≤3 distillation + 1 refine calls/window.

Caps keep retrieval trivially cheap, the library auditable, and the injection competition honest.

---

## 6. Wiring contract for task 19

New module `src/learning/skills/` with four entry points:

1. **`buildSituationSnapshot(...)`** — called by every coaching entry (task 12 flows) and the planning flow; result goes both to retrieval and into `interactions.learning_data.snapshot` at interaction write. `learning_data` shape: `{ "snapshot": SituationSnapshot, "skillsFired": number[] }` — document in `domain.ts`.
2. **`retrieveSkillsFor(snapshot, scope, urgency)`** → `{ instructions: string[], firedSkillIds: number[] }` (§1.4 + §2.1 caps). Caller passes `instructions` to `assembleCoachingPrompt` / `assemblePlanningPrompt`, bumps `times_fired`/`last_fired_at`, and carries `firedSkillIds` to the interaction write.
3. **`runLearningWindow(deps)`** — §5.2, invoked by the shared idle scheduler; owns passes 1/3/4.
4. **`recomputeConfidence(skillId | all)`** — §3.2; also invoked on every evidence write and at re-orientation.

Plus: `assemblePlanningPrompt` added to `assemble.ts` (§2.2); the two `.gbnf` files + zod validators + registry entries (§4.5, §4.6); `learning_state` migration (§7). Everything testable headless with `MockLLMProvider`; the grammars need one Phase-B device pass (fire both on-device, fresh-context discipline, before trusting them — same bar every other grammar met).

## 7. Schema gaps & cross-task flags

1. **`skills.is_active DEFAULT TRUE` contradicts born-inactive.** Resolution: the layer always sets it explicitly on insert; **recommend** a migration flipping the default to FALSE as defense-in-depth (nothing else inserts skills today, so it's cheap now).
2. **No home for watermarks/tunables** → new table `learning_state (key TEXT PRIMARY KEY, value TEXT)`: `attribution_watermark`, `distillation_watermark`, the §3.2 constants, per-skill `refined_at` notes. Genuine schema addition — flag to the data layer.
3. **`skill_evidence` can't distinguish Channel A from Channel B.** Not needed by the math (both weigh 1.0) but valuable for audit/debug; recommend nullable `source TEXT CHECK (source IN ('distiller','outcome'))`. Optional, non-breaking.
4. **`fireable_skills` view** is lossy (GROUP_CONCAT ambiguity, already documented in `domain.ts`) and lacks scope filtering — usable only as the active-skill index; conditions must come from `listConditions()`. No schema change (constraint: don't alter the view); implementation guidance only.
5. **`coaching_queue` CHECK constraint lacks R4's buried-task trigger type** (task 10). When that migration lands: extend the `trigVal` alternation in `skill_distill.v1.gbnf`, the `CoachingTrigger` snapshot type, and the friction-incident definition. Until then the layer simply never sees that trigger.
6. **`interactions.learning_data`** carries `snapshot` + `skillsFired` as documented JSON — no column changes, but the shape must be versioned alongside `summary_schema_version` discipline (a `"v":1` field inside the JSON suffices).
7. **Export note (§8.5):** skill instructions are model-written from structured digests, but digests include summary key points that may embed personal phrasing; the export path should treat `skills.instruction` like other summary-derived text (include, but under the same redaction pass).

## 8. Deliberate 4B simplifications (and what was consciously cut)

- **One candidate per distillation call, abstain-first** — no batch emission; the model never formats an array of skills.
- **Closed condition vocabulary, slot-enumerated context values, no free-text predicates, no `in` in output, no clock arithmetic** — the model names buckets and enum members only.
- **No LLM anywhere in matching, outcome judgment, dedup, or confidence** — all deterministic code over structured rows.
- **No semantic conflict detection** — replaced by structural prevention (dedup-to-evidence, subsumption filter, active-skill re-derivation → contradiction).
- **Instruction rewriting cut once a skill is active** — sharpening is last-writer-wins wording *pre*-activation and one-condition narrowing *post*-activation; full LLM rewrite loops are out of scope for v1 (the decay → prune → re-derive cycle achieves slow self-correction without them).
- **Attribution smearing accepted** (all fired skills share an outcome) — bounded by the ≤2 cap and absorbed by small evidence weights, mirroring §5.4's small-steps stance.

Known residual risks, accepted with eyes open: outcome attribution is correlational, not causal (mitigated by asymmetric contradiction weighting and the 14-day window); two disjoint-condition skills could still give clashing advice in one prompt (rare under the caps; harmless-worst-case is a muddled coaching turn, not data corruption); a user whose real pattern needs >3 conditions can't be captured in v1 (revisit only with evidence from the field).
