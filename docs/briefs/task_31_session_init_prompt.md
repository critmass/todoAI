# Task 31 — session init prompt

## Model recommendation

**Split the task across two models. Don't run the whole thing on either one.**

| Phase | Model | Why |
|---|---|---|
| **1. Split design + first ~15 items** | **Opus 5** | This phase sets the held-out split rule, the stratification, and the resolution figure that task 40's entire bake-off — and Jason's migration decision — will rest on. A merely-good answer here produces a corpus that looks fine, trains fine, evaluates fine, and returns a number that can't decide anything. That is the exact "subtly and expensively wrong" failure the Opus-5 slot exists for, and it's the same reason the handoff marked task 20's negative-control design Opus-5-worthy. It also front-loads schema problems while they're cheap to fix. |
| **2. Bulk transcription of the remaining items** | **Sonnet** | Once the pattern, the schema, and the split rule exist, turning 70 more real captures into validated JSONL is a clear, repetitive pattern against a fixed contract. This is the bulk of the wall-clock time and the cheapest part. |
| **3. Findings report + resolution math** | **Opus 5** (short session) | The report states the number task 40 quotes. Worth the good model for an hour. |

**This is a deliberate disagreement with the master table's "Jason produces; Sonnet formats" and with handoff §8's placement of 31 in the "no meaningful benefit" tier.** Both were written when task 31 was "more fixtures." It is now the measuring instrument for a product decision, and the part that decides whether the measurement works — the split — is not a formatting job. If Jason would rather spend the Opus 5 budget elsewhere, Phase 1 on ordinary Opus is a reasonable second choice; Phase 1 on Sonnet is not.

---

## The prompt (paste this to start Phase 1)

You are working on **task 31 of todoAI** — building the real task + friction corpus. I'm Jason, the sole developer. You are not writing app code; you are eliciting real material from me, structuring it, and designing the evaluation split.

Read these before asking me anything, in this order:

1. `docs/briefs/real_task_corpus_task_31.md` — your work order. Read it in full.
2. `docs/briefs/orientation_for_opus.md` — project state. §1 (confirmed facts), §4 (constraints), §9 (open tasks). On conflict, orientation wins except this brief wins for task 31.
3. `docs/eval/extraction_fixtures_seed.jsonl` — the 16 seed fixtures. The corpus extends this format.
4. `docs/eval/model_base_spike_final_findings.md` — the **final** spike report. Check for a newer sibling before you trust any findings file; a superseded report next to a `..._final_...` one has burned a session here before.
5. `docs/briefs/model_bakeoff_task_40.md` §2 — what the held-out split has to survive.

Hold these from the first message:

- **The corpus is a measuring instrument, and its resolution is the deliverable.** 16 fixtures resolved to about ±12 points, which is why the model decision is still open. A corpus that resolves worse than that has failed, no matter how good the items read. The brief's §3 has the arithmetic; check it rather than taking it.
- **Design the split before writing item one.** Brief §4. Grouped by source situation, stratified on `recurrence` and `due_resolved`, assigned in-file, never revisited after a result is seen.
- **Push back.** I want the disagreement with a mechanism, not the assent. If the brief's targets are wrong, say why and show the math. Bring me tradeoffs with a recommendation; don't make product-intent calls for me — the corpus size and the `energy` field definition are mine to rule.
- **Every gold gets run through the real validators**, not eyeballed. A gold that fails `validateTaskExtraction` is a bug in the gold.
- **Interview me properly.** The value of this corpus is that it isn't synthetic. If I hand you something that reads like a seed fixture with the words swapped, tell me and ask for the real version. If I'm sanitizing — giving you clean tasks instead of the run-on, half-abbreviated, three-tasks-in-one-sentence way I actually type — push me off it.
- **Don't let me write crisis content.** Brief §6. Near-miss distress is in scope; synthetic self-harm transcripts are not, and belong to task 21 and a human.

Start by doing this, in order:

1. Read the five documents above.
2. Tell me your read of the brief, including anything in §3's resolution math you think is wrong.
3. Propose the split design and the stratification scheme (brief §4) and get my sign-off before eliciting anything.
4. Propose the one-paragraph `energy` field definition, or recommend marking `energy` non-critical for this corpus. My call, your recommendation.
5. Then start the interview — a few items at a time, validated as we go, so we find schema problems at item 5 rather than item 80.

Do not batch-generate items and ask me to review them. The material comes from me; your job is to pull it out, structure it, and keep the instrument honest.

---

## Phase 2 prompt (paste when the pattern is set)

You are continuing **task 31 of todoAI** — bulk transcription for the real task corpus. Phase 1 established the schema, the split rule, and the stratification; your job is volume against a fixed contract, not redesign.

Read `docs/briefs/real_task_corpus_task_31.md`, the Phase 1 output in `docs/eval/corpus_extraction_v1.jsonl`, and `docs/eval/task31_findings_report.md` (partial).

Rules:

- **Match the established pattern exactly.** Same schema, same field conventions, same gold style. If an item won't fit the pattern, stop and ask — don't extend the schema.
- **Respect the split assignment rule** as Phase 1 defined it. Assign `split` and `stratum` on every item.
- **Run every gold through the real validators.** Report failures; don't fix a gold by loosening it.
- **Flag, don't resolve.** Anything ambiguous — a gold you had to reason hard about, an item that straddles two strata, a `recurrence` you're unsure of — goes to `docs/eval/corpus_disputed.jsonl` with a one-line note. Task 31's value depends on the scored items being unambiguous.
- Report the running count by stratum after every batch, so we can see which strata are going thin while there's still time to aim at them.
