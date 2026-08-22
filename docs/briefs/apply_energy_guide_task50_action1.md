# Apply the task 50 `energy` definition to the extraction prompt (task 50 §7 action 1)

**Brief written by the coordinator, 2026-08-22.** Task 50 is closed
(`docs/design/energy_definition_task50.md`). Its §7 action 1 is: replace the `energy` line in the
extraction field guide with the pinned prompt-form definition. This is a small, headless prompt
edit — but it changes the shipping extraction guide, so treat it with care.

## Role
You are a build subagent. You edit `src/`, run `npx jest` / `npx tsc --noEmit` / `npx eslint .` to
verify, and report. No device work. Do **not** `git commit` — leave the tree for coordinator review.

## The change (one edit)
In `src/llm/prompts/fieldGuides.ts`, replace the current `energy` line (currently line 51):

> `- energy: "low" | "med" | "high" ONLY if the user described the effort or energy. Otherwise null. Most tasks → null.`

with the pinned §2a text **verbatim** (from `docs/design/energy_definition_task50.md` §2a):

```
- energy: what it costs to get this done — making yourself START it and getting THROUGH it; take
  the higher. Higher if: no obvious first step, unpleasant, open-ended, a call or confrontation,
  hard focus, physically hard. low = just do it (trash, a text). med = needs a run-up or real
  effort (errands, an email thread). high = you psych yourself up for it, or need recovery after
  (gym, taxes, a hard conversation). ALWAYS pick one — never null.
```

Match the file's existing array-of-strings style (it's a `[...].join('\n')`; each guide line is a
string element). Keep it as one logical guide line for `energy`, however the surrounding lines are
formatted.

## Constraints (do not violate)
- 🔴 **Preserve the enumerated-exception shape.** `energy` becomes the **second** named field the
  model may *judge* rather than transcribe — the first is `estimated_duration_minutes` ("the ONLY
  field you may guess"). This is a **closed, named** exception to the abstention doctrine (Phase B's
  biggest win — `null`/`[]` are correct answers), NOT a general softening. Do not weaken any other
  field's "otherwise null / most → null" guidance. If the guide has a sentence framing which fields
  may be guessed, `energy` joins that enumerated set — it does not open the door generally.
- **Do NOT touch the grammar.** `src/llm/extraction/task_extraction.v1.gbnf` keeps
  `energy ::= "null" | "low" | "med" | "high"` — the grammar stays permissive; the *guide* forbids
  null. Changing the grammar to drop `null` turns a recoverable model slip into a generation failure.
- **No other field guide edits, no schema/migration/mapper change.** `energy_requirement`'s 1–5
  domain is unchanged; `mapper.ts` still maps a stray `null → 3` as a tolerant fallback (§3 of the
  design doc) — leave it.

## Two things to check and report (do not act on the second without flagging)
1. **Tests that pin the guide text.** A test may exact-match or snapshot the field guides or the
   assembled extraction prompt. If so, update ONLY the pinned string to the new text — change no
   assertion logic. (Precedent: task 48 replaced a stale exact-match test with the new pinned text; a
   tightening, not a weakening.) Name every test you touched.
2. **Token budget — FLAG, don't fix.** §2a is ~90 tokens vs the old ~30, and the extraction guide is
   already over its ~250-token budget (strategy §5.2). §2a says if budget must be recovered, take it
   from `tool_requirements` and the `context_tags` example — but that is a **further** prompt change
   to other fields and is **not** in this task's scope. Apply §2a as ruled, then **report the net
   token increase** and note the recovery option as a decision for Jason. Do not trim other fields.

## Verify (quote all three, worktree-aware)
Baseline: **973 tests / 86 suites** green; `tsc` clean; `eslint` 0 errors / 56 warnings. Raw `npx
jest` is ~1767/154 because of the stale worktree (`.claude/worktrees/...`, a fixed 794/68) — subtract
it, never quote the raw number.

## Deliverable
The edit + any pinned-test update, left uncommitted. Report back: the exact before/after guide text,
any test touched, the jest/tsc/eslint results (real numbers), the net token change, and a
**"Deviations from human decisions"** line (expected: none — this is a verbatim application of a
ruled definition; if you deviated at all, say how).
