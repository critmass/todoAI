# Task 52 — extraction-guide budget + enumeration pass

**Brief written by the coordinator, 2026-08-22.** Numbered from task 50's §7. Applying task 50's
`energy` definition (`docs/design/energy_definition_task50.md` §7.1, committed `aa9e508`) left the
extraction field guide with two things to clean up. This task is that cleanup — a small, careful
prompt edit. It is **not** on the critical path; it slots in anywhere headless.

## Role
Build subagent. Edit `src/`, verify with `npx jest` / `npx tsc --noEmit` / `npx eslint .`, report.
Do **not** `git commit` — leave the tree for coordinator review. No device work of your own (see
Verification).

## The two changes, in `src/llm/prompts/fieldGuides.ts`

**(a) Fix the enumeration contradiction.** Line 45 still reads:
> `- estimated_duration_minutes: ... This is the ONLY field you may guess — ...`

That "ONLY" is now false: task 50 made `energy` a second field the model must judge ("ALWAYS pick
one — never null"). Reword so the **two** judged fields are named together and the closed
enumerated-exception shape is preserved. Suggested (match the file's voice, tune as needed):
> `... This and energy are the only two fields you may judge for yourself — think about the actual work ...`

🔴 **Preserve the abstention doctrine.** For *every other* field, `null`/`[]` remain the correct,
expected answers (Phase B's biggest win). Do not soften any other field's "otherwise null / most →
null / usually []" guidance. The set of fields the model may judge stays **closed** at exactly two:
`estimated_duration_minutes` and `energy`. Line 41's general "Guess only where a field explicitly
says you may" stays as the umbrella rule.

**(b) Recover the token budget.** The new `energy` line added ~60 tokens to a guide already over its
~250-token budget (strategy §5.2). Recover roughly that much by **tightening `tool_requirements` and
the `context_tags` example** — the two sources task 50 design §3 names. Target: net guide length back
near its pre-energy size.

🔴 **Trim wording, never semantics.** `context_tags`'s rules (only tags that genuinely apply, 0–2,
one plain lowercase phrase, the "trash is ["home"] not everything" instinct) and `tool_requirements`'s
rules must survive the trim — you are cutting words, not loosening the field. The `context_tags`
guidance is load-bearing against tag over-assertion (the `must_include` subset-check trap, board
standing note / task 20); do not lose the "don't list every tag" instinct.

## Constraints
- **No grammar / schema / mapper / migration change.** Text only, in the one file's guide array.
- Keep constraint #2 discipline etc. — you are not touching grammars, just the prose guide strings.
- Do not touch any other field guide beyond `estimated_duration_minutes` (reword), `tool_requirements`
  and the `context_tags` example (trim), and (already done) `energy`.

## Verification
- Headless: `npx jest` / `npx tsc --noEmit` / `npx eslint .`. ⚠ **A trim may break a `.toContain(...)`
  assertion** — `assemble.test.ts` checks the assembled prompt contains certain substrings. If you cut
  a phrase a test asserts, either keep that exact phrase or update the assertion to the new wording
  (a substring the reworded guide still contains) — never delete the assertion. Name anything you touch.
- Report the **net token delta** vs before this task (goal: ≈ back to the pre-energy budget).
- 🔴 **Real no-regression confirmation is NOT yours to close.** Whether the reworded/trimmed guide
  actually extracts as well is a model-behaviour claim. It rides with **task 31's eval** once that
  corpus exists — ⚠ the 16-fixture bank's answer key is **known-invalid** (task 50 §6a: model-generated
  scaffolding), so it is *not* a valid oracle; do not "verify" against it. Flag in your report that
  device/eval confirmation is deferred to task 31 / the next device session (task 32). Your job is the
  careful text edit + the headless suite staying green.

## Deliverable
The edits (uncommitted) + a report: before/after of each changed line, net token delta, any test
touched, jest/tsc/eslint (real, worktree-aware — baseline 973/86, subtract the worktree's fixed
794/68), and a **"Deviations from human decisions"** section (empty is valid; write it out).
