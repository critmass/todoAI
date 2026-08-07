# Model-base spike — Qwen3.5-2B / 0.8B at Q4 vs Bonsai-4B TQ1_0

*A throwaway de-risk in the spirit of the Q1 grammar arc. Two device runs, one session. The question is not "switch models" — it's "**is there a smaller-or-equal-footprint point on this same architecture's precision ladder that we could put a LoRA on**." Read this whole preamble before running; the framing changed once we learned what Bonsai actually is.*

---

## 0. The reframe that makes this worth doing (and cheap)

**Bonsai is a quantization of Qwen.** The `prism-ml/Ternary-Bonsai-8B-gguf` model card lists its architecture as `qwen3`; the newer Bonsai-27B is explicitly a 1-bit/ternary compression of Qwen3.6-27B, "architecture unchanged." So our on-device 4B and a stock Qwen3.5-2B/0.8B are **the same architecture family at different precision points** — a ladder:

```
FP16 Qwen base  →  Q4_K_M  →  ternary (TQ1_0, what we run)  →  1-bit
```

Three consequences that shrink this spike:

1. **Gate 0 (does it even load) is very likely a PASS, not a hope.** Same arch family → same `llama.rn` chat template → same GBNF path. We are not testing a novel architecture; we're testing a different rung. (Still *confirm* it — see Gate 0 — but expect green.)
2. **The real axis is footprint inside the S23 FE's thermal-and-memory envelope**, not "is it a good model." Heat is our binding constraint (orientation §1). A higher-precision but bigger model can be *worse* for us even at equal quality.
3. **This is a LoRA-base scouting mission.** Our settled decision is no-LoRA (constraint #7). This spike does **not** overturn that. It answers a prerequisite question: *if we ever wanted a LoRA future, is there a servable base for it?* Bonsai's ternary format has no off-the-shelf LoRA→re-quantize path (that's PrismML's proprietary pipeline, the parked Stage-B fork). A **Q4** Qwen does — standard llama.cpp LoRA-merge-and-quantize. So a Q4 rung that fits the envelope is the only thing that makes the LoRA question real.

## 1. The syllogism this is testing (stated honestly)

Jason's reasoning: *if Qwen3.5-2B base ≈ Bonsai-4B base at Q4, then Qwen+LoRA would beat Bonsai.* **True** — a targeted LoRA on a narrow task (structured extraction + a bounded coaching register) reliably beats the un-adapted base, and Bonsai has no comparable adapter path. The spike's job is to find out **whether the equal-or-better base is servable inside the envelope**, because the syllogism's payoff is only real if the LoRA-adapted model still loads and runs grammar-constrained on the phone. That means the deliverable is a **footprint × thermal × quality** verdict, and the **0.8B is the model most likely to win** — a 0.8B at Q4 (~500–700 MB) is comparable to or *smaller* than our TQ1_0 4B and much cooler, while a 2B at Q4 (~1.5–1.8 GB) is bigger and hotter and is really the *quality-ceiling* probe.

## 2. Gates (fail fast, cheap)

Run each model through these in order. Stop at the first hard fail and record it — a no is a complete answer.

**Gate 0 — GGUF exists + loads on our pinned stock `llama.rn`.** Confirm a Q4_K_M (or Q4_K_S) GGUF is published for the size, push it to `/sdcard/Android/data/com.todoai/files/`, and load via the existing harness. Check `loadLlamaModelInfo` on the header first (isolates "arch unsupported" from "loads but misbehaves"). *Expected: pass, same arch family. If it fails, the finding is "our pinned llama.cpp build predates Qwen3.5 support — needs a `llama.rn` bump or the fork," which is real and worth knowing.*

**Gate 1 — footprint in the envelope (the primary axis).** Model size on disk; load time; **peak resident memory** on the 8 GB S23 FE (iOS-style "half of physical" isn't our limit but headroom still matters); tok/s **burst and steady-state** over ≥4 min sustained; **thermal behavior** — does it plateau like the 4B TQ1_0 did (~5.2 tok/s steady, held flat) or collapse? A model that's hotter/slower than our current 4B at equal quality is a *regression* for us, full stop.

**Gate 2 — the two things our app actually needs.**
- **(a) GBNF grammar-constrained decoding** works through `llama.rn` on this model — run one real extraction grammar from task 5. Our entire structured-output strategy (D-series) depends on this; if constrained decoding misbehaves on this rung, it's disqualifying regardless of raw quality.
- **(b) Extraction quality + hallucination sanity** on the real fixtures (`docs/eval/extraction_fixtures_seed.jsonl`) plus one distress transcript. Published benchmarks flag **high hallucination rates on the Qwen3.5 small models**, and our two most exposed paths are extraction and coaching-in-distress. This is where the 0.8B is most at risk: its reasoning index (~9) is well below the 2B (~16), and our 4B was already borderline on distress detection (which is *why* the crisis gate is deterministic and app-side). A model that runs beautifully but extracts unreliably is a no.

## 3. Method discipline (non-negotiable)

- **Reuse the Q1 harness.** This is a standalone measurement behind the existing `LLMProvider` seam — **do not wire anything into the app**, do not touch the provider, do not integrate. Same discipline as the grammar smoke-test arc.
- **Same harness, swap the file** for 2B vs 0.8B, so the two runs are comparable and setup cost is paid once.
- **Measure against the baseline we already have:** Bonsai-4B TQ1_0 — loads, ~5.2 tok/s steady, grammar green at ~0% overhead, extraction quality as last measured. Every number is *relative to that*.
- **Leave the device clean** (task 24's discipline): remove pushed GGUFs you don't intend to keep, note anything left.

## 4. The verdict table is the deliverable

The whole point is to replace "Qwen benchmarks look good" with "here's what runs on *our* phone." End with a three-way table:

| | Bonsai-4B TQ1_0 (baseline) | Qwen3.5-2B Q4 | Qwen3.5-0.8B Q4 |
|---|---|---|---|
| Loads on stock `llama.rn` | ✅ | ? | ? |
| Size on disk | ~1.7 GB | ? | ? |
| Peak RAM | (measured) | ? | ? |
| Load time | 1–4 s | ? | ? |
| Steady tok/s | ~5.2 | ? | ? |
| Thermal (plateau vs collapse) | plateau | ? | ? |
| GBNF works | ✅ ~0% overhead | ? | ? |
| Extraction quality | (baseline) | ? | ? |
| Hallucination sanity | (baseline) | ? | ? |

## 5. The decision rule (so the result routes correctly — "equal" has a specific meaning)

- **A Q4 rung is ≈-or-better on quality AND fits the envelope (0.8B is the hope):** this is a servable LoRA base. The follow-on is **migrate the base behind `LLMProvider` (cheap — we built for it), then prioritize task 31 (the corpus), then LoRA when the corpus exists and alpha has told us which axis to train.** Do NOT jump to training a LoRA on spike day — no corpus exists yet, and the base migration de-risks the adapter path first.
- **Only the 2B-Q4 is good enough, and it's too hot/big:** the choice becomes "live on Bonsai-ternary" vs "commit to the PrismML fork (Stage B) to LoRA-and-ternary-quantize properly." A bigger, now-*known* decision.
- **Everything roughly equal to Bonsai and Bonsai's already in the envelope:** **stay on Bonsai.** Equal-on-quality is a reason not to switch, not a reason to. The finding "the model is not our bottleneck" is itself valuable — it points effort at the scaffolding, the coaching prompts, task 17, and task 31 instead. Note Qwen3.5-Q4 as a validated *fallback* if Bonsai ever becomes a problem (abandoned repack, a `llama.rn` bump that breaks TQ1_0), and move on.

**The trap to avoid:** "equal base ⟹ LoRA better" is true but it's a reason to *migrate + build the corpus*, not to train an adapter now. Each step de-risks the next: spike → migrate → corpus → LoRA. Don't collapse it.

## 6. Definition of done

- Both models run through all four gates on the S23 FE (or fail with a recorded reason).
- The §4 verdict table filled with real device numbers.
- A one-paragraph recommendation keyed to the §5 decision rule — which of the three outcomes we're in, and the concrete next move.
- Device left clean.
- Written to `docs/eval/qwen35_spike_findings.md`.
