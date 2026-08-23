# Task 56 — findings: planner assertion strength (task 53 findings W3/W4/W6/W7/W9)

**Build subagent, 2026-08-23.** Brief: `docs/briefs/planner_assertion_strength_task_56.md`. Evidence
and mutations: `docs/eval/test_audit_task53_findings.md` §W3, W4, W6, W7, W9.

**Outcome: all five mutations are now proven detectors.** Every one was applied to
`src/planning/planner.ts`, watched go red against the strengthened assertion, and reverted
immediately. **No production code changed** — `git status` shows exactly one modified file,
`src/planning/__tests__/planner.test.ts`. None of the five turned out to be a behaviour bug: in
every case the planner was already doing the right thing and nothing would have noticed if it
weren't, which is exactly what the audit predicted.

One test was strengthened in place (W3), one was strengthened in place **and** given a boundary
sibling (W4), and three new tests were added (W6, W7, W9). Net **+4 tests**: 1026 → 1030.

---

## 1. W3 — "at most two major tasks" was measured by capacity, not by the limit

**Test:** `planner.test.ts:267` *"allocates at most two major tasks into the block, strict score
order"* (strengthened in place).
**Mutation:** `if (deepItems.length >= 2) break;` → `>= 3`.

**What was wrong.** The fixture was three 25-minute tasks in a **120**-minute session → 80-minute
block → 60 work minutes. After two placements only 10 work minutes remained, so the third was
rejected by `isPlaceableInBlock` — the §5.3.1 "1–2 major tasks" rule the test is named after never
got a chance to act.

**What I asserted.** Re-sized the session to **150 minutes** → 100-minute block → **75 work
minutes**. The two placed 25s leave exactly 25 — enough for a third that is both major
(25 ≥ `DEEP_FOCUS_MAJOR_MIN_MINUTES`) and placeable. Only the limit can now stop it. Kept the
original `toEqual([1, 2])` assertion and the original three-task / descending-importance fixture
(the "strict score order" intent), and added three discriminating assertions:

- `expect(deepPlanned).toBe(50)` and `expect(deepPlanned + 25).toBeLessThanOrEqual(75)` — the
  headroom is real, stated in minutes, so a future re-size cannot silently take it away again;
- the displaced third task is planned into the **front section** (`[3]`), not dropped.

**Mutation output (`>= 2` → `>= 3`):**

```
● deep-focus allocation (§5.3.1 + task 28 step 0) › allocates at most two major tasks into the block, strict score order

  expect(received).toEqual(expected) // deep equality

  - Expected  - 0
  + Received  + 1

    Array [
      1,
      2,
  +   3,
    ]

  > 284 |     expect(deep.map((i) => i.task.id)).toEqual([1, 2]);
```

All three of the new assertions fail under the mutation as well (deep planned minutes become 75, and
the front section becomes empty); the quoted one is simply the first to trip.

**Knock-on:** none. The 120-minute fixture is used by one other test (`planner.test.ts:297`, task
55's `DEEP_FOCUS_MAJOR_MIN_MINUTES` literal pin) which has its own two-task pool and was untouched.
The suite is green with no other assertion moved.

---

## 2. W4 — the 25 % deep-focus overrun buffer could be deleted entirely

**Tests:** `planner.test.ts:122` *"reserves an end-of-session block with the 25% overrun buffer…"*
(strengthened in place) and a new sibling at `planner.test.ts:154`.
**Mutation:** `const workMinutes = Math.floor(blockMinutes * (1 - DEEP_FOCUS_OVERRUN_BUFFER));` →
`const workMinutes = blockMinutes;`.

**What was wrong.** The only discriminating assertion was `plannedMinutes === 40`, and a 40-minute
task fits in 45 work minutes *and* in the unbuffered 60. Nothing in the fixture sat near the
boundary where the buffer is load-bearing.

**What I asserted.**

1. **In the existing test**, added a **50-minute task with the pool's highest importance (950)** to
   the same 90-minute-session fixture. It is the top-ranked candidate and is passed over for exactly
   one reason: 50 > 45 buffered work minutes. All five original assertions are untouched and still
   pass; one new one (`.not.toContain(2)`) says the stronger task is nowhere in the plan. Delete the
   buffer and the 50 takes the block instead of the 40.
2. **A new boundary test** (`a 60-minute block plans 45 work minutes, not 60: a 45 anchors it, a 46
   cannot`) puts a fixture on each side of the line: a 45-minute task anchors the block with
   `plannedMinutes === 45`; a 46-minute task anchors nothing, the block dissolves, and it is planned
   in the front section instead.

**Mutation output — existing test:**

```
● deep-focus allocation (§5.3.1 + task 28 step 0) › reserves an end-of-session block with the 25% overrun buffer applied to countdown sizing

  expect(received).toBe(expected) // Object.is equality

  Expected: 1
  Received: 2

  > 140 |     expect(deep[0].task.id).toBe(1);
```

**Mutation output — new boundary test:**

```
● deep-focus allocation (§5.3.1 + task 28 step 0) › a 60-minute block plans 45 work minutes, not 60: a 45 anchors it, a 46 cannot

  expect(received).toBe(expected) // Object.is equality

  Expected: false
  Received: true

  > 174 |     expect(taskItems(over).some((i) => i.deepFocus)).toBe(false);
```

**Note on the constant's *value*.** The boundary pins the buffer's **existence and effect**, not its
exact 0.25. `Math.floor(60 × (1 − 0.24))` is also 45, so a small drift in the constant would not
trip this. `DEEP_FOCUS_OVERRUN_BUFFER` was not among task 53's seven surviving W5 constant
mutations, so I did not add a literal pin for it — flagging it here rather than expanding scope.

---

## 3. W6 — the §5.3.2 difficulty gradient was entirely unguarded

**Test:** `planner.test.ts:377` *"runs an easier→harder difficulty gradient within a group, with real
jitter (§5.3.2)"* (new).
**Mutations, two of them:** `jittered.sort((a, b) => a.key - b.key)` → `b.key - a.key` (direction
reversed); and `DIFFICULTY_JITTER = 1.5` → `0` (jitter removed).

**Why a single seeded draw would not do.** Both claims are distributional — a *direction* and a
*real randomness* — and any one roll is one sample. A fixed-seed draw that happens to come out
ordered is precisely the vacuous test this task exists to remove, and it would also stay green under
the zero-jitter mutation, because with the jitter at 0 the sort is exact and the easy task is always
first. So the test tolerates the jitter **by construction**: it rolls the same single-context agenda
under **200 seeds** and asserts the distribution.

**Fixture.** Three 10-minute tasks in one context group, energies **2 / 3 / 4** — deliberately
*adjacent* difficulties, because `DIFFICULTY_JITTER`'s own doc comment claims adjacent difficulties
"genuinely swap run-to-run", and that is the claim part 2 measures. A 40-minute moderate session, so
all three always fit and every roll measures order and nothing else (asserted per roll).

**Assertions, in two parts:**

1. **Direction.** `meanIndex(energy 2) < meanIndex(energy 3) < meanIndex(energy 4)`, plus
   `meanIndex(4) − meanIndex(2) > 1` so the ramp must dominate rather than merely edge out noise.
   Observed means over 200 seeds: **0.27 / 1.02 / 1.71**.
2. **The jitter is real.** Count the rolls where the harder of an adjacent pair lands first:
   `midBeforeEasy > 0` and `hardBeforeMid > 0` (observed **45** and **52** of 200) — and both
   `< ROLLS / 2`, so they stay swaps rather than a coin flip.

**Mutation output — sort reversed** (part 1 trips; the easiest task's mean index goes from 0.27 to
1.73):

```
● arrangement (§5.3.2–5.3.4) › runs an easier→harder difficulty gradient within a group, with real jitter (§5.3.2)

  expect(received).toBeLessThan(expected)

  Expected: < 0.98
  Received:   1.73

  > 418 |     expect(meanIndex(1)).toBeLessThan(meanIndex(2));
```

**Mutation output — `DIFFICULTY_JITTER = 0`** (part 2 trips; every roll returns the same fixed
permutation):

```
● arrangement (§5.3.2–5.3.4) › runs an easier→harder difficulty gradient within a group, with real jitter (§5.3.2)

  expect(received).toBeGreaterThan(expected)

  Expected: > 0
  Received:   0

  > 424 |     expect(midBeforeEasy).toBeGreaterThan(0);
```

Task 55's literal pin (`planner.test.ts:731`) is left exactly as it is; its comment already records
that it pins the value and is not a behavioural guard. This is the guard it was waiting on. I added
a cross-reference in the new test's header comment and changed nothing in the pin test itself.

---

## 4. W7 — the pre-deep-block break was not counted against front capacity

**Test:** `planner.test.ts:433` *"counts the pre-deep-block break against front capacity (the front
never overruns)"* (new).
**Mutation:** `const preDeepBreak = allowBreaks && blockMinutes > 0 ? BREAK_MINUTES : 0;` → `0`.

**Fixture.** A 90-minute deep-focus session: 60-minute block, **30 gross minutes** of front section.
One 40-minute major anchors the block. The front pool is two tasks in a **single context group** (so
the only break the front must pay for is the §5.3.4 boundary break): **25 + 5 = 30**, which fits the
front exactly *only if that break is free*.

**Assertions, deliberately order-independent** — the novelty shuffle offers the two front tasks in
either order depending on the seed, and the test runs four seeds (1, 2, 19, 23):

- everything before the block — front tasks **and** the boundary break — sums to ≤ 30, the gross
  minutes the block leaves behind (`90 − round(90 × 2/3)`);
- exactly **one** front task is planned, whichever one the shuffle reached first.

Both hold under every seed unmutated (the plan is either `[25, break, deep]` or `[5, break, deep]`);
both fail under the mutation, which admits both front tasks and overruns the session by exactly the
break's five minutes.

**Mutation output:**

```
● arrangement (§5.3.2–5.3.4) › counts the pre-deep-block break against front capacity (the front never overruns)

  expect(received).toBeLessThanOrEqual(expected)

  Expected: <= 30
  Received:    35

  > 460 |       expect(frontMinutes).toBeLessThanOrEqual(30);
```

I chose a **minute-budget** assertion over a task-identity one on purpose: it states the actual rule
(the front section plus its break must fit the time the block leaves) rather than an incidental
consequence of it, and it survives the shuffle without needing a pinned seed.

---

## 5. W9 — the equal-energy group tie-break was unguarded

**Test:** `planner.test.ts:468` *"breaks an equal-mean-energy tie between groups by score, not
insertion order (§5.3.3)"* (new).
**Mutation:** drop `|| maxScore(b) - maxScore(a)` from the group sort.

**Why every existing fixture missed it.** `rankWithContextNovelty` *already* orders groups by
descending max score, so in every previous fixture the groups' insertion order agreed with the
tie-break and the tie-break was a no-op. The mutation was invisible because nothing ever disagreed
with it.

**Fixture — built so the two orders disagree.** Three tasks, all `energyRequirement: 3` (so the
energy ramp is a genuine tie and the tie-break is the only thing that can decide):

| task | context | importance | estimate | fate |
|---|---|---|---|---|
| 1 | home | 950 | 60 min | **leads the novelty order**, then does not fit the 40-minute session |
| 2 | home | 300 | 10 min | the home group's only survivor |
| 3 | computer | 600 | 10 min | stronger than task 2 |

The home group leads `rankWithContextNovelty` on task 1's strength, but reaches arrangement
represented only by its weakest member. Insertion order therefore says home-then-computer; the score
tie-break says the opposite. Asserted: task 1 is absent, every surviving task has energy 3 (the tie
is real by construction, not by luck), and the agenda is `[3, 2]`.

**Mutation output:**

```
● arrangement (§5.3.2–5.3.4) › breaks an equal-mean-energy tie between groups by score, not insertion order (§5.3.3)

  expect(received).toEqual(expected) // deep equality

  - Expected  - 1
  + Received  + 1

    Array [
  -   3,
      2,
  +   3,
    ]

  > 511 |     expect(items.map((i) => i.task.id)).toEqual([3, 2]);
```

---

## 6. Verification

| Check | Baseline (brief) | After |
|---|---|---|
| `npx jest` | 1026 tests / 88 suites | **1030 tests / 88 suites** (+4) |
| `npx tsc --noEmit` | clean | **clean** |
| `npx eslint .` | 0 errors / 56 warnings | **0 errors / 56 warnings** |

`git status` at the end: one modified file, `src/planning/__tests__/planner.test.ts`
(+200 / −3). `src/planning/planner.ts` is **unmodified** — every mutation was reverted immediately
after the check that used it, and the reverts are confirmed by the file's absence from `git status`,
not merely by intention. Nothing was committed.

### ⚠ A pre-existing full-suite failure, outside this task

`npx jest` reports **1 failed test** — `src/services/backup/__tests__/consistency.test.ts:91`,
*"the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)"*:

```
> 91 |     ).rejects.toThrow(/Circular dependency detected/);
```

**This is not mine and it is not new.** I ran the full suite **before touching anything** and it
failed there too, at 1025/1026 — the same test, the same assertion. What I observed:

- it **passes** when `consistency.test.ts` runs alone (11/11);
- it **passes** when `src/services/backup` + `src/db` run together (24 suites, 241 tests);
- it **fails reproducibly** in the full 88-suite run (3 for 3: once pre-change, twice post-change).

So it is load- or parallelism-sensitive rather than a logic defect in the test's own file, and it
sits in task 49 / migration 008 territory. Per the brief's scope rule I did not touch it, did not
investigate further than the above, and flag it here for the coordinator to task separately. The
brief's stated baseline of "1026 tests / 88 suites" is accurate as a *count*; the tree is **not**
fully green, and was not when I received it.

---

## Deviations from human decisions

**One, small, and it is a correction rather than a departure.**

The audit's suggested remediation for **W3** was "three **15**-minute major tasks in the same 60
work minutes." That fixture cannot work: at 15 minutes a task is not major
(`DEEP_FOCUS_MAJOR_MIN_MINUTES` is 25), so all three would be skipped by the `if (!major) continue;`
branch and no deep item would be placed at all. I kept the audit's *intent* — give the fixture
headroom so only the limit can stop the third — and got it by enlarging the session (120 → 150
minutes, i.e. 60 → 75 work minutes) while leaving the three 25-minute tasks as they were. The brief
permits this explicitly ("follow them or better them, but say which").

Nothing else diverged. Tests-only scope held, no production line changed, no existing assertion was
deleted or weakened, and both of W6's mutations are covered by the statistical construction the
brief asked for rather than by a lucky seed.
