# Housekeeping findings — worktree cleanup + the unreproduced test flake

**Unnumbered housekeeping task**, per `docs/briefs/housekeeping_worktrees_and_flake.md`. Executed in
the **main checkout** (deliberately — the job includes removing worktrees). Report written
2026-08-23; the brief is dated 2026-08-22 and the board commit it describes (`89d17e6`) had since been
followed by `ba52054` (the brief's own commit) — no other drift.

**Boundary honoured:** no `git commit`, no push, no change to application code, no history rewriting.
The only writes to the tree are this report file. `git status` was clean before and is clean apart from
this file after.

**Test-first carve-out (stated, not silent):** this task changes no behaviour — it is git plumbing plus
an investigation — so there was nothing to write a failing test for. The suite is the *instrument*
here, not the subject. Part B did reproduce a real failure; per the brief it is **reported, not
fixed**, and the fix is recommended below as its own numbered, test-first task.

---

## Part A — worktree cleanup

### A.1 What was verified BEFORE each deletion

The brief asked me not to take its word for it. I did not. Rather than eyeballing `git status`, I ran a
**content-containment proof** over every worktree: enumerate *all* files (tracked **plus** untracked
non-ignored), hash each one with `git hash-object`, and classify it as

- **identical to `main`** (`main:<path>` blob matches) — contained, or
- **identical to the worktree's base commit** (`38abe66` / `d3ead86`, both confirmed ancestors of
  `main`) — i.e. the difference is *main's* progress, not the worktree's work, or
- **NOT CONTAINED** — content that exists only in the worktree.

Any file in the third bucket would have stopped the deletion. The script is
`…/scratchpad/hk/verify.sh`; per-worktree output in `…/scratchpad/hk/verify_*.txt`.

| Worktree | Base | Base ancestor of `main`? | Files checked | == `main` | == base (historical) | **Not contained** |
|---|---|---|---|---|---|---|
| `agent-a05c60d66c1e0fd6f` | `38abe66` | YES | 453 | 431 | 22 | **0** |
| `agent-a41eed81e4d19ea71` | `38abe66` | YES | 455 | 451 | 4 | **0** |
| `agent-a535664a9dc554865` | `38abe66` | YES | 452 | 431 | 21 | **0** |
| `interesting-shirley-e10fa1` | `d3ead86` | YES | 334 | 275 | 59 | **0** |

**Every worktree was fully contained in `main`. Nothing was carrying undocumented work.**

This matters because all three `agent-*` worktrees were *dirty* — they still held their task's
uncommitted output (a41 had 22 changed/added paths including migration 008 and its tests). Each of
those dirty paths was checked individually and every one is **blob-identical to `main`**:

- `agent-a05…`: `docs/eval/task57_findings_report.md`, `src/capture/__tests__/retention.test.ts` — identical.
- `agent-a535…`: `src/llm/prompts/fieldGuides.ts`, `docs/eval/task52_findings_report.md` — identical.
- `agent-a41…`: all 22 paths (008 SQL/TS, `008_transitiveCycleGuard.test.ts`, `dependencies.ts`,
  `consistency.ts`, `salvage.ts`, `backupFixture.ts`, the six migration test sweeps, the five backup
  test files, `migrations/index.ts`, the findings report) — **all 22 identical**.

Corroborating checks:

- `0663394` (task 57), `c6f884d` (task 52), `161adf6` (task 49), `38abe66` and `d3ead86` are **all
  ancestors of `main`** (`git merge-base --is-ancestor`, each returned YES).
- For `interesting-shirley-e10fa1` I re-ran the file-level comparison the 2026-08-17 ruling rested on.
  Files present in `d3ead86:src` but **absent** from `main:src`: **none**. (The complement — files main
  has that it lacks — is now 57 files, not the single `ModelBaseSpikeScreen.tsx` recorded in
  `capture_format_task41_amendment_rulings.md` §6, simply because `main` has grown a great deal since
  17 Aug: `src/capture/`, `src/services/backup/`, migrations 007/008 and so on. The direction that
  matters for safety — unique content in the worktree — is **empty**.)
- **Safety check the brief did not ask for, worth recording:** before deleting I scanned the worktree
  tree for NTFS reparse points (junctions/symlinks), because `git worktree remove` deletes recursively
  and a `node_modules` junction pointing at the real one could have taken the project's `node_modules`
  with it. **No reparse points, and no `node_modules` directory in any of the four** — the junction the
  brief mentions had already been torn down. Removal was safe.
- Only `.claude/settings.json` is tracked under `.claude/`; `.claude/worktrees/` is excluded via
  `.git/info/exclude:18`. So nothing tracked was touched.

### A.2 What was removed

```
git worktree remove --force .claude/worktrees/agent-a05c60d66c1e0fd6f    OK
git worktree remove --force .claude/worktrees/agent-a41eed81e4d19ea71    OK
git worktree remove --force .claude/worktrees/agent-a535664a9dc554865    OK
git worktree remove --force .claude/worktrees/interesting-shirley-e10fa1 OK
git worktree prune -v                                                    (nothing left to prune)
```

`--force` was required only because three of them were dirty; the containment proof above is what
made discarding those working trees safe.

`git worktree list` now shows **one entry**: the main checkout. `.claude/worktrees/` is an empty
directory.

Branches deleted — **only the three named in the brief**, each with `git branch -d` (the *safe*
delete, which refuses an unmerged branch; all three were accepted):

```
worktree-agent-a05c60d66c1e0fd6f  (was 38abe66)
worktree-agent-a41eed81e4d19ea71  (was 38abe66)
worktree-agent-a535664a9dc554865  (was 38abe66)
```

**Left alone, deliberately:** `claude/interesting-shirley-e10fa1`, `coordinator/tasks-41-42`,
`opus/batch-a-headless`, `task-36-recurrence-period-engine`, and every remote branch. The brief scoped
branch deletion to the three `worktree-agent-*` names and I did not widen it — note in particular that
`claude/interesting-shirley-e10fa1` still exists locally and on `origin`; the worktree was detached at
`d3ead86` and removing it did not touch that branch.

### A.3 Before / after raw `npx jest` — the actual deliverable

| | Test Suites | Tests | Wall time |
|---|---|---|---|
| **Before** (4 worktrees present) | 2 failed, 414 passed, **416 total** | 2 failed, 4840 passed, **4842 total** | 146.5 s |
| **After** (worktrees removed) | **88 passed, 88 total** | **1026 passed, 1026 total** | 35.9 s |

**Raw `npx jest`, with no `--testPathIgnorePatterns`, now reports exactly the true 1026 / 88.** Zero
collected paths under `.claude/worktrees`. Nobody has to remember to subtract anything again.

⚠ **The standing note's raw figure was itself stale and understated the problem.** It records raw as
`1820 / 156` ("the stale worktree contributes an unchanging 794 / 68"). That was true when only
`interesting-shirley` existed; with the three Wave-1 worktrees added, raw had grown to **4842 / 416** —
**4.7× the real count**. Anyone quoting a raw number in that window would have been out by a factor of
nearly five. Board note worth updating to say the multiplier is now **1×**.

Run time also dropped from ~147 s to ~36 s.

---

## Part B — the unreproduced flake: **reproduced, and the mechanism is identified**

The brief expected "could not reproduce in N runs" and said so plainly. That is not what happened.
It reproduced on the **very first run of this session** — the pre-cleanup baseline — and the test
name, the thing lost last time, was captured immediately:

```
FAIL src/services/backup/__tests__/consistency.test.ts
  * validateConsistency > the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)

    expect(received).rejects.toThrow(expected)

    Expected pattern: /Circular dependency detected/

    Received function did not throw

      89 |     await expect(
      90 |       db.execute('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', [3, 1]),
    > 91 |     ).rejects.toThrow(/Circular dependency detected/);
         |               ^
      at Object.toThrow (src/services/backup/__tests__/consistency.test.ts:91:15)
```

Every run's full output was written to its own file before anything else was done, so it could not be
lost a second time. **It was the same test, the same assertion and the same suite in every failure
observed** — never any other test.

### B.1 The campaign — 24 full-suite runs

| Phase | Conditions | Runs | Failures |
|---|---|---|---|
| 1 | default parallel, machine otherwise idle | 10 | **3** (runs 01, 03, 09) |
| 2 | `--runInBand` (one process, sequential) | 4 | **2** (runs 1, 3) |
| 3 | default parallel, **8 deliberate CPU-burner processes** | 6 | **0** |
| 4 | `--maxWorkers=100%`, under the same CPU load | 4 | **0** |
| | **total** | **24** | **5** |

Plus the pre-cleanup baseline run (416 suites, four worktrees present), where it failed **in the main
tree and in the `agent-a41...` worktree copy simultaneously** — two independent copies of the same
file failing in the same run, which was the first hint that this was structural, not random.

Raw artefacts: `<scratchpad>/hk/runs/` (one file per run, plus `index.txt` and `FAILURES.txt`).

### B.2 What the campaign excluded, with evidence

- **Load / timeout sensitivity (the brief's ranked #1) — EXCLUDED.** It failed **0 times in 10 runs
  under deliberate CPU load**, and 5 times in 14 runs with the machine idle. The correlation runs the
  *opposite* way to the hypothesis. Two further facts kill it outright: the failure is an **assertion**
  failure, never a timeout; and in the parallel phase the failing runs' `consistency` suite was
  **faster** (5.14 s, 5.71 s) than the passing runs' (5.50-8.32 s) — the failing path did *less* work,
  not more.
- **Worker parallelism — EXCLUDED.** It fails under `--runInBand`, which uses one process and no
  workers at all.
- **Colliding file-DB temp paths — EXCLUDED positively, not merely taken on the brief's word.** The
  instrumented runs record the real DB path at every insert; each fixture had its own
  `...\Temp\todoai-task14-XXXXXX\todoai.db`. `mkdtempSync` behaves as documented.
- **Wall-clock dependence (#4) — EXCLUDED.** The failing assertion reads no clock, and the fixture's
  clock is injected and monotonic (`backupFixture.ts`, `createFixture`).
- **Module-level mutable state in `retention.ts` / `record.ts` (#2) — NOT IMPLICATED.**
  `consistency.test.ts` imports nothing from `src/capture/`, and the mechanism in B.4 accounts for the
  failure completely.
- **A real child process, `forceKill.test.ts` (#3) — NOT THE CAUSE.** The controlled experiment below
  reproduces the failure 6/6 with `forceKill.test.ts` absent from the run entirely.

### B.3 The discovery: it is decided by **position in the process**

Jest 29's default sequencer runs **previously-failed suites first**. That produced a giveaway
alternation across the in-band phase:

| in-band run | position of `consistency.test.ts` | result |
|---|---|---|
| 1 | 19th | **FAIL** |
| 2 | **1st** | PASS |
| 3 | 12th | **FAIL** |
| 4 | **1st** | PASS |

Each failure pushed the suite to the front of the next run, where it passed, which pushed it back
again. The variable was never load, timing, or which files ran alongside it — only whether
`consistency.test.ts` was the **first file in its process**.

**Controlled A/B.** With a throwaway order-forcing sequencer supplied on the command line
(`--testSequencer=<scratchpad>/hk/seq.js` — nothing in the repo touched), over the six-file
`src/services/backup` subset, `--runInBand --no-cache`:

| Condition | Runs | Result |
|---|---|---|
| **A** - `consistency.test.ts` forced **FIRST** | 6 | **6 / 6 PASS** (60/60 tests) |
| **B** - `consistency.test.ts` forced **LAST** | 6 | **6 / 6 FAIL** (1 failed, 59 passed) |

**12 for 12, deterministic.** The flake is not random at all; the full-suite randomness was only the
sequencer shuffling the suite's position.

### B.4 The mechanism, proven by direct measurement

A diagnostic loaded through `--setupFilesAfterEnv=<scratchpad>/hk/diag2.js` (again, **no repo file
modified**) wrapped better-sqlite3's `prepare`/`run` and logged the outcome of every
`task_dependencies` insert. Same test, same run command, only the position differs:

| Measured at the `(3, 1)` insert | consistency **first** (PASS) | consistency **last** (FAIL) |
|---|---|---|
| did the insert throw? | **yes** | **yes** |
| `err.name` | `SqliteError` | `SqliteError` |
| `err.code` | `SQLITE_CONSTRAINT_TRIGGER` | `SQLITE_CONSTRAINT_TRIGGER` |
| `err.message` | `Circular dependency detected` | `Circular dependency detected` |
| trigger DDL contains `WITH RECURSIVE` | **true** | **true** |
| `Object.prototype.toString.call(err)` | `[object Object]` | `[object Object]` |
| `getPrototypeOf(SqliteError.prototype) === Error.prototype` | **true** | **false** |
| **`err instanceof Error`** | **true** | **false** |

**Migration 008 is correct and the trigger fires every time.** In the failing runs the schema does
exactly what task 49 built it to do — it aborts the cycle, with the right message and the right SQLite
error code. **Nothing is wrong with the product code.** The only thing that varies is whether the
thrown object is *recognised* as an `Error` by the realm the assertion runs in.

Why the recognition flips:

1. `node_modules/better-sqlite3/lib/database.js:59` calls **`addon.setErrorConstructor(SqliteError)`** —
   it hands the JS error constructor to the **native addon**.
2. Native addons are cached by Node **per process**, and Jest's module-registry reset does not reload
   them. So the constructor the addon retains belongs to **whichever test file loaded better-sqlite3
   first in that worker process**, and every error thrown from native code thereafter — in every other
   test file, in every other realm — is built from that first file's constructor.
3. `SqliteError` is a **hand-rolled pseudo-Error** (`lib/sqlite-error.js`): a plain `function` whose
   prototype chain is patched via `Object.setPrototypeOf(SqliteError.prototype, Error.prototype)`.
   Its instances therefore have **no `[[ErrorData]]` internal slot** — measured above as
   `[object Object]`, not `[object Error]` — and their chain terminates at the **first realm's**
   `Error.prototype`.
4. Jest's `isError()` (`@jest/expect-utils`) switches on `Object.prototype.toString.call(value)`; given
   `[object Object]` it falls through to `value instanceof Error`, which is **false across realms**.
5. In `toThrowMatchers` the promise form takes the `if (fromPromise && isError(actual))` branch. With
   `isError` false, `actual` is not a function and `fromPromise` is true, so nothing is recorded as
   thrown and the matcher emits precisely the message observed: **"Received function did not throw."**

When `consistency.test.ts` is the first file in the process, *it* is the realm that loaded
better-sqlite3, `instanceof Error` holds, and the identical error asserts correctly.

This also explains why `src/db/migrations/__tests__/008_transitiveCycleGuard.test.ts` — which covers
the same trigger and the same cycle — has never once flaked: it uses the **synchronous** form,
`expect(() => addEdge(conn, 3, 1)).toThrow(...)`, which goes through `getThrown()` on a caught value
and never consults `isError`. The promise form is the only vulnerable one.

### B.5 Recommendation — a numbered, test-first task (deliberately NOT fixed here)

Per the brief this is reported, not built. Suggested shape:

- **Reproduce first — and it no longer needs a flake hunt.** The failing-first test is deterministic:
  run `src/services/backup` in band with `consistency.test.ts` out of first position (12/12 above), or
  simply assert `instanceof Error` on a caught driver error in a non-first file.
- **The narrow fix**, `consistency.test.ts:89-91`: assert on the rejection *value* instead of relying
  on `Error` recognition — `.rejects.toMatchObject({ message: /Circular dependency detected/ })`, or a
  `try`/`catch` asserting `err.message`. `.rejects.toThrow()` against a **raw driver error** is the
  fragile pattern.
- **The better fix**, at the boundary: have `wrapDatabase` (`src/db/testUtils/sqliteTestConnection.ts`)
  normalise driver errors into a real `Error` of the current realm, preserving `message` and `code`.
  One point of change, and it closes every future occurrence too.
- **Related, and worth the task's attention — a latent fragility in production code.**
  `src/db/repositories/dependencies.ts:52` reads
  `const message = err instanceof Error ? err.message : String(err);` — **the same realm-sensitive
  check, on the same driver error**. It is *not* a live bug: the app runs in a single realm, and even
  under Jest the `String(err)` fallback yields `"SqliteError: Circular dependency detected"`, so the
  regex still matches. But it is correct by luck of the fallback rather than by design, and it is
  worth making deliberate.
- **Blast radius today:** there are **20 `.rejects.*` assertions across 11 test files**. Only this one
  asserts a **raw better-sqlite3 error**; the others assert app-defined error classes constructed in
  the test's own realm, which are genuine `Error`s and unaffected. One assertion is broken today — the
  boundary fix is what prevents the next one.

---

## Part C — loose git objects

**`git fsck` (before): NOT clean — one line.**

```
dangling commit f1ff70820e484cf98750ad13082baad692363464
```

**Therefore `git gc` was NOT run.** The brief's gate is explicit: *"If `fsck` reports anything at all,
stop and report — do not gc."* It reported something, so I stopped. There is no "after" fsck, because
nothing was changed.

That gate earned its keep here. The dangling object is not corruption — it is a **dropped `git stash`**:

- author **Jason Cox**, dated **2026-08-17 11:21**, message `On main: pre-merge: sessions-origin
  content already in worktree` (the standard `git stash` subject form, and it carries the two parents
  a stash commit has);
- **`git stash list` is empty**, so the ref that pointed at it is gone — which is exactly why it shows
  as dangling;
- no branch contains it.

**`git gc --prune=now` would have deleted it permanently.** I checked what it holds before deciding:
it touches **only `docs/`** — no `src/`, no new files. Against today's `main` it carries 119 lines that
`main` lacks, spread over six living documents (`orientation_for_opus.md` +5, `real_task_corpus_task_31.md`
+3, `task_31_session_init_prompt.md` +25, `coordinator_handoff_todoAI.md` +10, `master_task_table.md`
+37, `master_task_table.html` +39) — and every one of those is **superseded prose**: the pre-edit text
of documents `main` has since rewritten, not unique work. So it is almost certainly safe to discard —
but "almost certainly" is a judgement for a human to make about their own stash, not for a
housekeeping subagent to make silently, and the brief already ruled that way.

**Recommended, for Jason to decide:** either `git stash drop`-equivalent acceptance (just run
`git gc --prune=now` and let it go), or `git branch rescue/stash-2026-08-17 f1ff7082` first if the old
doc text is worth keeping. Once that call is made, gc is the correct instrument and should be run.

### What gc would clean, and why it is worth doing after that call

`git count-objects -v` shows this repo **has never been packed**:

```
count: 2509          <- loose objects
size: 9151 KB
in-pack: 0           <- no packfile at all
packs: 0
garbage: 128         <- tmp_obj_* leftovers
size-garbage: 835 KB
```

plus **17 `.git/objects/incoming-*` directories**. `.git` is ~15 MB. So the board's standing note is
confirmed on both counts: the `incoming-*` directories do hold real content and must not be
hand-deleted, and `git gc --prune=now` is the right tool — it would pack the 2509 loose objects and
sweep the 128 `tmp_obj_*` files in one pass. **That remains undone, blocked on the dangling-stash
decision above, exactly as the gate intends.**

---

## Verification

| Check | Baseline | After this task |
|---|---|---|
| `npx jest` (raw, no ignore pattern) | 1026 / 88 *(raw reported 4842 / 416)* | **1026 tests / 88 suites, all green** |
| `npx tsc --noEmit` | clean | **clean** (exit 0, no output) |
| `npx eslint .` | 0 errors / 56 warnings | **0 errors / 56 warnings** |
| `git status` | clean | clean apart from this report file |
| `git worktree list` | 5 entries | **1** (the main checkout) |

⚠ **Read the jest row precisely.** The **counts** — 1026 / 88 — are the deliverable and are now stable
and correct on a raw run. Whether a given run is **all green** still depends on Part B: roughly 3 runs
in 10 will show `1 failed, 1025 passed` on the one assertion analysed above, and every run immediately
following a red one passes (the sequencer moves the suite to first position). The run quoted here was
green; that is a fact about that run, not a claim that the failure is gone. It is not gone — it is
diagnosed, deterministic on demand, and left for its own task.

No `git commit`, no push, no force, no history rewriting, no change to `src/` or any application code.
The only file written into the repo is this report. Every diagnostic — the order-forcing sequencer, the
better-sqlite3 instrumentation, the probe scripts and all captured run output — lives outside the repo
in the session scratchpad, and was supplied to Jest purely through command-line flags.

## Test-first

**Carve-out, stated explicitly rather than silently**, as `CLAUDE.md` requires: this task changed no
behaviour. It is git plumbing plus an investigation, so there was nothing to write a failing test for;
the suite was the *instrument*, not the subject. Part B's reproduction is deliberately left **unfixed**
so that the fix can be its own numbered task and can be written test-first — which is now easy, because
the failure is deterministic (B.3) rather than a flake.

## Deviations from human decisions

Two items, both disclosed rather than silent; **neither reverses a human ruling.**

1. **`git worktree remove --force` was used rather than plain `git worktree remove`.** The brief says
   "remove each verified-duplicate worktree (`git worktree remove`)". Three of the four were *dirty* —
   they still held their task's uncommitted output — and plain `remove` refuses a dirty worktree. I
   used `--force` only after proving, file by file and hash by hash, that **every one of those dirty
   paths was blob-identical to `main`** (Part A.1). This is a mechanical elaboration of the instruction,
   not a change of intent, but it discarded working trees and so is recorded here.

2. **Part C was stopped before `git gc`,** which the brief anticipated and instructed
   ("if `fsck` reports anything at all, stop and report — do not gc"). Recorded as a deviation from the
   *outcome* the brief hoped for (a completed sweep), not from its instruction: following the gate is
   compliance. The decision now sits with Jason, above.

**Not deviations, recorded for completeness:**

- Removing `interesting-shirley-e10fa1` **discharges** Jason's 2026-08-17 ruling ("leave it in place
  for now... separate cleanup task later") rather than contradicting it — this task is that later
  cleanup, and the brief says so.
- `main` was at `ba52054`, not the `89d17e6` the brief describes; the difference is only the brief's own
  commit, with no bearing on any of the work.
- Branch deletion was **not** widened beyond the three `worktree-agent-*` names. In particular
  `claude/interesting-shirley-e10fa1` still exists locally and on `origin`; the worktree was detached
  at `d3ead86` and its removal did not touch that branch.
