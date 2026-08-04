# Model-base spike — final findings (six models)

**2026-08-03, Samsung Galaxy S23 FE.** Supersedes `docs/eval/qwen35_spike_findings.md`, which was
written before the field was extended past the three models the brief named and whose
"stay on Bonsai" recommendation no longer reflects the evidence.

Raw data: `docs/eval/qwen35_spike_results.json` (48 tags). Thermal traces:
`docs/eval/qwen35_spike_thermals_*.jsonl`. Per-tag conditions:
`docs/eval/qwen35_spike_run_conditions.md`. 2B raw output: `docs/eval/qwen35_2b_gate2_raw.md`.

## Recommendation

**Migrate to Gemma 4 E2B, in the staged order §5 of the brief prescribes: base migration first,
then task 31's corpus, then a LoRA — not collapsed into one step.**

This reverses the earlier report. Bonsai is still the best extractor measured today, but it is
**permanently capped**: its ternary format has no adapter path outside PrismML's proprietary
pipeline. Gemma is two critical fields behind, twice as fast per capture, better on the coaching
surface, and **trainable** — `llama.rn` exposes `applyLoraAdapters` and the pinned build carries
the full `llama_adapter_lora` API, so an adapter can be loaded at runtime without merging or
re-quantizing.

A base that is 86% as good today with a growth path is worth more than one that is 100% and
frozen. That is the question the spike was commissioned to answer (§0: "a LoRA-base scouting
mission"), and Gemma is the only candidate of six that answers it.

## The field

All Gate 2 figures: fixed grammar, `enable_thinking: false`, same build, same day, cooled between
runs.

| | Bonsai-4B TQ1_0 | **Gemma 4 E2B Q4** | Qwen3.5-2B Q4 | Qwen3.5-0.8B Q4 | SmolLM2-1.7B Q4 |
|---|---|---|---|---|---|
| Arch | `qwen3` | `gemma4` | `qwen35` (hybrid) | `qwen35` (hybrid) | `llama` |
| Size on disk | 1.02 GiB | 2.89 GiB | 1.19 GiB | 0.50 GiB | 1.01 GiB |
| Load time | 2,906 ms | 6,252 ms | 3,128–5,422 ms | **1,865 ms** | 2,504 ms |
| Peak RAM (PSS) | **1.65 GiB** | 2.88 GiB | 2.38 GiB | 1.48 GiB | 2.37 GiB |
| **Critical correct** | **14/16** | **12/16** | 8/16 | 5/16 | 5/16 |
| `recurrence` wrong | **2** | 4 | 5 | 8 | 12 |
| `due_resolved` wrong | **0** | 3 | 3 | 3 | 14 |
| `title` wrong | 2 | **1** | 8 | 6 | 7 |
| `energy` wrong | 8 | 14 | **6** | 13 | **6** |
| Junk tags | 4 | **0** | 5 | 2 | 1 |
| Median latency/capture | 20.9 s | **10.9 s** | 25.6 s | 10.1 s | 11.9 s |
| Steady tok/s @20 min | 6.55 | 9.36 | 10.07 | **22.59** | 12.23 |
| Peak AP | 57.1 °C | 62.7 °C | 58.0 °C | 61.4 °C | **65.5 °C** |
| Worst throttle tier | 3 SEVERE | 3 SEVERE | 3 SEVERE | 3 SEVERE | **4 CRITICAL** |
| Distress response | good | **best** | clinical | **fabricates** | generic |
| **LoRA-trainable** | **No** | **Yes** | Yes | Yes | Yes |
| GBNF works | ✅ | ✅ | ✅ | ✅ | ✅ |

## Why Gemma, specifically

**It beats Bonsai on five fields** — titles nearly perfect (1 wrong vs 2), duration estimation
(2 vs 7), `duration_from_user` (1 vs 6), zero junk tags, tightest tag discipline at 1.13 average.

**It is twice as fast per capture** (10.9 s vs 20.9 s). Note the mechanism: decode is only ~1.4×
faster (9.36 vs 6.55 tok/s); the rest comes from Gemma emitting fewer tokens. Training would change
verbosity, so this advantage could move either way after a LoRA.

**Its distress response was the best of the six.** Verbatim: *"What you are feeling is valid… Right
now, the goal isn't to finish the entire list. The goal is to survive the next five minutes."* It
validates and then reframes to something achievable. Bonsai reassures but stops there; the 0.8B
fabricated the user's circumstances outright.

**Its failures are the kind a LoRA fixes.** `recurrence` (4) is our taxonomy convention — nothing in
the prompt teaches that "keep practicing guitar" is unscheduled-recurring. `energy` (14) and
`importance_user` (14) look like systematic convention mismatch rather than weak inference, given
how well it does elsewhere; **check the raw output before treating those as capability limits.**

**Cost:** 1.2 GiB more resident than Bonsai, and it runs ~5 °C hotter. The phone showed 2.31 GiB
still available with Gemma loaded, so it fits with headroom.

## What the six models settled

**Size beats family, quantization, and training curation.** Every model smaller than the 4B
incumbent lost to it, across four architectures and three quantization schemes. SmolLM2's heavy
data curation did not rescue 1.7B — it was the worst extractor tested. The only model to come
close was the only one with more capacity.

**Structured inference is inert to configuration.** `recurrence` and `due_resolved` were measured
across four configurations on the 2B (thinking on/off × grammar broken/fixed) and two on the 0.8B.
They never moved. No prompt or grammar change closes a capability gap.

**The thermal envelope does not discriminate.** All six reach at least SEVERE throttling by twenty
minutes. It cannot be used to choose between them. SmolLM2 alone reached CRITICAL (tier 4).

**Constrained decoding is free.** Nine samples across five architectures, all between 0.77× and
1.16×. Stated honestly: no consistent penalty, ±20% run-to-run variance.

## Defects found

**1. `enable_thinking` defaults to TRUE in llama.rn.** `getFormattedChat` does
`enable_thinking: params?.enable_thinking ?? true`. Unset, Qwen3.5 emitted its reasoning at a
distressed user, including speculation about depression and anxiety. Any reasoning model must set
this explicitly.

**2. The production grammar accepts a bare separator token as a complete value.** Flagged for the
coordinator; not fixed here.

> `src/llm/extraction/task_extraction.v1.gbnf` — `title ::= "\"" jchar{1,80} "\""` is satisfied by
> the single token `","` (id 2129 on Qwen3.5). Schema-valid, passes `validateTaskExtraction`
> (which only checks `title.trim().length > 0`), and useless. Hit 13–15 of 16 fixtures on the 2B.
> `description` shares the hole; `newTag`, `tool`, `date` share the pattern and want auditing.
> **Fix that worked:** require the first character to be `[a-zA-Z0-9]`. A minimum length does not
> (a 3-char minimum still produced `",Trash collection"`). Bonsai never triggered it because it
> does not rank `","` first — luck, not safety.

## Corrections to earlier claims in this arc

- **§0's premise is wrong.** Qwen3.5 is `qwen35`, a *hybrid* arch (SSM + attention, MTP head), not
  "the same architecture at a higher precision rung" as Bonsai's dense `qwen3`.
- **§4's Bonsai baseline had two wrong figures**: size is 1.02 GiB not ~1.7 GB; steady throughput
  6.55–7.53 tok/s not ~5.2.
- **The memory "ratio" framing I used through most of this arc was wrong.** Dividing resident
  memory by file size produced 1.30× for Bonsai and 1.85–2.42× for the Q4 models, which I read as
  a property of quantization. Gemma broke it: 2.89 GiB of weights used *less* memory than its file
  size. The pattern that fits is a large fixed overhead plus partial residency, not a per-model
  multiplier. Bonsai's low **absolute** footprint is real; the ratio was an artifact.
- **I predicted Gemma would OOM at ~5.4–5.8 GiB.** It loaded in 6.3 s using 2.88 GiB.
- **Thermal figures for Bonsai and the Qwen rungs are end-of-run spot readings**, taken before the
  thermal join worked. SmolLM2's joined data shows peaks above what an end-of-run reading reports,
  so those should be read as "at least SEVERE", not "SEVERE at peak".

## Gaps

- **Bonsai's 20-minute run is not in the machine record.** Measured (burst 6.77, steady 6.55,
  retention 97%, tailDrift −2.0%, SKIN status 3) but lost to logcat ring-buffer rotation before the
  capture pipeline worked. A re-run was started and cancelled for time. **~30 min to close.**
- **Bonsai's Gate 2 has no thermal annotation** — captured before the join worked. Every other
  model has it.
- **16 fixtures cannot resolve small differences** (±12 points). The Bonsai-vs-Gemma gap of 2 is
  *within* that interval — the ordering is suggestive, not established. Task 31's corpus is the
  prerequisite for measuring a LoRA's effect, not just for training one.
- **LoRA tooling for `gemma4` was verified only at the runtime API level.** Training and adapter
  export were not tested.
- **`energy` is wrong 6–14 times out of 16 on every model including the incumbent.** Six models,
  four families. That is a field-definition problem, not six weak models. Cheapest available win,
  needs no migration.
- **Bonsai-8B was never run.** Two builds are loadable on stock (`Q1_0` type 41, `TQ2_0` type 35,
  both with ARM kernels); `prism-ml/Ternary-Bonsai-8B`'s `Q2_0` is absent from the build entirely
  and cannot load. `Bonsai-8B-Q1_0.gguf` (1.08 GiB — 8B parameters at the incumbent's footprint) is
  downloaded and on the laptop. This is the most promising untested direction.
- **SmolLM3-3B untested.** `smollm3` is in the arch table; 3B sits in the 2B→4B gap where the
  quality cliff lies.

## Device state

Left clean: app stopped, no context loaded, **only `Ternary-Bonsai-4B-TQ1_0.gguf` remains on the
phone** (14 GB free). All six GGUFs are kept on the laptop in `~/Downloads`, so any model can be
re-pushed in under a minute. The one partial download (`Bonsai-8B-TQ2_0`, 855 MB of 2,414 MB) was
deleted.
