# src/llm — structured output layer

Static artifacts and pure functions only: JSON Schemas, GBNF grammars, zod validators, and
model-free mappers for every grammar-constrained call the app makes. No model calls, no
`llama.rn`, no device, no DB — see `docs/briefs/grammars_task_5.md` (implementation brief)
and `docs/briefs/structured_output_strategy_task_4.md` (binding strategy; decisions D1–D11).

## Surfaces

| Surface | Folder | Mapper? |
|---|---|---|
| `task_extraction.v1` | `extraction/` | yes — `extractionToTaskWrite` |
| `task_breakdown.v1` | `breakdown/` | yes — `subtaskImportance` / `breakdownToSubtaskWrites` |
| `coaching_resolution.v1` | `resolution/` | no — dispatch/apply is task 6/12 |
| `summary.v1` | `summary/` | no — persistence mapping is a later task |

Each folder has `<surface>.vN.json` (schema), `<surface>.vN.gbnf` (grammar), `validator.ts`
(zod + cross-field rules), and `__tests__/` (validator tests + a `schemaDrift.test.ts`).
`src/llm/index.ts` barrel-exports all of it.

## The JSON Schema is the source of truth (D2)

For each surface, the `.json` file is authored first and is authoritative. The `.gbnf`, the
zod validator, and the eval harness's fixtures are all meant to agree with it — the
`schemaDrift.test.ts` in each surface's `__tests__/` is what actually checks that: it runs a
shared set of valid/invalid fixtures through both the zod validator *and* `ajv` compiling the
real `.json` file, and asserts they agree. If you change one, run the drift test before
touching the other two.

## Regenerating a `.gbnf`

There's no checked-in generator script — `llama.cpp`'s `json_schema_to_grammar` converter
wasn't available in this environment, and the brief explicitly allows hand-authoring since
heavy hand-tightening (D3) is required either way. In practice:

1. Update the `.json` schema first.
2. Rebuild the `.gbnf` by hand, reusing `src/llm/grammar/primitives.ts` (`boundedStringRule`,
   `boundedIntRule`, `literalAlternationRule`, `nullableRule`, `JCHAR_RULE`) for the repetitive
   bounded-string/int/enum rules rather than retyping the character classes. For a grammar
   this size, it's easiest to assemble the rule list in a throwaway Jest test that
   `console.log`s the joined lines, eyeball the output, then paste it into the real `.gbnf`
   file and delete the scratch test — that's how all four of these were built.
3. Keep property order in the `.gbnf`'s `root` rule matching the JSON Schema's declared
   property order — that's the generation/conditioning order (D3.3), and JSON Schema itself
   doesn't enforce it, only the grammar does.
4. Update the header comment's schema+version citation.
5. Re-run that surface's tests (validator, drift, mapper if present).

Dynamic-slot surfaces (`task_extraction.v1`, `task_breakdown.v1`, `coaching_resolution.v1` —
see D7) are templates: `{{slot_name}}` placeholders that `grammar/buildGrammar.ts` substitutes
at call time with a literal alternation of the app's actual candidate values (known context
tags, the task ids in play). They are not valid GBNF until substituted.

## Rule-name constraint — no underscores (Q1c)

**No GBNF rule name (the LHS of `::=`) may contain `_` on this build.** `llama.cpp`'s GBNF
parser (as bundled in `llama.rn` 0.12.5) lexes rule names with an `is_word_char` predicate that
accepts letters, digits, and `-`, but not `_` — an underscore inside a rule name silently
truncates the identifier and the parser then fails on the malformed remainder
(`failed to parse grammar`). This is a **build quirk, not GBNF semantics** — don't "fix" the
workaround later thinking it's wrong. See `docs/eval/Q1c_findings_report.md` for the isolating
probes.

**JSON keys are unaffected and keep their underscores freely** — `"estimated_duration_minutes"`
stays as a schema key; only the *rule* referenced under it is renamed (e.g. to
`estimatedDurationMinutes`). Every rule name in the checked-in `.gbnf` files uses camelCase for
this reason. `src/llm/grammar/__tests__/ruleNaming.test.ts` is the regression guard — it lints
every checked-in `.gbnf` file and `buildGrammar`'s substituted output against
`/^[a-zA-Z][a-zA-Z0-9]*$/`.

An earlier investigation (`docs/eval/Q1b_findings_report.md`) concluded instead that **a rule's
name must exactly match its own JSON key** — that conclusion is **retracted**. It rested on a
probe pair that changed the rule's name and its underscore status at the same time; Q1c isolated
the two and found the underscore was the whole story (key-matching is directly falsified by
grammars that already parse with a rule name unrelated to its key, e.g. `jchar`, `weekday`).
Do not reinstate the key-matching rule.

## The `{m,n}` caveat — unverified, not yet trusted

Every grammar here uses GBNF's `{m,n}` bounded-repetition syntax (bounded strings, bounded
integers, 0–N-item arrays). Whether the `llama.cpp` bundled in `llama.rn` 0.12.5 actually
supports `{m,n}` has **never been tested** — there is no device in this session's loop, and
the original spike ran zero grammars. `grammar/boundedRepetition.ts` exists purely as
insurance: it mechanically expands any `element{m,n}` into an equivalent nested-optional
sequence, so if the on-device smoke test below shows `{m,n}` is unsupported, regenerating is a
config flip (rewrite with the expansion), not a rewrite of any surface's logic.

**Nothing in this layer is validated against a real model yet.** All 200+ tests in `src/llm/`
prove the schemas/grammars/validators/mappers are internally consistent and pure-function
correct on desktop — they say nothing about whether the actual 4B, under an actual grammar,
on an actual device, produces valid or field-correct output. That's strategy §6.7's **Q1**:
load a trivial grammar via `llama.rn` on-device, then `task_extraction.v1.gbnf`; measure
per-token overhead and grammar-compile time; confirm `{m,n}` support one way or the other. Per
the strategy doc, this is the highest-information single measurement left, and it's a
prerequisite for trusting anything downstream of it (task 6's provider, task 7's prompts, the
eval harness's numbers). Do not treat this layer as proven until Q1 has run.
