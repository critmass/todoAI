# Task 38 — Train the Gemma 4 E2B extraction/coaching LoRA

**Owner:** Opus (pipeline design + training-script authorship) + **Jason** (runs the training; owns GPU/compute). **Not on-device** — training happens off-phone; the *artifact* (a LoRA adapter) is what ships to the device for task 40.
**Depends on: task 31 (the corpus).** This task cannot start until task 31 has produced real training data. That dependency is the whole point — a LoRA is only as good as what it's trained on, and the six-model spike (`docs/eval/model_base_spike_final_findings.md`) is explicit that the 16 seed fixtures cannot resolve the differences that matter.

**Read first:**
1. `docs/eval/model_base_spike_final_findings.md` — the whole rationale. Especially: why Gemma (trainable, `applyLoraAdapters` in the pinned build), what its *real* gap is (`recurrence` 4-wrong and `due_resolved` 3-wrong on true inference; `energy`/`importance_user` are a **null-convention mismatch, not capability**), and the "±12-point resolution" caveat.
2. `docs/eval/gemma4_e2b_gate2_raw.md` — Gemma's actual per-fixture output, so training targets the real failure modes, not imagined ones.
3. `docs/briefs/orientation_for_opus.md` §1 (model-decision-open), §4 (constraints the adapter must not break — grammar path #3, scales #6).
4. Whatever task 31 produced (`docs/eval/` corpus files).

---

## 1. What this builds

A **LoRA adapter for Gemma 4 E2B** that raises extraction accuracy on todoAI's schema toward (and ideally past) Bonsai-4B's 14/16, so the three-way bake-off (task 40) is a fair fight between an *adapted* Gemma and the frozen Bonsai family. The deliverable is the adapter file (GGUF-loadable via `llama.rn`'s `applyLoraAdapters`), the training script/config, and a held-out eval showing the lift.

**Before training anything, try the free fix.** The spike found Gemma's two worst fields (`energy`, `importance_user`, 14 wrong each) are a **convention mismatch** — Gemma *infers* values the schema wants left `null` ("record only what was said"). That is fixable by **prompt alone**. Establish the prompt-only baseline first: fix the null-convention in the system prompt, re-measure. The LoRA then only has to close the *residual* gap (`recurrence`, `due_resolved`), which is smaller and more clearly capability. Training to fix something a prompt line fixes is wasted effort and risks overfitting the adapter to a non-problem.

## 2. Scope

1. **Corpus → training-set conversion.** Task 31's real messy tasks + coaching transcripts + friction episodes become instruction/target pairs in Gemma's chat format, targeting the schema the grammar enforces. The *targets* must obey the same conventions the golds do (null-when-unstated included), or the LoRA learns to hallucinate values.
2. **The training pipeline** — base Gemma 4 E2B, LoRA config (rank, alpha, target modules, LR), the training run, and adapter export to a format `llama.rn`'s `applyLoraAdapters` loads. Verify the export loads at the runtime API level *before* declaring done (the spike confirmed the API exists but did not test training/export end-to-end — that gap is this task's to close).
3. **Held-out evaluation** — a train/eval split of the corpus, measured on the same critical-field metric the spike used (so task 40's comparison is apples-to-apples). Report the lift over the prompt-only baseline, per field.
4. **The distress/coaching surface** — Gemma already had the best distress response of the six; the LoRA must **not regress** it. Include coaching examples in the eval, and confirm the adapter doesn't trade coaching quality for extraction accuracy.

## 3. Decisions to make and record

**a. Adapter or full fine-tune?** LoRA is the whole premise (runtime-loadable, no re-quant, keeps the base swappable). Stay with LoRA unless there's a measured reason not to.
**b. How much data is enough?** Task 31's corpus is small by fine-tuning standards. Decide whether it supports a real adapter or only a prompt-fix + tiny adapter, and say so honestly — a LoRA trained on too little data will overfit and look great on the eval split while generalizing worse than the prompt-only base. The held-out split is the guard.
**c. What "ready for the bake-off" means.** Define the bar before training: e.g. "matches or beats the prompt-only baseline on `recurrence` + `due_resolved` on held-out data, with no coaching regression." If the LoRA can't clear its own bar, that is a *finding* (Gemma's ceiling on this task with this much data), and task 40 runs with the prompt-only Gemma instead.

## 4. Constraints that bite here

- **The null-convention is the schema's, not a preference.** "Record only what was said" — the adapter must honor it or it defeats the point (Gemma's inference *was* the bug).
- **Don't break the grammar path (#3).** Whatever the adapter does, the model still emits under GBNF constraint on-device; train targets that are grammar-valid.
- **Scales (#6)** — energy/importance targets are the user-facing coarse values projected through the schema, never raw internal integers.
- **Keep the base swappable.** The adapter loads *onto* stock Gemma 4 E2B via `applyLoraAdapters` — do not produce a merged/re-quantized model that couples the base and the adapter (that would forfeit the runtime-load advantage that made Gemma the pick).

## 5. Definition of done

- The prompt-only baseline established and measured first (the free fix).
- A LoRA adapter trained on the task-31 corpus, exported, and **confirmed loadable via `llama.rn`'s `applyLoraAdapters`** on the pinned build.
- Held-out eval showing per-field lift over the prompt-only baseline; the "ready for bake-off" bar met, or the shortfall reported as a finding.
- No coaching/distress regression.
- Findings report at `docs/eval/task38_findings_report.md`: the prompt-only baseline numbers, the LoRA lift, the (a)–(c) decisions, whether the adapter cleared its bar, and the adapter artifact's location. This report is task 40's input.
