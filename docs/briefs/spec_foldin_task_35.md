# Task 35 — Spec fold-in (v2.3 → v2.4)

**Owner:** Sonnet/Haiku. **Branch:** `opus/batch-a-headless` (or its own — this task touches `docs/` only). **Headless, docs-only.**
**Commissioned by Jason, 2026-07-20.**

**File-disjoint by construction:** you work only in `docs/`. Tasks 13 and 36 work in `src/`. Say so in your report; this is what let task 27 run safely alongside 25 and 33.

**A naming correction, made here so it doesn't propagate.** The master task table once called this "v2.3 → v2.5." That was wrong: **spec version and `schema_metadata` version track different things** (product-facing rulings vs. applied DDL state) and legitimately drift apart. The spec's last version is **v2.3**; the next one is **v2.4**. It will *describe* schema state through **2.6.0** (migration 005 landed with task 13, after the v2.5 reference snapshot was cut). Put a header note saying so, so the next reader doesn't "fix" the mismatch.

**Read first:**
1. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` — what you're folding into.
2. `docs/reference/ADHD_Task_Management_App_Database_Schema_v2.5.sql` — the current *reference snapshot*, but **it is one migration behind on-device state**: migration 005 (task 13) took the live schema to **2.6.0** and added three session-runtime tables. The snapshot catch-up is task 34/27's domain, not yours; but the spec's schema description should reflect 2.6.0. You are **not** producing a new snapshot — only the spec prose.
3. `docs/eval/task34_findings_report.md` — migration 004 and the dropped view.
4. `docs/eval/task11_findings_report.md` — the planner contracts.
5. `docs/design/multisession_task28_design_amendment_extend.md` — Jason's split-extend ruling.
6. `docs/eval/task27_findings_report.md` — how the previous fold-in was done, and the caveat it correctly recorded about describing target state.

---

## 1. What to fold in

**a. Migration 004 — §4.5 is currently false.** Spec v2.3 §4.5 states that `algorithm_weights` still carries `context_fit` at 25/20/20/15/20 and that no migration has ever touched that table. Migration 004 did both: dropped `context_fit` from the CHECK, deleted the row unconditionally, and reseeded the four survivors to 31/23/23/23 **only where `data_points_count = 0`**. Also record that **`active_tasks_with_neglect` was dropped** — it computed a retired `weeks²` curve through a `POWER()` unavailable on-device, so it could never have run. Neglect lives in `listActiveByNeglect` and nowhere else.

**b. Task 11's planner contracts (§5.3, §6.2).** The selection boundary as the pool's only entry (capability filter → dependency filter → ranker, both reject sets retained); `PlanAdjustment` as the single sanctioned LLM seam with planning deterministic in v1; `blockKind` (countdown/openBlock); `plannedMinutes`; `replanRemaining`'s callers; the break-first rule after a long stretch. **Pull the exact names and formulas from `src/planning/` and the findings report — not from this brief's summary of them.**

**c. The extend amendment (§8.7, §6.2).** Extend is now **two** affordances: `+5 minutes` (flat, uncapped, no timer-face change, tail shifted) and `Keep going` (25-min quanta, count-up, tail regenerated, `sessions.extended`). The end-of-block prompt has **five** options. The §4.3 guardrail is **ruled: option B, hyperfocus only** — `+5` is exempt by design. Repeated `+5` queues a `repeated_extension` conversation at task close.

**Be precise about one thing here:** `repeated_extension` and `long_extend` are **`trigger_data.kind` values on the existing `pattern_detected` trigger type** — they are *not* new `coaching_queue` trigger types, and no migration adds them. If §7.2 enumerates trigger types, do not lengthen that list.

**d. Migration 005 / task 13 (§4.5, §6, §8.2).** Task 13 landed after v2.3 was cut. Fold in: schema is now **2.6.0**; three session-runtime tables exist (`session_runtime`, singleton `active_episode`, `session_task_extension`); `sessions` rows are born `'abandoned'` (crash-truthful); the timestamp-based timer + episode lifecycle + crash recovery are built and device-confirmed. **Do not restate the table DDL** — point at migration 005 and describe behavior. The expiry-alarm-can't-be-a-JS-timer finding (task 13 §9.4) belongs in §6.2/§8.2 as an implementation constraint on task 24.

**e. §11 priorities.** 11, 13, 25, 26, 27, 33, 34 have landed. The remaining personal-ship path is **23 → 24** (design → UI). Task 36 (recurrence period engine) is new and headless. Task 35 (this task) is docs-only.

## 2. What NOT to do

- **Do not touch v2.2 or v2.3.** They stay as historical record, unedited. You are writing a new file.
- **Do not produce a new schema snapshot.** `v2.5.sql` is current.
- **Do not invent resolution** for anything still open. Open items stay open and stay marked open: the `which:"next"` semantics (task 22), the crisis-detector coverage (21), the device envelope (30), the 8B/1.7B quant path (29).
- **Do not restate a formula from memory or from this brief.** Every formula — the neglect curve, R6's smoothing, R8's gap, the weight split, the confidence decay — gets pulled from source or from the findings report that ruled it. Task 27's brief did this and caught two documents that both claimed to state R8 and disagreed.
- **Do not describe unbuilt work as built.** Task 27's report correctly flagged that it described ruled target state ahead of the code. Same discipline: **task 36 (recurrence engine) is likely still unbuilt when you write** — mark its §4.2 time-driven behavior as ruled-but-unbuilt if so. (Task 13 *has* landed and is device-confirmed, so its behavior may be described as built.) A spec may describe target state — but it must say which parts are target vs shipped.

## 3. Definition of done

- `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` exists, with the version-note header explaining the spec-vs-schema numbering (spec v2.4 describing schema 2.6.0).
- v2.2, v2.3, and the v2.5 schema snapshot are untouched.
- Findings report at `docs/eval/task35_findings_report.md`: what changed section by section, **any conflict you found between two documents** (that's the highest-value output of a pass like this), what you marked as ruled-but-unbuilt, and anything left open.
