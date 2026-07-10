# Sonnet Brief — Task 5: Schemas, GBNF Grammars, Validators & Mappers (todoAI)

**For:** a Sonnet coding session (Claude Code) in this repo.
**Binding authority:** `docs/briefs/structured_output_strategy_task_4.md` (Fable's task-4 strategy). That doc **decides**; this brief **implements**. Where they ever seem to differ, the strategy wins — and stop and ask rather than reconciling silently. Read it first, in full. Decisions are cited below by their IDs (D1–D11, §4).
**Spec/schema of record:** `docs/reference/ADHD_Task_Management_App_Specification_v2.2.md` (§3.3–§3.4, §4.1–§4.2, §7.1); `src/types/domain.ts` (the `Recurrence` union is authoritative).
**Depends on:** tasks 3 (types) and 4 (strategy) — both done. **Does not depend on and must not touch:** the DB layer, the provider/runtime, prompts, or the eval harness.

You are producing **static artifacts and pure functions only** — JSON Schemas, GBNF grammars, zod validators, and deterministic mappers. **No model calls, no `llama.rn`, no device, no I/O, no DB.** Everything you write must be unit-testable on desktop with no model in the loop.

---

## What "task 5" covers here

The build matrix calls this "GBNF grammar files," but the strategy (its intro, D2, §4) scopes the unit of work as **schema → grammar → validator → mapper**, per surface. Build all four for each surface, because they're one source of truth split into four derived forms (D2) and they must be tested together. The **mappers/resolvers** (the "code computes" half of D4/D5) are pure, schema-coupled, and model-free — they belong here, not in the provider (task 6). If you think a mapper is drifting toward runtime concerns, stop and flag it.

---

## Surfaces to build (from strategy §2 + §4)

Four surfaces, each its own schema+grammar+validator (+mapper where noted):

1. **`task_extraction.v1`** — the flagship (§4.1). Mapper required.
2. **`task_breakdown.v1`** — subtasks (§4.2). Mapper required (importance banding).
3. **`coaching_resolution.v1`** — the union (§3.7/§4.3). Validator only; dispatch/apply is task 6/12.
4. **`summary.v1`** — (§4.4). Validator only; persistence mapping is light, leave it to the summary writer (later task).

Skill-record schemas are **task 18, not now** (strategy §7).

---

## File layout to create

```
src/llm/
  extraction/
    task_extraction.v1.json      # JSON Schema — SOURCE OF TRUTH (D2)
    task_extraction.v1.gbnf      # generated then hand-tightened; header cites schema + version
    validator.ts                 # zod + cross-field rules; typed errors
    mapper.ts                    # validated extraction + todayISO -> { taskWrite, recurrence }
    __tests__/
  breakdown/
    task_breakdown.v1.json | .gbnf
    validator.ts
    mapper.ts                    # subtask importance banding (spec §4.1)
    __tests__/
  resolution/
    coaching_resolution.v1.json  # TEMPLATE grammar (task_id + tag slots, D7)
    coaching_resolution.v1.gbnf
    validator.ts
    __tests__/
  summary/
    summary.v1.json | .gbnf | validator.ts | __tests__/
  due/
    dueSpec.ts                   # DueSpec union type + resolveDue(spec, todayISO) -> ISO|null (D5)
    __tests__/
  grammar/
    buildGrammar.ts              # slot substitution + GBNF-escaping for dynamic grammars (D7)
    boundedRepetition.ts         # {m,n} -> nested-optional expander (D3.5 fallback insurance)
    primitives.ts                # shared GBNF rule fragments (jchar, bounded string, etc.)
    __tests__/
  index.ts                       # barrel: export every schema path, validator, mapper, buildGrammar
```

Match the conventions already in `src/types` and `src/db`: typed errors in the style of `src/db/errors.ts`, `__tests__/` siblings, strict TS, no default exports where the codebase uses named.

---

## Binding rules (from the strategy — implement exactly)

**D2 — one source of truth.** For each surface author the **JSON Schema first**. Generate the GBNF from it (llama.cpp's `json_schema_to_grammar` is a fine starting point; hand-authoring to the schema is also fine since heavy tightening is required either way), then hand-tighten per D3. The `.gbnf` header comment must name its source schema **and version**. Derive the zod validator from the same schema. Add a **drift test** per surface asserting the zod validator and the JSON Schema agree on a shared set of valid/invalid fixtures — this is the mechanism that stops the three forms diverging.

**D3 — grammars are maximally rigid.** No whitespace freedom (compact JSON, tighten the generator's optional-ws rules to nothing). Fixed key order = **generation/conditioning order**; all keys required, `null` where unknown (discriminated unions branch after the discriminator and then carry only that variant's keys). Closed enums as literal alternatives (recurrence types, weekdays, periods, energy, actions — never free strings). Bounded everything: JSON-safe char class with explicit length caps (titles `{1,80}`, descriptions/reasons `{1,200}`, tags `{1,20}`), bounded integer digit patterns. **No free-text reasoning fields inside any grammar** (the reasoning is the recap turn, D1 — not your concern here, but never give it a field to live in).
- ⚠ **`{m,n}` support is unverified** on `llama.rn` 0.12.5's bundled llama.cpp (strategy D3.5 / eval Q1). Author grammars using `{m,n}`, **and** write `boundedRepetition.ts` so a bounded repeat can be mechanically expanded to nested optionals. If Q1 later shows `{m,n}` unsupported, regenerating is a config flip, not a rewrite. You cannot run Q1 (no device) — just deliver both forms' machinery and note it.

**D4 — the model emits user-scale; code projects.** Extraction emits `importance_user` (1–10 | null) and `energy` (`low|med|high` | null) — **never** internal 100–1000 / 1–5. The mapper projects through the existing `src/types/scales.ts`. Null policy is **code**, not model: `importance_user` null → internal 500; `energy` null → 3. Do not add these defaults to the grammar.

**D5 — dates are transcription, not math.** Implement the `DueSpec` union and `resolveDue(spec, todayISO)` in `due/dueSpec.ts`:
```
DueSpec = null
  | { kind: 'on_date';  date: 'YYYY-MM-DD' }
  | { kind: 'in_days';  days: 1..365 }
  | { kind: 'weekday';  day: 'monday'..'sunday'; which: 'this' | 'next' }
```
The model emits the union; `resolveDue` computes the ISO date against `today`. **The date fixtures in `docs/eval/extraction_fixtures_seed.jsonl` are your unit tests** — `resolveDue` must reproduce their `due_resolved` given each case's `today`:
- `date-weekday-01`: "by Friday", today Wed `2026-07-08` → `2026-07-10`
- `date-relative-01`: "in two weeks" → `days:14` → `2026-07-22`
- `date-absolute-01`: "December 3rd", today July → year inferred → `2026-12-03`
Handle the year-inference and this/next-weekday edges deliberately; these are exactly where date code hides bugs.

**D6 — recurrence: keep `null` and `unscheduled` distinct, forever.** The extraction `RecurrenceSpec` mirrors `src/types/domain.ts`'s `Recurrence` **minus `progress`** (a new task starts at 0):
```
RecurrenceSpec = null
  | { type:'scheduled_quota'; quota:N; period:P; days:[Weekday+] }
  | { type:'quota'; quota:N; period:P }
  | { type:'scheduled'; days:[Weekday+] }
  | { type:'unscheduled' }
  | { type:'count'; target:N }
```
`null` (one-off) and `{type:'unscheduled'}` have **opposite completion semantics** and must never collapse. In the extraction mapper: `null` → `recurrence: undefined` (no `task_recurrence` row → true one-off, per the `domain.ts` note); `{type:'unscheduled'}` → the union member. The *ask-don't-guess* policy is a **prompt rule (task 7)** — your job is only to make the two representable and distinct, and to map them faithfully. Interval recurrence ("every 3 days") has **no representation** — do not invent one; it's a flagged schema question (strategy §3.5, §7).

**D7 — dynamic-slot grammars are templates.** Some grammars can't be fully static because the legal value set is known only at call time. Author these as **templates with named slots**, plus `buildGrammar(template, slots)` doing literal substitution **with GBNF-escaping** of injected values:
- `coaching_resolution.v1.gbnf`: `task_id` slot (the app injects the 1–5 candidate ids as an alternation, e.g. `("12"|"47")`) — a bare `[0-9]+` id rule is forbidden (a 4B will fabricate ids). `modify_task`'s `context_tags` also uses the tag slot.
- `task_extraction.v1.gbnf`: **also a template** — `context_tags` is a dynamic-vocabulary slot (known tags as literal alternatives + one bounded new-tag escape, D7). `title`/`description`/etc. stay static.
- `task_breakdown.v1.gbnf`: `parent_task_id` is a single-id slot.
- `summary.v1.gbnf`: no dynamic slots (fully static).
Task 6 supplies slot values at runtime; you build the templates + the substitution helper + tests (feed sample ids/tags, assert valid escaped GBNF out).

**D8 — coaching resolution is a union grammar, not native tool-calling.** Implement §4.3 exactly, including `no_change` as a first-class action (without it the grammar corners the model into inventing an intervention). `break_down_task` and `add_missing_task` are **stubs that carry only ids/title** — they trigger a later staged call, they don't inline a second schema. Applying resolutions is task 6/12; you only validate.

**D10 — validators do zod + cross-field, with typed errors.** Each `validator.ts` exposes a `validate(raw): Result` that runs the zod parse **then** the cross-field rules, throwing errors in the `src/db/errors.ts` style (add an `LlmOutputValidationError` or similar). Cross-field rules at minimum: `count` ⇒ `target ≥ 1`; `scheduled`/`scheduled_quota` ⇒ `days` non-empty; `quota`/`scheduled_quota` ⇒ `quota ≥ 1` and `period` present; `estimated_duration_minutes` in `[1,1440]`; title non-empty after trim; resolved due date not in the past unless the case allows it. The **retry/fallback ladder itself is task 6** — you provide the `validate()` it calls, not the orchestration.

**D9 — sampling is not yours**, but its consequence is: because generation is greedy at temp 0 (task 6), an unbounded string in a grammar becomes a legal repetition loop. D3's bounds are what prevent that. Just don't emit an unbounded string rule anywhere.

---

## Mappers (pure, model-free)

**`extraction/mapper.ts`** — `extractionToTaskWrite(valid, todayISO) -> { taskWrite: TaskWriteInput; recurrence: Recurrence | undefined }`:
- `title`, `description`, `toolRequirements`, `contextTags` pass through.
- `estimatedDuration` = the emitted minutes; `durationSource` = `duration_from_user ? 'user' : 'model_guess'` (spec §4.1). Duration is never null.
- `energyRequirement` = `scales` projection of `energy` (null → 3).
- `importance` = `scales` projection of `importance_user` (null → 500).
- `nextDueAt` = `resolveDue(due, todayISO)`.
- `recurrence` = `RecurrenceSpec` → `Recurrence | undefined` (**`null` → undefined**; add `progress: 0` for `count`).
- Produces **domain write inputs only** — no persistence, no repository calls.

**`breakdown/mapper.ts`** — assigns subtask importance from the parent's band (spec §4.1): a `subtaskImportance(parentImportance, index, ordered)` helper. `ordered` → sequential values in the parent's 1–99 sub-band (e.g. parent 700 → 701, 702, …); **`!ordered` → all siblings share one value** (e.g. all 701). The model never manufactures sibling distinctions — it only emits the `ordered` flag and titles/durations (§4.2). Subtask context/energy default to the parent's.

---

## Explicitly OUT of scope (do not build — later tasks; building now = rework)

- System prompts, field guides, the recurrence decision-tree prose (task 7).
- `TernaryBonsaiProvider`, any `llama.rn` call, sampling config, the generate→validate→retry→fallback **orchestration**, context reuse (task 6).
- The eval harness/runner and on-device grammar verification / Q1–Q4 (task 20 track + Jason). Make your validators and `scales`/`resolveDue` **importable** by the harness — that's the only coupling.
- Skill schemas/distillation (task 18).
- Editing the DB schema, domain types, or `scales.ts` (tasks 2/3). Import them; don't modify them. If one needs a change, flag it.
- Interval recurrence (unrepresented by design).

---

## Acceptance criteria

- Four surfaces, each with schema + grammar (header cites schema+version) + validator, co-located; `src/llm/index.ts` barrel exports them.
- **Drift test per surface:** zod validator and JSON Schema agree on a shared valid/invalid fixture set (D2).
- **Validator tests:** hand-authored valid objects accepted; each cross-field rule has a rejecting case (bad `count` target, empty `days`, zero `quota`, past due, empty title, out-of-range duration).
- **`resolveDue` reproduces every date fixture's `due_resolved`** from `extraction_fixtures_seed.jsonl` given its `today` (weekday/in_days/on_date branches, year inference, this-vs-next).
- **Extraction mapper tests** over the seed cases' gold: recurrence maps correctly for all five types **+ the one-off** (`null → undefined`, kept distinct from `unscheduled`); scales projected with the null defaults; `duration_from_user` → `durationSource`; due resolved.
- **Breakdown mapper tests:** ordered → distinct banded values; unordered → shared value; all within the parent's band and not colliding with the next hundred.
- **`buildGrammar` tests:** injecting sample task ids / tags yields valid, correctly GBNF-escaped grammar text; injected values with quotes/backslashes are escaped, not breaking the grammar.
- **`boundedRepetition` test:** a `{m,n}` rule expands to an equivalent nested-optional rule.
- `tsc` strict passes; `npm run lint` clean. If you add a dependency (e.g. `zod`, or a JSON-Schema→zod tool), note it in `README_build.md`.
- A short `src/llm/README.md` (or top-of-`index.ts` comment) stating: JSON Schema is source of truth; how to regenerate a grammar; the `{m,n}` caveat and the Q1 smoke test that must confirm it on-device before this is trusted.

Work in small commits, one surface at a time (schema → grammar → validator → mapper → tests), starting with **extraction** (it's the flagship and exercises every mechanism: dynamic tag slot, DueSpec, scales, the recurrence union). When a spec/strategy point is ambiguous, stop and ask — do not guess, especially anywhere near the `null`/`unscheduled` boundary.
