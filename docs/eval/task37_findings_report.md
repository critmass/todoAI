# Task 37 — Extraction-grammar separator-token hole: findings report

**Date:** 2026-08-17 · **Branch:** `main` · **Commit:** `0ad7184`
**Brief:** `docs/briefs/grammar_separator_hole_task_37.md`
**Source defect report:** `docs/eval/qwen35_spike_findings.md`, "Two defects found" §2
(that document is superseded as a *model-base verdict* by `model_base_spike_final_findings.md`;
its grammar-defect analysis is what this task acted on, and it held up)

---

## 1. The defect, restated from the code

A GBNF rule of the shape `name ::= "\"" jchar{1,n} "\""` is satisfied by the single token `","`.
The opening quote literal starts the string, `,` is a member of the `jchar` class
(`[^"\\\x00-\x1F] | ...` — it excludes only the quote, the backslash, and control characters),
and the closing quote literal ends it. Nothing downstream caught it:

- the JSON parse succeeds — `","` is well-formed;
- `taskExtractionSchema`'s `z.string().min(1).max(80)` passes — length is 1;
- `task_extraction.v1.json`'s `minLength: 1` passes for the same reason;
- `validate()`'s cross-field rule `data.title.trim().length === 0` passes, because a comma
  trims to a comma.

A task titled `,` was therefore savable through every gate the pipeline has. The Qwen3.5-2B
spike produced it on 13–15 of 16 fixtures. Bonsai has never produced it because it does not rank
that token first at that position — which is a property of the incumbent model's weights, not of
the grammar, and would evaporate on any model change.

**The brief was right on every point I could check**, including the negative result: a minimum
length does not close the hole, because the leading separator is admitted regardless of what
follows it.

## 2. Which slots had the hole

Audited by reading all four checked-in `.gbnf` sources, not by assumption. Every rule below had
the bare `"\"" jchar{1,n} "\""` shape and was therefore satisfiable by `","`.

| Grammar | Rules with the hole |
|---|---|
| `src/llm/extraction/task_extraction.v1.gbnf` | `title`, `description`, `date`, `newTag`, `tool` |
| `src/llm/breakdown/task_breakdown.v1.gbnf` | `title` |
| `src/llm/resolution/coaching_resolution.v1.gbnf` | `newTag`, `changesNotes`, `reason120`, `date`, `condition120`, `title` |
| `src/llm/summary/summary.v1.gbnf` | `keyPoint`, `disposition`, `energyNote` |

**15 rules across 4 grammars.** The brief named `title` and `description` as confirmed and
flagged `newTag`, `tool`, `date` for audit; all three were hits. The brief did not enumerate the
resolution and summary grammars' individual rules — those came out of the audit.

**On `date` specifically** (the brief asked for it to be checked separately): it *was*
collapsible. Its digit/dash structure is no longer grammar-enforced — the file's own comment
records that `validator.ts`'s `^\d{4}-\d{2}-\d{2}$` regex is "the sole enforcer of the real
YYYY-MM-DD shape now" — so the grammar accepted `","` there too. The difference from `title` is
that the *consequence* was bounded: the date regex would have rejected it and thrown into the
D10 retry ladder, a loud failure rather than a silent bad save. It is fixed for consistency, and
because a first character of `[a-zA-Z0-9]` is strictly implied by a date anyway.

**One rule is deliberately exempt.** `tagKnown ::= "\"" {{context_tags_known}} "\""` opens with a
D7 dynamic slot, not a character class. `buildGrammar` replaces it with a closed alternation of
literal tag strings the app already holds, so the model can only select one of the offered
values — there is no separator to emit. The regression test documents this exemption explicitly
rather than silently skipping it.

## 3. The fix applied

A new shared primitive in each of the four grammars:

```
firstChar ::= [a-zA-Z0-9]
```

and every affected rule rewritten from `"\"" jchar{1,n} "\""` to `"\"" firstChar jchar{0,n-1} "\""`.

**Bounds are unchanged.** `firstChar` + `jchar{0,n-1}` spans exactly the same 1..n characters as
`jchar{1,n}` did, so no length contract with zod or the JSON Schema moved. I checked this rule by
rule rather than applying it mechanically.

Constraint compliance:

- **Constraint #2 (no underscores in rule names):** `firstChar`, camelCase, matches
  `/^[a-zA-Z][a-zA-Z0-9]*$/`. `ruleNaming.test.ts` passes on all four files and on `buildGrammar`'s
  substituted output.
- **`#` comments:** left exactly as they are, and the new explanatory comments are `#` comments
  in the same style. No comment-handling step was added or removed.
- **Constraint #3 (startup guard):** see §6 for what was and was not verified.
- **Embedded-copy drift guards:** there are **two**, not one. `src/llm/grammar/grammarText.ts`
  (all four grammars, guarded by `grammarText.test.ts`) and `src/dev/extractionGrammarText.ts`
  (the extraction grammar only, guarded by `src/dev/__tests__/extractionGrammarText.test.ts`).
  The brief mentions only the first; missing the second would have failed the suite. Both were
  regenerated from the `.gbnf` sources rather than hand-patched, per their headers' instruction.

### Cost of the fix, stated honestly

Requiring an alphanumeric first character forbids legitimate leading characters: `$50 to the
landlord`, `(re)schedule dentist`, `"Salem's Lot" return`. This is **not** a rejection cost. Under
grammar-constrained decoding the forbidden token is simply unavailable at that position, so the
model takes its next-best token and emits e.g. `50 dollars to the landlord` or `Reschedule
dentist`. The cost is a mildly different phrasing, not a failed capture. That asymmetry —
generation-time constraint is cheap, validation-time rejection is expensive — is the reason the
two layers are deliberately different (§4).

## 4. The validator layer: adopted, and deliberately weaker

**Adopted.** `validate()` in `src/llm/extraction/validator.ts` now rejects a title containing no
alphanumeric character anywhere:

```ts
} else if (!HAS_ALPHANUMERIC.test(data.title)) {
  issues.push('title: must contain at least one alphanumeric character');
}
```

It is placed in the cross-field section next to the existing trim check, **not** in
`taskExtractionSchema`. That placement matters: `schemaDrift.test.ts` asserts that the zod object
schema and the JSON Schema agree via ajv, so a rule added to the zod object would have required a
matching `pattern` in `task_extraction.v1.json`. Cross-field rules live outside that comparison,
exactly as `title.trim()` already does. No schema change was needed.

**Why it is weaker than the grammar rule** (has-an-alphanumeric-somewhere, not
alphanumeric-first): the grammar constrains generation and costs a phrasing; this check *rejects*
and throws into the D10 retry ladder. Making the two layers identical would fail `$50 to the
landlord` outright at validation time even though the grammar path would never have produced it.
The layers cover different failure modes and should not be the same rule:

- the grammar closes the hole at the source, on the grammar path;
- the validator covers the **prompt-JSON fallback path**, where the startup guard has disabled
  grammars entirely and no grammar constraint is in play at all. That path is precisely where a
  bare `","` is most likely and least defended, and it is why one layer was never enough.

**What I did not extend it to.** I considered applying the same check to `context_tags` and
`tool_requirements` (the brief's junk-tag motivation) and decided against it. A junk tag is
cosmetic; throwing the whole extraction into a retry over one cosmetic array element is
disproportionate, and the grammar layer now handles the generatable form of that junk. This was
the brief's explicit "decide whether", so it is a decision inside my remit, not a deviation —
but it is a judgment Jason can reverse cheaply if he'd rather have the stricter behavior.

## 5. The junk-tag suspicion: partly confirmed, and it splits in two

The spike suspected Bonsai's observed junk tags — `":mixing"`, `":episode"`,
`"work_on_it_until_did"` — were the same defect in milder form. **They are two different things,
and the brief's framing merges them.**

- **`":mixing"` and `":episode"` are the same root cause.** Both are leading-separator artifacts
  from `newTag ::= "\"" jchar{1,20} "\""`: the model emitted a colon token in first position
  because the grammar permitted it. The `firstChar` fix **does** close this — a leading `:` is now
  ungeneratable in `newTag`. Same defect, milder because the model continued with real content
  after the separator instead of closing the string immediately. This confirms the spike's
  suspicion for these two.
- **`"work_on_it_until_did"` is not the same cause at all.** It begins with `w` — an alphanumeric.
  No first-character rule touches it, and no length or character-class rule would. It is a
  phrasing failure: the model produced a snake_case sentence fragment where a short tag was
  wanted. That is a prompt/instruction problem or a candidate for a `newTag` shape constraint
  (e.g. forbidding `_`), and **it is not fixed by this task.** Neither the brief nor the spike
  distinguished these; I am flagging it so nobody reads "task 37 fixed the junk tags" and stops
  looking.

**A related residue the audit surfaced:** `tagKnown`'s alternation is populated from tags the app
already holds, and those were seeded by earlier `newTag` emissions. So any junk tag already
persisted in the database will keep being offered back to the model as a legitimate known tag,
forever, regardless of this fix. The grammar fix stops new junk of the leading-separator kind from
entering; it does not clean what is already stored. If the alpha database has `":mixing"` in it,
that needs a data pass, not a grammar pass.

## 6. Verification

| Check | Result |
|---|---|
| `npx jest` | **811 passing in the real tree**, 69 suites (raw report: 1605 / 137 — see note) |
| `npx tsc --noEmit` | clean, no output |
| `npx eslint .` | 0 errors, 56 warnings (all pre-existing inline-style in `src/dev/`) |
| `grammarText.test.ts` drift guard | pass |
| `src/dev/__tests__/extractionGrammarText.test.ts` drift guard | pass |
| `ruleNaming.test.ts` (no-underscore lint) | pass, incl. `buildGrammar` output |
| `schemaDrift.test.ts` (zod ↔ JSON Schema via ajv) | pass, unchanged |

**On the jest count.** The stale worktree at `.claude/worktrees/interesting-shirley-e10fa1` is
collected as a second copy of the tree and contributes 68 suites / 794 tests of its own. Baseline
before this task: 1588 raw = 794 real. After: 1605 raw = **811 real**, +17, all in the real tree
(the worktree copy is an old commit and did not move: 137 − 68 = 69, 1605 − 794 = 811). No failure
occurred in either copy.

**Tests added (the pinning fixture the brief asked for):**

- `src/llm/extraction/__tests__/validator.test.ts` — `','` as a title is now **rejected**, along
  with `'.'`, `':'`, `'-'`, `',,,'`, `' , '`, `'::'`, `'--'`. Plus the companion assertion that
  `'$50 to the landlord'`, `'(re)schedule dentist'` and `'"Salem\'s Lot" return'` are still
  **accepted**, which pins the deliberate weakness of the validator layer so a later "tighten it
  to match the grammar" change fails loudly.
- `src/llm/grammar/__tests__/freeTextFirstChar.test.ts` — new. Reads all four `.gbnf` sources
  (the text that actually reaches the on-device parser) and asserts: every quoted-string rule
  opens with `firstChar`; `firstChar` is defined as `[a-zA-Z0-9]` in each file; no
  `jchar{1,` repetition survives anywhere; and all of that still holds through `buildGrammar`
  substitution with representative slot values. It has a guard-the-guard assertion so it cannot
  pass vacuously if the scanning regex stops matching.

### 🔴 Believed, not confirmed

**No real llama.cpp parse of the edited grammars has happened.** Constraint #3 requires the
startup guard to compile every registered grammar before any user session, and the guard is
device-only — headlessly I can verify that `buildGrammar` substitution succeeds and that the
tightened rules survive it, which is what `freeTextFirstChar.test.ts` does, but that is a string
check, not a parse. `{m,n}` bounded repetition itself is confirmed working on this build (Q1c),
and `firstChar ::= [a-zA-Z0-9]` is an ordinary character-class rule with a lint-clean name using
no construct the file did not already use — so I have no specific reason to expect a parse
failure. **That is an argument, not a measurement.** The device check is task 32's device sweep,
per the brief, and until it runs:

1. that the four grammars still compile through the startup guard, and
2. that normal extraction did not regress on Bonsai through the tightened grammar

are both **believed, not confirmed**. If (1) fails the consequence is contained by design — the
guard disables the grammar path and falls back to prompt-JSON + validation, where the new
validator layer is the live defense.

## 7. Residue and follow-ups (not done here, deliberately)

- **`boundedStringRule` in `src/llm/grammar/primitives.ts` still emits the vulnerable shape.**
  It builds `${ruleName} ::= "\"" jchar{${min},${max}} "\""` — the exact pattern this task removed
  from every checked-in grammar. It is exported from `src/llm/index.ts`, and nothing currently
  generates a grammar from it at runtime (the four `.gbnf` files are hand-authored), so it is not
  a live bug today. But a fifth grammar authored with it would reintroduce the hole silently. I
  left it alone because it is outside the file scope I was given;
  `freeTextFirstChar.test.ts` would catch the resulting `.gbnf`, which is the important half.
- **`"work_on_it_until_did"`-class junk tags are unfixed** — see §5. Different root cause.
- **Already-persisted junk tags are unfixed** — see §5, `tagKnown` note. Needs a data pass.
- **`description`, `changesNotes`, `keyPoint`, `disposition`, `energyNote` have no validator-layer
  alphanumeric check** — only `title` does. The grammar covers them on the grammar path; on the
  prompt-JSON fallback path they are as exposed as `title` was. I judged `title` the field where a
  junk value does real damage (it becomes the task's identity) and the others cosmetic, so I did
  not spend rejection-cost on them. Reversible if that reads wrong.

## Deviations from human decisions

**One.**

**I edited `src/llm/summary/summary.v1.gbnf`, which was not in the file scope I was given.**
The scope named my files as the extraction grammar, its embedded copy, the validator, "and the
coaching/breakdown grammars if the audit finds the pattern there." The brief's §2 enumeration
likewise says "this grammar or the coaching/breakdown grammars." Summary is in neither list.

Mechanism and reasoning: `summary.v1.gbnf`'s `keyPoint`, `disposition` and `energyNote` have the
identical `"\"" jchar{1,n} "\""` shape and the identical hole. The brief's own definition of done
says the hole must be closed in "every other string slot sharing the pattern (audited, not
assumed)," which points the other way from its enumeration — I read the omission as an artifact of
the spike having only examined the extraction grammar, not as a decision to leave summary
vulnerable. `src/llm/summary/` is not owned by task 41 Phase 2, so no file-disjointness was
broken. But it is a departure from the explicit list, and reporting it as merely "thorough" would
be exactly the laundering the standing rule exists to prevent.

**Provisional until Jason rules.** Reverting is cheap and self-contained: revert the three rules
and the `firstChar` definition in `summary.v1.gbnf`, regenerate `grammarText.ts`, and remove
`summary.v1.gbnf` from `freeTextFirstChar.test.ts`'s file list. The three summary rules would then
be knowingly-vulnerable, which is why I did not choose that by default.

*(Two things that are explicitly **not** listed here because they are not deviations: the decision
not to extend the validator check to `context_tags`/`tool_requirements` (§4) and the decision not
to touch `primitives.ts` (§7). The first is a judgment the brief expressly delegated to me
("decide whether"); the second is scope compliance, not a departure from it. Both are recorded
above so Jason can overturn either.)*

## Correction to the brief

The brief §3 says "**The** grammar text has an embedded-copy drift guard," singular, naming only
`grammarText.ts`. There are two. `src/dev/extractionGrammarText.ts` holds a second byte-identical
copy of the extraction grammar with its own drift test. A session that regenerated only the one
named in the brief would have had the suite fail on a file the brief never mentioned. Flagging it
so the next grammar edit does not lose time to it.

---

## Appendix — the coordinator's spawn prompt (added for completeness)

*Added by the coordinator 2026-08-19. Per the rule ruled that day (every subagent gets a durable written brief, not just an inline prompt), this appendix records verbatim the inline prompt the coordinator sent when spawning this task's subagent. It supplements the pre-existing brief `docs/briefs/grammar_separator_hole_task_37.md`, which the prompt points to.*

> You are executing **task 37** on the todoAI project (repo root: `C:\Users\physi\Documents\projects\todoAI`, branch `main`). You are the builder, not the coordinator. Jason is the sole developer and decision-maker.
>
> **Your work order:** `docs/briefs/grammar_separator_hole_task_37.md` is your brief and it is complete — read it first and follow it. It even contains the spike-confirmed fix. Also read, as it instructs: (1) `docs/eval/qwen35_spike_findings.md` — the "Two defects found" section (⚠ this report is superseded as a model-base verdict by `model_base_spike_final_findings.md`, but its grammar defect analysis stands and is your spec; do not take any "stay on Bonsai" conclusion from it); (2) `src/llm/extraction/task_extraction.v1.gbnf`; (3) `validateTaskExtraction` in `src/llm/`; (4) `docs/briefs/orientation_for_opus.md` §4 and §1.
>
> **Summary of the bug:** `title ::= "\"" jchar{1,80} "\""` accepts a bare `","` as a complete, schema-valid, validator-passing title — the validator only checks `title.trim().length > 0`, and a comma trims to a comma. Bonsai dodges it by not ranking `","` first; Qwen3.5-2B hit it 13–15 of 16. **Fix: require the first character to be alphanumeric** (`[a-zA-Z0-9]`, then the existing `jchar` set for the remainder). **A minimum length does NOT work** — the spike tested it; `",Trash collection"` passes a 3-char minimum. **Audit, don't assume:** `title` and `description` confirmed; `newTag`, `tool`, `date` flagged and need checking individually, plus any other free-text slot using the bare `jchar{n,m}` pattern in this grammar or the coaching/breakdown grammars.
>
> **Constraints that will bite you:** No underscores in GBNF rule names (`/^[a-zA-Z][a-zA-Z0-9]*$/`, lint-enforced) — factor out a `firstChar`, not `first_char`; a build quirk of this llama.cpp lexer, do not "fix" the workaround. `#` comments parse fine on this build — do not add or strip a comment step. The startup guard compiles every grammar — confirm yours still compiles through `buildGrammar` against representative slot values; a malformed grammar can kill the process uncatchably, worse than the bug. Embedded-copy drift guard: the `.gbnf` on disk and the generated `.ts` constant must stay in sync; regenerate the embedded copy after editing.
>
> **Verification:** Run `npx jest`, `npx tsc --noEmit`, `npx eslint .`. 🔴 The jest count is a known trap — it reports ~1588; the real number is 794. A stale git worktree at `.claude/worktrees/interesting-shirley-e10fa1` is a second copy of the tree inside the project and jest collects its 68 suites too. Jason ruled it stays. Halve any count you quote, and if a test fails check whether it failed in the real tree or the duplicate. Baseline before you start: 794 green, tsc clean, eslint 0 errors / 56 warnings (all inline-style in `src/dev/`). Add a fixture that pins the fix: a model output of `","` for a title is now rejected, not saved.
>
> **Deliverable:** a findings report at `docs/eval/task37_findings_report.md` covering: which slots had the hole, the fix applied, whether you added the validator defense-in-depth layer (recommended: yes — a title with no alphanumeric character is never a real task, and it also catches the milder junk-tag cases), and whether the junk-tag suspicion (Bonsai's `":mixing"`, `":episode"`, `"work_on_it_until_did"`) is the same root cause in milder form. 🔴 Your report MUST contain a section titled exactly "Deviations from human decisions" (standing project rule, coordinator handoff §4); separate from "decisions this task had to make" and "deferred deliberately"; empty is a valid answer and must be written out explicitly; a deviation is provisional until Jason rules it. Code comments must cite the document that actually authorises them — a false "per the task brief" has already fooled a coordinator here.
>
> **Scope boundaries:** Do not touch `src/capture/`, `src/llm/errors.ts`, `src/llm/provider/ladder.ts`, `src/app/`, `src/execution/`, `src/specs/`, `scripts/`, `jest.setup.js`, or the Android sources — task 41 Phase 2 owns those and the tracks are file-disjoint. Your files are the extraction grammar, its embedded copy in `grammarText.ts`, possibly `extraction/validator.ts`, and the coaching/breakdown grammars if the audit finds the pattern there. The device check is NOT yours — the S23 FE no-regression confirmation batches into task 32; note your result is believed, not confirmed, until it runs on hardware. Commit at natural breakpoints; do not push. If the brief is wrong about something, say so plainly with the mechanism — this project wants the disagreement, not the assent.
