# Task 34 — Schema reconciliation pass

**Owner:** Sonnet. **Branch:** `opus/batch-a-headless`. **Headless.**

**Runs in parallel with task 11** — no overlap: 11 works in `src/services/planning/` and `src/scoring/`, this task works in `src/db/migrations/` and `docs/reference/`.

**Why this exists.** Task 27's fold-in surfaced two latent inconsistencies it correctly refused to fix silently, because both are schema/migration decisions rather than documentation calls. Neither breaks anything today. Both are the kind that surface much later as a mystery.

**Read first:**
1. `docs/eval/task27_findings_report.md` **§5 and §6** — where both problems were found, and the evidence that the reference `.sql` is hand-maintained rather than generated.
2. `docs/eval/task26_findings_report.md` **§2 and §3** — the verified rebuild discipline. **This is the most valuable thing you will read**; it documents SQLite behavior on this exact build that the earlier briefs got wrong.
3. `docs/eval/task33_findings_report.md` §1 — migration 003, which the reference snapshot doesn't yet reflect.
4. `src/db/migrations/002_skill_layer_schema.sql` and `003_*.sql` — the pattern to follow.
5. `docs/briefs/orientation_for_opus.md` §4 — constraints.

---

## 1. `algorithm_weights` is seeded with a retired composition

**The problem.** R3 changed the scoring weights to **31/23/23/23** and removed context-fit from the weighted sum entirely (context and tools became a hard pre-filter). That landed in `src/scoring/factors.ts`. But `algorithm_weights` — **the table whose entire purpose is persisting learned weights for §5.4** — is still seeded at the retired **25/20/20/15/20** in `001_initial_schema.sql`, with `context_fit` still a legal value in its `factor_name` CHECK.

So the same fact lives in two places and they disagree. It's dormant only because task 17 doesn't exist yet; the moment it does, the learning loop starts from a composition the app abandoned.

**What to do — migration 004:**
- Update the four surviving factor rows to **31 / 23 / 23 / 23** (importance / urgency / energy_match / historical_success). They must sum to 100.
- Remove the `context_fit` row, and remove `'context_fit'` from the `factor_name` CHECK. **A CHECK change means a full table rebuild** — follow 002's discipline exactly (§2 below).
- **Guard against clobbering learned data.** Today every row has `data_points_count = 0`, so a straight reseed is safe. It won't always be. **Only rewrite `weight_percentage` where `data_points_count = 0`**, and leave any row that has actually learned something alone. This costs one `WHERE` clause now and prevents a data-loss migration later. If you find a reason this guard is wrong, say so rather than dropping it silently.
- The `context_fit` row is deleted regardless of `data_points_count` — the factor no longer exists in the model, so learned data about it has nowhere to go. Note this asymmetry in the migration comment.

## 2. The rebuild hazards are already documented — don't rediscover them

Task 26 verified all of this empirically on this build. Reuse it:

- **`PRAGMA foreign_keys` cannot be toggled inside a transaction** — it's silently a no-op. `applyMigration` already takes a `rebuildsTables` flag that handles this correctly. **Use the flag; do not put `PRAGMA foreign_keys` lines in your `.sql`**, where they'd be misleadingly inert.
- **Views must be dropped *before* `DROP TABLE`**, or the drop is flatly rejected with a "no such table" error inside the view. Indexes and triggers are dropped silently and just need recreating.
- **AUTOINCREMENT sequence must be saved and restored** across a rebuild, or ids get reused once anything has ever been deleted. `algorithm_weights` is AUTOINCREMENT and this migration **deletes a row**, so this one is live, not theoretical — the `sqlite_sequence` save/restore is mandatory here.
- Assert `PRAGMA foreign_key_check` empty afterward, and assert every index, trigger, and view present by name.

Version bumps to **2.5.0** (003 set 2.4.0). The `.ts` copy is byte-generated from the `.sql`; follow the existing generation step so the drift test passes.

## 3. A decision to make and record: `active_tasks_with_neglect`

The view still computes the **retired `weeks²` curve** via `POWER()` — a function that **doesn't exist on the device's SQLite build**, which is why `listActiveByNeglect` does the arithmetic in TypeScript. So the view is dead code that encodes a superseded ruling in SQL, and it now also knows nothing of R1's linear curve, R8's accrual gate, or task 28's three-way anchor.

**Recommendation: drop it in this migration.** A stale view that cannot run and states a retired rule is a trap — the next person to read the schema for ground truth will find `POWER((days)/7, 2)` and reasonably conclude neglect is quadratic. That is precisely the ruling this project has been most careful about.

**Counter-argument, so you can weigh it:** dropping is irreversible in a forward-only scheme, and the view is harmless while unread. If you drop it, the neglect logic then lives in exactly one place (`listActiveByNeglect`), which is the real argument in favor.

**Either way: record the decision and the reasoning in the migration comment and the report.** Don't leave it half-done — a view "kept for reference" needs a comment saying it's non-authoritative and why.

## 4. Refresh the reference schema snapshot

`docs/reference/*.sql` is **hand-maintained** (task 27 §6 verified there's no generator). The current v2.3 snapshot reflects migration 002 only; 003 landed afterward, and 004 is this task.

- Create `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql` covering **002 + 003 + 004**. Retain the earlier snapshots, per the existing convention.
- **Use periods in the filename, not underscores** (`v2.5`, not `v2_5`) — task 27 established this is the repository's real convention.
- Note in the header that **`schema_metadata` version (2.5.0) and spec version (v2.3) legitimately differ** — they version different things, and a future reader will otherwise think one is wrong.
- Include 003's columns (`duration_type`, `work_state`, `accumulated_minutes`, `last_worked_at`, `sessions.tasks_progressed`, the two widened `interactions` CHECKs).

## 5. Constraints

- **Never cap neglect** (#5). This task touches nothing that computes it — if you find yourself editing neglect math, you're out of scope.
- Forward-only, non-destructive to user data apart from the deliberate `context_fit` row removal.
- Don't touch `src/scoring/` — task 11 is working there right now.

## 6. Definition of done

- Migration 004 applies cleanly to a **fresh** DB and to a **populated 2.4.0** DB (seed `algorithm_weights` rows, including one with `data_points_count > 0`, and confirm it survives untouched).
- `foreign_key_check` clean; all views/indexes/triggers asserted present by name; AUTOINCREMENT id-reuse test as in 002.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- Reference snapshot written; earlier versions retained.
- `docs/eval/task34_findings_report.md`: what landed, **the `active_tasks_with_neglect` decision and its reasoning**, whether the `data_points_count` guard held up, and anything else stale you noticed while in the schema.
