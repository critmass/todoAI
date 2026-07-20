# Task 34 Findings Report — algorithm_weights schema reconciliation (v2.4 → v2.5)

**Verdict: DONE.** Migration 004 applies cleanly to a fresh DB and to a populated 2.4.0 DB (seeded
`algorithm_weights` rows, including one with `data_points_count > 0`, confirmed to survive
untouched) in automated tests; full suite (495 tests, 51 suites), `tsc --noEmit`, and `eslint .`
all clean. Branch `opus/batch-a-headless`, headless, in parallel with task 11 — nothing under
`src/scoring/` or `src/services/planning/` was read for editing purposes or touched.

**Read first:** `docs/briefs/schema_reconciliation_task_34.md` (the brief), `docs/eval/task26_findings_report.md`
§2–§3 (the verified rebuild discipline this migration reuses without rediscovering),
`docs/eval/task27_findings_report.md` §5–§6 (where the two latent problems were originally
flagged and the hand-maintained-.sql determination), `src/db/migrations/004_algorithm_weights_reconciliation.sql`
(the migration itself, which carries most of the reasoning inline).

---

## 1. What changed

**The migration** — `src/db/migrations/004_algorithm_weights_reconciliation.sql` (+ generated
`.ts` copy), registered in `src/db/migrations/index.ts` as version `2.5.0`, `rebuildsTables: true`:

1. **`algorithm_weights` rebuild.** `factor_name`'s CHECK drops `'context_fit'` — R3 (task 10)
   removed context/tools from the weighted sum entirely in favor of a hard pre-filter
   (`src/scoring/filter.ts`), so the table's legal-value set now matches what the code actually
   scores. The context_fit row is deleted **unconditionally** during the rebuild's copy step
   (`WHERE factor_name != 'context_fit'`), regardless of its `data_points_count` — see §3 for why
   this asymmetry is deliberate, not an oversight.
2. **Reseed to 31/23/23/23**, matching `src/scoring/factors.ts`'s `FACTOR_WEIGHTS` exactly
   (`importance: 0.31, urgency: 0.23, energyMatch: 0.23, historicalSuccess: 0.23`) — confirmed by
   reading the file before writing the migration, not assumed from the brief. Applied via four
   `UPDATE ... WHERE factor_name = 'X' AND data_points_count = 0` statements **after** the rebuild,
   not baked into the copy — see §3.
3. **`active_tasks_with_neglect` view dropped.** See §2 for the decision and reasoning, recorded
   in full in the migration file's header comment and repeated below per the brief's instruction
   not to leave it half-done.
4. **`sqlite_sequence` save/restore for `algorithm_weights`**, following 002/003's verified
   discipline — load-bearing here, not defensive boilerplate, because this migration is the first
   of the four to actually delete a row from an AUTOINCREMENT table. Covered by a dedicated test
   that deletes the second-highest-id row, then confirms the next insert after migrating doesn't
   reuse the deleted highest id.
5. No `PRAGMA foreign_keys` lines in the `.sql` (delegated to `index.ts`'s `rebuildsTables` flag,
   per constraint carried from 002/003) and `PRAGMA foreign_key_check` asserted empty before the
   version bump, exactly as 002/003 do.

**TypeScript surface kept honest with the schema** (not optional — task 26 established this
precedent and I followed it, since leaving stale types would recreate exactly the kind of
DB/code drift this task exists to close):
- `src/types/db.ts`'s `AlgorithmFactorName` drops `'context_fit'`.
- Two comments that described `active_tasks_with_neglect` as an existing-but-bypassed view
  (`src/types/db.ts` near `CoachingPriorityQueueRow`, `src/db/repositories/tasks.ts`'s
  `TaskWithNeglect` doc comment) updated to state it was **dropped** by migration 004 and why —
  otherwise both comments would point a future reader at a view that no longer exists.
- `src/types/domain.ts`'s `AlgorithmWeightWriteInput` comment, which said "migration 001 seeds all
  five rows already," corrected to four (with a one-clause note about the fifth).
- `src/db/repositories/__tests__/learning.test.ts`'s hardcoded expectations (5 rows,
  `importance` = 25) updated to the post-004 reality (4 rows, `importance` = 31).
- `src/db/migrations/__tests__/index.test.ts`, `002_skillLayerSchema.test.ts`,
  `003_multisessionWork.test.ts` — version-number and view-list assertions that hardcoded "the
  latest version" as `2.4.0` or included `active_tasks_with_neglect` in an exact view list, now
  that `runMigrations` walks one migration further. These aren't 004-specific tests; they're
  002/003's own tests whose assertions happened to encode "whatever the latest version currently
  is," which changed out from under them. See §4.

## 2. The `active_tasks_with_neglect` decision

**Dropped.** Weighing both sides as the brief asked:

**For dropping (the position I landed on):** the view computes the retired `weeks²` curve via
`POWER()`, a function that does not exist on this app's on-device SQLite build (confirmed
empirically, `docs/eval/task12_phaseB_findings_report.md` §1) — so it has been unable to actually
*execute* since before task 10 even landed the linear curve it now also fails to reflect. It is
also now three rulings behind: R1's linear curve (task 10), R8's recurrence accrual-start gate
(task 25), and task 28's three-way anchor merge (task 33) all live exclusively in
`listActiveByNeglect` (`src/db/repositories/tasks.ts`), which has been the sole authoritative
implementation for every real query since the view was first bypassed. A view that cannot run and
states a superseded rule is not a harmless reference — it's a trap for exactly the failure mode
this project has been most careful to prevent: a future reader trusting the SQL they can see over
the TypeScript they'd have to go find, and concluding neglect is quadratic when it has been linear
for three tasks running.

**Against (weighed, not dismissed):** dropping is irreversible in this forward-only migration
scheme, and the view was genuinely harmless while unread — nothing was silently broken by its
presence through v2.3 and v2.4. That's a real cost; forward-only means there's no clean way to
bring it back if some future task wants a SQL-level neglect view for tooling or ad-hoc queries.

**Why "for" won:** "harmless while unread" isn't a property the schema enforces — nothing stops a
future migration, tool, or ad-hoc query from reading it, and every version this view survived, it
survived *more* wrong than the last (v2.2: matches nothing since R1; v2.3/v2.4: also misses R8 and
task 28). A view kept "for reference" has to actually be correct reference; this one hasn't been
since task 10. Dropping it collapses the neglect computation to exactly one place with nothing
left to drift out of sync with it. If a SQL-level view is ever wanted again, it should be written
fresh against whatever the current rule is, not resurrected from a three-rulings-stale copy.

## 3. Two guards, and why they're asymmetric

The brief asked for the reasoning behind treating `context_fit`'s deletion and the surviving four
rows' reseed differently, and to say so if the guard seemed wrong. It doesn't — the two halves
answer different questions:

- **`context_fit` is deleted unconditionally.** The factor no longer exists in the scoring model
  (R3 removed it from the weighted sum; it's a hard pre-filter now, not a weight). Any
  `data_points_count` it accumulated before R3 shipped describes learning about a factor that
  isn't scored anymore — there is no field to carry that data *forward into*, so gating the
  deletion on it wouldn't protect anything; it would just leave a permanently-orphaned row with no
  code path that will ever read it again.
- **The surviving four rows are reseeded only where `data_points_count = 0`.** These factors still
  exist and are still scored. Today the guard is a no-op in practice — task 17 (the learning-loop
  consumer) doesn't exist yet, so every row's `data_points_count` is genuinely 0 on every real
  device this migration will ever run against. But the guard is not written for today; it's
  written for the migration file staying correct **after** task 17 ships. Without it, this exact
  file, applied to a device where the learning loop has already adjusted `importance`'s weight
  based on real user behavior, would silently overwrite that learned value with the hardcoded
  default — a real data-loss migration, not a hypothetical one. The guard costs four `WHERE`
  clauses now and forecloses that failure permanently.

Tested directly: one test sets `data_points_count = 12` on `importance` before migrating and
confirms `weight_percentage`, `data_points_count`, and `confidence_level` all survive byte-for-byte
untouched; another confirms a `data_points_count = 0` row (`urgency`) *does* get reseeded to 23;
a third confirms `context_fit` is deleted even when it's given `data_points_count = 7` first,
proving the asymmetry is real and not just a document claim.

## 4. A side effect I hadn't originally scoped: 002/003's own tests needed touching

`runMigrations` walks the full `MIGRATIONS` list forward from whatever version a DB is on, so 002's
and 003's existing test suites — which already called `runMigrations` and asserted "the latest
version" or "the full view list" — silently became assertions about 004's output too, the moment
004 was registered. This isn't scope creep into task 11's or an earlier task's territory; it's the
direct, mechanical consequence of the forward-only runner design 002 built and 003 relied on
unchanged. Three call sites needed updates, all mechanical (no test's *intent* changed):

- `002_skillLayerSchema.test.ts`: two `getCurrentSchemaVersion` assertions (`'2.4.0'` → `'2.5.0'`)
  and one exact view-name list (drop `active_tasks_with_neglect`).
- `003_multisessionWork.test.ts`: one `getCurrentSchemaVersion` assertion, one view-list assertion
  (switched from an exact list to `arrayContaining` minus the dropped view — it was already using
  the weaker form via the `arrayContaining` matcher for 003's own purposes), and one test title
  that literally asserted a version number in prose ("lands at 2.4.0...") which is no longer
  accurate now that a fresh install continues past it — retitled rather than left misleading.
- `index.test.ts`: the top-level "applies every migration on an empty database" test's final
  version and view-list expectations, plus the two `algorithm_weights` row-count assertions (`5` →
  `4`) in the seed and idempotency tests.

Flagging this pattern explicitly since it will recur: **every future migration that lands will
require this same pass over 00N-1's and earlier suites' "latest version" and "full object list"
assertions**, not just its own new test file. Nothing in the current test structure catches this
automatically — it only surfaces as a failing assertion in an unrelated file's test, which is easy
to misdiagnose as "I broke someone else's test" rather than "this was always a moving target by
design."

## 5. Stale items noticed, not in the brief's list

- **`docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §4.5 now describes a table
  state that no longer exists.** It says, verbatim, that `algorithm_weights`' seed data "still
  lists `context_fit` at the retired 25/20/20/15/20 split" and that "no migration has ever touched
  that table." Both sentences were accurate when task 27 wrote them and are false as of this
  migration. I did not touch the spec `.md` — the brief scoped this task to
  `src/db/migrations/` and `docs/reference/*.sql`, and a spec fold-in is its own kind of pass (the
  one task 27 did for 001/002) with its own section-by-section discipline that a schema-migration
  task shouldn't improvise partway through. Flagging it here so the next spec fold-in pass (v2.4
  spec, whenever scheduled) picks it up rather than rediscovering it independently.
- **`docs/reference/ADHD_Task_Management_App_Database_Schema_v2.3.sql`'s own header** carries the
  same now-stale claim about `algorithm_weights` (its §"STALE, NOT FIXED HERE" note). Left
  untouched deliberately — v2.2 and v2.3 snapshots are retained as historical record per the
  established convention (task 27 did the same for v2.2 when writing v2.3), so v2.3's header
  correctly describes v2.3's own state at the time it was current. Do not "fix" old snapshots to
  match new reality; that's what the new snapshot (v2.5) is for.
- **No other table or view references `algorithm_weights` or `active_tasks_with_neglect`.**
  Checked directly (grep across `src/` and `docs/`) before writing the migration, not assumed: no
  FK points at `algorithm_weights`, no other view selects from either it or the dropped view, and
  the only production code that reads `algorithm_weights` is `src/db/repositories/learning.ts`,
  which is factor-name-agnostic (typed CRUD, no hardcoded row count or specific factor logic) and
  needed no changes.

## 6. Files touched

- `src/db/migrations/004_algorithm_weights_reconciliation.sql` (+ generated `.ts`) — new
- `src/db/migrations/index.ts` — registered migration 004 at version `2.5.0`, `rebuildsTables: true`
- `src/db/migrations/__tests__/004_algorithmWeightsReconciliation.test.ts` — new, 12 tests
- `src/db/migrations/__tests__/002_skillLayerSchema.test.ts`, `003_multisessionWork.test.ts`,
  `index.test.ts`, `schemaDrift.test.ts` — updated for the new final version / view list / byte-identity check (§4)
- `src/types/db.ts` — `AlgorithmFactorName` drops `context_fit`; two comments updated for the
  dropped view
- `src/types/domain.ts` — `AlgorithmWeightWriteInput` row-count comment corrected
- `src/db/repositories/tasks.ts` — `TaskWithNeglect` doc comment updated for the dropped view
- `src/db/repositories/__tests__/learning.test.ts` — updated seed-value expectations
- `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql` — new; v2.2/v2.3 retained untouched

## 7. Verification

- `npx jest` — 51 suites, 495 tests, all pass (12 of them new, in `004_algorithmWeightsReconciliation.test.ts`).
- `npx tsc --noEmit` — clean.
- `npx eslint .` — 0 errors (55 pre-existing warnings, all in unrelated `src/dev/*Screen.tsx` files
  I didn't touch — same baseline task 26 recorded).
- Migration 004 applies cleanly to a fresh DB (lands at `2.5.0`; four weights sum to exactly 100;
  `context_fit` rejected by the CHECK; `active_tasks_with_neglect` absent; the other four views,
  both triggers, and `foreign_key_check` all present/empty as expected).
- Migration 004 applies cleanly to a populated 2.4.0 DB: a `data_points_count > 0` row survives
  completely untouched; a `data_points_count = 0` row is reseeded; `context_fit` is deleted even
  with learned data on it (the asymmetry, §3); the AUTOINCREMENT id-reuse scenario (delete the
  historical high-water-mark row, migrate, insert) confirmed the next id is not reused; idempotent
  on a second `runMigrations` call.
- `PRAGMA foreign_key_check` asserted empty and `PRAGMA foreign_keys` confirmed restored to `ON`
  after both the fresh-install and populated-upgrade paths.
