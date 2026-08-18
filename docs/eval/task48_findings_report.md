# Task 48 findings report

## What this task was

Task 37 closed the separator-token hole (a free-text rule shaped `"\"" jchar{1,n} "\""` is
satisfied by the single token `","`) in all four checked-in `.gbnf` files by requiring the first
character of every free-text string to be alphanumeric (`firstChar`). It did not touch
`boundedStringRule` in `src/llm/grammar/primitives.ts`, the shared builder those four files were
hand-authored to mirror. Nothing calls `boundedStringRule` at runtime today - all four grammars
are static text - but the primitive itself still emitted the vulnerable shape, so a fifth grammar
built through it would silently reintroduce the hole, and `freeTextFirstChar.test.ts` (which lints
the checked-in `.gbnf` files) would not catch that because there'd be no `.gbnf` file to lint until
someone wrote one out.

## Before / after

Before:

```
boundedStringRule('str80', 1, 80) -> str80 ::= "\"" jchar{1,80} "\""
```

After, for `min >= 1`:

```
boundedStringRule('str80', 1, 80) -> str80 ::= "\"" firstChar jchar{0,79} "\""
boundedStringRule('str10', 3, 10) -> str10 ::= "\"" firstChar jchar{2,9} "\""
```

`firstChar` supplies one of the required characters; `jchar{min-1,max-1}` supplies the rest, so
the rule still spans exactly `[min,max]` characters overall - same technique task 37 used in the
`.gbnf` files (`firstChar jchar{0,n-1}` for the `min=1` case), generalized to `min-1`/`max-1` for
any `min >= 1`.

After, for `min === 0`:

```
boundedStringRule('opt80', 0, 80) -> opt80 ::= "\"\"" | "\"" firstChar jchar{0,79} "\""
boundedStringRule('empty0', 0, 0) -> empty0 ::= "\"\""
```

## How `min: 0` is handled

An empty string can't be forced to start with an alphanumeric - there is no first character to
constrain. Making the empty case route through `firstChar` would either wrongly forbid the empty
string (breaking bounds) or require a special-case escape hatch that undermines the hole-closing
guarantee. So for `min === 0` the rule is an explicit alternation: the literal empty string
`"\"\""`, or the `min=1` shape covering 1..max characters. This is not a case the emitter "can't
express" - it's expressible, just as two alternatives instead of one bounded repetition - so
nothing here needed a loud failure. The one true degenerate case, `min === 0, max === 0` (a field
that must always serialize as `""`), collapses to the literal alone, since the `firstChar` branch
would otherwise emit an invalid `jchar{0,-1}`.

No bound value is unrepresentable under this shape, so `boundedStringRule` still only throws on
the pre-existing bounds-sanity check (`min < 0` or `max < min`); no new throw path was added.

## Where `firstChar` is defined, and why

Added `FIRST_CHAR_RULE_NAME` (`'firstChar'`) and `FIRST_CHAR_RULE`
(`firstChar ::= [a-zA-Z0-9]`) as exported constants in `primitives.ts`, following the exact
precedent already set by `JCHAR_RULE_NAME`/`JCHAR_RULE`: `boundedStringRule` references the rule
by name and documents that it *assumes* `FIRST_CHAR_RULE` is already defined in the grammar,
rather than emitting the definition itself.

I considered having `boundedStringRule` emit the `firstChar ::= [a-zA-Z0-9]` line inline on every
call. Rejected: a grammar with multiple bounded-string fields (which is every real grammar in this
codebase - `task_extraction.v1.gbnf` alone has four) would get the rule definition repeated once
per field, and a duplicate rule definition is a parse error on some builds (explicitly called out
in the task brief). The existing `JCHAR_RULE` pattern already solved this exact "shared primitive,
defined once, referenced by many rule bodies" problem for the character class the string body
uses; `firstChar` is the same kind of shared primitive one level up, so it gets the same treatment
for consistency and to avoid a second, differently-shaped convention in one file. A caller
assembling a grammar from these primitives is expected to include `FIRST_CHAR_RULE` (and
`JCHAR_RULE`) in the shared-primitives section exactly once, exactly as they're already expected
to include `JCHAR_RULE` once - `boundedStringRule` was already leaving that responsibility to the
caller for `jchar`, so leaving it there for `firstChar` too is not a new failure mode, just the
same one extended consistently.

## What test pins it

`src/llm/grammar/__tests__/primitives.test.ts`:
- `boundedStringRule` describe block: four cases pinning the exact emitted string for
  `min=1` (bounds shift by one, matching the `.gbnf` files' `firstChar jchar{0,79}` shape),
  `min>1` (bounds shift by one on both ends), `min=0` (empty-string alternation), and
  `min=0,max=0` (collapses to the empty literal) - plus the pre-existing invalid-bounds throw
  test, left in place.
- New `FIRST_CHAR_RULE` describe block pinning `FIRST_CHAR_RULE_NAME === 'firstChar'` and
  `FIRST_CHAR_RULE === 'firstChar ::= [a-zA-Z0-9]'`, matching the literal string
  `freeTextFirstChar.test.ts` checks for in the `.gbnf` files, so the two can't drift apart
  silently.

## What existing test had to change, and why that's correct

`primitives.test.ts`'s original `boundedStringRule` test asserted the exact old (vulnerable)
output string: `'str80 ::= "\\"" jchar{1,80} "\\""'`. That assertion is what the task brief
requires me to break - it was pinning the shape being fixed. I replaced it with the four cases
above, which pin the new hardened shape as precisely as the old test pinned the old one (exact
string equality, not a loosened substring/regex check), so this is a like-for-like tightening
of the same assertion style, not a weakened assertion.

`buildGrammar.test.ts` and `ruleNaming.test.ts` needed no changes - `boundedStringRule` is not
called from any `.gbnf` file or from `buildGrammar`'s template-substitution path, so neither
suite's fixtures were touched by this change. Verified by grep: `boundedStringRule` has no
callers outside `primitives.ts` itself, `index.ts` (re-export), `primitives.test.ts`, and
`index.test.ts` (a smoke test that only asserts `typeof llm.boundedStringRule === 'function'`).

## Verification

- `npx jest`: 143 suites / 1666 tests passed (raw, includes the stale worktree at
  `.claude/worktrees/interesting-shirley-e10fa1`, which does not see these edits and still
  reports its old counts unchanged). Halved: 75 suites / ~868 real tests, consistent with the
  stated baseline plus this task's 4 new test cases (`primitives.test.ts` real copy went from
  2 to 6 `it`s in the affected describe blocks).
- `npx tsc --noEmit`: clean, no output.
- `npx eslint .`: 0 errors, 56 warnings, all pre-existing inline-style warnings in `src/dev/`.

**Believed, not confirmed**: no real llama.cpp parse ran headless. The new shape is the same
`firstChar jchar{0,n-1}` pattern task 37 already put in front of the on-device parser via the
four `.gbnf` files (task 32's device sweep is the source of truth there); this task only extends
that already-exercised shape to the primitive that builds it, plus the novel `min=0` alternation
branch, which is untested on-device. If it matters before a caller actually generates a grammar
with `min=0` through this primitive, that should batch into task 32's device sweep too.

## Deviations from human decisions

None. The brief's four constraints (no underscores in rule names, don't break `buildGrammar`'s
slot substitution, decide and justify where `firstChar` lives, handle `min: 0` explicitly or fail
loudly) were followed as given; no instruction was reinterpreted, skipped, or overridden. This
section is written out explicitly per standing project rule even though it is empty.
