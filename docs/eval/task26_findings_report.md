# Task 26 Findings Report — skill-layer schema migration (v2.2 → v2.3)

**Verdict: DONE.** Migration 002 applied cleanly to a fresh DB and to a populated 2.2.0 DB
(seeded tasks, skills, conditions, evidence, coaching-queue rows) in automated tests; full suite
(421 tests), `tsc --noEmit`, and `eslint .` all clean. Branch `opus/batch-a-headless`, headless.

**Read first:** `docs/briefs/skill_schema_migration_task_26.md` (the brief), `docs/eval/task18_design_report.md`
§2 (the six gaps), `src/db/migrations/002_skill_layer_schema.sql` (the migration itself, which
carries most of the reasoning inline).

---

## 1. What changed

**The migration** — `src/db/migrations/002_skill_layer_schema.sql` (+ generated `.ts` copy),
registered in `src/db/migrations/index.ts` as version `2.3.0`:

1. New table `learning_state (key, value, updated_at)` — no rebuild needed.
2. `skills.is_active` default flipped `TRUE` → `FALSE` — **rebuild** (SQLite can't `ALTER
   COLUMN` a default). Existing rows keep their actual stored value; only the default for future
   inserts changes.
3. `skill_evidence.source TEXT CHECK (source IN ('distiller','outcome'))`, nullable — simple `ADD
   COLUMN`, no rebuild (confirmed empirically: SQLite allows a `CHECK` on a brand-new column via
   `ADD COLUMN`, since it isn't altering an existing constraint). The design report explicitly
   recommended the `CHECK`; the task brief's own wording only said "nullable TEXT column," so I
   went with the design report's more specific version since it matches this schema's existing
   convention (every other enum-shaped text column here has a `CHECK`).
4. `coaching_queue.trigger_type` CHECK gains `'buried_task'` (R4) and `'breakdown_complete'`
   (R7) — **rebuild**. `urgency`'s CHECK was verified (not assumed) to already cover
   `immediate`/`next_start`/`next_open`; no change made there.
5. `learning_data` JSON `"v":1` convention — documented at the `Interaction.learningData` field
   in `src/types/domain.ts`, since no writer of the `{snapshot, skillsFired}` shape exists yet
   (task 19 builds it). Not a schema change, so nothing in the `.sql`.
6. `fireable_skills` footgun comment — added at the view's recreation site in the `.sql`. See §3
   for why this can't live in the *stored* view definition.

**TypeScript surface kept honest with the schema** (not optional — see §2):
`CoachingTrigger` gained the two new literals (`src/types/db.ts`); `SkillEvidenceRow`/`SkillEvidence`
gained `source` end to end, including `skillsRepository.addEvidence`'s new optional 4th
parameter (otherwise the column would be reachable by raw SQL only); the `is_active` row→domain
mapper's fallback default flipped `true`→`false` to mirror the new column default; a new
`LearningStateRow` type was added to `db.ts` (no domain mapper or repository — see §4).

**Framework fix** (`src/db/migrations/index.ts`) — see §2, this was necessary, not optional.

## 2. Framework: had to write it, not just use it

The existing runner never actually supported what this migration needed, in two independent ways:

- **`runMigrations` never applied more than `MIGRATIONS[0]`.** The pre-existing code read
  `currentVersion`, applied the first migration only if the DB was empty, and otherwise did
  *nothing* — a comment described the intended "apply anything newer" loop, but it was never
  written, because there was only ever one migration to prove it against. I implemented an actual
  version-ordered loop (`isNewerVersion`, dot-separated numeric compare) so a fresh install walks
  001 then 002, and a real 2.2.0 device picks up only 002.
- **`PRAGMA foreign_keys` cannot be toggled from inside an open transaction.** Verified
  empirically against this repo's SQLite build (better-sqlite3, v3.53.2): setting the pragma
  inside a `BEGIN` is silently a no-op — enforcement stays whatever it already was. Since
  `applyMigration` unconditionally wrapped every statement in one `db.transaction()`, a migration
  SQL file containing `PRAGMA foreign_keys = OFF;` as its first statement would have done
  *nothing*, and the subsequent `DROP TABLE` on a table other tables reference via FK would have
  thrown (`FOREIGN KEY constraint failed`) — confirmed by direct test before writing the fix.
  `applyMigration` now takes a `rebuildsTables` flag; when set, it issues `PRAGMA foreign_keys =
  OFF` via `db.execute()` (outside any transaction) before opening the transaction, and restores
  `ON` in a `finally` after. Migration 002's `.sql` deliberately contains **no** `PRAGMA
  foreign_keys` lines — they would be misleading (silently inert if read as "this line does the
  disabling") — and says so in its header comment.
- `applyMigration` also now inspects the result of any `PRAGMA foreign_key_check` statement and
  throws (aborting/rolling back) if it returns rows, rather than silently committing a broken FK.

## 3. Two things the design report's hazard section didn't flag

The brief said a rebuild "silently drops views, indexes, and triggers unless you recreate them."
Empirically, on this SQLite build, that's not quite what happens — and there's a second,
unrelated gap the brief never mentions at all.

**a. `DROP TABLE` is flatly rejected while a dependent VIEW still exists — not silent.** Built a
minimal repro (parent/child/view/index/trigger, `foreign_keys=OFF`, inside a transaction):
`DROP TABLE parent` while `view_parent AS SELECT ... FROM parent` still existed threw `"error in
view view_parent: no such table: main.parent"` immediately, refusing to proceed. Indexes and
triggers *are* silently and automatically dropped by `DROP TABLE` (confirmed separately) and
just need recreating afterward, as the brief says — but views are a harder failure, not a softer
one: they must be dropped **before** `DROP TABLE`, or the migration doesn't run at all. Both
rebuilds in migration 002 (`fireable_skills` before `skills`, `coaching_priority_queue` before
`coaching_queue`) do this. Net effect on correctness is the same either way (recreate the view),
but "silent" undersells the failure mode — a first attempt without dropping the view first
doesn't quietly succeed with a stale view, it just errors out on the spot, which is actually the
safer failure to hand someone.

**b. AUTOINCREMENT's "never reuse a rowid" guarantee breaks across a rebuild, silently, if
anything was ever deleted.** Not mentioned anywhere in the brief or design report. Reproduced
directly: insert ids 1, 2, 3 into an `AUTOINCREMENT` table, delete id 3 (`sqlite_sequence.seq`
stays 3), rebuild-and-rename via the standard procedure, then insert a new row — it gets id **3**,
reused, because the rebuild's `INSERT INTO new SELECT ... FROM old` only ever copies rows that
still exist, so the new table's `sqlite_sequence` entry gets created from `MAX(id)` of what's
left (2), not the table's true historical high-water mark (3). `skills` and `coaching_queue` are
both `AUTOINCREMENT`, and neither repository (`skills.ts`, `coaching.ts`) currently exposes a
delete, so this is **dormant today** — but it's exactly the kind of bug that "surfaces weeks
later as a mystery" once something *does* delete a row (e.g. a future skill-pruning feature).
Fixed in both rebuilds: the pre-rebuild `sqlite_sequence.seq` is captured into a temp table
before the drop, and restored (`MAX` of the saved value and the post-copy actual max) after the
rename. Covered by a dedicated test (`002_skillLayerSchema.test.ts`, "never reuses an
AUTOINCREMENT id...") that reproduces the delete-then-migrate scenario and asserts the next
insert gets a genuinely new id.

Both were found by writing small `better-sqlite3` repros *before* committing to a migration
design, specifically because the brief's phrase "verify... rather than assuming" seemed worth
taking literally beyond just the FK-cascade and view/index/trigger checks it named.

## 4. One thing deliberately left out, on purpose

`learning_state` got a `LearningStateRow` type in `db.ts` (matching this file's existing
convention of one row type per table regardless of whether a repository exists yet — e.g.
`BackupLogRow`/`DataRetentionRow` predate any repo for those tables too) but **no domain mapper
and no repository**. Task 19 owns the actual access pattern (typed keys, get-with-default
semantics for watermarks/tunables) and is the only consumer; building that now would be designing
ahead of the consumer rather than migrating a schema. Flagging this explicitly rather than
silently picking a side, per the brief's instruction.

## 5. Side effect: `urgencyForTrigger` needed the two new cases

Extending `CoachingTrigger` broke exhaustiveness in `src/services/coaching/triggers.ts`'s
`switch` (`tsc --noEmit` caught it immediately: "Function lacks ending return statement"). This
wasn't optional — leaving it broken fails the Definition of Done's `tsc` gate. Added:
`breakdown_complete → 'immediate'` (spec-pinned across three docs: R7 "fires with urgency =
'immediate'"); `buried_task → 'next_open'` (my own reasonable default, documented inline — R4's
scan runs "at app open," analogous to `app_reorientation`/`pattern_detected`; the existing
`urgency` override parameter on `enqueueCoachingTrigger` already lets a caller escalate the
due-soon variant to `immediate` per-instance). Task 19/25 are the real callers and can override
at the enqueue site; this only had to be non-broken, not final policy.

## 6. Files touched

- `src/db/migrations/002_skill_layer_schema.sql` (+ generated `.ts`) — new
- `src/db/migrations/index.ts` — `rebuildsTables` flag, real version-ordered `runMigrations` loop, `foreign_key_check` throw-on-violation
- `src/db/migrations/__tests__/002_skillLayerSchema.test.ts` — new, 12 tests
- `src/db/migrations/__tests__/index.test.ts`, `schemaDrift.test.ts` — updated for the new final version / byte-identity check
- `src/types/db.ts`, `src/types/domain.ts` — `CoachingTrigger`, `SkillEvidenceSource`, `SkillEvidenceRow`/`SkillEvidence.source`, `LearningStateRow`, `is_active` fallback, `learningData` versioning doc comment
- `src/db/repositories/skills.ts`, `__tests__/skills.test.ts` — `addEvidence(source)`, updated default-`isActive` expectations
- `src/services/coaching/triggers.ts`, `__tests__/triggers.test.ts` — the two new urgency mappings (§5)

## 7. Verification

- `npx jest` — 48 suites, 421 tests, all pass.
- `npx tsc --noEmit` — clean.
- `npx eslint .` — 0 errors (55 pre-existing warnings, all in unrelated `src/dev/*Screen.tsx` files I didn't touch).
- `PRAGMA foreign_key_check` asserted empty after migrating a populated DB.
- `fireable_skills`, `coaching_priority_queue`, all five views, both rebuilt tables' indexes, and both pre-existing triggers asserted present by name after migration.
- New CHECK values accepted (`buried_task`, `breakdown_complete` with `urgency='immediate'`); a bogus `trigger_type` still rejected.
- `skills.is_active` defaults `FALSE` on a fresh insert post-migration; a pre-migration row that relied on the *old* `TRUE` default is confirmed unchanged after migrating.
