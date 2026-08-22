# CLAUDE.md — todoAI

Repo-wide instructions for **any** agent (coordinator or subagent) working in this repository. The
full project rules live in the doc system (pointers at the bottom) — this file adds the standing
engineering policy below and points you at them. It does not duplicate them.

## Test-first — write the test before the code

**For any change to behavior, write the test first, run it, and watch it fail for the right reason
before you write the implementation.** A test written *after* the code — or one never seen to fail —
can pass vacuously and proves nothing. This is not ceremony: task 41's force-kill acceptance test was
written and committed *before* its implementation, and substituting a buffering writer made it fail
on exactly the intended assertion. That is what made it a real regression detector rather than
decoration (`docs/eval/task41_findings_report.md`).

- **New behavior / new code path → failing test first**, then implement until it goes green.
- **Bug fix → reproduce first:** write a test that fails on the *current* bug before you fix it (task
  26 did this — "confirmed by direct test before writing the fix").
- **Always end green**, with the new or changed behavior actually covered, and **name in your report
  the test that guards each change.**
- **Carve-outs — permitted, but state them in your report, never silently:** pure documentation /
  prompt-string / config edits with nothing behavioral to assert (e.g. a field-guide wording change);
  mechanical refactors already fully covered by existing tests (run them — don't add ceremony); and
  throwaway `src/dev/` spikes. If you skip test-first, say why.

Verification still runs at the end regardless: `npx jest`, `npx tsc --noEmit`, `npx eslint .`. ⚠ A
stale git worktree (`.claude/worktrees/…`) makes raw `npx jest` double every count — quote the real
number (subtract the worktree's fixed suite count), never the raw one.

## Where the rules live (source of truth — this file is only a thin layer over them)

- `docs/master_task_table.md` — the board; **wins on per-task status.**
- `docs/briefs/orientation_for_opus.md` — module contracts (§3), non-negotiable constraints (§4),
  settled decisions (§5), ship gates (§8). **Wins on contracts/constraints/decisions/gates.**
- `docs/coordinator_handoff_todoAI.md` — the coordinator role and working discipline (incl. the
  execution boundary: the coordinator briefs subagents and verifies; it does not author code, run
  builds, or drive the device).
- Your per-task brief in `docs/briefs/` — **wins for its own task.**
