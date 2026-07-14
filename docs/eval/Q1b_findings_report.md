# Q1b Findings Report — bounded-integer repair + the date_str grammar bug

**For:** an Opus agent picking up this thread. You were not in the room for any of this — read
in full before touching code. This report is self-contained; it also links back to the two
documents it builds on.

**Question:** Q1b's brief asked three things: (1) validate the digit-width-alternation fix for
`boundedIntRule`, (2) confirm the array-shape inference the Q1 report made without testing, (3)
confirm the `due` union parses once `days_int` is fixed. All three were run live on-device. The
third didn't pass — which opened a second, unrelated investigation into why, and that
investigation is most of this report.

**Verdict: fix applied for `date_str`, decision still pending for `boundedIntRule`.**
- Probe A (digit-width alternation) and Probe B (array shape) both **pass** — validated, not yet
  applied to `src/llm/grammar/primitives.ts`.
- The `due` union still failed after the `days_int` fix, for a **second, completely unrelated
  bug**: `date_str`. Nine structural fix attempts against that bug all failed before the actual
  cause was isolated (see §3). A tenth attempt found it and works — **applied and tested live**,
  in both `.gbnf` files that had the pattern.
- Along the way, three more likely-broken fields were discovered in
  `coaching_resolution.v1.gbnf` that share the exact same bug and were never previously tested.
  **Not fixed** — flagged in §5 for you to pick up.

**Date:** 2026-07-13 · **Device:** Samsung Galaxy S23 FE (serial `R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf`, SHA-256 `da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c`
· **`llama.rn`:** 0.12.5 · Full machine-readable data: [`q1b_results.json`](q1b_results.json).

**Read first, in order:** [`Q1_grammar_findings_report.md`](Q1_grammar_findings_report.md) (the
original Q1 investigation — its isolated trigger condition is what Q1b's brief responds to),
then [`docs/briefs/Q1b_bounded_integer_probe_brief.md`](../briefs/Q1b_bounded_integer_probe_brief.md)
(what this session was asked to do).

---

## 1. Q1b's three probes (as briefed)

Run from `src/dev/Q1GrammarSpikeScreen.tsx`, under a new "Q1b: bounded-integer repair probes"
section.

| Probe | Grammar | Result |
|---|---|---|
| A — digit-width int alternation | `intval ::= i4\|i3\|i2\|i1`, each a fixed-width run of mandatory classes | **PASS** — parses and generates a real multi-digit value (`245`) once the prompt was tightened to stop the model answering with a single digit |
| B — array-of-named-alternation shape | `"[" (day ("," day){0,2})? "]"` | **PASS** — parses, emits a valid 3-element array |
| C — `due` union with `days_int` fixed via Probe A's shape | full `due` union, `days_int` rebuilt as `d3\|d2\|d1` | **FAIL** — does not parse. Notably: **did not crash the process** this run (Q1's original crash on this exact shape did not reproduce — consistent with Q1's own note that it wasn't reliably reproducible) |

Probe A and B are genuine, validated confirmations of the brief's hypotheses. Probe C's failure
is what this report is mostly about.

## 2. Why Probe C failed: isolating `date_str`

Bisecting `due`'s three non-null branches (`due_on_date`, `due_in_days`, `due_weekday`) by
elimination pointed at `due_on_date`'s `date_str` rule:

```gbnf
date_str ::= [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]
```

This has **no optionality at all** — every character class matches exactly once. By the
original Q1 report's own characterized trigger ("a mandatory character class immediately
followed by an *optional* class-derived continuation"), this shape should be perfectly safe. It
isn't — confirmed failing, then **re-confirmed as the first call on a completely fresh native
context** (force-stop + relaunch), ruling out a stale/poisoned context as the explanation.

This is a **second, distinct, previously-uncharacterized parser bug**, unrelated to the one Q1
found and unrelated to what Probe A fixed.

## 3. Nine dead ends before the real cause (read this before proposing a tenth)

Each of these was a reasoned, structurally-distinct hypothesis, tested live, and refuted. Do not
re-attempt any of them — they're listed so the next person doesn't repeat the work.

| # | Hypothesis | Result |
|---|---|---|
| 1 | Naming the digit class (`digit ::= [0-9]`) instead of inline `[0-9]` | FAIL |
| 2 | Literal digit alternation (`"0"\|"1"\|...\|"9"`) — zero bracket-classes anywhere | FAIL |
| 3 | `{m,n}` operator on named sub-rules (`year ::= digit{4,4}`), distinct symbols | FAIL |
| 4 | Fold the `"-"` separator into each branch's own literal (`month_dash ::= "-01"\|...`) — zero standalone literal tokens between symbols | FAIL |
| 5 | Fallback: bounded `jchar` string, exact count (`jchar{10,10}`) | FAIL |
| 6 | Same fallback, a real range instead of exact-count (`jchar{1,10}`) | FAIL |
| 7 | `date_str` given its own quote literals (mirrors `title`/`description`'s exact shape) | FAIL |
| 8 | Same as #7, bound changed to the already-proven `{1,20}` | FAIL |
| 9 | Control: rename `date`/`date_str` to an unrelated `foo`/`foo_str`, same everything else | FAIL |

Also ruled out along the way: **context poisoning** (one failed grammar compile corrupting a
reused native context for every later call on it — real, and worth knowing about, but not the
explanation here: `date_str`'s original failure and every fix attempt from #7 onward were
independently re-confirmed on freshly relaunched, never-before-used contexts); **non-determinism**
(the same passing/failing grammars were re-run 2× each and were 100% reproducible, not flaky);
and **`llama.rn`'s jinja auto-grammar override** (its JS layer can silently overwrite an explicit
`grammar` param with one generated by chat-template processing when `jinja` isn't set to
`false` — a real footgun, found by reading `node_modules/llama.rn/src/index.ts:408`, but forcing
`jinja: false` on the failing grammar didn't change the result, so it isn't the mechanism here).

## 4. The actual trigger, and the fix

Isolated by controlled pairwise comparison, holding every other variable constant:

> **For a `jchar{m,n}`-based rule, the rule name referenced from its parent must exactly match
> its own JSON key text, or the grammar fails to parse.**

Evidence (all on fresh, never-before-used native contexts, each re-run twice):

- `title ::= "\"" jchar{1,80} "\""`, referenced as `root ::= "{\"title\":" title "}"` — key
  `"title"` matches rule name `title`. **PASSES, 2/2.**
- Identical grammar, renamed to `foo_str`, key still `"foo"` (`root ::= "{\"foo\":" foo_str "}"`)
  — key `"foo"` does **not** match rule name `foo_str`. **FAILS, 2/2**, same bound (80),
  same everything else.
- Same grammar again, rule renamed to `foo` (matching its key exactly) — **PASSES.**

Bound value, indirection depth, exact-count vs. range, character classes vs. literal
alternation, and the specific string "date" were all independently ruled out first (§3). Naming
match is the one variable left, and flipping it flips the result every time it was tested. **The
mechanism inside `llama.cpp`/`llama.rn` that produces this was not identified** — this is an
empirical characterization, not a root-caused explanation. Treat it as a hard constraint on this
build, not a fully understood one.

**The fix**, validated directly in the real `due_on_date` shape (not a toy example) before being
applied:

```gbnf
due_on_date ::= "{\"kind\":\"on_date\",\"date\":" date "}"
date ::= "\"" jchar{1,10} "\""
```

`date_str` → `date` (matches the `"date"` key), given its own quote literals instead of relying
on the parent's literal to supply them (mirrors `title`/`description`'s proven shape exactly).
Live-confirmed: parses, and generates a real, correctly-formatted date (`2026-07-13`, today's
date, unprompted beyond "reply with exactly...").

**Applied to:**
- [`src/llm/extraction/task_extraction.v1.gbnf`](../../src/llm/extraction/task_extraction.v1.gbnf) (`due_on_date`)
- [`src/llm/resolution/coaching_resolution.v1.gbnf`](../../src/llm/resolution/coaching_resolution.v1.gbnf) (`until_on_date` — identical duplicate of the same pattern)
- [`src/dev/extractionGrammarText.ts`](../../src/dev/extractionGrammarText.ts) (the Metro-importable mirror; there's a byte-identical drift-guard test on this, updated in lockstep)

**Digit/dash structure is no longer grammar-enforced.** The grammar now only bounds length
(1–10 JSON-safe characters); it no longer requires digits and dashes in the right positions.
This is safe: `validator.ts` in **both** affected schemas already independently regex-checks
`^\d{4}-\d{2}-\d{2}$` before the date is trusted (confirmed by reading both files *before*
applying the fix, not assumed) — the D10 retry ladder catches anything malformed.

**Verified after applying:**
- `npx tsc --noEmit` — clean.
- `npx jest` — **29/29 suites, 244/244 tests pass**, including the byte-identical
  `extractionGrammarText.test.ts` drift guard.
- Not yet re-run: task 5's Stage 2/3 (blocked on `boundedIntRule` — see §6).

## 5. Not fixed — flagged for you

While isolating the trigger, grepping both `.gbnf` files for jchar-based fields where the rule
name doesn't match its own JSON key turned up three more in
**`coaching_resolution.v1.gbnf`**, all previously untested:

| Rule | Its JSON key | Used in |
|---|---|---|
| `changes_notes` | `"approach_notes"` | `changes` (part of `modify_task`) |
| `reason120` | `"reason"` | `eliminate_task` **and** `no_change` (two call sites) |
| `condition120` | `"condition"` | `until_condition` |

These match the confirmed bug pattern exactly (jchar-based, rule name ≠ own key) and are very
likely broken the same way `date_str` was, but **this was not tested live** — it's a pattern
match against a confirmed bug, not an independent confirmation. Before fixing:

1. Confirm each one actually fails (don't assume — `date_str`'s bug had a genuinely
   unpredictable trigger; verify before touching).
2. Apply the same fix shape: rename each rule to match its key exactly
   (`changes_notes` → `approach_notes`, `reason120` → `reason`, `condition120` → `condition`),
   give each its own quote literals, keep the same bounds (200/120/120 respectively — those
   aren't implicated by anything found here).
3. Re-run `npx jest` after — no drift-guard test exists for `coaching_resolution.v1.gbnf` (only
   `task_extraction.v1.gbnf` has a Metro mirror), so there's nothing to keep in sync, just the
   validator tests to re-check.
4. Grep the OTHER two schemas (`task_breakdown.v1.gbnf`, `summary.v1.gbnf`) for the same
   pattern too — they weren't in scope for this session's checks beyond the initial `date_str`
   duplicate search, but the same bug class could exist there. `task_breakdown.v1.gbnf`'s only
   jchar field (`title`) already matches its key; `summary.v1.gbnf`'s do too (`disposition`,
   `energy_note`, `key_points`) — a first pass suggests these two files are clean, but worth a
   second look before considering the whole surface covered.

## 6. `boundedIntRule` — validated, not applied

Probe A validated the digit-width-alternation shape live. It has **not** been applied to
`src/llm/grammar/primitives.ts`'s `boundedIntRule` function, per the original session's explicit
instruction to report back before applying any fix — that instruction was never superseded for
this specific change (it was for `date_str`, which is a hand-written `.gbnf` construct, not the
generated `boundedIntRule` primitive).

If/when you apply it: the Q1b brief (§"The fix", in
[`docs/briefs/Q1b_bounded_integer_probe_brief.md`](../briefs/Q1b_bounded_integer_probe_brief.md))
has the scope discipline already spelled out — one-primitive change, don't touch schemas/
validators/bounds, add a regression-guard unit test, regenerate the affected `.gbnf` files. That
guidance still stands; nothing found in this session changes it. Once applied, task 5's Stage 2
and Stage 3 (blocked purely on `due` not parsing) become runnable for the first time.

## 7. Recommended next steps, in order

1. Decide on `boundedIntRule` (§6) — it's validated and low-risk to apply.
2. Verify and fix the three flagged `coaching_resolution.v1.gbnf` fields (§5).
3. Second-pass grep `task_breakdown.v1.gbnf` and `summary.v1.gbnf` for the same pattern, to
   close out the "is this the whole surface" question properly.
4. Once `due` and `boundedIntRule` are both fixed, run task 5's Stage 2 (real fixture pass/fail
   + validator pass rate) and Stage 3 (constrained vs. unconstrained tok/s) for the first time —
   these were blocked from Q1 through today purely on parse failures, never on anything about
   the model's actual extraction quality.
5. Consider whether the naming-must-match-key constraint (§4) belongs in a code comment/lint
   convention at the top of every `.gbnf` file, or in `src/llm/grammar/primitives.ts`'s own
   header — it's a landmine for anyone hand-authoring a new bounded-string field later, and nothing
   in GBNF's own syntax will warn them.

## 8. Reproduction

- Harnesses: [`src/dev/Q1GrammarSpikeScreen.tsx`](../../src/dev/Q1GrammarSpikeScreen.tsx) (Q1b
  probes A/B/C, poison-check) and
  [`src/dev/DateStrProbeScreen.tsx`](../../src/dev/DateStrProbeScreen.tsx) (all `date_str`
  probes C1 through P) — reachable via a "Q1 Harness" / "date_str Probes" switcher added to
  `App.tsx`. Both are throwaway dev spikes; diagnostic buttons are left in place, not cleaned up
  (matching this whole investigation's own established convention).
- Raw data: [`q1b_results.json`](q1b_results.json).
- If you re-run any probe expecting a **fresh** result: force-stop and relaunch the app first
  (`adb shell am force-stop com.todoai && adb shell am start -n com.todoai/.MainActivity`) — Fast
  Refresh preserves the loaded native context across JS edits, which is convenient for iteration
  but means a probe's result can be confounded by whatever ran on that same context before it
  (§3's poisoning note). Every finding in this report that mattered was re-verified this way;
  don't trust a single non-fresh run for anything new.
- Environment gotchas (Git Bash mangling `adb` device paths, the OS gesture-nav zone eating taps
  near the screen bottom, Metro dying silently on long sessions, etc.): see the session-handoff
  box at the top of
  [`docs/briefs/Q1_grammar_smoke_test_brief.md`](../briefs/Q1_grammar_smoke_test_brief.md). One
  new gotcha from this session: a switcher UI added to `App.tsx` without a top safe-area inset
  rendered under the status bar and silently ate its own taps — fixed with
  `useSafeAreaInsets()`; watch for this if adding more top-of-screen controls to either harness.
