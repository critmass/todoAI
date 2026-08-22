# Task 53 — Test-suite integrity audit: are tests confirming bad code?

**Owner:** audit subagent (Opus). **Status:** ⬜ complete — findings only.
**Audit-only.** No test was fixed, no source was changed, nothing was committed. Every mutation
below was reverted immediately after the run that used it; the tree was verified clean
(`git status --porcelain` empty, `git diff --stat` empty) before this file was written, and the
baseline re-confirmed green after the last mutation.

**Baseline (real, worktree excluded):** **973 tests / 86 suites, all passing, ~18 s.**
Raw `npx jest` reports 1767/154 because the stale `.claude/worktrees/interesting-shirley-e10fa1`
adds a fixed 794/68. Every count in this document is the real one, obtained with
`npx jest --testPathIgnorePatterns worktrees`.

---

## 0. Method

The brief's mutation heuristic, applied for real rather than by inspection: *break the code in a
plausible way and see whether the suite goes red.* A harness applied one literal substitution to a
source file, ran jest, and reverted via `git checkout` under a `trap` so no mutation could outlive
its run.

**33 mutations were executed, every one against the full 973-test suite** (targeted runs were used
only for triage; every finding reported here was confirmed full-suite, so "survived" means *no test
anywhere in the repo detects it*). A control mutation (`neglectCurve` → constant `1`) was run first
and each sweep re-verified the tree afterwards.

**Result: 18 caught, 15 survived.** A survivor is not automatically a defect — but a survivor whose
behaviour a test *claims in its own title* is exactly the failure this audit was chartered to find.

### Headline counts

| Bucket | Count |
|---|---|
| **Confirmed weak / misleading** | **12** (9 demonstrated by a surviving mutation; 3 structural) |
| **Pins a known bug, correctly flagged** — left alone | **3** |
| **Fine** — spot-checked, demonstrated detector | **11 suites / areas** |
| **Handed to tasks 20 / 31 / 40** (eval-oracle validity, out of scope) | **1** |

Two whole-suite properties are worth stating up front, because they are *good*: there is **not a
single `expect(true).toBe(true)`-class tautology** in the suite, and **not a single snapshot test**
(`toMatchSnapshot` / `toMatchInlineSnapshot` appear nowhere). Taxonomy classes 1 (literal
tautology) and 4 (frozen snapshot) are essentially absent from the unit suite. The real weakness is
concentrated in classes 2 (passes against a stub) and 3 (assertion that cannot fail on the thing it
names).

---

## 1. Confirmed weak / misleading — ranked by blast radius

### 🔴 W1. The recovery ladder's default salvage policy has no test on its rejecting branch

**`src/services/backup/ladder.ts` — `defaultAcceptSalvage`** · `src/services/backup/__tests__/ladder.test.ts`

**Mutation that did not turn it red:**
```
return tasksRecovered && report.taskRowsRecovered > 0;   →   return tasksRecovered;
```
**973/973 passed.**

**Would still pass if X were wrong:** if the ladder accepted a salvage that recovered the `tasks`
table with **zero rows**. Three tests appear to cover this and none of them do:

- `ladder.test.ts:68` "salvages a corrupt working database and promotes the rebuild" — reaches the
  default policy, but only on the **accepting** branch (400 tasks seeded, `taskRowsRecovered > 0`).
- `ladder.test.ts:97` "falls through to restore when the salvage recovers nothing worth keeping" —
  the title names the policy, but the fixture corrupts the file **header**, so `salvageDatabase`
  *throws* and control leaves via the `catch` at `ladder.ts:152`. `accept()` is never called. This
  test exercises the exception path, not the policy.
- `ladder.test.ts:123` "honours an injected salvage policy that rejects a lossy rebuild" — injects
  `acceptSalvage: () => false`, testing that the **seam** is honoured, not that the **default** is
  correct.

**Why this ranks first.** The accepting branch calls `promoteToWorking(...)` — it overwrites the
user's working database — and then `return`s with `status: 'salvaged'`, so **step 3
(restore-from-backup) never runs**. A wrong policy here silently replaces a recoverable database
with an empty one while a good backup sits unused on disk. `ladder.ts`'s own header names this
class of bug: *"A ladder that wiped a device because it ran out of automatic options would be the
single worst bug this task could ship."* That guard is currently asserted by nothing.

**Remediation (test-first).** Add a fixture that produces a salvage where the `tasks` table is
recovered but empty — e.g. seed a working DB with zero tasks (or with only non-`tasks` rows) and
corrupt a data page rather than the header — and assert `outcome.status === 'restored'`, that
`workingDbReplaced` reflects the restore rather than the salvage, and that the restored row count
matches the backup. Confirm it fails against `return tasksRecovered;` before landing it.

---

### 🔴 W2. `scoreTask` can silently drop `skipCount` from the historical-success evidence count

**`src/scoring/score.ts:75`** · `src/scoring/__tests__/score.test.ts`

**Mutation that did not turn it red:**
```
historicalSuccessFactor(task.successRate, task.completionCount + task.skipCount)
                                       →  historicalSuccessFactor(task.successRate, task.completionCount)
```
**973/973 passed.**

**Would still pass if X were wrong:** because **no scoring or planning fixture anywhere in the repo
sets `skipCount` to a nonzero value.** Verified by grep — the only nonzero `skipCount` in the tree is
`src/services/coaching/__tests__/triggers.test.ts:56`, where it is opaque `triggerData`, not a
scoring input. Every `makeTask()` helper in `score.test.ts`, `factors.test.ts`, `filter.test.ts`,
`noveltyEntropy.test.ts`, `planner.test.ts` and `plannedMinutes.test.ts` hard-codes `skipCount: 0`.

**Consequence if wrong:** `attemptCount` is the denominator of the R6 Bayesian shrinkage. Losing the
skip half means a task skipped twenty times reads as *no evidence* and stays pinned at the 0.5
prior instead of converging toward its real, low success rate — on a 23 % weight, across every
ranking the app makes. `factors.test.ts` pins the *formula* thoroughly; nothing pins the *wiring*
that feeds it.

**Remediation.** One test in `score.test.ts` with `completionCount: 2, skipCount: 8` asserting
`scored.factors.historicalSuccess` equals `historicalSuccessFactor(rate, 10)` and **not**
`historicalSuccessFactor(rate, 2)`. (The equivalent wiring guard for the missed-quota boost already
exists and is good — see F5 — it just lives in `advance.test.ts`, not here.)

---

### 🟠 W3. "At most two major tasks" is measured by capacity, not by the limit

**`src/planning/planner.ts:299`** · `src/planning/__tests__/planner.test.ts:224`

**Mutation that did not turn it red:**
```
if (deepItems.length >= 2) break;   →   if (deepItems.length >= 3) break;
```
**973/973 passed.**

**Would still pass if X were wrong:** the test is titled *"allocates at most two major tasks into
the block, strict score order"* and asserts `deep.map(i => i.task.id) === [1, 2]`. But its fixture
is three 25-minute tasks in a 120-minute session → `blockMinutes = 80`, `workMinutes = 60`. After
two placements `workRemaining` is 10, so the third is rejected by `isPlaceableInBlock`, **not by the
limit**. The spec rule the test names (§5.3.1's "1–2 major tasks") is unmeasured.

**Remediation.** Give the fixture headroom — three 15-minute major tasks in the same 60 work minutes
— so only the `>= 2` limit can stop the third. Verify it fails against `>= 3` first.

---

### 🟠 W4. The 25 % deep-focus overrun buffer can be deleted entirely

**`src/planning/planner.ts:258`** · `src/planning/__tests__/planner.test.ts:120`

**Mutation that did not turn it red:**
```
const workMinutes = Math.floor(blockMinutes * (1 - DEEP_FOCUS_OVERRUN_BUFFER));
                                            →   const workMinutes = blockMinutes;
```
**973/973 passed.**

**Would still pass if X were wrong:** the test is titled *"reserves an end-of-session block with the
25 % overrun buffer applied to countdown sizing"* and its inline comment says *"≤ 45 work minutes —
fits WITH the buffer"* — but the only discriminating assertion is `plannedMinutes === 40`, and a
40-minute task fits in 45 **and** in 60. The buffer is load-bearing only at the boundary, and no
fixture sits near it.

Note the nuance: the *unit* is properly guarded — `plannedMinutes.test.ts:98` asserts
`isPlaceableInBlock(task, 60, 20) === false`, which does distinguish gross from work minutes. It is
the **planner's computation of `workMinutes`** that nothing checks.

**Remediation.** Add a task estimated at 50 minutes to the 90-minute-session case and assert it is
**not** placed (50 > 45 work minutes) while a 45-minute one is. That assertion is false without the
buffer.

---

### 🟠 W5. Systemic: tunable constants are asserted against themselves

**`src/scoring/__tests__/factors.test.ts`, `src/planning/__tests__/planner.test.ts`**

Seven constant mutations survived the full suite:

| Constant | Mutation | Result |
|---|---|---|
| `URGENCY_HORIZON_DAYS` | 14 → 30 | ** survived ** |
| `BASE_SENSITIVITY_CEILING` | 0.15 → 0.4 | ** survived ** |
| `MISSED_QUOTA_BOOST_MAX` | 0.25 → 0.30 | ** survived ** |
| `DEEP_FOCUS_MAJOR_MIN_MINUTES` | 25 → 20 | ** survived ** |
| `BREAK_MINUTES` | 5 → 7 | ** survived ** |
| `EASIER_MAX_ITEM_MINUTES` | 25 → 60 | ** survived ** |
| `DIFFICULTY_JITTER` | 1.5 → 0 | ** survived ** |

**Mechanism (taxonomy #1, in its subtle form).** The tests either assert against the constant
itself — `expect(urgencyFactor(farOut, 5, NOW)).toBeCloseTo(BASE_SENSITIVITY_CEILING)` — or
*compute the fixture from* the constant:

```ts
const halfHorizon = new Date(NOW + (URGENCY_HORIZON_DAYS / 2) * MS_PER_DAY).toISOString();
expect(urgencyFactor(halfHorizon, 1, NOW)).toBeCloseTo(0.5, 5);
```

Both sides move together, so the assertion is invariant under any change to the value. These are
*design decisions* — `factors.ts` marks several `REVIEW(task10): a reasoned starting horizon, not a
measured one` — and a design decision that no test pins can be changed by accident and never
noticed.

**The remedy is already in the repo, twice.** Both are worth copying rather than inventing:

- `factors.test.ts:45–48` asserts `importanceFactor(null)` against **both**
  `DEFAULT_IMPORTANCE_INTERNAL / 1000` **and** the literal `0.5`. The mutation
  `DEFAULT_IMPORTANCE_INTERNAL 500 → 700` was **caught** — by the literal, not by the symbol.
- `src/execution/constants.ts` is pinned with literals throughout (`59_999` / `60_000` for
  `PARK_GATE_MS`, `min(25)` for the quantum, `1/3` and `2/3` for the shrinkage). **All four
  execution-constant mutations were caught** (see F1). This is the same codebase getting it right in
  one module and not the other.

**Remediation.** For each constant above, add one literal-valued assertion alongside the symbolic
one. Not a rewrite — one extra `expect` per constant.

---

### 🟠 W6. The §5.3.2 difficulty gradient is entirely unguarded

**`src/planning/planner.ts:359–367`**

**Two mutations, neither turned it red (973/973 each):**
```
jittered.sort((a, b) => a.key - b.key);   →   jittered.sort((a, b) => b.key - a.key);   // easy→hard reversed
export const DIFFICULTY_JITTER = 1.5;     →   = 0;                                       // jitter removed
```

**Would still pass if X were wrong:** nothing anywhere asserts the within-group ordering direction.
`planner.test.ts`'s arrangement block checks group *ordering* (the ascending energy ramp) and break
placement, but never the gradient inside a group. So the spec's "easier front, harder back" could
run backwards, and the "real randomness" that makes it novelty rather than a fixed order could be
zero, and the suite is silent.

**Remediation.** With a fixed seed, assert the mean energy-requirement position: over N seeded rolls
of a single-group agenda, the low-energy task's mean index is below the high-energy task's. That
assertion is false under both mutations and tolerates the jitter by construction.

---

### 🟡 W7. The pre-deep-block break is not counted against front-section capacity

**`src/planning/planner.ts:335`**

**Mutation that did not turn it red:**
```
const preDeepBreak = allowBreaks && blockMinutes > 0 ? BREAK_MINUTES : 0;   →   const preDeepBreak = 0;
```
**973/973 passed.** The front section may overrun the session by the break's 5 minutes and no test
notices. Remediation: one capacity test sized so the last front task fits *only* if the pre-deep
break is uncounted.

---

### 🟡 W8. `contextGroupKey`'s NUL escape is a documented claim with no test

**`src/scoring/score.ts:121–124`**

**Mutation that did not turn it red:** `return '\x00flexible';` → `return 'flexible';` — 973/973.

The code comment makes an explicit behavioural claim — *"so a task tagged literally `flexible` never
merges into the no-tags group"* — and nothing tests it. Low blast radius (a shuffle-grouping
oddity), but it is a stated invariant with zero coverage. Remediation: one test with
`contextTags: ['flexible']` alongside a `contextTags: []` task, asserting different group keys.

---

### 🟡 W9. The equal-energy group tie-break is unguarded

**`src/planning/planner.ts:358`** — dropping `|| maxScore(b) - maxScore(a)` survives (973/973).
Groups with equal mean energy fall back to insertion order rather than score order. Low severity;
noted for completeness.

---

### 🟡 W10. `src/capture/retention.ts` has **no test file at all**

Both mutations survived (973/973), including one the file's own comment forbids:

```
for (const day of days.slice(0, Math.max(0, days.length - 1)))   →   for (const day of days)
```
— i.e. **rotation deletes the newest day**, against `retention.ts`'s explicit *"never the newest,
which is what you are debugging"*. Also survived: `CAPTURE_WARN_BYTES` 80 % → 20 % of the ceiling.

`src/capture/__tests__/` contains `availableBytes`, `forceKill`, `mutationCapture`, `record` and
`sha256` — no `retention`. This is an absent test rather than a confirming one, but the mutation
heuristic surfaces it in the same pass, and the 512 MB ceiling is the bound task 14 reasons about
when it treats `capture/` as reclaimable space. Remediation: a small unit test over a fake
`CaptureWriter` covering rotate-oldest-first, never-the-newest, and the warn threshold.

---

### 🟡 W11. `blockKindsAgree` is a compile-time guard dressed as a runtime assertion

**`src/execution/__tests__/timer.test.ts:22–24, 79–83`**

```ts
const blockKindsAgree: BlockKindsAgree = true;
...
it("keeps the planner's BlockKind and the stored EpisodeBlockKind identical", () => {
  expect(blockKindsAgree).toBe(true);
});
```

The runtime assertion is taxonomy #1 — a constant compared to the literal it was just set to. The
*real* guard is the type annotation: if the unions diverge, `BlockKindsAgree` resolves to `false` and
the assignment is a type error. But jest runs through **babel-jest** (`@react-native/jest-preset`,
`babel.config.js` — types stripped, never checked), so **`npx jest` cannot detect the drift this test
appears to guard.** Only `npx tsc --noEmit` can.

The guard does exist — the verification ritual runs `tsc` — so this is *misleading*, not *absent*.
Remediation: rename the test and add a comment saying the enforcement is `tsc`, so a green jest run
is never read as proof the vocabularies agree. (A green-jest-only CI path would silently lose it.)

---

### 🟢 W12. Migration forward-sweep — a structural note, not a defect

**`src/db/migrations/__tests__/`**

The brief's specific worry — *"a migration test that silently became an assertion about a later
migration"* — is **present in the assertions but not in the outcome.** `002_skillLayerSchema.test.ts`
asserts `getCurrentSchemaVersion(conn)).toBe('2.8.0')`, which is **007's** doing; likewise its view
list is the post-004 list. The tests say so in their own comments, honestly:
*"runMigrations walks the whole list, so the DB lands at the latest version (003-007 ride along)."*

**Demonstrated:** mutating 002's own version bump (`'2.3.0'` → `'2.2.0'`) left **002's own suite
green**. It was caught only by `schemaDrift.test.ts` (the `.sql` ↔ `.ts` mirror — a different guard)
and by `003_multisessionWork.test.ts`'s legacy fixture, whose `beforeEach` sanity-checks `'2.3.0'`.

So each migration's version bump is guarded by the **next** migration's legacy fixture. That chain is
complete by construction — and this suite is genuinely well built: **every** migration test
constructs its own `createLegacyVxxxConnection()` fixture rather than testing from a fresh install
(verified across 002–007). The one thing to watch: the **last** migration in `MIGRATIONS` has no
downstream fixture, so when 008 lands, 007's bump becomes guarded and 008's does not. Worth a note in
the migration-authoring convention rather than a code change.

---

## 2. Pins a known bug, correctly flagged — **left alone**

These are the opposite of the problem. Listed so the distinction stays visible.

| Test | What it pins | How it is flagged |
|---|---|---|
| `src/services/backup/__tests__/consistency.test.ts:20, :74` | Migration 001's `prevent_circular_dependencies` trigger only catches the direct reverse pair, so a 3-cycle inserts cleanly (task 49). | Explicit in both test names (*"which the schema trigger does NOT catch"*, *"the schema trigger lets through"*) and in the inline comment: *"That is the point of the assertion."* |
| `src/capture/__tests__/forceKill.test.ts:10–18` | The acceptance test exercises the **Node** writer, not the **Kotlin** one, and does not test `fsync`. | A 🔴 header block — *"WHAT THIS DOES NOT PROVE, STATED SO NOBODY OVER-READS A GREEN"* — that names the divergence as a desktop inference and hands ground truth to design §14.2's device run. This is the model for disclosing a taxonomy-#5 seam. |
| `src/services/backup/sessionGate.ts` (header) | The gate cannot know free space in advance; it makes the attempt itself the test, and `quick_check` is deliberately weaker than `integrity_check`. | Stated in full in the module header, with the alternatives named and put to Jason rather than chosen silently. The `quick: true` → `quick: false` mutation **is** caught by `sessionBackupGate.test.ts`. |

---

## 3. Fine — spot-checked, demonstrated detectors

Each of these was probed with at least one mutation that **turned it red**.

| Area | Mutation(s) caught |
|---|---|
| `src/execution/__tests__/timer.test.ts` | `PAUSE_COACHING_RATIO` 0.2→0.3; `REPEATED_EXTENSION_MINUTES_FLOOR` 10→4; `LONG_EXTEND_BLOCK_MULTIPLE` 2→3; `PARK_GATE_MS` 60 s→30 s. **4/4.** Boundary values pinned with literals — the model for W5. |
| `src/execution/__tests__/episodeService.test.ts` | crash recovery crediting **zero** minutes (3 tests red); session-over-by-time detection dropped (1 test red). Crash recovery is genuinely guarded. |
| `src/scoring/__tests__/noveltyEntropy.test.ts` | `weightedShuffle` ignoring `finalScore` entirely (uniform shuffle) — caught by the fail-safe-outlier share assertion. A real measurement-based regression test, and one that correctly distinguishes "shuffle collapsed to deterministic" from "the §5.2 fail-safe is working". |
| `src/scoring/__tests__/filter.test.ts` | dropping the R7c breakdown-confirmation hold (`&& !held`) — **5 tests across 3 suites** red. The task-25 side-door risk is genuinely closed. |
| `src/scoring/__tests__/score.test.ts` | `neglectCurve` → constant; the deterministic id tie-break removed. |
| `src/scoring/__tests__/factors.test.ts` | `DEFAULT_IMPORTANCE_INTERNAL` 500→700. The **formulas** (R6 shrinkage, the `f + (1−f)·boost` shape, the clamps, the quota-met cutoff) are pinned with derived literals and are strong; only the constant *values* are not (W5). |
| `src/planning/__tests__/planner.test.ts` | letting open-ended tasks into the front section. The selection-boundary and replan blocks are solid; the weaknesses are localised to W3/W4/W6/W7/W9. |
| `src/planning/__tests__/plannedMinutes.test.ts` | row-by-row against design §3.2, including the gross-vs-work-minutes distinction W4 needs. |
| `src/llm/extraction/__tests__/validator.test.ts` | the task-37 junk-title guard neutered; past-due rejection dropped. Both red. |
| `src/services/backup/__tests__/ladder.test.ts` | removing the step-4/5 offers on `unrecoverable`. The ladder's *shape* is well guarded — it is only `defaultAcceptSalvage` (W1) that is not. |
| `src/db/migrations/__tests__/*` | `schemaDrift.test.ts` is a real `.sql` ↔ `.ts` mirror guard (caught the 002 edit immediately); every per-migration test builds its own legacy fixture. |
| `src/llm/grammar/__tests__/ruleNaming.test.ts` | a real lint over both checked-in and `buildGrammar`-substituted GBNF, explicitly guarded against vacuity by `expect(names.length).toBeGreaterThan(0)`. |
| `src/capture/__tests__/forceKill.test.ts` | the demonstrated-detector standard the brief cites. Explicitly anti-vacuous at `:158` — *"A harness that silently did nothing would otherwise pass every assertion below vacuously."* |

On the `toContain` class (taxonomy #3): the heaviest user is
`src/llm/prompts/__tests__/assemble.test.ts` (13 occurrences), and it is **fine** — the subset checks
are on prompt *strings*, where "the prompt contains this instruction" is the correct assertion, and
they are paired with a negative (`not.toContain('learned approaches')`) and an exact bound
(`expect(messages[0].content).toBe(base)`). No unbounded-subset weakness was found in the unit suite.

---

## 4. Handed to tasks 20 / 31 / 40 — not re-litigated here

**`src/dev/extractionFixturesData.ts` — `context_tags_must_include`.** Present across the 16-fixture
bank; a subset check, therefore blind to over-production by construction (a model emitting the entire
tag vocabulary passes every time). This is the brief's motivating pattern and it is **task 20 / 31 /
40's domain**, so it is flagged and handed over rather than analysed.

Two observations to pass along with it, both in the fixtures' favour:

1. **The oracle itself is tested.** `src/dev/__tests__/extractionScoring.test.ts` opens with *"The
   Task 7 tuning loop keys every decision off these verdicts, so the oracle itself is tested"* and
   covers `normalizeTitle`, `recurrenceEquals`, `isJunkTag`, `scoreExtraction`. That is the right
   instinct and is not what needs revisiting.
2. **The open question is the golds' provenance, not the scorer's correctness** — i.e. task 50 §6a's
   model-generated answer key read later as ground truth. That distinction is the useful handover.

---

## 5. Recommended remediation order

Every fix below is **test-first** per `CLAUDE.md`: strengthen the assertion, watch it fail against
the exact mutation named here, *then* it is a real guard. A "fix" that still passes against the
mutation has fixed nothing.

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | **W1** ladder `defaultAcceptSalvage` rejecting branch | 🔴 data loss | new fixture, ~1 test |
| 2 | **W2** `scoreTask` skipCount wiring | 🔴 every ranking | 1 test |
| 3 | **W3** deep-block "at most two" limit | 🟠 | re-size an existing fixture |
| 4 | **W4** 25 % overrun buffer | 🟠 | 1 assertion |
| 5 | **W5** literal-pin the 7 unpinned constants | 🟠 systemic | 1 `expect` each |
| 6 | **W6** difficulty gradient direction + jitter | 🟠 | 1 seeded statistical test |
| 7 | **W10** `capture/retention.ts` — no coverage | 🟡 | new small suite |
| 8 | **W7 / W8 / W9 / W11** | 🟡 | 1 test or 1 comment each |
| 9 | **W12** migration-authoring note (last-migration bump) | 🟢 | convention note |

**Suggested grouping into follow-up tasks:** W1 alone (backup/recovery, its own task — it is a
data-loss path); W2 + W5 together (scoring assertion strength); W3 + W4 + W6 + W7 + W9 together
(planner assertion strength); W10 alone (capture retention coverage); W8 + W11 + W12 as a small
hygiene sweep.

---

## 6. Audit hygiene

- 33 mutations executed, each reverted immediately by the harness's `trap` before the next ran.
- `git status --porcelain` and `git diff --stat` verified empty after every sweep and at the end.
- Baseline re-confirmed after the final mutation: **86 suites / 973 tests passed.**
- Nothing was committed. The only new file is this one.
