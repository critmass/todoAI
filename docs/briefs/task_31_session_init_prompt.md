# Task 31 — session init prompt

**Refreshed 2026-08-22 by the coordinator** after task 50 closed and the corpus-size ruling landed.
What changed from the prior version: **`energy` is now DEFINED** (task 50 — the session no longer
proposes it, it *labels to it*); **corpus size is RULED** (100+ Type-A, ~50 held out — not an open
question); and two hard rules are now front-loaded — **golds are human-authored (a model may draft
input strings, never the answer key)** and **the 16-fixture bank's answer key is invalid** (extend its
*format*, never inherit its values). Task 31 is now **fully unblocked** (41 and 50 both done).

## Model recommendation

**Split the task across two models. Don't run the whole thing on either one.**

| Phase | Model | Why |
|---|---|---|
| **1. Split design + first ~15 items** | **Opus 5** | This phase sets the held-out split rule, the stratification, and the resolution figure that task 40's entire bake-off — and Jason's migration decision — rests on. A merely-good answer produces a corpus that looks fine, trains fine, evaluates fine, and returns a number that can't decide anything. That is the exact "subtly and expensively wrong" failure the Opus-5 slot exists for. It also front-loads schema problems while they're cheap. |
| **2. Bulk transcription of the rest** | **Sonnet** | Once the pattern, schema, and split rule exist, turning ~70 more real captures into validated JSONL is a clear repetitive pattern against a fixed contract — the bulk of the wall-clock time and the cheapest part. |
| **3. Findings report + resolution math** | **Opus 5** (short) | The report states the number task 40 quotes. Worth the good model for an hour. |

*(A deliberate disagreement with the master table's old "Jason produces; Sonnet formats" — that was written when 31 was "more fixtures." It is now the measuring instrument for a product decision, and the split is not a formatting job. If the Opus-5 budget is better spent elsewhere, Phase 1 on ordinary Opus is a reasonable second choice; Phase 1 on Sonnet is not.)*

---

## The prompt (paste this to start Phase 1)

You are working on **task 31 of todoAI** — building the real task + friction corpus. I'm Jason, the sole developer. You are not writing app code; you are eliciting real material from me, structuring it, and designing the evaluation split. Task 31 is the critical-path measuring instrument for the model-migration decision (`31 → 38 → 40`), and it is now fully unblocked.

Read these before asking me anything, in this order:

1. `docs/briefs/real_task_corpus_task_31.md` — your work order. Read it in full, including §0.1 (energy labeling + the hard gold constraints).
2. `docs/design/energy_definition_task50.md` — **the `energy` field is already defined (task 50).** §2b is your gold-labeling rubric; §3/§5/§6c are hard constraints on how golds are made. You do **not** re-derive the energy definition; you label to it.
3. `docs/briefs/orientation_for_opus.md` — project state. §1 (confirmed facts), §4 (constraints), §9 (open items). On conflict, orientation wins except this brief wins for task 31.
4. `docs/eval/extraction_fixtures_seed.jsonl` — the 16 seed fixtures. Extend their **format**; do **not** inherit their expected values (see the "hold these" note on the invalid key).
5. `docs/eval/model_base_spike_final_findings.md` — the **final** spike report. Check for a newer sibling before trusting any findings file; a superseded report next to a `..._final_...` one has burned a session here before.
6. `docs/briefs/model_bakeoff_task_40.md` §2 — what the held-out split has to survive.

Hold these from the first message:

- **The corpus is a measuring instrument, and its resolution is the deliverable.** The corpus size is **ruled: 100+ Type-A extraction items, ~50 held out** (≈±11 points — finally tighter than the seed set). Brief §3 has the arithmetic; check it rather than trusting it. If 100+ turns out unaffordable, a smaller number is legitimate **only if** you compute the actual resolution it gives and hand that figure to task 40 up front — a bake-off that knows its own resolution is useful; one that doesn't is the trap.
- **Design the split before writing item one.** Brief §4. Grouped by source situation, stratified on `recurrence` and `due_resolved`, assigned in-file, never revisited after a result is seen. **This is the Phase-1 deliverable I sign off before you elicit anything.**
- 🔴 **Golds are human-authored — you may help me draft the input *strings*, but the answer key is mine, never a model's** (task 50 §6c). This is the exact trap that invalidated the 16-fixture bank: its expected-value column was model-generated, so a "bake-off" against it measured two models' arbitrary choices, not capability. Generate 100+ golds that way and task 40 measures nothing. Hard rule, not a preference.
- 🔴 **`energy` is defined — label to task 50 §2b, never null, never internal 2/4.** `energy` = activation cost (the cost to *start* + *get through*, take the higher; gym→`high`, trash→`low`). Every gold carries `low`/`med`/`high`. Do not re-open the definition; if a real capture genuinely doesn't fit the rubric, flag it to `disputed`, don't bend the rubric.
- **The 16 seed fixtures' answer key is invalid** (task 50 §6a — it was thermal-test scaffolding, model-generated). Match their JSONL *format*; re-label every value from scratch. Do not quote "16 fixtures resolved to ±12" as if those answers were ground truth — the ±12 is a statistical property of n=16, not a validated score.
- **Push back.** I want the disagreement with a mechanism, not the assent. If the brief's targets or arithmetic are wrong, show the math. Bring me tradeoffs with a recommendation; don't make product-intent calls for me.
- **Every gold gets run through the real validators** (`validateTaskExtraction` et al.), not eyeballed. A gold that fails a validator is a bug in the gold.
- **Interview me properly.** The value of this corpus is that it isn't synthetic. If I hand you something that reads like a seed fixture with the words swapped, tell me and ask for the real version. If I'm sanitizing — clean tasks instead of the run-on, half-abbreviated, three-tasks-in-one-sentence way I actually type — push me off it.
- **Don't let me write crisis content.** Brief §6. Near-miss distress is in scope; synthetic self-harm transcripts are not — those belong to task 21 and a human.

Start by doing this, in order:

1. Read the six documents above.
2. Tell me your read of the brief, including anything in §3's resolution math you think is wrong.
3. Propose the split design and stratification scheme (brief §4) and get my sign-off **before eliciting anything**.
4. Then start the interview — a few items at a time, each gold labeled to the task 50 §2b energy rubric and run through the real validators as we go, so we find schema problems at item 5 rather than item 80.

Do not batch-generate items and ask me to review them. The material — and every gold value — comes from me; your job is to pull it out, structure it, design the split, and keep the instrument honest.

---

## Phase 2 prompt (paste when the pattern is set)

You are continuing **task 31 of todoAI** — bulk transcription for the real task corpus. Phase 1 established the schema, the split rule, and the stratification; your job is volume against a fixed contract, not redesign.

Read `docs/briefs/real_task_corpus_task_31.md` (incl. §0.1), `docs/design/energy_definition_task50.md` §2b (the energy rubric), the Phase 1 output in `docs/eval/corpus_extraction_v1.jsonl`, and `docs/eval/task31_findings_report.md` (partial).

Rules:

- **Match the established pattern exactly.** Same schema, field conventions, gold style. If an item won't fit, stop and ask — don't extend the schema.
- 🔴 **Golds are human-authored (Jason's), never model-generated** — you transcribe and structure what Jason gives; you do not invent the answer key (task 50 §6c). **`energy` labels to task 50 §2b: never null, never 2/4.**
- **Respect the split assignment rule** as Phase 1 defined it. Assign `split` and `stratum` on every item.
- **Run every gold through the real validators.** Report failures; don't fix a gold by loosening it.
- **Flag, don't resolve.** Anything ambiguous — a gold you reasoned hard about, an item straddling two strata, a `recurrence` you're unsure of, an `energy` that doesn't sit cleanly in the rubric — goes to `docs/eval/corpus_disputed.jsonl` with a one-line note. The scored items must be unambiguous.
- Report the running count by stratum after every batch, so we can see which strata are thin while there's still time to aim at them.
