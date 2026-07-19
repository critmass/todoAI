# Task 26 — Skill-layer schema migration

**Owner:** Sonnet. **Branch:** `opus/batch-a-headless`. **Headless.**

**Blocks:** task **25** (needs the `coaching_queue` trigger values) and task **19** (needs everything else).
**Sequence this before 25.**

**Read first:**
1. `docs/eval/task18_design_report.md` §2 — the six schema gaps. This is the source of truth for items 1–5 below.
2. `docs/design/skill_layer_task18_design.md` — the design these support.
3. `src/data/migrations/` — the existing migration pattern. **Follow it exactly**; don't invent a new one.
4. `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.2.sql` — current schema.

This is a mechanical, well-specified migration. There is one non-obvious hazard (§2). Everything else is routine.

---

## 1. What to change

**a. New table `learning_state`.** The one genuine addition. Key/value store for distillation watermarks and runtime-tunable parameters, so the evolver knows where it left off without a new table per concern.

```sql
CREATE TABLE learning_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**b. `skills.is_active` default flips to FALSE.** Skills are born inactive and are activated only once confidence clears the firing threshold. Defense in depth: if the confidence gate is ever bypassed by a bug, a newly distilled skill still cannot fire. Existing rows keep their current values — this changes the default, not the data.

**c. `skill_evidence.source`** — new nullable TEXT column. Optional provenance for an evidence row; nullable so nothing existing breaks.

**d. `coaching_queue` trigger-type CHECK gains TWO values, in this one migration:**
- `buried_task` — R4's buried out-of-context/tool task trigger.
- `breakdown_complete` — R7's parent-confirmation trigger (fires with `urgency = 'immediate'`).

Both are needed by task 25, which is why 26 sequences first. The existing `urgency` CHECK already covers `immediate`/`next_start`/`next_open` — **no change needed there**; verify rather than assume.

**e. `learning_data` JSON gains an internal `"v": 1`.** Not a schema change — a convention. Add it to the writer and document it where the JSON shape is defined, so future readers can branch on version.

**f. Documentation only: `fireable_skills` is index-only.** Add a comment on the view stating that its `GROUP_CONCAT`'d conditions are **not** parseable for matching, and that conditions must be read via `listConditions()`. This is a footgun the design report specifically called out; the comment is the fix.

---

## 2. The hazard: SQLite cannot ALTER a CHECK constraint

Items (b) and (d) both touch CHECK constraints, and **SQLite has no `ALTER TABLE ... ALTER COLUMN`**. You cannot modify a CHECK or a column default in place. The correct approach is the standard 12-step table-rebuild procedure:

1. `PRAGMA foreign_keys = OFF`
2. Create the new table under a temporary name, with the corrected CHECK/default
3. `INSERT INTO new SELECT ... FROM old` — copy every row
4. `DROP TABLE old`
5. `ALTER TABLE new RENAME TO old`
6. Recreate any indexes, triggers, and **views** that referenced the table
7. `PRAGMA foreign_key_check`
8. `PRAGMA foreign_keys = ON`

Do the whole thing **inside a transaction**. `coaching_queue` has dependent tables (`coaching_tasks`, `coaching_sessions`, `coaching_external_dependencies`) with FKs pointing at it — verify they survive the rebuild rather than assuming they do. `skills` is referenced by `skill_conditions` and `skill_evidence`, and by the `fireable_skills` view, which **must be recreated** after the rebuild.

If the existing migration framework already wraps this pattern, use it. If it doesn't, write it carefully — a silently dropped FK or view here surfaces much later as a mystery.

---

## 3. Constraints

- **Forward-only.** No down-migrations. Existing data is preserved; nothing is destructive.
- **Idempotent registration** — the migration runs once and records itself the way the existing ones do.
- Bump the schema version in `schema_metadata`.
- Don't touch anything not listed above. In particular the neglect view stays uncapped and the importance/energy CHECK ranges stay as they are.

## 4. Definition of done

- Migration applied cleanly to a fresh DB **and** to a populated one (seed a few tasks, skills, conditions, evidence rows, and coaching-queue rows first, then migrate and confirm nothing was lost).
- `PRAGMA foreign_key_check` clean after the rebuild.
- `fireable_skills`, all indexes, and all triggers confirmed present afterward — **check explicitly, this is what rebuilds break.**
- New CHECK values accepted; a bogus trigger type still rejected.
- `skills.is_active` defaults FALSE on new inserts; existing rows unchanged.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- Short findings report at `docs/eval/task26_findings_report.md`: what changed, whether the framework already handled the rebuild or you wrote it, and anything you found that the design report missed.
