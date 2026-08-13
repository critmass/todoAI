# Task 37 — Extraction-grammar separator-token hole

**Owner:** Opus or Sonnet (bounded, well-specified). **Headless.** **Carries a light `P`** — the fix should be re-checked on-device against the real model, but the unit-level fix and audit are headless.
🔴 **This is a live bug in shipped production code**, found by the Qwen3.5 spike (`docs/eval/qwen35_spike_findings.md`, "Two defects found"). It is not model-swap work — it exists on Bonsai today and is one tokenizer change away from firing.

**Read first:**
1. `docs/eval/qwen35_spike_findings.md` — the "Two defects" section and the boxed grammar analysis. This is the whole spec for the task; it even contains the confirmed fix.
2. `src/llm/extraction/task_extraction.v1.gbnf` — the grammar with the hole.
3. `src/llm/` validators — `validateTaskExtraction` (the reason the hole is invisible: it only checks `title.trim().length > 0`).
4. `docs/briefs/orientation_for_opus.md` §4 constraint #2 (no underscores in rule names — the lint that any grammar edit must still pass) and the §1 note that GBNF `#` comments parse fine on this build (don't add a comment strip).

---

## 1. The bug

`task_extraction.v1.gbnf`'s title rule is `title ::= "\"" jchar{1,80} "\""`. A single comma satisfies it: the opening quote starts the string, `,` is a legal `jchar`, the closing quote ends it. The model can emit `","` as a complete, well-formed, **schema-valid** title. It passes `validateTaskExtraction` because that only checks non-empty-after-trim, and a comma trims to a comma. The result is a saved task titled `,` — valid by every check the pipeline has, and useless.

**Why it's been invisible:** Bonsai happens not to rank `","` first at that position, so it never emits it. That is **luck, not safety** — the spike hit it 13–15 times out of 16 on Qwen3.5-2B, which *does* rank the comma token (id 2129) high there. The defect is latent under the current model and would surface the moment the model changes. The spike also suspects Bonsai's observed junk tags (`":mixing"`, `":episode"`, `"work_on_it_until_did"`) are **the same defect in milder form** — the grammar permitting a structurally-valid but semantically-empty value.

## 2. The fix (confirmed by the spike)

**Require the first character of the string to be alphanumeric:** `[a-zA-Z0-9]` as the first `jchar`, then the existing `jchar` set for the remainder. The spike verified this closes the hole.

**What does NOT work** (the spike tested it): a minimum length. A 3-char minimum still produced `",Trash collection"` — the comma leads, the length passes. So the fix is about the *first character*, not the count. Do not implement a min-length and assume it's fixed.

**Scope of the fix** — audit and apply to every rule with this shape:
- `title` — confirmed hit.
- `description` — confirmed identical shape and hole.
- `newTag`, `tool`, `date` — the spike flags these as sharing the pattern; audit each. `date` is special — it has its own format (it should already be constrained to a date shape; confirm it can't collapse to a separator).
- Any other free-text string slot in this grammar or the coaching/breakdown grammars that uses the bare `jchar{n,m}` pattern.

**Consider the validator too.** The grammar fix is primary (it's the gate that should never have allowed it), but decide whether `validateTaskExtraction` should also reject a title that is all-punctuation as defense-in-depth. Recommendation: yes, a cheap secondary check — a title with no alphanumeric character is never a real task — because it also catches the milder junk-tag cases at the validation layer regardless of which grammar produced them. Two layers, since the spike showed the single layer failed silently.

## 3. Constraints that bite here

- **Constraint #2** — the rule-name lint (`/^[a-zA-Z][a-zA-Z0-9]*$/`, no underscores) still applies to any new rule you factor out. If you extract a `firstChar` rule, name it `firstChar`, not `first_char`.
- **Constraint #3** — this grammar is compiled by the startup guard. After editing it, confirm it still compiles cleanly through `buildGrammar` against representative slot values; a malformed grammar is worse than the bug.
- **Don't touch the `#`-comment behavior** — comments parse fine on this build; don't add or strip them.
- **The grammar text has an embedded-copy drift guard** (task 36 §0 fixed its line-ending sensitivity): the `.gbnf` on disk and the `.ts` constant generated from it must stay in sync, and a test asserts it. Regenerate the embedded copy after editing, or that guard will (correctly) fail.

## 4. Definition of done

- The separator-token hole closed in `title`, `description`, and every other string slot sharing the pattern (audited, not assumed), via the first-character-alphanumeric fix.
- The optional validator defense-in-depth decided and, if adopted, implemented.
- Grammar still compiles through the startup guard; the embedded-copy drift guard passes; rule-name lint passes.
- Full suite + `tsc --noEmit` + `eslint .` clean. Add a fixture that pins the fix: a model output of `","` for a title is now **rejected**, not saved.
- **Light device check:** on the S23 FE with Bonsai, confirm the fix didn't regress normal extraction (the real fixtures still extract correctly through the tightened grammar). This can batch into task 32's device sweep rather than its own session.
- Findings report at `docs/eval/task37_findings_report.md`: which slots had the hole, the fix applied, whether the validator layer was added, and whether the junk-tag suspicion (Bonsai's `":mixing"` etc.) turned out to be the same root cause.

*This is the highest-priority of the newly-surfaced work: it's a correctness bug in the shipped extraction path, cheap to fix, and it protects against exactly the kind of silent failure the whole deterministic-scaffolding philosophy exists to prevent. Do it before the next alpha capture session if you can.*
