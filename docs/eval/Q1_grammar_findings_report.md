# Q1 Grammar Smoke Test — Findings Report

**Question:** Does GBNF grammar-constrained decoding actually work on `llama.rn` 0.12.5 +
Ternary-Bonsai-4B (TQ1_0), on-device — the assumption strategy doc §3.3 (grammars, bounded
fields, greedy decoding) rests on entirely.

**Verdict: RED.** Grammar-constrained decoding works in general (Stage 0/1 pass cleanly), but
the specific grammar shape task 5 uses for every bounded integer field — `[1-9] [0-9]{0,N}` —
fails to parse on this device's `llama.cpp` build, and the assumed fallback (expand `{m,n}` to
nested optionals) **does not fix it**. No working grammar shape for bounded integers was found
within this spike's scope. §3.3 needs a decision before tasks 6/7/12 build further on the
grammar path: either a redesigned integer-field grammar, or the prompt-JSON + strict-validation
fallback.

**Date:** 2026-07-11 · **Device:** Samsung Galaxy S23 FE (serial `R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf`, SHA-256 `da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c`
· **`llama.rn`:** 0.12.5 · Full machine-readable data: [`q1_results.json`](q1_results.json).

---

## 1. Background

Strategy doc §3.3 depends on GBNF grammar-constrained decoding working reliably: rigid
grammars, bounded fields, greedy decoding, a validate→retry→salvage ladder. An earlier spike
proved the model produces coherent JSON when chat-templated — but with no grammar applied, and
inconsistent shape across prompts. Q1 exists to close that gap: does a real grammar, fired for
real, actually constrain output on this stack? This report answers that question across two
work sessions on the same throwaway harness (`src/dev/Q1GrammarSpikeScreen.tsx`).

Q1 was scoped to four questions (strategy §6.7): (1) do grammars work at all, (2) does the real
extraction grammar produce valid, validator-passing JSON, (3) what's the constrained-vs-
unconstrained overhead, (4) is bounded `{m,n}` repetition supported. This report answers 1 and
4 definitively, and explains why 2 and 3 were never reached.

## 2. Method

**Session 1** built the harness (model load reused from `README_build.md`'s documented
pattern — the original `BonsaiSpikeScreen.tsx` it was meant to crib from no longer exists in
this repo), ran Stages 0–1 live, and live-bisected Stage 2's failure down to a specific field.
A fix was written but not run before the session ended.

**Session 2** confirmed the fix on-device, found it didn't work, and ran five further live
probes to isolate the actual root cause — each one testing and either confirming or refuting a
specific hypothesis about what was failing, narrowing from "the whole grammar" down to a
precise two-token pattern.

All constrained calls used greedy decoding (temperature 0, `top_k` 1), matching production
intent (strategy D9).

## 3. Findings

### 3.1 Stage 0 — does the grammar mechanism work at all: **PASS**

```
root ::= "yes" | "no"
```

Fed a prompt designed to ramble ("Tell me about your day in detail"). Output was constrained to
exactly `"no"`. `llama.rn`'s `completion()` accepts and applies a `grammar` parameter, without
erroring — the foundational Q1 question is answered yes.

### 3.2 Stage 1 — bounded repetition on a *named* rule: **PASS as-authored**

```
root ::= "\"" jchar{1,20} "\""
```

`{m,n}` applied to `jchar` — a named rule whose own definition contains a nested, non-zero-min
exact repetition (`"u" [0-9a-fA-F]{4}`) — worked first try, producing `"Short and sweet!"`. No
expander fallback was needed for this pattern. (In hindsight, per §3.5 below, this result was
correct but for a different reason than originally assumed.)

### 3.3 Stage 2 — the real `task_extraction.v1` grammar: **FAIL**

Instantiating the real grammar via `buildGrammar` and running it against seed fixtures threw
`Error: failed to parse grammar` immediately — parse-time, not generation-time; fails in
<20ms, before any tokens are produced. Live bisection narrowed it precisely:

| Grammar slice | Result |
|---|---|
| `title` alone | PASS |
| `title` + `description` | PASS |
| `title` + `estimated_duration_minutes` (`[1-9] [0-9]{0,3}`) | **FAIL** |

**A second, more severe finding surfaced in the same bisection.** One candidate (`due`, which
also contains an un-expanded `[0-9]{0,2}` in `days_int`) didn't throw a catchable JS error like
the duration case — it **killed the entire app process** (confirmed 3×: process vanishes from
`adb shell ps` entirely, no Java-level crash log, no native tombstone found). The same
underlying error class has two different failure behaviors — a clean throw and a full process
death — and the retry/fallback ladder (spec D10) can only catch the first kind. Note: a later
run this session using the full expanded grammar (which also contains `due`) did **not**
crash — it failed with a normal catchable error instead. One data point, not enough to call the
crash non-reproducible, but worth flagging as inconsistent.

### 3.4 The fix attempt — expand `{m,n}` to nested optionals: **FAILS at every granularity tested**

The original hypothesis: Stage 1 applied `{m,n}` to a *named* rule and passed; Stage 2's
failing case applies it directly to an *inline character class* (`[0-9]{0,3}`). Task 5's
`boundedRepetition.ts` only rewrites `name{m,n}` for one named rule at a time, so this session's
harness generalized it (`expandAllBoundedRepetitionOccurrences`, diagnostic-only code, never
touching `src/llm/`) to also catch inline bracket-expressions and parenthesized groups, then
expand every occurrence to nested optionals.

Tested live on-device at three shrinking granularities — **all three fail identically to the
unfixed grammar**:

| Test | Grammar | Result |
|---|---|---|
| Full grammar, fully expanded | entire `task_extraction.v1.gbnf`, ~5300 chars | **FAIL** — `Error: failed to parse grammar` |
| Small fragment | `title` + `estimated_duration_minutes` only, expanded, 1049 chars | **FAIL** — same error |
| Duration alone | `estimated_duration_minutes` only, expanded | **FAIL** — same error |

This ruled out two plausible explanations before they were ever written down: aggregate
grammar size/complexity (the 1049-char fragment fails just as fast as the 5300-char full
grammar), and `title`'s exceptional nesting depth (`jchar{1,80}` expands to 79 nested optional
groups — dropping `title` entirely and testing duration alone still fails).

### 3.5 Root cause isolation — five targeted probes

With the "just expand it" fix ruled out, five further minimal probes each tested one specific
hypothesis about *why*, in order:

| # | Hypothesis | Probe grammar | Result | Verdict |
|---|---|---|---|---|
| 1 | Naming the repeated class fixes it | `[1-9] (digit (digit (digit)?)?)?`, `digit ::= [0-9]` | FAIL | **Refuted** |
| 2 | `(...)?` isn't supported at all | `"a" ("b")?` | PASS — output `"a"` | **Refuted** |
| 3 | Nesting depth itself is the trigger | `"a" ("b" ("c" ("d")?)?)?` (3 levels, pure literals) | PASS — output `"a"` | **Refuted** |
| 4 | Zero-minimum repetition on a class is the trigger | `"x" [0-9]{4}` and `"x" [0-9]{0,4}` | **both PASS** | **Refuted** |
| 5 | Any two adjacent character classes fail | `[1-9] [0-9]` (no repetition/optionality at all) | PASS — output `"10"` | **Refuted** |

Every individually plausible explanation was directly tested and directly refuted. What
survives, by elimination and by the shape of every failing case above:

> **The trigger is a mandatory character class immediately followed by an
> optional/repeated character-class-derived continuation** — regardless of whether that
> optionality is written as native `{0,N}` or hand-expanded into nested `(...)?` groups.
> The same character classes with *no* optionality (`[1-9] [0-9]`), and optional/nested
> groups built purely from string literals, both parse and generate correctly in isolation.

This also retroactively explains Stage 1's pass: `jchar{1,20}` applies `{m,n}` to a rule whose
body is an *alternation*, not a bare character class in an optional-continuation position — a
structurally different (and apparently safe) shape.

## 4. Scope of impact

This is not specific to `estimated_duration_minutes` or to `task_extraction.v1`. Task 5's
`boundedIntRule` primitive (`src/llm/grammar/primitives.ts`) generates exactly the vulnerable
shape (`[1-9] [0-9]{0,N}`) for every bounded integer field. Checked directly against all four
schemas:

| Schema | Vulnerable fields | Grammar shape |
|---|---|---|
| `task_extraction.v1` | `estimated_duration_minutes`, `days_int`, `quota_int`, `target_int` | `[1-9] [0-9]{0,N}` |
| `task_breakdown.v1` | `estimated_duration_minutes` | `[1-9] [0-9]{0,3}` |
| `coaching_resolution.v1` | `duration_int`, `days_int` | `[1-9] [0-9]{0,N}` |
| `summary.v1` | **none** — has no bounded-integer fields | n/a |

Three of the four schemas are affected; `summary.v1` happens not to need bounded integers at
all. Array-style fields (`context_tags`, `tool_requirements`, `weekday_array`, `key_points`)
use `("," rule){0,N}` where `rule` is a named alternation of string literals (like `jchar` or
`weekday`), not a bare character class — structurally closer to Stage 1's confirmed-working
pattern than to the failing one. This wasn't directly tested this session, so treat it as a
reasonable inference from the isolated trigger condition, not a confirmed-safe result.

## 5. What was not run

- **Stage 2's real numbers** (fixture pass/fail count, validator pass rate across the 4 seed
  prompts) — never captured, because no version of the grammar parses.
- **Stage 3** (constrained vs. unconstrained tok/s, grammar-compile time) — not run; measuring
  overhead against a grammar that doesn't parse isn't meaningful.

Both remain blocked on either a redesigned bounded-integer grammar shape or a decision to stop
pursuing the grammar path for these fields.

## 6. Verdict against the brief's rubric

The brief's own rubric (`docs/briefs/Q1_grammar_smoke_test_brief.md`):

> **RED — escalate before the batch builds on it.** Stage 0 errors/crashes, or Stage 2 output
> is still invalid despite the grammar, or overhead is crippling. → The fallback world:
> prompt-JSON + strict validation + one-retry, no hard constraint.

Stage 0 passes cleanly, so this isn't a binding/stack problem. But Stage 2 output is invalid
despite the grammar, **and** the rubric's own assumed escape hatch — flip on the `{m,n}`
expander — is now confirmed not to be one. That's a materially worse position than the
"YELLOW, needs the expander" the original bisection pointed toward: there is currently no known
working grammar shape for bounded integers on this stack.

## 7. Options going forward (not evaluated further — a design decision, not a spike finding)

1. **Redesign the bounded-integer grammar shape.** E.g., alternation of fixed-width branches
   (`"1"|"2"|...|"9"|"10"|"11"|...`) instead of a mandatory digit followed by an optional tail —
   sidesteps the isolated trigger condition entirely, since alternation between fully-mandatory
   branches has no "class immediately followed by optional class" position. **Untested
   hypothesis, not a finding** — impractical to hand-enumerate for large ranges (e.g. 1–1440
   minutes) without codegen, and would need its own on-device confirmation before trusting it.
2. **Fall back to prompt-JSON + strict validation + one retry, no hard constraint** for
   bounded-integer fields specifically (grammars could still constrain everything else — enums,
   string bounds, structural shape). A partial, more surgical version of the brief's full RED
   fallback.
3. **Full fallback**, per the brief's RED path: prompt-JSON + strict validation + retry for the
   whole surface, no grammar constraint at all.

## 8. Reproduction

- Harness: [`src/dev/Q1GrammarSpikeScreen.tsx`](../../src/dev/Q1GrammarSpikeScreen.tsx)
  (commit `c3d1cd6` adds the session-2 probes; diagnostic functions/buttons are still present,
  not yet cleaned up — see the brief's open items).
- Raw data: [`q1_results.json`](q1_results.json).
- Full narrative + environment gotchas (Metro, `adb` path-mangling in Git Bash, OS gesture-nav
  zone catching taps near the screen edge, etc.): the session-handoff box at the top of
  [`docs/briefs/Q1_grammar_smoke_test_brief.md`](../briefs/Q1_grammar_smoke_test_brief.md).
- Reassembly tool for a full uninterrupted run's logcat: `scripts/q1-reassemble.js`.
