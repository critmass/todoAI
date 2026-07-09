# Structured-Output Strategy & Eval Design — Task 4 (todoAI)

**What this is:** the binding strategy for every grammar-constrained output in the app, plus the eval methodology that proves (or falsifies) the reliability bar. This is the design the spec's §3.3 defers to.
**Spec of record:** `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md` (§3.2–§3.4, §4.2–§4.4, §7.1–§7.2, §8.3). **Schema of record:** v2.2 SQL + the domain types in `src/types/domain.ts` (the `Recurrence` union is authoritative).
**Consumers:**
- **Task 5 (Sonnet)** — builds the JSON Schemas, GBNF grammars, and validators exactly as §3–§4 specify.
- **Task 7 (Opus)** — writes the system prompts within the prompt-side rules in §5.
- **Task 6 (Opus)** — the `TernaryBonsaiProvider` must support what §2/§6 assume (grammar param, greedy sampling per-call, token-budget caps, prefix reuse).
- **Jason** — runs the eval loop in §6 and supplies the inputs in §8.

**Empirical honesty up front.** The spike proved the model loads, streams, and produces good *prose* when chat-templated. It ran **4 illustrative prompts, zero grammars**. Everything below is therefore a strategy with explicit falsification points (§6.7), not a validated design. The eval exists to convert these decisions from "reasoned" to "measured" — and several decisions name the measurement that would reverse them.

---

## 0. Decisions at a glance

| # | Decision | One-line rationale |
|---|---|---|
| D1 | The user-visible **recap turn doubles as the draft** in draft-then-constrain | Gets the semantic-drift guard nearly free — the reasoning pass is also the confirmation UX |
| D2 | **JSON Schema is the single source of truth**; GBNF and runtime validators are generated/derived from it | One artifact to review; grammar, validator, and fixtures can't drift apart |
| D3 | Grammars are **maximally rigid**: fixed key order, all keys required, compact whitespace, closed enums, bounded strings/digits | Every removed degree of freedom is tokens saved and a failure mode deleted |
| D4 | The model emits **user-scale values only** (importance 1–10, energy low/med/high); code projects to internal scales | Never let a 4B do arithmetic the app can do deterministically (`scales.ts`) |
| D5 | Dates are emitted as a **relative-date union**, resolved to ISO in code | Transcription, not date math — small models fail at calendar arithmetic |
| D6 | Recurrence classification follows a **fixed decision tree with an ask-don't-guess policy**; `null` vs `unscheduled` may never be silently defaulted | Opposite completion semantics; a silent wrong guess corrupts data invisibly |
| D7 | **Grammars are generated at runtime** where the legal value set is known (task ids, context-tag vocabulary) | Deletes the fabricated-id failure class instead of validating it after the fact |
| D8 | Coaching resolutions use the **same grammar mechanism as everything else** (a union grammar), not `llama.rn` native tool-calling | One tested code path; native tool-call templates are unproven on this model |
| D9 | All constrained generations use **greedy decoding (temp 0)**; prose turns keep normal sampling | Determinism, reproducibility, and evals that mean something |
| D10 | Runtime failure ladder: **validate → one corrective retry → graceful fallback with salvage** | Matches spec §3.3.4/§8.3; never loops, never blocks the app |
| D11 | **One generation = one job.** A call produces either prose or one structured object, never both | Mixing is the classic small-model failure; the app's flow states decide which call happens |

---

## 1. The constraints that drive everything

1. **~5.2 tok/s steady-state generation, CPU-only** (S23 FE, plateaus — this is the floor to design for, not optimize away). Every output token is ~200 ms. A 150-token JSON object costs ~30 s. Output size is a first-class design budget, not a style preference.
2. **Prefill speed is unmeasured.** The spike measured generation, not prompt processing. System-prompt length, few-shot examples, and schema descriptions all cost prefill time on CPU. Until measured (§8.2), every prompt-side rule assumes prefill is expensive and budgets accordingly.
3. **Grammar-constrained decoding is untested on this stack.** `llama.rn` 0.12.5 exposes a `grammar` completion param, but nobody has run GBNF against TQ1_0 on-device. Overhead, correctness, and interplay with the chat template are all open (§6.7 Q1).
4. **Chat template is a precondition, not a variable.** All calls go through the `messages` API. A grammar cannot rescue un-templated output (README_build gotcha; spec §3.2).
5. **A grammar guarantees syntax, never semantics.** llama.cpp masks illegal tokens; it does not tell the model what the fields mean, and it can *force* a cornered model to emit something confidently wrong. The whole strategy is about closing that gap: schema description in the prompt (spec §3.3.2), a draft pass (D1), an "unknown" escape on every uncertain field (§3.4), and validation after (D10).

---

## 2. Where structured output happens (the surface inventory)

Each surface gets **its own grammar**, sized to its job. Outputs are staged small rather than monolithic — at 5 tok/s, three 40-token outputs beat one 150-token output *and* each stage conditions the next.

| Surface | When | Grammar | Size budget (output tokens) |
|---|---|---|---|
| **Task extraction** | End of an add-task conversation, after the recap | `task_extraction.gbnf` | ≤ 120 typical, 200 hard cap |
| **Task breakdown** | When the coach proposes subtasks (garage case) | `task_breakdown.gbnf` | ≤ 150 |
| **Coaching resolution** | When the coaching flow reaches disposition | `coaching_resolution.gbnf` (union) | ≤ 100 |
| **Conversation summary** | Session/conversation close, idle window | `summary_v1.gbnf` | ≤ 120 |
| **Skill records** (Phase 2) | Idle-window distillation (§5.5) | deferred to task 18 | — |

Two structural rules bind all of them:

- **D11 — one generation, one job.** Conversational turns are unconstrained prose. Structured calls are separate generations, triggered by *app flow state* (the add-task flow reached "save"; the coaching flow reached "disposition"; the session ended) — never by the model deciding mid-prose to emit JSON. This removes the hardest reliability problem (mode-switching inside one generation) by construction.
- **Breakdown is not part of extraction.** Extraction v1 has no `subtasks` field. A breakdown is its own staged call, made only when the conversation went there. Unordered sibling subtasks share an importance value (spec §4.1) — the breakdown schema encodes an *ordering flag*, not per-subtask importance.

---

## 3. The strategy decisions, with rationale

### 3.1 D1 — The recap turn is the draft (draft-then-constrain, nearly free)

The naive draft-then-constrain doubles generation cost: a free reasoning pass, then a constrained pass. At 5 tok/s that's brutal. But the task-input UX *already requires* a user-visible recap ("Done — 'Take out trash', scheduled weekly on Tuesdays" — spec §7.1), and coaching *already requires* a stated disposition before acting.

So the standard shape for every high-stakes structured call is:

1. **Recap turn** (unconstrained prose, streamed to the user, ~30–50 tokens): the model restates what it understood — task, recurrence in plain words, duration, when it's due. Streaming makes the latency *felt* as conversation, not waiting.
2. **Constrained turn** (grammar on, greedy): extraction over the full conversation *including its own recap*. The recap is in-context reasoning the constrained pass can transcribe rather than re-derive.

This is draft-then-constrain where the draft is also the confirmation UX and the primary semantic-drift guard. If the recap is wrong, the user corrects it *before* the structured call happens — a guard no grammar can provide.

- **Simple path:** recap streams, extraction runs behind it, task commits with an inline edit/undo affordance (low friction — don't make simple adds click through a confirm).
- **Complex path** (long conversation, breakdown proposed): explicit confirm on the recap before committing, per spec §7.1's extended flow.
- **Skip the recap only** for tiny app-initiated updates where the conversation already *is* one exchange (e.g. a one-word skip-reason chip). Eval Q3 (§6.7) measures what the recap is actually buying; if it buys nothing on simple tasks, drop it there and keep it for complex ones.

### 3.2 D2 — One source of truth: JSON Schema → GBNF + validator + fixtures

For each surface, task 5 authors a **JSON Schema file** (checked into `src/llm/schemas/`, versioned — `task_extraction.v1.json` etc.). From it:

- **GBNF** is generated with llama.cpp's `json_schema_to_grammar` converter, then **hand-tightened** (see D3) and checked in *next to its source schema* with a header comment naming the schema+version it was generated from. Regenerating is a build-time/dev-time step, not a runtime one — except for the D7 dynamic slots.
- **Runtime validator** (zod) is derived from the same schema (hand-mirrored is fine if a codegen dependency isn't worth it, but then a unit test must assert the zod validator accepts/rejects a shared fixture set so schema and validator can't silently drift).
- **Eval gold objects** (§6) are validated against the same schema, so fixtures can't drift either.

`summary_schema_version` and the extraction schema version ride the same convention: bump the version, keep the old adapter (spec §4.4).

### 3.3 D3 — Grammar design rules (binding for task 5)

Every degree of freedom in the grammar is either tokens the model must spend or a place it can wander. Remove all of them:

1. **Compact JSON, zero whitespace freedom.** The generated grammar's optional-whitespace rules are tightened to *none* (no spaces, no newlines). Pretty-printing at 5 tok/s is paying real seconds for nothing.
2. **Fixed key order, all keys required.** Optional keys create "did it omit or forget?" ambiguity and multiply grammar branches. Every key appears, in a fixed order, `null` where unknown. Exception: discriminated unions (recurrence, resolution actions) branch after their `"type"`/`"action"` discriminator and then contain *only* that variant's keys.
3. **Key order is conditioning order.** The model generates left-to-right, so earlier fields prime later ones. Extraction order: `title` first (grounds everything), then facts stated by the user (duration, due, tags), then *classification* fields (recurrence last among the semantics-bearing fields, so it conditions on everything else already transcribed).
4. **Closed enums everywhere possible.** Recurrence types, weekdays, periods, energy, actions — all literal alternatives in the grammar, never free strings.
5. **Bounded everything.** Strings use a JSON-safe char class (no unescaped `"` `\` or control chars; standard escapes allowed) with explicit length caps (`{1,80}` for titles, `{1,200}` for descriptions/reasons). Integers are bounded digit patterns (`[1-9]` / `"10"` for importance; `[1-9][0-9]{0,3}` for minutes). An unbounded string in a grammar is an invitation for a greedy-decoding repetition loop that the grammar itself makes legal.
   - ⚠ **Verify bounded repetition `{m,n}` is supported** by the llama.cpp bundled in `llama.rn` 0.12.5 (it landed upstream mid-2024, so it should be — but the spike never loaded a grammar). If not, task 5 generates the bounded expansion programmatically (nested optionals). This is eval Q1's first smoke test.
6. **No free-text "reasoning" fields inside grammars.** The reasoning lives in the recap turn (D1). A `notes`/`reasoning` field inside a constrained output burns the token budget and is exactly where a grammar-legal ramble goes to live.

Illustrative idiom (task 5 writes the real ones):

```gbnf
root        ::= "{\"title\":" str80 ",\"importance_user\":" importance ",..."
importance  ::= "null" | [1-9] | "10"
str80       ::= "\"" jchar{1,80} "\""
jchar       ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
```

### 3.4 D4 + D5 — The model transcribes; code computes

The 4B's job is **transcription and classification, never arithmetic**:

- **Scales:** the model emits `importance_user` (1–10 or null) and `energy` (`low|med|high` or null). Code projects through `src/types/scales.ts` (importance ×100; energy 1/3/5). Defaults for null are code policy (importance → 500, energy → 3), not model output. The model never sees or emits internal 100–1000 / 1–5 values.
- **Dates:** the model emits a relative-date union; code resolves it against the device clock:

  ```
  DueSpec = null
    | {"kind":"on_date","date":"YYYY-MM-DD"}          // user said an absolute date
    | {"kind":"in_days","days":1..365}                 // "in two weeks" → 14
    | {"kind":"weekday","day":"monday".."sunday","which":"this"|"next"}
  ```

  The prompt states today's date *and weekday* (cheap insurance even though the model shouldn't need it for the union). "By Friday" is transcription (`weekday/friday/this`); making the model compute `2026-07-10` itself is date math — the classic small-model own-goal. **Falsification point:** if eval shows the 4B handles direct ISO emission at equal accuracy, the union can be simplified to ISO-or-null in v2; start safe.
- **`duration_from_user`** (bool) rides next to `estimated_duration_minutes` so code can set `duration_source` correctly ('user' vs 'model_guess', spec §4.1). The duration field is **never null** — when the user didn't say, the model guesses (that's spec-required coach behavior) and flags it.

### 3.5 D6 — Recurrence: a decision tree and an ask-don't-guess policy

Recurrence is the one classification where a plausible wrong answer **corrupts data invisibly** (`null` archives an ongoing task after one completion; `unscheduled` never closes a true one-off; a fake period on either breaks both). It gets special treatment end-to-end:

**The decision tree (goes in the task-input system prompt, near-verbatim — task 7):**

1. Does completing it once finish it forever? → **one-off** (`recurrence: null`)
2. Is it "done after N total completions, ever"? → **`count`** (target N)
3. Does it happen on fixed days? → with a per-period quota alongside → **`scheduled_quota`**; otherwise → **`scheduled`**
4. Is there a quota per period but no fixed days? → **`quota`**
5. Does it recur indefinitely with no schedule and no quota (ongoing project, practice, "keep at it")? → **`unscheduled`**

**The ask-don't-guess policy:** recurrence must be *established* — either stated clearly by the user or resolved by one short clarifying question ("Is this a one-time thing, or something ongoing?"). It is the only field with this status. Duration may be guessed (flagged), importance/energy may be null (defaulted) — **recurrence may not be silently defaulted when ambiguous.** In the eval, a clarifying question on an ambiguous case *is the correct answer* (§6.4).

The extraction-side recurrence union mirrors `src/types/domain.ts` minus `progress` (a new task starts at 0):

```
RecurrenceSpec = null
  | {"type":"scheduled_quota","quota":N,"period":P,"days":[Weekday+]}
  | {"type":"quota","quota":N,"period":P}
  | {"type":"scheduled","days":[Weekday+]}
  | {"type":"unscheduled"}
  | {"type":"count","target":N}
```

Known model gap, out of scope for v1: interval recurrence ("every 3 days") has no representation in the domain union (weekday-based only). Don't bend a fixture or a grammar around it; it's a schema question for a later version. The prompt should steer such a request to the nearest weekday expression with the user's consent.

### 3.6 D7 — Runtime-generated grammars where the legal set is known

Two failure classes disappear entirely if the grammar itself enumerates the legal values at call time:

- **Task ids** in coaching resolutions: the app knows exactly which tasks are in play (the coaching context injected 1–5 candidates). The resolution grammar's `task_id` rule is generated per-call as `("12"|"47"|"103")`. A 4B *will* eventually fabricate an id if given `[0-9]+`; don't let the failure exist.
- **Context tags:** generated per-call as `(known-tag-1|...|known-tag-n|new-tag-string)` — existing vocabulary as literals, plus one bounded-string escape for genuinely new tags. This biases toward vocabulary reuse (tag sprawl is a real cost in context-fit scoring) without forbidding growth.

Implementation note for tasks 5/6: the checked-in `.gbnf` files are **templates** with named slots; a small `buildGrammar(template, slots)` helper does literal substitution (with GBNF-escaping of values) at call time. Grammar compilation cost per call is assumed cheap but is measured in eval Q1.

### 3.7 D8 — Coaching resolutions: one mechanism, a union grammar

Spec §3.4 frames coaching outcomes as tool calls. The *mechanism* here is deliberately **not** `llama.rn`'s native tool-calling path (jinja tool templates + model-specific call formats — unproven for Ternary Bonsai, and a second reliability surface to eval). Instead, resolutions are the same thing everything else is: a grammar-constrained JSON union, dispatched by code.

```
Resolution =
  | {"action":"modify_task","task_id":ID,"changes":{"duration_minutes":N|null,"context_tags":[...]|null,"energy":E|null,"approach_notes":str|null}}
  | {"action":"break_down_task","task_id":ID}            // triggers the breakdown call (own grammar, staged)
  | {"action":"eliminate_task","task_id":ID,"reason":str120}
  | {"action":"defer_task","task_id":ID,"until":DueSpec|{"condition":str120}}
  | {"action":"add_dependency","task_id":ID,"depends_on_task_id":ID}
  | {"action":"add_missing_task","title":str80}          // stub; full extraction runs as its own staged call
  | {"action":"no_change","reason":str120}
```

Notes: `no_change` is a first-class action (spec §6.3) — without it the grammar corners the model into inventing an intervention. `break_down_task` and `add_missing_task` are *stubs that trigger the next staged call* rather than inlining a second schema's worth of output. The dependency-on-`count` semantics (depends = depends on N completions) come free from the data layer — nothing for the model to know. Effects remain deterministic and auditable — code applies them through the repositories, satisfying §3.4's actual intent.

The flow trigger is app-driven (D11): the coaching conversation runs as prose; when it reaches disposition (model proposed one and user agreed, or user picks "wrap up"), the app makes the constrained resolution call over the transcript.

### 3.8 D9 — Sampling policy

- **Constrained calls: greedy (temp 0, no penalties).** Extraction is transcription; there is one right answer. Greedy makes evals reproducible and behavior stable across runs. Repetition risk inside bounded fields is handled by D3's length caps, not by samplers.
- **Prose turns (conversation, recap): normal sampling** (the warm coaching voice needs it) — task 7 tunes values; start near temp 0.7.
- `maxTokens` on constrained calls = the surface's hard cap from §2. A generation that hits the cap is **by definition invalid** (truncated JSON) and enters the retry ladder — this is the *only* expected source of valid@1 failures once grammars work.

### 3.9 D10 — Runtime failure ladder

Per constrained call:

1. **Generate** (grammar, greedy, capped).
2. **Validate**: zod schema pass, then cross-field rules — `count` ⇒ `target ≥ 1`; `scheduled*` ⇒ `days` non-empty; `quota ≥ 1`; resolved due date not in the past (unless conversation said so); title non-empty after trim. Typed errors, same style as `src/db/errors.ts`.
3. **On failure — one corrective retry**: append a terse system-note turn ("Your previous output failed validation: <first error, one line>. Emit the corrected JSON only.") and regenerate under the same grammar. One retry, not a loop (spec §3.3.4).
4. **On second failure — graceful fallback** (spec §8.3): the "give me a moment" path, **salvaging what validated** — prefill a manual quick-add form with every field that passed, so the user confirms two fields instead of retyping everything. The failure is logged with the raw output (dev builds only — §4.4 transient-conversation rule) so it can become a fixture.
5. valid@1 and retry-success are tracked as runtime health metrics alongside tok/s (spec §3.5) — the eval bar (§6.5) keeps being measured in production, on the user's real inputs, forever.

---

## 4. The concrete schemas (v1)

### 4.1 `task_extraction.v1` (the flagship — key order is generation order)

```json
{
  "title":            "str, 1–80 chars",
  "description":      "str 1–200 | null",
  "estimated_duration_minutes": "int 1–1440",
  "duration_from_user": "bool",
  "due":              "DueSpec | null          (§3.4)",
  "context_tags":     "[tag, 0–5]              (D7 dynamic vocabulary)",
  "tool_requirements":"[str20, 0–5]",
  "energy":           "\"low\"|\"med\"|\"high\"|null",
  "importance_user":  "1–10 | null",
  "recurrence":       "RecurrenceSpec | null   (§3.5) — LAST: conditions on everything above"
}
```

~60–110 output tokens compact. Everything nullable except `title`, `estimated_duration_minutes`, `duration_from_user`, and the (possibly empty) arrays.

### 4.2 `task_breakdown.v1`

```json
{
  "parent_task_id": "ID (dynamic)",
  "ordered": "bool                      — do these subtasks need a sequence?",
  "subtasks": "[ {\"title\": str80, \"estimated_duration_minutes\": int, \"duration_from_user\": bool}, 2–8 ]"
}
```

Code assigns importance: parent band + sequence position if `ordered`, **one shared value if not** (spec §4.1 — the model is never asked to manufacture sibling distinctions). Subtask context/energy default to the parent's; the coach edits after via `modify_task` if the conversation said otherwise.

### 4.3 `coaching_resolution.v1` — as specified in §3.7.

### 4.4 `summary.v1` (pattern-setter; finalized when coaching lands)

```json
{
  "summary_schema_version": "\"1\" (literal in grammar)",
  "kind": "InteractionType enum",
  "key_points": "[str120, 1–3]",
  "disposition": "str120 | null",
  "energy_note": "str80 | null"
}
```

Raw transcripts are never persisted (§4.4); this object is what survives. Task ids and ratings are attached by *code* from flow state — the model summarizes, it doesn't recall ids.

---

## 5. Prompt-side rules (binding envelope for task 7)

1. **Always the `messages` API.** Non-negotiable (§3.2).
2. **The constrained call's prompt contains a compact natural-language field guide** — llama.cpp constrains tokens, it doesn't teach the schema (spec §3.3.2). Budget: ≤ 250 prompt tokens for the guide, including the recurrence decision tree (§3.5) and today's date+weekday. Field guide and grammar must be updated together (same PR) — a guide describing schema v1 against a v2 grammar is a semantic-drift *generator*.
3. **Few-shot examples are a measured luxury.** One worked extraction example likely costs 150–250 prefill tokens. Do not add few-shots until eval Q4 (prefill speed) says they're affordable, and add them only if they measurably move field accuracy (§6.7 Q2/Q3 runs with and without).
4. **The ask-vs-guess policy verbatim:** recurrence must be established or asked (one question, plain words); duration is guessed and flagged when unstated; importance/energy are left null when unstated — never interrogate the user field-by-field (adaptive questioning, §7.1: ask only what's needed).
5. **Scope-to-observable-work rule** (§7.1) belongs in the task-input prompt: external events become their *arrangement* ("Schedule dentist appointment"), with duration = the arranging effort. The eval traps this (§6.4).
6. **Context reuse note for task 6:** within one conversation, keep the llama.rn context alive across turns so each call only prefills the delta; the constrained call rides the same context as the conversation it extracts from. This is likely the single biggest real-world latency lever; verify supported behavior in `llama.rn` 0.12.5 and measure in Q4.

---

## 6. Eval design

### 6.1 What the eval must establish

The allocation doc's bar, made concrete: **≥99% valid@1** and **≥95% field-correct on critical fields** across the real-example set, **plus zero silent `null`↔`unscheduled` misclassifications** (a clarifying question is a pass; a silent wrong guess is the one unacceptable outcome). Secondary: latency within budget (§2 caps at measured tok/s) and answers to the four open questions (§6.7).

### 6.2 Fixture format

JSONL, one case per line, in `docs/eval/` (seed file: `extraction_fixtures_seed.jsonl`, committed with this doc). Shape:

```json
{
  "id": "trap-unsched-01",
  "source": "synthetic | real",
  "today": "2026-07-08",
  "turns": [{"role":"user","content":"..."}, ...],
  "clarify_answers": ["It's ongoing, I never really finish it"],
  "gold": {
    "title": ["organize garage", "garage organization"],
    "estimated_duration_minutes": {"min": 30, "max": 120},
    "duration_from_user": false,
    "due_resolved": "2026-07-10",
    "energy": "high",
    "importance_user": null,
    "context_tags_must_include": ["home"],
    "recurrence": {"type": "unscheduled"},
    "clarify_ok": ["recurrence"]
  },
  "critical": ["recurrence", "due_resolved"],
  "notes": "why this case exists"
}
```

Conventions: `title` is a list of acceptable normalized forms (lowercase, trimmed, punctuation-stripped compare); durations are gold **ranges** (exact when `duration_from_user`); `due_resolved` is the ISO date the DueSpec must resolve to given `today` (fixtures pin `today` so date cases never rot); `clarify_answers` is a queue — if the model ends a turn with a question, the harness plays the next answer; `clarify_ok` lists fields where asking (then getting it right) is a pass; `critical` names the fields that count toward task-correct for this case.

### 6.3 Metrics (precise definitions)

| Metric | Definition | Target |
|---|---|---|
| **valid@1** | First constrained generation parses + passes zod + cross-field rules (truncation counts as failure) | ≥ 99% (expect ~100 once grammars work; every failure gets a root cause) |
| **field-correct** | Per-field, over cases where the field is gold-specified: enums/ids/recurrence exact; durations in gold range; titles in accepted set; due resolved-date exact | ≥ 95% on critical fields |
| **task-correct@1** | All of the case's `critical` fields correct in one attempt (clarify-then-correct counts, per `clarify_ok`) | ≥ 90% |
| **recurrence confusion matrix** | 6-way (`null` + 5 types), over all cases | **zero** silent `null`↔`unscheduled` errors; other confusions surface in the matrix for prompt iteration |
| **clarify discipline** | Questions asked on unambiguous cases (over-asking is friction) / silent guesses on ambiguous ones | over-ask ≤ 10% of unambiguous; silent-guess = 0 on `clarify_ok` cases |
| **latency** | p50/p95 wall-clock per constrained call on-device, + output tokens, + prefill time | within §2 budgets at 5.2 tok/s |

**Statistical honesty:** with ~30 real cases, 95% means "one, maybe two errors." Report **counts, not just percentages**, always with the denominator. The set grows over time (§6.6); the percentages start meaning more as it does.

### 6.4 Case inventory

The seed file covers the trap taxonomy with synthetic cases (spec-derived); Jason's **20–30 real tasks** (§8.1) are the substance — messy phrasing is the point, synthetic traps only guarantee coverage:

- each of the 5 recurrence types + true one-off, phrased naturally
- **`null` vs `unscheduled` traps** (ongoing projects, "keep practicing…") — the zero-tolerance set
- **`count` vs `quota` traps** ("apply to 20 jobs" — total-ever vs per-period) and **`scheduled` vs `scheduled_quota`** ("meds Mon/Wed/Fri" vs "run 3×/week aiming Mon/Wed/Fri")
- date expressions across the DueSpec union ("by Friday", "in two weeks", "December 3rd")
- unstated durations (guess + flag) and floor-style durations ("at least an hour" — records 60, `duration_from_user: true`; the multi-session semantics are §8.7's problem, not extraction's)
- the **scope-to-observable trap** (external event → arrangement task)
- multi-turn complex case ending in a breakdown (exercises `task_breakdown.v1`)
- resolution-grammar cases (given a scripted coaching transcript, is the right action + right task id emitted?) — added when task 7's coaching prompts exist; format identical

### 6.5 Dev / holdout split

Split the real cases **~⅔ dev / ⅓ holdout at random, once**. All synthetic traps are dev. Prompts and grammars are iterated against dev only; the holdout is run **only at config freeze** (before task 7 signs off) and after any later prompt/grammar change, as the regression gate. Tuning against the holdout quietly turns "≥95% measured" into "≥95% memorized" — with N this small, that discipline is the whole difference between a number and a hope.

### 6.6 Harness (two phases) and provenance

- **Phase A — desktop, for iteration speed.** Same GGUF file, desktop llama.cpp (`llama-cli --grammar-file … --temp 0`), driven by a Node script; scorer in TypeScript sharing the zod validators and `scales.ts` (the Jest/`better-sqlite3` precedent applies: desktop as proxy, device as truth). Same weights + same sampler + greedy ⇒ semantically equivalent output; **latency numbers from Phase A are meaningless** and never reported.
- **Phase B — on-device, for truth.** A dev-only screen (spiritual successor to `BonsaiSpikeScreen`) loads bundled fixtures, runs them through the real `TernaryBonsaiProvider`, writes results JSONL to the app files dir; `adb pull`; same scorer. Confirms Phase A semantics + produces the real latency/prefill numbers. Run at config freeze and before any release-ish milestone; Phase A on every iteration.
- **Every run writes a manifest:** model file SHA-256, grammar file hashes, prompt template version, sampler params, llama.rn/llama.cpp version, device + thermal note, fixture set hash. An eval number without its manifest is a rumor.
- **Growing the set:** when real usage produces a wrong extraction, the correction becomes a fixture. Capture is an **explicit dev-build action** (raw conversations are transient by §4.4 — the capture button is the consent), stored locally only.

Building the harness is **Sonnet work (task 20 track) against this section**; it needs no design decisions beyond what's here.

### 6.7 The four questions the first runs must answer (falsification points)

1. **Q1 — Do grammars work at all on this stack?** Load a trivial grammar via llama.rn on-device; then `task_extraction.gbnf`. Measure per-token overhead and grammar-compile time; verify `{m,n}` repetition support (D3.5). *If grammars fail or overhead is crippling, the whole §3.3 approach falls back to prompt-JSON + strict validation + retry — a different, worse world we need to know about immediately.*
2. **Q2 — Does constraining hurt semantics?** Same fixtures, grammar-on vs grammar-off (prompt-only JSON), field accuracy compared. This measures the "cornered model" effect (§1.5) directly and tells us whether the D1 recap is load-bearing or belt-and-braces.
3. **Q3 — What does the recap buy?** Recap-then-constrain vs constrain-directly, on simple and complex cases separately. Expected: negligible on simple, meaningful on complex; prune the recap where it buys nothing (it still stays wherever the UX wants it).
4. **Q4 — Prefill economics.** Tokens/sec prefill on-device, cold and warm (context-reuse, §5.6). Sets the real prompt budget and decides few-shots (§5.3), and whether per-turn latency needs prompt surgery.

---

## 7. Out of scope for this task

- Writing the actual grammars, schemas, validators (task 5), system prompts (task 7), provider/runtime code (task 6), or the harness code (task 20 track).
- Skill-record schemas and distillation prompts (task 18 — but they inherit D2/D3/D9/D10 wholesale).
- Coaching conversation *quality* evaluation (task 7/12 concern; this doc only fixes the resolution mechanism).
- The §8.7 multi-session/hyperfocus design; §3.5's interval-recurrence gap (schema decision, flagged, not extraction's problem).

## 8. Required from Jason (the loop can't close without these)

1. **The 20–30 real tasks** (allocation-doc prep item 3), messy and verbatim, ideally with what *you'd* consider the right extraction. Drop them as fixture lines (or raw text — anyone can fixture-ify them) into `docs/eval/`. The seed file shows the format. Real friction episodes and coaching transcripts matter later (task 18); extraction only needs the tasks.
2. **The Q1 smoke test on the S23 FE** (once task 5's first grammar exists): does a GBNF-constrained call return, and at what tok/s vs unconstrained? Ten minutes with the dev screen; it's the highest-information single measurement left in the §3.3 domain, exactly like the original spike was for §3.1.
3. **Phase B runs at config freeze** (§6.6) — you are the device-side of the loop (prep item 8).
