# Housekeeping — worktree cleanup + the unreproduced test flake

**Brief written by the coordinator, 2026-08-22, at Jason's instruction.** **Deliberately unnumbered** —
this is repo housekeeping, not project work, so it takes no board number. It follows the same
brief-and-report discipline as a numbered task regardless: written work order in, findings report out.

## 0. Role and boundary

Housekeeping subagent. You run git plumbing and the test suite, and you report. You may run
`npx jest` / `npx tsc --noEmit` / `npx eslint .` freely. **Do not `git commit`, do not push**, and do
not change application code — if Part B leads you to a code fix, **report it, don't build it** (it
becomes its own numbered task). Leave the tree clean.

---

## 1. Part A — worktree cleanup

### What exists right now

```
C:/Users/physi/Documents/projects/todoAI                                    89d17e6 [main]
.claude/worktrees/agent-a05c60d66c1e0fd6f                                   38abe66 [worktree-agent-a05c60d66c1e0fd6f]
.claude/worktrees/agent-a41eed81e4d19ea71                                   38abe66 [worktree-agent-a41eed81e4d19ea71]
.claude/worktrees/agent-a535664a9dc554865                                   38abe66 [worktree-agent-a535664a9dc554865]
.claude/worktrees/interesting-shirley-e10fa1                                d3ead86 (detached HEAD)
```

**The three `agent-*` worktrees** are mine, from Wave 1 (tasks 57, 52, 49). Their content **has been
merged into `main`** — 57 and 52 by file copy, 49 by patch — and committed at `0663394`, `c6f884d`,
`161adf6`. They are now pure duplicates.

**`interesting-shirley-e10fa1`** is the long-standing one. ✅ **Jason ruled on 2026-08-17: "leave it in
place for now, flag it in the report, separate cleanup task later."** **This is that later task** — so
removing it now *discharges* that ruling rather than contradicting it. It is a **verified** duplicate,
not an assumed one (`capture_format_task41_amendment_rulings.md` §6): diffing `src/`, `__tests__/`,
`package.json` and `jest.config.js` between `d3ead86` and `main` yielded exactly one file —
`src/dev/ModelBaseSpikeScreen.tsx`, present on `main`, absent there, and it has no test.

### Why it matters (not merely tidiness)

Every one of these is a **full second copy of the tree inside the project**, and **jest collects them**.
Raw `npx jest` currently reports ~1820/156 against a true 1026/88. That has already caused a documented
incident — "1588 tests green" was quoted as a result when it was a claim spanning two different
commits. Each extra worktree makes the raw number less interpretable and the trap easier to fall into.

### What to do

1. 🔴 **Verify before you delete — do not take my word for it.** For **each** worktree, independently
   confirm its content is fully represented in `main` before removing it:
   - for the three `agent-*` trees: `git -C <path> status` and a diff of their tracked content against
     `main`, plus confirmation that the corresponding commits (`0663394`, `c6f884d`, `161adf6`) contain
     that work;
   - for `interesting-shirley-e10fa1`: re-confirm `d3ead86` is an **ancestor of `main`**
     (`git merge-base --is-ancestor d3ead86 main`) and re-run the file-level diff above.
   **If any worktree holds content not in `main`, STOP and report it — do not delete it.** That is the
   whole point of this step; a worktree carrying unmerged work has happened in this project before (the
   fourth branch nobody had documented).
2. Remove each verified-duplicate worktree (`git worktree remove`), then `git worktree prune`.
3. Delete the now-dangling `worktree-agent-*` branches. **Only** those three; do not delete any other
   branch.
4. **Confirm the payoff:** after cleanup, `npx jest` **with no `--testPathIgnorePatterns`** should report
   the true **1026 / 88**. Quote that. It means nobody has to remember to subtract anything ever again,
   which is the actual deliverable here.

---

## 2. Part B — the unreproduced flake (an honest attempt)

### Exactly what was observed, stated precisely

On the **first** full run immediately after `git apply` of task 49's patch, in the main tree:

```
Test Suites: 1 failed, 87 passed, 88 total
Tests:       1 failed, 1025 passed, 1026 total
```

⚠ **The failing test's name was not captured** — the coordinator re-ran before scrolling back, which is
the mistake this task is partly cleaning up after. **Four subsequent full runs were clean at 1026/88**,
`tsc` clean and `eslint` unchanged throughout. At the time of the failure, the three `agent-*`
worktrees were present on disk and one had recently had a `node_modules` junction created and removed.

### One hypothesis already ruled out — don't spend time on it

**Colliding file-DB temp paths are NOT the cause.** `src/db/testUtils/fileDbOperations.ts:59` uses
`fs.mkdtempSync(path.join(os.tmpdir(), 'todoai-task14-'))`, so every fixture gets a unique directory.
Parallel workers cannot tread on each other there.

### Candidates worth testing, roughly ranked

1. **Load/timeout sensitivity.** The failure happened when the machine was busiest (three worktrees,
   a junction being torn down, a patch just applied). `ladder.test.ts` was observed taking **11.8 s** in
   one run — a suite that heavy is a natural candidate for exceeding a timeout under contention.
2. **Module-level mutable state leaking across tests within a worker.** `retention.ts:51`'s
   `pendingWarning` is new (task 57), and `record.ts` holds the capture writer/health singletons.
3. **A real child process:** `forceKill.test.ts` spawns `forceKillChild.cjs` — process spawning is a
   classic source of load-dependent flakes.
4. **Wall-clock dependence** — anything reading real `Date.now()` near a boundary rather than an
   injected clock.

### What to actually do

- **Re-run the full suite many times** (≥20, and more if cheap), capturing each run's output to a file
  so a failure is never lost again. Vary the conditions: default parallel, `--runInBand`, and at least
  a few runs under deliberate CPU load. If jest offers seed/order randomisation on this version, use it.
- **On any failure, capture everything**: the test name, the assertion, the suite, the run conditions.
  That single artifact is worth more than any amount of reasoning about it.
- If you reproduce it, diagnose the mechanism and **report it — do not fix it.** A fix becomes its own
  numbered, test-first task.
- 🔴 **"Could not reproduce in N runs" is a COMPLETE AND ACCEPTABLE ANSWER, and is the expected one.**
  Say so plainly with the run count and conditions. **Do not manufacture a root cause**, and do not
  dress up a hypothesis as a finding — an honest negative here is genuinely useful, and inventing a
  culprit would be worse than nothing. State clearly which candidates you positively **excluded** (with
  evidence) versus merely didn't hit.

---

## 3. Part C — loose git objects (small, optional, do it last)

The board's standing note records that `rm -rf .git/objects/incoming-*` was **never done** and that the
instruction rested on a false premise: **15 of those 17 directories contain real loose objects** (~1.2 MB),
so hand-deleting them is how a repo gets corrupted. **`git gc --prune=now` is the correct instrument.**
Run `git fsck` first, confirm it is clean, then `git gc --prune=now`, then `git fsck` again and confirm
still clean. **If `fsck` reports anything at all, stop and report — do not gc.**

---

## 4. Hard limits
- **Never delete a worktree, branch, or object you have not verified is fully contained in `main`.**
- Never touch the main checkout's working tree content, `src/`, or application code.
- No `git commit`, no `git push`, no force-anything, no history rewriting.
- Don't remove or modify the `.claude/settings.json` file or anything else tracked under `.claude/`.

## 5. Test-first
**Carve-out, stated explicitly per `CLAUDE.md`:** this task changes no behaviour — it is git plumbing
plus an investigation — so there is nothing to write a failing test for. The suite is the *instrument*
here, not the subject. If Part B leads to a proposed code fix, that fix is a separate task and **is**
test-first (reproduce the flake in a test first).

## 6. Verify
Before and after: `npx jest`, `npx tsc --noEmit`, `npx eslint .`. Baseline **1026 tests / 88 suites**,
`tsc` clean, `eslint` 0 errors / 56 warnings. **After Part A the raw `npx jest` number should itself be
1026/88** with no ignore-pattern needed — that is the check that cleanup actually worked.

## 7. Deliverable
`docs/eval/housekeeping_2026-08-22_report.md`, containing:
- **Part A:** what you verified for each worktree *before* deleting, what you removed, the branches
  deleted, and the before/after raw jest numbers.
- **Part B:** the number of runs, the conditions varied, every failure captured verbatim (or an explicit
  "no failures in N runs"), which candidates you excluded **with evidence**, and — if you found it — the
  mechanism, as a *recommendation* for a follow-up task rather than a fix.
- **Part C:** the `fsck` results either side and whether you ran `gc`.
- A section titled exactly **"Deviations from human decisions"** — empty is valid and must be written
  out explicitly.

## 8. Read first
1. This brief.
2. `docs/master_task_table.md` → **Standing notes** (the stale-worktree note and its 2026-08-17 ruling;
   the loose-objects note).
3. `docs/design/capture_format_task41_amendment_rulings.md` §6 — the existing verification that
   `interesting-shirley-e10fa1` is a true duplicate.
4. `CLAUDE.md`.
