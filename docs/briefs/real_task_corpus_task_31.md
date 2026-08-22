# Task 31 — Real task + friction corpus

**Owner:** **Jason produces the content; an assistant session elicits, structures, and splits it.**
**Status:** ⬜ open. **Critical path.** Blocks 38 → 40 (the model-migration decision), and feeds 19 (distillation), 20 (eval fixtures), 11 (pool snapshot).
**No `P`.** Nothing here runs on the phone. This is a sitting-at-a-desk task.

---

## 0. Read first

1. `docs/eval/extraction_fixtures_seed.jsonl` — the 16 seed fixtures. **The corpus extends this format; it does not invent a new one.**
2. `docs/eval/model_base_spike_final_findings.md` — the *final* spike report (not `qwen35_spike_findings.md`, which it supersedes). Its critical-field metric is the metric this corpus must be measurable under.
3. `docs/briefs/gemma_lora_training_task_38.md` §2.1, §3b — what 38 needs the corpus to be.
4. `docs/briefs/model_bakeoff_task_40.md` §2 — why the held-out split exists and what it must resolve.
5. `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` §4.2 (recurrence), §7.1 (task input), §7.2 (coaching triggers).
6. `src/llm/index.ts` — the validators. **A gold value that would fail `validateTaskExtraction` is a bug in the gold, not in the validator.**

---

## 0.1 Energy labeling + gold constraints — RULED by task 50 (2026-08-22)

🔴 **Read `docs/design/energy_definition_task50.md` before labeling any `energy` gold.** Task 50 (the gate this task waited on) is closed, and it hands this task three hard requirements that must not be softened:

- **The `energy` rubric is §2b of that doc** — `energy` = **activation cost** (the cost to *start* the task + *get through* it, **take the higher, never the average** — averaging pushes everything to `med` and the field stops discriminating). Bands: `low` = just do it (trash, a text); `med` = needs a run-up or real effort (errands, an email thread); `high` = psych yourself up / need recovery after (gym, taxes, a hard conversation). Keep the **gym→`high` / trash→`low`** pair as the calibration anchors. Label every `energy` gold against this rubric, not against intuition.
- **NO null energy golds, NO internal-2/4 golds.** Extraction always emits `low`/`med`/`high` → internal 1/3/5; every gold carries a value. Internal 2 and 4 are app-assigned (learned via §5.4) and are **never** a gold value.
- 🔴 **Golds are HUMAN-authored. A model may draft input *strings*, but NEVER the answer key** (§6c). This is the exact trap that invalidated the 16-fixture bank: its expected-value column was model-generated, so a "preliminary bake-off" measured two models' arbitrary choices, not capability. Generate 100+ golds that way and the same defect is rebuilt at six times the size — task 40 then measures nothing. **Hard requirement, not a preference.**

⚠ **On the 16 seed fixtures (§0 item 1):** extend their *format*, but do **not** inherit their expected values as ground truth — they were thermal-test scaffolding (task 50 §6a). Re-label, don't inherit.

---

## 1. Why this task's scope changed

Task 31 was originally "cheapest quality win" — more fixtures so evals stop being thin. The 2026-08-03 six-model spike promoted it to **the critical-path prerequisite for a product decision**: whether todoAI migrates off Ternary-Bonsai-4B to a trainable Gemma 4 E2B.

That promotion carries a consequence the original framing did not, and it is the most important thing in this brief:

> **The spike could not decide the model question because 16 fixtures resolve to about ±12 percentage points. A corpus whose held-out split is *smaller than 16 items* resolves worse than the thing it was built to replace.**

"20–30 real messy tasks," split into train and held-out, yields a held-out set of roughly 10–15. At an expected pass rate near 0.8, that is a 95% interval of about **±23 points** — roughly double the uncertainty the spike already had. Task 40 would then run the full three-way bake-off, on the device, and return a number that still cannot distinguish the contenders. The decision would stay blocked and the effort would be spent.

**So the corpus target is raised.** See §3.

---

## 2. What the corpus is (three item types, three consumers)

These are **not interchangeable**, and the count that matters for the bake-off is only the first.

| Type | What it is | Feeds | Format |
|---|---|---|---|
| **A. Extraction items** | A real, messy, as-you-would-actually-type-it task capture, plus its gold structured output | **38** (training), **40** (held-out eval), 20 (fixtures) | Same JSONL schema as `extraction_fixtures_seed.jsonl` |
| **B. Coaching transcripts** | A hand-written exchange for one of §7.2's five triggers, with the gold resolution-union object | **38**'s no-regression check, 19's distillation prompts | JSONL, new file |
| **C. Friction episodes** | A real instance of a task going wrong — buried, repeatedly skipped, repeatedly extended, abandoned — in narrative form plus its structured signals | 19 (skill layer) | Markdown + a small JSONL index |

**Type A is the bake-off's measuring instrument.** Types B and C are valuable but do not shrink the resolution problem. Do not let a count of 30 "corpus items" that is 12 A + 10 B + 8 C be mistaken for 30 extraction items.

---

## 3. Targets

**Type A — extraction items: 80–120 total, of which 45–60 are held out.**

The arithmetic, so it can be argued with rather than trusted:

| Held-out n | 95% interval at p≈0.8 | vs. the spike's ±12 |
|---|---|---|
| 12 | ±23 pts | ~2× worse |
| 16 (the seed set) | ±20 pts | the status quo |
| 30 | ±14 pts | marginal |
| **50** | **±11 pts** | **finally better** |
| 100 | ±8 pts | good, probably unaffordable |

Two things make this less brutal than it looks:

- The metric is **per critical field**, not per item. Each item contributes an observation on `recurrence`, `due_resolved`, `energy`, `importance_user`, `title`, `duration`. If 40 scores per field, 50 held-out items give 50 observations *per field*, which is the number in the table — the table is already the per-field figure. Do not double-count this as a bonus.
- **Stratification beats raw n.** 50 items chosen to cover the failure modes evenly resolve a real difference better than 50 arbitrary ones, because the contenders differ on specific fields (`recurrence`, `due_resolved`), not uniformly. See §5.

**If 80–120 is not affordable, that is a legitimate answer — but it must be recorded as a decision, not discovered later.** The honest fallback: build the largest well-stratified Type-A set you can, compute the actual resolution it gives, and hand task 40 that number up front so the bake-off's protocol can say "this run can only detect differences larger than X." A bake-off that knows its own resolution is useful. One that doesn't is the trap the spike already fell into.

**Type B — coaching transcripts: 15–25**, at least two per trigger, and at least three that are *near-miss distress* (frustrated, defeated, self-critical — but not crisis). Rationale in §6.

**Type C — friction episodes: 10–15**, drawn from real life, not invented.

---

## 4. The held-out split — design it before writing a single item

This is where the task is most likely to be quietly wrong, so it is specified rather than left to judgment.

1. **Split by *source situation*, not by row.** If three items came from the same real project ("the garage"), they share vocabulary and structure; scattering them across train and held-out leaks. Group first, then assign whole groups.
2. **Stratify on the fields that decide the bake-off.** `recurrence` type (scheduled / unscheduled / count / null-one-off) and `due_resolved` (present / absent / relative-weekday) must be represented in *both* splits in similar proportion. A held-out set with no `unscheduled` items cannot measure the null-vs-unscheduled trap, which is the zero-tolerance failure.
3. **Assign the split once, write it down, and never revisit it.** Put the assignment in the item itself (`"split": "train" | "heldout"`), commit it, and treat re-splitting after seeing a result as corpus corruption. Task 38 trains on `train` only; task 40 evaluates on `heldout` only.
4. **Freeze the held-out set from the assistant that writes the training pipeline.** Practically: 38's session should be able to read the schema and the train split, and should not need the held-out contents.
5. **Reserve a small `calibration` slice (~10 items) if 38 wants to tune anything.** Tuning against held-out is the classic way to produce a great number and a worse model. If 38 needs a knob, it turns it against `calibration`, never `heldout`.

---

## 5. What makes an item worth writing

The seed fixtures are `"source":"synthetic"` and they read like it. The corpus's value is that it is **not** that. Concretely, prefer items that:

- **Come from your actual life**, transcribed close to how you'd really type them — including the run-on, the trailing "…or maybe next week?", the abbreviation only you use, the task that is three tasks.
- **Sit on a boundary the app has a ruling about.** The null-vs-unscheduled trap (constraint #7). `which:"next"` weekday resolution (task 22's live ambiguity — include several, they cost nothing extra and they'll be the evidence when 22 gets ruled). Duration stated vs. inferred. A one-off that *sounds* recurring.
- **Are ambiguous enough that a clarifying question is the right answer.** `clarify_ok` exists for this; a corpus with no legitimate-clarification items teaches a model to guess.
- **Include the ugly ones you'd be tempted to leave out** — the task you never did, the one whose title is embarrassing, the one that doesn't fit the schema cleanly. Those are the ones the app will actually meet.

Avoid: items written to be easy, items that are the same shape as a seed fixture with words swapped, and items whose gold you had to reason hard about — if *you* aren't sure of the gold, the item is a bad test, not a hard one. Park those in a `disputed` file; they're interesting, but they can't score a model.

**The `energy` warning.** The spike found `energy` scored 6–14/16 on **every** model including Bonsai — that is an ambiguous *field definition*, not weak models. Do not write 100 golds against an ambiguous definition and bake the ambiguity in. Either (a) pin the definition first, in one paragraph, and write to it, or (b) mark `energy` non-critical for this corpus and let a later task fix it. **Pick one explicitly and record it in the findings report.**

---

## 6. The distress items, and a hard boundary

Type B must include near-miss distress items because task 38 must prove the LoRA doesn't regress Gemma's distress handling — the one dimension where Gemma clearly beat Bonsai.

**But:** crisis detection is deterministic, app-side, and must never be handed to the model (spec, and confirmed on-device — the 4B answered suicidal ideation with a productivity tip). So:

- Type B items may express frustration, defeat, hopelessness *about a task*, shame about avoidance, exhaustion.
- Type B items **must not** be authored as synthetic self-harm or suicidal content in order to test the crisis path. The crisis path is tested by `checkCrisis`'s phrase list under task 21, by a human, with real referral text — not by writing crisis transcripts into a training corpus that a LoRA will then be trained on.
- The gold for a near-miss distress item is a **coaching resolution**, not a crisis referral. If an item is genuinely ambiguous between the two, it belongs in task 21's review pile, not here.

---

## 7. Deliverables

1. `docs/eval/corpus_extraction_v1.jsonl` — Type A. Seed-fixture schema plus two new fields: `"split"` and `"stratum"`.
2. `docs/eval/corpus_coaching_v1.jsonl` — Type B.
3. `docs/eval/corpus_friction_v1.md` + `docs/eval/corpus_friction_v1.jsonl` — Type C (narrative + structured index).
4. `docs/eval/corpus_disputed.jsonl` — items whose gold couldn't be settled. Not scored; kept because they're the interesting ones.
5. `docs/eval/task31_findings_report.md` — **the deliverable that matters most.** It must state:
   - Final counts by type and by stratum, and the **actual resolution** the held-out set gives (the ±X figure). Task 40's brief will quote this number.
   - The `energy` decision from §5.
   - The split rule as executed, including any group that was hard to assign.
   - Which strata came out thin, so 38 and 40 know where the corpus is weak.
   - Anything the act of writing it revealed about the schema, the spec, or a ruling — this has historically been where the real findings come from.
6. A one-line update to the seed file's status: superseded-for-eval, retained as regression fixtures.

---

## 8. Done means

- Type A hits its stated target, or the shortfall is recorded with its resolution consequence in the findings report.
- Every gold passes the real validators (`validateTaskExtraction` et al.) — run them, don't eyeball them.
- The split is assigned, in-file, committed, stratified, and grouped by source situation.
- The findings report states the resolution figure task 40 will run against.
- No item's gold contradicts spec v2.4, constraint #5 (`null` ≠ `unscheduled`), or constraint #6 (two-level scales).

---

## 9. Open questions to bring back, not to answer alone

- **Corpus size vs. Jason's time.** §3 asks for 80–120 Type-A items. That is hours of real work. If it's too much, the *number* is Jason's call; the *consequence* of a smaller number is this brief's to state, and it has.
- **The `energy` definition.** Pinning it is a product-intent call (§5). Bring the proposed one-paragraph definition; don't adopt one silently.
- **Whether 39 gets used.** If the corpus wants a real conversion/eval-harness step between 31 and 38, that's task 39, currently reserved and unused.
