# Task 40 — Three-way model bake-off (the migration decision gate)

**Owner:** **Jason + Opus.** Device work: Opus prepares the exact protocol and reads the pulled results; Jason runs it on the S23 FE. **Entirely `P`.**
**Depends on: task 38 (the trained Gemma LoRA) and task 31 (the corpus).** Cannot run until both exist — the whole point is to decide on a *real corpus* with an *adapted* Gemma, not on the 16 seed fixtures the spike explicitly said can't resolve the gap.
**This task gates the migration decision. It does not make it** — it produces the numbers; Jason makes the call.

*(Numbering note: this is the bake-off. Task 38 is the LoRA training. If a separate corpus→eval-harness conversion task is wanted between them it takes number 39; otherwise 39 is unused and this stays 40 to keep the bake-off visually distinct as the endgame.)*

**Read first:**
1. `docs/eval/model_base_spike_final_findings.md` — the six-model spike this concludes. Reuse its exact critical-field metric, its Gate-2 protocol (fixed grammar, `enable_thinking:false`, cooled between runs), and its verdict-table shape.
2. `docs/eval/task38_findings_report.md` — the Gemma LoRA, its prompt-only baseline, and whether it cleared its bar.
3. `docs/briefs/orientation_for_opus.md` §1 (model-decision-open, the three contenders and why), §4 constraints.
4. The task-31 corpus — the eval set is drawn from its **held-out** split, never the training split (or the Gemma LoRA has seen the test).

---

## 1. The three contenders

| Contender | What it is | Why it's in |
|---|---|---|
| **LoRA-Gemma-4-E2B** | Stock Gemma 4 E2B + task 38's adapter (loaded via `applyLoraAdapters`) | The migration candidate — trainable, 2× faster/capture, best distress; the LoRA is meant to close its inference gap |
| **Bonsai-8B-Q1_0** | The incumbent family's **untested** rung (1.08 GiB, 8B params at the 4B's footprint; downloaded, never run) | The spike called it "the most promising untested direction" — 8B capacity may beat everything without any adapter, keeping you in the Bonsai family |
| **T-Bonsai-4B TQ1_0** | The current shipping model | The incumbent baseline — the thing a migration must decisively beat to justify its cost |

**The decision this gates:** migrate to LoRA-Gemma, migrate to Bonsai-8B, or stay on Bonsai-4B. Three real outcomes.

## 2. The protocol (fair-fight discipline is the whole value)

- **Same corpus, same day, same build, cooled between runs**, exactly as the spike's Gate 2 ran — otherwise the numbers aren't comparable and the task is worthless.
- **Eval set = task 31's held-out split**, not the seed fixtures, not the LoRA's training data. Big enough to resolve the differences the 16-fixture set couldn't (±12 points was its resolution; the whole reason for the corpus is to shrink that).
- **The critical-field metric from the spike** — same fields, same scoring, so this extends the spike's table rather than inventing a new axis. Add coaching/distress evaluation (the spike scored it qualitatively; do at least that).
- **Grammar constrained, `enable_thinking:false`** (the spike's defect #1 — a reasoning model left on `thinking:true` speculated about a distressed user's mental health; set it explicitly for any contender that supports it).
- **Measure the full envelope, not just accuracy:** critical-field correctness, per-field breakdown, latency/capture, steady tok/s, peak RAM, thermal tier — because a model that's more accurate but doesn't fit the S23 FE's envelope is still a loss (Gemma runs ~5 °C hotter and 1.2 GiB heavier than Bonsai-4B; the report says it fits with headroom, but confirm it under sustained real use).
- **Task 37's grammar fix must be in place first** (the separator-token hole) — you don't want a contender winning or losing on a bug that affects them unequally by tokenizer luck.

## 3. Pulled-DB discipline (non-negotiable)

Every accuracy claim checked against extracted output pulled off the device, not read on screen — the same rule that caught silent bugs in tasks 13, 24, and 32, and the same rule the spike itself followed. A model that *looks* right in the UI and writes garbage to the DB fails.

## 4. The decision framing (for Jason)

The output is a three-way verdict table plus a recommendation, but the **call is Jason's** and it's not purely "highest score wins." The real question the spike framed: *is a trainable base that's close-but-behind worth more than a frozen base that's ahead?* Concretely —

- **If LoRA-Gemma matches or beats Bonsai-4B** on the held-out corpus and fits the envelope → migrate to Gemma; the growth path (further LoRA iterations as the corpus grows) is now real and Bonsai never had it.
- **If Bonsai-8B beats both** → migrate *within the family* to 8B; you get the capability jump without leaving the proven runtime, at the cost of staying frozen (no LoRA path). Whether that matters depends on whether 8B is *good enough* that adaptation is moot.
- **If Bonsai-4B still wins** decisively → stay; the migration cost isn't justified, and the finding is "the incumbent is the right model," with Gemma noted as the trainable fallback if the corpus later grows enough to change the answer.
- **The subtle case:** LoRA-Gemma *slightly* behind Bonsai-4B but with a **trajectory** (clear lift from prompt-only → LoRA-v1, implying LoRA-v2 on a bigger corpus passes it). This is where "trainable vs frozen" actually bites, and it's a judgment call, not a number — surface it explicitly rather than letting the raw score decide.

## 5. Definition of done

- All three contenders run through the protocol on the S23 FE against the held-out corpus, pulled-DB verified.
- A verdict table extending the spike's, plus latency/RAM/thermal for each.
- A recommendation keyed to §4's framing — which outcome the evidence supports, with the trajectory case called out if it applies.
- **Jason's migration decision recorded** (this task surfaces it; Jason rules it) in orientation §1, replacing "model decision: open."
- Device left clean; contenders kept on the laptop for re-test.
- Findings report at `docs/eval/task40_findings_report.md`.
