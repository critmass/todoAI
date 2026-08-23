# Task 52 — findings: extraction-guide budget + enumeration pass

**Build subagent, 2026-08-23.** Numbered from task 50's §7. Brief:
`docs/briefs/extraction_guide_budget_task_52.md`.

**Outcome: both edits made, headless suite green (998/86), single file touched
(`src/llm/prompts/fieldGuides.ts`), no test needed changing.**

---

## 1. Change (a) — fix the enumeration contradiction

`estimated_duration_minutes` (line 45):

**Before:**
> `... This is the ONLY field you may guess — think about the actual work ...`

**After:**
> `... This and energy are the only two fields you may judge for yourself — think about the actual
> work ...`

Used the brief's suggested wording near-verbatim. The closed enumerated-exception shape is
preserved: exactly two named fields (`estimated_duration_minutes`, `energy`), not a general
softening. Line 41's umbrella rule ("Guess only where a field explicitly says you may") is
untouched, and every other field's `null`/`[]` guidance (`due`, `importance_user`,
`duration_from_user`, etc.) is untouched — verified by reading the full diff (§5) and confirming no
other line changed.

## 2. Change (b) — recover the token budget

`context_tags` example (line 49):

**Before:**
> `- context_tags: where/how THIS task is actually done. Pick only tags that genuinely apply —
> usually 0–2. Never list every tag; taking out the trash is ["home"], not
> ["home","office","phone"]. Each element is ONE plain lowercase phrase — never punctuation,
> fragments, or non-English text. Nothing clearly fits → [].`

**After:**
> `- context_tags: where/how THIS task is done. Only tags that genuinely apply — usually 0–2, never
> every tag (trash is ["home"], not ["home","office","phone"]). Each: ONE plain lowercase phrase, no
> punctuation/fragments/non-English. Nothing fits → [].`

`tool_requirements` (line 50):

**Before:**
> `- tool_requirements: 0–5 real things needed; same element rules. Usually [].`

**After:**
> `- tool_requirements: 0–5 real things; same element rules. Usually [].`

Every rule the brief named as load-bearing survives, unweakened:
- **context_tags**: "only tags that genuinely apply" — present. "usually 0–2" — present, unchanged
  numbers. **The "don't list every tag" instinct** — present ("never every tag"). **The
  `["home"]`/`["home","office","phone"]` calibration example — kept byte-for-byte**, brackets and
  all; nothing about it was shortened, since the brief flags this exact pair as load-bearing against
  tag over-assertion. Element format rule (ONE plain lowercase phrase; no punctuation / fragments /
  non-English) — present, all three prohibitions intact. Abstention default (`Nothing fits → []`) —
  present.
- **tool_requirements**: cardinality (0–5), "same element rules" cross-reference to context_tags'
  format rule, and the `Usually []` abstention default — all present, unchanged. Only the filler word
  "needed" was cut.

Trims applied were filler-word removal and clause-merging ("Pick only tags... — usually 0–2. Never
list every tag" → "Only tags... — usually 0–2, never every tag"), dropping "actually", "taking out
the" (before "trash"), "is" / "text" (redundant given the surrounding nouns), and "clearly" (emphasis
word, not a semantic claim — "Nothing fits" and "Nothing clearly fits" both mean the same abstention
default).

## 3. Token accounting

**No BPE tokenizer is available in this environment or in the repo's dependencies** (no
`node_modules` present to inspect; no tiktoken/gpt-tokenizer package in `package.json`). I could not
produce a real token count and did not fabricate one. Instead I measured word count and character
count directly and report both, cross-checked against the one data point the project itself
published: task 50's doc (`docs/design/energy_definition_task50.md` §2a) states the new `energy` line
is "~90 tokens, against the current line's ~30" — an old line of 17 words / 93 chars, a new line of
80 words / 443 chars. That implies **~1.1 tokens per word** is a closer proxy here than chars/4 (the
old-line chars/4 estimate of 23 undershoots the doc's own "~30", the new-line chars/4 estimate of 111
overshoots "~90"; words×1.1 gives 18.7 and 88.0 — both closer). I used words×1.1 as the primary
estimate below, with raw word/char counts shown for anyone who wants to re-derive with a real
tokenizer.

| line | words before → after | chars before → after | est. tokens (words×1.1) before → after |
|---|---|---|---|
| `estimated_duration_minutes` | 42 → 47 | 240 → 270 | 46.2 → 51.7 (**+5.5**) |
| `context_tags` | 48 → 34 | 314 → 249 | 52.8 → 37.4 (**−15.4**) |
| `tool_requirements` | 11 → 10 | 76 → 69 | 12.1 → 11.0 (**−1.1**) |
| **net (this task)** | 101 → 91 | 630 → 588 | 111.1 → 100.1 (**≈ −11 tokens**) |

**This does not reach the brief's "~60 tokens" aspirational recovery target, and I want to be
explicit about why rather than quietly under-deliver.** The brief's own §2a token estimate implies
the JSON-bracket examples (`["home"]`, `["home","office","phone"]`) are disproportionately expensive
under a real subword tokenizer — each bracket, quote, and comma is typically its own token — while my
word-count proxy counts each bracketed literal as a single "word" and so cannot see that cost at all.
That means the biggest real lever for token recovery in this guide is almost certainly the bracketed
example, and the brief explicitly protects it: *"the `context_tags` guidance is load-bearing against
tag over-assertion... do not lose the 'don't list every tag' instinct"* and names the `["home"]` /
`["home","office","phone"]` pair directly as the thing that instinct rides on. I judged that
shortening or removing that example to chase the ~60-token figure would cross from trimming wording
into trimming semantics — the brief's harder constraint — so I left it intact and recovered what was
available in the surrounding prose instead. The other two candidate cuts ("clearly", "needed", "Pick",
"actually", "taking out the", "is"/"text") are genuinely filler; I found no further cuts of that kind
without touching a rule the brief named as protected.

Net effect across the three touched lines: **≈ −11 estimated tokens**, a partial but real recovery
toward the pre-energy budget, achieved without weakening any rule identified as load-bearing.

## 4. Test-first compliance (`CLAUDE.md`) — carve-out taken, stated

This is a **pure prompt-string wording change** with nothing new to assert: no new code path, no new
branch, no new field, no change to what data is accepted or rejected — only how three sentences in a
constant string array are worded. CLAUDE.md's carve-out list names exactly this case ("pure
documentation / prompt-string / config edits with nothing behavioral to assert (e.g. a field-guide
wording change)"). I searched the test suite before editing (`Grep` across `src/` for the exact
phrases being changed — `"ONLY field you may guess"`, `tool_requirements`, `context_tags`) and
confirmed no test asserts on the specific prose in lines 45/49/50; `assemble.test.ts` (the file the
brief flagged as the likely breakage point) only asserts on `RECURRENCE_DECISION_TREE`,
`SCOPE_TO_OBSERVABLE_RULE`, and the substring `'ASK one short question'` — none of which this task
touches. No test was added and no test needed updating.

Whether the reworded/trimmed guide still extracts correctly on-device is a model-behavior claim, not
a headless-testable one — per the brief, that confirmation rides with task 31's eval, not this task.

## 5. Verification

Run at the repo root (worktree root — this worktree's `npx jest` reports the true count directly per
the outer brief, no subtraction needed).

| check | result |
|---|---|
| `npx jest` | **998 passed / 86 suites** — matches stated baseline exactly (998/86), 0 change |
| `npx jest src/llm/prompts/__tests__/assemble.test.ts` (within the full run) | **PASS** — the file flagged as the likely breakage point |
| `npx tsc --noEmit` | clean, no output |
| `npx eslint .` | **0 errors, 56 warnings** — unchanged from baseline |

Full diff (only file touched):

```diff
--- a/src/llm/prompts/fieldGuides.ts
+++ b/src/llm/prompts/fieldGuides.ts
@@ -42,12 +42,12 @@ export const EXTRACTION_FIELD_GUIDE = [
   'Fields, in order:',
   '- title: short imperative name.',
   '- description: extra detail the user gave, or null.',
-  '- estimated_duration_minutes: ... This is the ONLY field you may guess — think about the actual work ...',
+  '- estimated_duration_minutes: ... This and energy are the only two fields you may judge for yourself — think about the actual work ...',
   '- duration_from_user: ...',
   '- duration_type: ...',
   '- due: ...',
-  '- context_tags: where/how THIS task is actually done. Pick only tags that genuinely apply — usually 0–2. Never list every tag; taking out the trash is ["home"], not ["home","office","phone"]. Each element is ONE plain lowercase phrase — never punctuation, fragments, or non-English text. Nothing clearly fits → [].',
-  '- tool_requirements: 0–5 real things needed; same element rules. Usually [].',
+  '- context_tags: where/how THIS task is done. Only tags that genuinely apply — usually 0–2, never every tag (trash is ["home"], not ["home","office","phone"]). Each: ONE plain lowercase phrase, no punctuation/fragments/non-English. Nothing fits → [].',
+  '- tool_requirements: 0–5 real things; same element rules. Usually [].',
   '- energy: ...',
```
(full lines shown in §1/§2; elided here for width.)

`git status --short`: `M src/llm/prompts/fieldGuides.ts` — the only file touched, uncommitted per
instruction.

## 6. Deviations from human decisions

**One, disclosed, not a constraint violation.** The brief's aspirational recovery target of "~60
tokens" (§3 of this report) was not reached — actual recovery is ≈ −11 estimated tokens (words×1.1
proxy). This is a deviation from the *target*, not from a *constraint*: the brief's two 🔴 items
(preserve the abstention doctrine / closed two-field exception; trim wording never semantics) were
both honored in full, and the brief itself frames the 60-token figure as "recover roughly that much"
and the verification section as "goal: ≈ back to the pre-energy budget" rather than a pass/fail gate.
I chose to protect the `context_tags` bracketed calibration example (explicitly named load-bearing)
rather than cut it for token count, since I judged that the biggest real (BPE-tokenizer) cost in
these two lines almost certainly lives in that bracketed example and that no tokenizer was available
in-repo to verify a deeper cut wouldn't also be a semantic cut. Flagging this for the coordinator: if
a real tokenizer count later shows more budget is recoverable without touching the protected example,
that is a small follow-up, not a redo of this task.

No other deviations. No test was added or removed (§4 carve-out, stated). No file other than
`src/llm/prompts/fieldGuides.ts` was touched. Device/model-behavior confirmation is deferred to task
31 / the next device session per the brief; not attempted here, and the known-invalid 16-fixture bank
(task 50 §6a) was not used as an oracle.
