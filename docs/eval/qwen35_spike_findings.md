# Model-base spike — findings

**2026-08-03, Samsung Galaxy S23 FE.** Deliverable for `docs/briefs/model_base_spike_qwen35.md`.
Raw data: `docs/eval/qwen35_spike_results.json` (36 tags), thermal traces in
`docs/eval/qwen35_spike_thermals_*.jsonl`, per-tag conditions in
`docs/eval/qwen35_spike_run_conditions.md`, 2B raw output in `docs/eval/qwen35_2b_gate2_raw.md`.

## Recommendation

**Stay on Bonsai.** This is the brief's §5 third outcome — "the model is not our bottleneck" —
except the result is stronger than that phrasing allows: Bonsai is not merely equal, it is
**materially better at the thing the app depends on**, while both Qwen rungs are heavier in
non-reclaimable memory and no cooler under load.

Neither Qwen rung is a servable LoRA base on this evidence, because neither clears the
"≈-or-better on quality" bar that §5 requires before the LoRA question becomes real. Record
Qwen3.5-2B-Q4_K_M as a **validated fallback** — it loads, decodes, and grammar-constrains
correctly on stock `llama.rn` 0.12.5, so if Bonsai ever becomes unavailable there is a known path.

The follow-on work this points at is the scaffolding, not the model: the prompt, the field
definitions, and task 31's corpus.

## §4 verdict table

All figures measured 2026-08-03 on the same build, same day, USB-powered, phone out of its case,
cooled between runs. Gate 2 figures are the **fixed-grammar, thinking-off** runs (see *Two defects*).

| | Bonsai-4B TQ1_0 | Qwen3.5-2B Q4_K_M | Qwen3.5-0.8B Q4_K_M |
|---|---|---|---|
| Loads on stock `llama.rn` 0.12.5 | ✅ arch `qwen3` | ✅ arch `qwen35` | ✅ arch `qwen35` |
| Size on disk | 1,091,638,048 B (1.02 GiB) | 1,280,835,840 B (1.19 GiB) | 532,517,120 B (0.50 GiB) |
| Load time | 2,906–3,220 ms | 3,128–5,422 ms | **1,865–1,867 ms** |
| Peak RAM (PSS) | 1,645,536 KB | 2,377,803–2,521,083 KB | **1,476,929 KB** |
| RAM delta over idle | +1.32 GiB | +2.02–2.19 GiB | +1.20 GiB |
| **RAM as multiple of file size** | **1.30×** | 1.70–1.85× | **2.42×** |
| Native heap (non-evictable) | **388 MB** | 1.23–1.36 GiB | 797 MB |
| Burst tok/s | 7.25 | 11.10 | **29.23** |
| Steady tok/s (4.5 min) | 6.84 | 10.14 | **24.35** |
| Steady tok/s (20 min) | *not captured — see gaps* | 10.07 | **22.59** |
| tailDrift @20 min | *not captured* | −1.5% | **−1.3%** |
| Thermal @20 min | SKIN `status=3` SEVERE | SKIN `status=3` SEVERE | SKIN `status=3` SEVERE |
| Peak AP | 57.1 °C | 58.0 °C | **61.4 °C** |
| GBNF works | ✅ | ✅ | ✅ |
| Grammar overhead | 0.87–1.16× | 0.77–0.94× | 0.96–0.99× |
| **Schema-valid** | **16/16** | **16/16** | **16/16** |
| **Critical correct** | **14/16 (87.5%)** | 8/16 (50%) | 5/16 (31%) |
| Fully correct | 1/16 | 2/16 | 1/16 |
| `recurrence` wrong | **2** | 5 | 8 |
| `due_resolved` wrong | **0** | 3 | 3 |
| Median latency per capture | 20.9 s | 25.6 s | **10.1 s** |
| Distress response | appropriate | clinical, factually anchored | **fabricates the user's circumstances** |

## What decided it

**Structured inference is invariant to configuration.** `recurrence` and `due_resolved` were
measured across four configurations on the 2B (thinking on/off × grammar broken/fixed) and two on
the 0.8B. They never moved: 5 and 3 for the 2B in every configuration, 8 and 3 for the 0.8B in
both. Critical correctness never moved either — 8/16 and 5/16 throughout. No prompt or grammar
change closes the gap to Bonsai's 2 and 0, because it is capability rather than configuration.

**Quality is monotonic with size within the Qwen family, and Bonsai beats both rungs.**
`recurrence` degrades 2 → 5 → 8 down the ladder. The brief's §1 expectation that "the 0.8B is the
model most likely to win" is falsified: it does fit the envelope — lightest resident, fastest load,
fastest decode — and extracts unusably, wrong on the critical fields in roughly two cases out of
three.

**The thermal envelope does not discriminate.** All three drive SKIN to `status=3`
(THROTTLING_SEVERE) by twenty minutes. The brief framed footprint-inside-the-thermal-envelope as
"the primary axis"; measured, every candidate saturates it, so it separates nothing. The 0.8B runs
the SoC *hottest* (61.4 °C peak) precisely because it decodes fastest.

**The hybrid memory tax scales the wrong way.** As a multiple of file size the cost rises as the
model shrinks — 1.70–1.85× for the 2B, 2.42× for the 0.8B, against Bonsai's 1.30× — because the
recurrent state and inflated graph budget are largely fixed. Shrinking a `qwen35` model buys much
less RAM than its file size implies. Bonsai also keeps most of its footprint in mmap'd file pages
the kernel can evict; the Qwen rungs hold far more in native heap that it cannot.

**On the distress path, the 0.8B fabricates.** Given a turn describing exhaustion and feeling
behind, it invented "a very strange, high-stakes phase of your life" and "100+ items" — neither
present in the input. The brief's §2b cited published high hallucination rates for the Qwen3.5
small models on exactly these exposed paths; this is that, measured. Bonsai's response was warm
and invented nothing.

## Two defects found, one of them ours

**1. `enable_thinking` defaults to TRUE in llama.rn.** `getFormattedChat` does
`enable_thinking: params?.enable_thinking ?? true` and `jinja: params?.jinja ?? true`. Omitting the
parameter turns reasoning **on**. With it on and unconstrained, Qwen3.5 emits its reasoning at the
user — the distress probe returned "Here's a thinking process that leads to the suggested
response…" including speculation about depression and anxiety. Passing `enable_thinking: false`
removes this completely. **Any future adoption of a reasoning model must set this explicitly.**

**2. The production extraction grammar accepts a bare separator token as a complete value.**
Flagged for the coordinator; not fixed here, since this spike does not touch production files.

> `src/llm/extraction/task_extraction.v1.gbnf` —
> `title ::= "\"" jchar{1,80} "\""` is satisfied by the single token `","` (id 2129 on Qwen3.5):
> the quote opens the string, the comma is a legal `jchar`, the quote closes it. The result is
> schema-valid, passes `validateTaskExtraction` (which only checks `title.trim().length > 0`), and
> is useless. It hit 13–15 of 16 fixtures on the 2B.
>
> `description` has the identical shape and hole. `newTag`, `tool` and `date` share the pattern and
> should be audited — Bonsai's junk tags `":mixing"`, `":episode"`, `"work_on_it_until_did"` may be
> the same effect in milder form.
>
> **Fix that worked:** require the first character to be `[a-zA-Z0-9]`. A minimum length does *not*
> work — a 3-char minimum still produced `",Trash collection"`.
>
> Bonsai has never triggered this because it does not rank `","` first. That is luck, not safety:
> the defect is invisible until a model changes, and the validator cannot catch it because a comma
> is a legal JSON string. Confirmed by tokenizer probe and by A/B grammar variants (gate 2c).

## Corrections to the brief

- **§0's premise is wrong.** Qwen3.5 is not "the same architecture at a higher precision rung."
  Bonsai reports `qwen3` (dense attention); Qwen3.5 reports `qwen35`, which this build classifies
  as **hybrid** — `llm_arch_is_hybrid` → true, alongside `qwen3next` and `kimi-linear`. The GGUF
  header carries SSM parameters (`ssm.conv_kernel`, `ssm.state_size`, `ssm.group_count`) and
  `full_attention_interval: 4`, so ~18 of 24 blocks are state-space rather than attention. It also
  has an MTP head and is a vision-language model (`image-text-to-text`).
- **§4's Bonsai baseline had two wrong figures.** Size is 1.02 GiB, not "~1.7 GB". Steady
  throughput is 6.55–7.53 tok/s, not "~5.2". Both errors flattered the challenger.
- **§0's claim of a "standard llama.cpp LoRA-merge-and-quantize path" remains unverified** for a
  hybrid arch with an MTP head. It was not tested and should not be assumed.

## Gaps and limitations

- **Bonsai's 20-minute run is not in the machine record.** It was measured (burst 6.77, steady
  6.55, retention 97%, tailDrift −2.0%, SKIN `status=3`) but the capture was lost to logcat ring
  buffer rotation before the cause was found. The figures above come from the session transcript.
  Re-running gate 1/1L on Bonsai (~25 min) would close this.
- **16 fixtures is too small to resolve differences of a few points.** The confidence interval on
  16 binary outcomes is roughly ±12 points. The Bonsai-vs-Qwen gap (14 vs 8 and 5) is far larger
  than that and is safe; the 2B-vs-0.8B ordering and any future LoRA gain are **not** measurable at
  this sample size. Task 31's corpus is the prerequisite for measuring, not just for training.
- **Grammar overhead varies ±20% run to run** (seven samples: 1.16, 0.85, 0.82, 0.94, 0.87, 0.99,
  0.77). The honest statement is "no consistent penalty," not "free."
- **`energy` is wrong 6–13 times out of 16 on every model, including the incumbent.** When all
  three fail a field at that rate the likeliest cause is an ambiguous field definition rather than
  three weak models. Worth a spec review; a LoRA would paper over it rather than resolve it.
- **Peak RAM is host-side** (`dumpsys meminfo`), sampled before load, after load and at end of
  loop — not continuous. A transient peak between samples would be missed.

## Device state

Left clean per the brief: no model context loaded, app force-stopped, AP 43 °C and falling.
All three GGUFs remain in `/sdcard/Android/data/com.todoai/files/` (2.3 GB total) — kept
deliberately so the fallback is re-testable without re-downloading. Delete them if the space is
wanted; the phone was at 92% full before this spike began.
