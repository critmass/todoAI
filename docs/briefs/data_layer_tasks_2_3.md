# Sonnet Brief — Tasks 2 & 3: Data Layer + Types (todoAI)

**For:** a Sonnet coding session (e.g. Claude Code) working in this repo.
**Spec of record:** `ADHD_Task_Management_App_Specification_v2.2.md`. **Schema of record:** `ADHD_Task_Management_App_Database_Schema_v2.2.sql` (v2.2, already validated — it executes cleanly and the `count`/`unscheduled`/neglect mechanics have been tested).
**Environment:** bare React Native 0.86.0, New Architecture on, Android-only for now, `applicationId com.todoai`. See `README_build.md` for the toolchain and gotchas.

You are building the **persistence layer and the TypeScript types** — the foundation every other component reads and writes. Nothing above this layer (scoring, coaching, LLM, UI) is in scope. Stay narrow and get this exactly right.

---

## Do types first, then the DAO

The build matrix numbers types as task 3 (after the DAO, task 2), but in practice a clean DAO consumes the types, so **build the type layer first, then the data-access layer on top of it.** One coherent piece of work, in this order: migration in place → types → connection/migration-runner → repositories → tests.

---

## Recommended stack (verify, then commit)

- **SQLite driver:** `@op-engineering/op-sqlite` (JSI, New-Architecture-ready, the standard for bare-RN on-device data). Install the current version and **confirm it builds and loads on-device before building the DAO on top of it** — a one-query smoke test (`SELECT sqlite_version();`) on the S23 FE. Do not adopt Expo SQLite (this is a bare project).
- **No ORM.** Use **raw parameterized SQL** through op-sqlite. The hand-authored schema is the single source of truth; an ORM (Drizzle) would want to own the schema in TS and fight that. (A type-safe query builder like Kysely over the raw driver is a fine *later* enhancement — not now.)
- **Always parameterize.** Never string-interpolate values into SQL.

---

## File layout to create

```
src/
  db/
    migrations/
      001_initial_schema.sql     <- the validated v2.2 schema (see step 1)
      index.ts                   <- migration runner
    connection.ts                <- opens the DB; sets PRAGMA foreign_keys = ON
    repositories/
      tasks.ts
      recurrence.ts
      dependencies.ts
      interactions.ts
      sessions.ts
      coaching.ts
      skills.ts
      learning.ts                <- algorithm_weights, energy_patterns, context_effectiveness
    index.ts                     <- barrel export
  types/
    db.ts                        <- enums + raw row types (mirror columns exactly)
    domain.ts                    <- domain entities (parsed JSON, recurrence union)
    scales.ts                    <- importance/energy projection helpers
```

---

## Step 1 — Put the schema migration in place

Copy the validated `ADHD_Task_Management_App_Database_Schema_v2.2.sql` into `src/db/migrations/001_initial_schema.sql` **verbatim**. Do not re-derive or "clean up" the DDL — it has been validated as-is, including deliberate choices that look unusual (see constraints below). Treat it as immutable input to this task.

---

## Task 3 — Types (`src/types/`)

### `db.ts` — enums as string-literal unions + raw row types
- One union type per `CHECK (... IN (...))` column. At minimum: `TaskStatus`, `DurationSource` (`'user' | 'model_guess'`), `RecurrenceType` (`'scheduled_quota' | 'quota' | 'scheduled' | 'unscheduled' | 'count'`), `InteractionType`, `CompletionStatus`, `SessionType`, `ModelTier` (`'8B' | '4B' | '1.7B'`), `CoachingTrigger`, `CoachingUrgency` (`'immediate' | 'next_start' | 'next_open'`), `SkillScope`, `EvidenceType`, `ConditionOp`, `BackupType`, `RetentionPolicy`, `PatternType`.
- One `Row` interface per table, mirroring columns **exactly** (snake_case, nullability as in the schema, JSON columns typed as `string`). These represent what the driver returns.

### `domain.ts` — domain entities
- camelCase entities with JSON columns **parsed** into real types (`contextTags: string[]`, `skipReasons: string[]`, `actualDurationHistory: number[]`, etc.).
- **The recurrence discriminated union is the important one — model it precisely so illegal states are unrepresentable:**
  ```ts
  type Recurrence =
    | { type: 'scheduled_quota'; quota: number; period: Period; scheduledDays: Weekday[] }
    | { type: 'quota'; quota: number; period: Period }
    | { type: 'scheduled'; scheduledDays: Weekday[] /* + interval if needed */ }
    | { type: 'unscheduled' }                       // reopens on completion; neglect-only
    | { type: 'count'; target: number; progress: number };  // done only at target
  ```
  A **true one-off has no recurrence at all** (`recurrence?: Recurrence` is `undefined` / no `task_recurrence` row). Encode the distinction in the type system: `null`/absent ≠ `{ type: 'unscheduled' }`. This is a correctness requirement — the two have opposite completion semantics (see constraints).
- Provide `rowToDomain` / `domainToRow` mapper functions for each entity (parse/serialize JSON, assemble/disassemble the recurrence union from `recurrence_type` + `recurrence_pattern` + `target_count` + `current_period_progress`).

### `scales.ts` — the two-level scales (spec §4.1)
- Importance: `userToInternalImportance(1..10) -> 100..1000` (×100) and `internalToUserImportance(100..1000) -> 1..10`. Note the internal value is the real one used in scoring; subtask banding (701–799 under a 700 parent) lives in the low digits and must round-trip without loss — the user projection is display-only.
- Energy: `userToInternalEnergy('low'|'med'|'high') -> 1|3|5` and back; document that internal **2 and 4** are app-assigned (behavioral discounting), never user-entered.
- Keep these pure and unit-tested; they encode spec decisions, so a wrong mapping is a silent data bug.

---

## Task 2 — Data access (`src/db/`)

### `connection.ts`
- Open the DB from app-private storage (see `README_build.md` for the `com.todoai` path).
- **Set `PRAGMA foreign_keys = ON;` on every connection open** — SQLite defaults it OFF, and the schema relies on FK cascades. This is the single most common silent bug; do not skip it.
- Expose a single shared connection/handle.

### `migrations/index.ts`
- A minimal forward-only runner: read the current version from the `schema_metadata` table (key `version`); if the DB is empty, apply `001_initial_schema.sql` as one transaction; leave a clean seam to add `002_*.sql` later. No down-migrations needed.
- **Apply the schema on-device and confirm it succeeds** — see the POWER() note in constraints; the views must actually create on op-sqlite's bundled SQLite, not just in a desktop SQLite.

### `repositories/*.ts`
One repository per aggregate, each exposing typed CRUD + the specific reads the app needs. Return **domain** types (via the mappers), not raw rows. Notable methods:
- **tasks:** create (default `duration_source='model_guess'` unless caller says `'user'`), getById, update, soft-delete (set `status`), list active, and a **read that surfaces the neglect-ordered active list** (from the `active_tasks_with_neglect` view — see POWER() note).
- **recurrence:** create/update a `task_recurrence` row from a `Recurrence` union value; enforce that `target_count` is set **iff** `type='count'` (the schema has this CHECK — surface a clear error, don't let it bubble as a raw constraint failure).
- **dependencies:** add/remove; expose the existing circular-dependency guard (the schema trigger raises `'Circular dependency detected'` — catch and rethrow as a typed error).
- **interactions / sessions / coaching / skills / learning:** straightforward typed CRUD + the reads each table's views expose (`coaching_priority_queue`, `fireable_skills`, `recent_session_performance`).

### Expose primitives for these behaviors, but do NOT implement the business rules here
The following are **service-layer** rules (a later task); the DAO only needs to make them *possible* with clean primitives, and should document them:
- **`unscheduled` completion:** update `last_completed_at` (which resets neglect) **without** setting `status='completed'` — the task stays `active`. (A one-off/`null` task *does* get closed on completion.) Provide a method that expresses "record a completion of an unscheduled task."
- **`count` completion:** increment `current_period_progress`; the task flips to done (and thus unblocks dependents) **only** when it reaches `target_count`. Provide an increment method that returns whether the target was reached.

---

## Constraints that must be respected (hard-won — do not "fix" these)

1. **`PRAGMA foreign_keys = ON` on every connection.** (Restated because it's the #1 bug.)
2. **The `active_tasks_with_neglect` view is intentionally UNCAPPED** (`POWER((days)/7, 2)`, no ceiling). Do not add a cap — the unboundedness is a deliberate fail-safe (spec §5.2). **BUT:** `POWER()` requires SQLite's math functions, which may not be compiled into op-sqlite's bundled build. **Verify the view creates and returns on-device.** If `POWER()` is unavailable, do **not** cap or alter the intent — instead compute the neglect multiplier in TypeScript in the repository read (square the weeks-neglected there) and leave a `// TODO` noting the view couldn't run on-device. Flag this back to the human either way.
3. **Importance is stored 1–1000, energy 1–5** — these are internal fine scales, never the user-facing 1–10 / low-med-high. Never write a user-facing value into these columns; go through `scales.ts`.
4. **Urgency is derived, not stored.** `urgency_level` is an optional *base* sensitivity only; effective urgency is computed later from `next_due_at`. Do not compute or persist a "final" urgency here.
5. **`null`/absent recurrence ≠ `unscheduled`.** Opposite completion semantics (constraint above). The type system and the mappers must keep them distinct.
6. **JSON columns** (`context_tags`, `skip_reasons`, `actual_duration_history`, `conclusions`, `learning_data`, `context_used`, `recurrence_pattern`, etc.) are TEXT with `json_valid` CHECKs — always `JSON.stringify` on write and `JSON.parse` on read, and never write invalid JSON.
7. **Timestamps** use SQLite `CURRENT_TIMESTAMP` (UTC). Be consistent; don't mix in local-time strings.
8. **Don't touch the schema DDL** beyond placing it as migration 001. If you believe something in the schema is wrong, flag it to the human — do not silently edit it.

---

## Explicitly OUT of scope for tasks 2 & 3

Do not build these — they are later tasks and building them now creates rework:
- Scoring / neglect *application* logic (Opus, task 9) — you only expose the data.
- Session planning, coaching logic, the skill-injection engine, any LLM/`llama.rn` code.
- The pre-session **backup/restore + corruption-recovery** state machine (Opus, task 14) — the DAO reads/writes the live DB only.
- Business-rule services (the `unscheduled`/`count` completion *policies* — you expose primitives, not the policy).
- Any UI.

---

## Acceptance criteria (task 2 & 3 done)

- `npm run android` builds; the app applies migration 001 on the S23 FE with **all tables, views, and triggers created successfully on-device** (op-sqlite, not just desktop SQLite).
- `tsc` passes under the project's `strict` config; `npm run lint` is clean.
- A round-trip test per repository: create → read-back → update → read-back → (soft) delete, asserting parsed domain types.
- Recurrence round-trips through the DB for **all five types + a no-recurrence one-off**, and the `count`-without-`target` / non-`count`-with-`target` cases raise typed errors.
- `scales.ts` unit tests: importance and energy map both directions without loss across the full range.
- A short note appended to `README_build.md` if any dependency/version was added, and a flag to the human if the POWER() fallback (constraint #2) had to be used.

Work in small, reviewable commits (types → connection → runner → one repository at a time → tests). When in doubt about a spec decision, stop and ask rather than guessing.
