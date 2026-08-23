# Task 58 — findings: test-hygiene sweep (W8 / W11 / W12)

**Build subagent, 2026-08-23.** Three small, unrelated items from task 53's audit
(`docs/eval/test_audit_task53_findings.md`). Brief: `docs/briefs/test_hygiene_sweep_task_58.md`.

**Outcome: all three landed.** One new behavioural test (W8), one test rename + explanatory
comment (W11, carve-out), one pair of comments recording a structural gap (W12, carve-out). No
production behaviour changed anywhere. Nothing committed.

---

## 1. W8 — `contextGroupKey`'s NUL-sentinel claim now has a test

**File:** `src/scoring/__tests__/score.test.ts` (new `describe` block, imports `contextGroupKey`
from `../score`).

Added one test asserting a task with `contextTags: ['flexible']` gets a different `contextGroupKey`
than a task with `contextTags: []`:

```ts
describe('contextGroupKey (task 58 / W8 — the NUL-sentinel invariant)', () => {
  it('keys a task tagged literally "flexible" differently from an untagged task', () => {
    const untagged = makeTask({ id: 1, contextTags: [] });
    const literallyFlexible = makeTask({ id: 2, contextTags: ['flexible'] });
    expect(contextGroupKey(untagged)).not.toBe(contextGroupKey(literallyFlexible));
  });
});
```

**Test-first, as the brief required.** Ran green against the real code first
(`npx jest src/scoring/__tests__/score.test.ts -t "NUL-sentinel"` → 1 passed), then applied the
named mutation to `src/scoring/score.ts:122`:

```
if (task.contextTags.length === 0) return '\x00flexible';   →   return 'flexible';
```

and reran the same targeted test. **It failed for the right reason:**

```
● contextGroupKey (task 58 / W8 — the NUL-sentinel invariant) › keys a task tagged literally "flexible" differently from an untagged task

  expect(received).not.toBe(expected) // Object.is equality

  Expected: not "flexible"

    133 |     const untagged = makeTask({ id: 1, contextTags: [] });
    134 |     const literallyFlexible = makeTask({ id: 2, contextTags: ['flexible'] });
  > 135 |     expect(contextGroupKey(untagged)).not.toBe(contextGroupKey(literallyFlexible));
        |                                            ^
    136 |   });
    137 |   });

Test Suites: 1 failed, 1 total
Tests:       1 failed, 12 skipped, 13 total
```

Reverted the mutation immediately after (`git diff --stat src/scoring/score.ts` empty before and
after). The sentinel value itself (`'\x00flexible'`) was **not** touched — per the brief's warning,
it stays byte-identical (still a source escape, not a raw byte, so `score.ts` stays reviewable as
text; still purely a `Map` key, never persisted or displayed).

**Guard:** `src/scoring/__tests__/score.test.ts` → `contextGroupKey (task 58 / W8 — the NUL-sentinel
invariant) › keys a task tagged literally "flexible" differently from an untagged task`.

## 2. W11 — `blockKindsAgree` test renamed, enforcement mechanism made explicit (carve-out)

**File:** `src/execution/__tests__/timer.test.ts`.

This is a **test-first carve-out** per `CLAUDE.md` and the brief §4: no behavioural code changed,
so there is nothing to watch fail. The change is a rename plus two comments.

1. Extended the existing comment above the `Extends`/`BlockKindsAgree` type declaration
   (`timer.test.ts:19-24`) to state explicitly: the guard is the **type annotation**, not the
   `expect`; jest runs through babel-jest (`@react-native/jest-preset`) which strips and never
   checks types, so `npx jest` cannot detect this drift — only `npx tsc --noEmit` can; and named
   the risk: **a CI path running jest but not tsc would silently lose this guard entirely.**
2. Renamed the test itself, from *"keeps the planner's BlockKind and the stored EpisodeBlockKind
   identical"* (which reads as a claim the runtime assertion proves) to *"records that BlockKind and
   EpisodeBlockKind are kept identical by tsc, not by this assertion"* — the title now names the
   real enforcement mechanism instead of implying the `expect` is what's doing the work — plus an
   inline comment on the `it()` reiterating that this is a tautology and why the test still exists
   (discoverability / suite count, not detection).

Per the brief: **the construct was not deleted.** `blockKindsAgree`, `BlockKindsAgree`, and the
`expect(blockKindsAgree).toBe(true)` assertion are all still present and still pass — the type-level
guard is real and stays wired exactly as it was. Confirmed with `npx tsc --noEmit` (clean) after the
change.

**Guard:** unchanged — the type system, exercised by `npx tsc --noEmit`, at
`src/execution/__tests__/timer.test.ts:22-24`. The renamed jest test at `:88-95` is documentation of
that fact for anyone reading the suite, not a new detector.

## 3. W12 — the unguarded last-migration bump, recorded in `src/db/migrations/index.ts` (carve-out)

**File:** `src/db/migrations/index.ts`. Also a **carve-out** — a documentation note only, per the
brief §3/§4 ("this one is a note, not a code change").

Two comments added, both explained in §0's file-level convention and again at the point where a
migration author would actually be looking:

1. **The authoring header** (top of the file, next to the existing "To add 003_*.sql:..." note) now
   tells whoever adds a migration to give it its own `createLegacyVxxxConnection()` fixture — the
   existing convention every migration test since 002 already follows — and states *why*: that
   fixture is what guards the **previous** migration's version bump.
2. **A comment directly above/after the `MIGRATIONS` array** states the mechanism in full: each
   migration's version bump is guarded by the next migration's legacy fixture (confirmed by task
   53's mutation sweep across 002-007), so the **last** entry in the list is always unguarded until a
   successor lands. Names today's unguarded entry explicitly — **008, schema 2.9.0** — and tells
   whoever writes 009 that landing it both closes 008's gap and reopens the same gap for 009, and to
   record that fact again at this same spot.

**No separate "migration-authoring convention" document exists in the repo** (checked
`docs/briefs/orientation_for_opus.md` and grepped `docs/` for one) — the authoring convention lives
entirely in `src/db/migrations/index.ts`'s header comment, so both halves of the brief's "a comment
in index.ts and/or the migration-authoring convention" instruction point at the same file. Nothing
else was touched.

### Proposed direct guard (not built, per the brief's instruction)

A cheap, narrow option if a follow-up task wants to close the gap without a new fixture: a single
assertion in `src/db/migrations/__tests__/schemaDrift.test.ts` (or a new one-line test) asserting
`MIGRATIONS[MIGRATIONS.length - 1].version` equals the literal string of the newest schema version
(e.g. `'2.9.0'` today) — a direct pin on the *last* array entry, independent of any downstream
fixture. It would need updating by hand every time a migration is added (the same manual-bump cost
`schemaDrift.test.ts` already accepts for its `.sql`↔`.ts` mirror), and it only pins that the bump
*string* is what the author intended, not that `runMigrations` actually reaches and applies it end
to end the way a legacy fixture does. Whether that trade-off is worth taking is a wider call than
this task's brief authorized — flagging it here rather than building it, as instructed.

## 4. A known, already-diagnosed flake was observed during verification (not this task's)

While running `npx jest` repeatedly to confirm the final count, `src/services/backup/__tests__/consistency.test.ts`'s
*"the schema trigger now REJECTS a three-task cycle outright (migration 008, task 49)"* test failed
intermittently under the full 88-suite run (fail / pass / fail / pass across four consecutive runs
with this task's changes present), while passing every time when scoped to `src/services/backup/`
alone or run in isolation. Before writing this up I confirmed it is unrelated to W8/W11/W12: reverted
this task's three changed files (`git stash`) and the full suite still ran clean twice, so the
flake's presence or absence tracks nothing this task touched.

**This is not a new finding.** `git log` on this worktree shows it already reproduced, root-caused,
and numbered: `e71b542` ("Housekeeping: worktrees removed, the flake found; number the fix as task
59") and `docs/eval/housekeeping_2026-08-22_report.md` Part B. Summary from that report: it is
**order-dependent, not load-dependent** — `better-sqlite3`'s hand-rolled `SqliteError` is cached by
the native addon per **process**, not per Jest realm, so `err instanceof Error` (consulted by Jest's
`isError()` inside `.rejects.toThrow()`) flips false once the suite has run long enough / late enough
in the worker's lifetime; migration 008 and the trigger are correct in every case, only the
assertion form is fragile. `docs/briefs/realm_error_assertion_task_59.md` already briefs the fix
(swap to the synchronous `expect(() => …).toThrow()` form, as the sibling
`008_transitiveCycleGuard.test.ts` already does, which never flakes). Noted here only because I
observed it live during this task's own verification and wanted the coincidence on record — no
action taken, no files touched for it, and it is **already** task 59's, not something this brief
authorized me to fix.

## 5. Verification

Run in this worktree, final run after the above investigation.

| check | result |
| --- | --- |
| `npx jest` | **88 suites passed / 1027 tests passed** — baseline 88/1026, **+1 test** (W8). See §4 for the intermittent unrelated flake observed during repeated runs. |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint .` | **0 errors, 56 warnings** — unchanged from baseline |

`git status --porcelain` (before writing this report) shows exactly three modified files and no
staged/committed changes:

```
 M src/db/migrations/index.ts
 M src/execution/__tests__/timer.test.ts
 M src/scoring/__tests__/score.test.ts
```

## Test-first compliance (`CLAUDE.md`)

- **W8** is new behavioural coverage: test written first, watched fail against the exact named
  mutation (§1), reverted, kept — the full requirement, not a carve-out.
- **W11** is a **carve-out**: a test rename plus explanatory comments, no assertion logic changed
  and no code path is newly exercised — there is nothing that could be made to fail first. Stated
  here explicitly per the brief's instruction, not skipped silently.
- **W12** is a **carve-out**: a documentation/comment note with zero code change, exactly the
  brief's own framing ("this one is a note, not a code change"). Stated here explicitly, not skipped
  silently.

## Deviations from human decisions

None. All three items were implemented exactly as scoped in the brief: the NUL sentinel's value was
left untouched, the `blockKindsAgree` construct and its type were not deleted, and W12 stayed a
comment/convention note rather than becoming a code change. The one discretionary call — a proposed
direct guard for W12 — was surfaced as a proposal in §3 rather than built, per the brief's explicit
instruction that building it would be a wider call than this task's scope.
