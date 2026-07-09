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
