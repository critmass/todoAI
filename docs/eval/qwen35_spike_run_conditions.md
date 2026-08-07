# Model-base spike — actual run conditions per result tag

**2026-08-03.** Companion to `docs/eval/qwen35_spike_results.json`. Read this before trusting
the `runNote` field embedded in any result tag `r0`–`r8`.

## Why this file exists

Every result in `qwen35_spike_results.json` carries a `runNote` string from the harness manifest
(`src/dev/ModelBaseSpikeScreen.tsx`). The intent was that this string be updated before each run
so the manifest travels with the numbers — strategy §6.6, "a number without its manifest is a
rumor."

That failed. **Tags `r0`–`r8` all carry the same, earliest version of the string** — *"phone idle
and cool at the start of the run"* — regardless of what the source file said at the time.

The cause: Metro's Fast Refresh connection to the device dies during a sustained decode loop. The
JS thread is saturated running back-to-back `completion()` calls and stops answering Metro's
heartbeat, so Metro terminates the connection:

```
ERROR  [timeout] connection terminated with Device for app='com.todoai'
       on device='SM-S711U - 16 - API 36' after not responding for 60 seconds.
```

From that point the app keeps executing the bundle it already had. Saving the file changed the
source and passed typecheck and lint, but never reached the running app. Two separate manifest
edits were lost this way before it was noticed.

**The embedded `runNote` values in `r0`–`r8` are stale. They are not evidence of the conditions
those runs were taken under.** The numbers themselves are unaffected — throughput, memory, and
load timings were measured by the device and logged correctly. Only the manifest text is wrong.

The results JSON has deliberately **not** been edited to correct the strings. It is the device's
own captured output; rewriting it would make a false record look authentic. This file is the
correction instead.

## What each run was actually taken under

Common to all: Samsung Galaxy S23 FE (`SM-S711U`), `llama.rn` 0.12.5 stock prebuilt, debug build
installed over the personal release install, `n_ctx` 2048, 4 threads, `n_gpu_layers` 0, greedy
(temp 0, top_k 1), USB-connected throughout. Sustained loops are 128 `n_predict` per iteration.

| Tag | Model | Gate | Case | Start temp | End temp | Notes |
|---|---|---|---|---|---|---|
| `r0` | Qwen3.5-2B Q4_K_M | 0a header | **on** | 30.8 °C | — | |
| `r1` | Qwen3.5-2B Q4_K_M | 0b load | **on** | 30.8 °C | — | 4163 ms |
| `r2` | Qwen3.5-2B Q4_K_M | 1 (4.5 min) | **on** | 31.0 °C | 39.6 °C | still declining at cutoff |
| `r3` | Bonsai-4B TQ1_0 | 0a header | off | 31.1 °C | — | |
| `r4` | Bonsai-4B TQ1_0 | 0b load | off | 31.1 °C | — | 2906 ms |
| `r5` | Bonsai-4B TQ1_0 | 1 (4.5 min) | off | 31.1 °C | 39.4 °C | plateaus; last 8 samples span 0.29 tok/s |
| `r6` | Qwen3.5-2B Q4_K_M | 0a header | off | 29.2 °C | — | |
| `r7` | Qwen3.5-2B Q4_K_M | 0b load | off | 29.2 °C | — | 5422 ms |
| `r8` | Qwen3.5-2B Q4_K_M | 1 (4.5 min) | off | 29.2 °C | 37.1 °C | re-run of `r2` without the case |

Tags from `r9` onward carry an accurate `runNote` and do not need this table.

## Known asymmetries in the comparison

Stated so nobody reads the verdict table as cleaner than it is.

- **`r2` was taken with a phone case on; `r5` and `r8` without.** This was caught mid-session and
  `r8` re-ran `r2` caseless to check it. The case turned out not to matter for throughput
  (burst 16.34 → 16.36, steady 11.89 → 11.74, retention 73% → 72%); it cost about 0.7 °C of
  temperature rise (+8.6 °C cased vs +7.9 °C caseless).
- **`r8` started 1.9 °C cooler than `r5`** (29.2 °C vs 31.1 °C). The intended cooldown target was
  31.3 °C, but the phone's screen locked during the wait and it kept cooling while it was being
  woken. This biases in favour of the 2B, and it still came out marginally lower than `r2`.
- **Memory readings are host-side** (`adb shell dumpsys meminfo com.todoai`), taken before load,
  after load, and at end of loop. There is no filesystem/proc native module in this project, so
  peak RAM cannot be sampled from JS.
- **Load times vary run to run** — the same model and file measured 4163 ms (`r1`), 5422 ms
  (`r7`), and 4450 ms on a third load. Treat any single load figure as one sample.

## Corrections to earlier records in this session

- The commit message on `6e5a96f` states *"Run note now records that the phone is out of its case
  and that the first 2B run was taken with the case on."* **This is not true of the captured
  data.** The source file recorded it; the running app never picked the change up, so `r5` — the
  Bonsai baseline committed in that same commit — carries the stale note like everything else.
  The commit is left as written rather than rewritten; this entry is the correction.
- Two figures in `docs/briefs/model_base_spike_qwen35.md` §4 are wrong, measured against the
  actual device: Bonsai-4B TQ1_0 is **1,091,638,048 B (1.02 GiB)**, not "~1.7 GB", and its steady
  throughput is **7.53 tok/s** (9.92 cold burst), not "~5.2". Both errors flattered the
  challenger. Per the project's convention the brief is not edited; this is the correction.
