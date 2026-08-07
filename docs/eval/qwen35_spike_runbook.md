# Model-base spike — runbook for the full pass

**Written 2026-08-03, for the next session.** Everything below is committed and validated
(typecheck, lint, unit tests, and smoke tests of the join and merge logic). Nothing here has been
run end-to-end on the device yet — that is tomorrow's job.

## Before starting

1. **Charge the phone to ~80%+ on a real charger, and run it from that charger.** Sustained
   decode drew ~1700 mA while nominally charging on a PC USB port, so the phone discharged
   through the whole run. The lower half of the battery both drains faster and runs hotter, which
   contaminated the 20-minute run: part of its 58 °C AP reading is discharge heating, not decode.
2. **Turn on Developer options → "Stay awake"** (or set screen timeout to 30 min). The runner
   sends `KEYCODE_WAKEUP` every 30 s, but that wakes the display without resetting Android's
   screen-off timer, so the screen visibly blinks on and off during long runs. A dark screen also
   runs cooler, which perturbs the thermal curve. This is the one manual step; the runner does
   not change device settings itself.
3. Confirm both Qwen GGUFs are in `%USERPROFILE%\Downloads` (they are, as of tonight) — the
   runner pushes whatever the device is missing.
4. Metro must be running: `npm start`.
5. **Reload the app after any harness edit.** Metro's Fast Refresh connection dies during a
   sustained decode loop (the JS thread stops answering its heartbeat), and every later edit then
   silently fails to reach the running app. This cost two manifest edits on day one — the results
   carried a stale run note that claimed conditions that were not true. Force-stop and relaunch,
   then confirm the change is visible on screen before trusting it.

## Running it

```powershell
.\scripts\run-model-base-spike.ps1
```

That pushes any missing model, verifies each hash on-device, starts the thermal sampler, and for
each of `bonsai4b`, `qwen2b`, `qwen08b`: cools to AP ≤ 40 °C with SKIN throttling clear, opens the
harness, selects the model, taps **RUN FULL SUITE**, and waits.

Useful variants:

```powershell
.\scripts\run-model-base-spike.ps1 -Models qwen08b        # one model
.\scripts\run-model-base-spike.ps1 -SkipPush              # models already pushed
.\scripts\run-model-base-spike.ps1 -CoolToApC 38          # stricter thermal parity
```

Budget roughly **30 min per model plus cooldown — about 2 hours for all three.**

## What the suite does per model

Order is deliberate. Quality gates run *before* the thermal ones, because Gate 1L leaves the phone
in sustained severe throttling and extraction timings taken in that state measure the governor
rather than the model.

| Step | What it answers |
|---|---|
| Gate 0a | header reads; does this build recognise the arch |
| Gate 0b | model loads; load time |
| Gate 2a | GBNF constrained decoding works; grammar overhead vs unconstrained |
| Gate 2b | 16 real fixtures scored; distress transcript logged verbatim |
| Gate 1 | 4.5-min sustained decode (comparable to day-one numbers) |
| Gate 1L | 20-min sustained decode; `tailDrift` says whether it floored |
| release | frees the context so the next model starts from a clean heap |

If Gate 0b fails the suite aborts for that model and records it. A no is a complete answer.

## Afterwards

The runner already reassembles and joins. Results land in
`docs/eval/qwen35_spike_results.json`, with each decode sample annotated:

```json
"thermal": { "apC": 58.0, "skinC": 45.4, "skinStatus": 3, "batteryLevel": 32 }
```

and a `thermalSummary` per run (peak AP, peak SKIN, worst throttling status, battery drop).
`skinStatus` 3 is `THROTTLING_SEVERE` — that is the envelope signal.

Raw thermal readings are kept separately in `docs/eval/qwen35_spike_thermals_<stamp>.jsonl`.

## What is still open going in

- **Bonsai's 20-minute behaviour is unmeasured.** Its 4.5-minute curve plateaued (last eight
  samples inside 0.29 tok/s), but "flat for two minutes" is not "flat for twenty." The suite now
  runs Gate 1L on Bonsai too, which closes this.
- **The 0.8B is entirely unmeasured.** It is the rung the brief expects to win, and its footprint
  cannot be estimated by scaling the 2B's — hybrid models carry a recurrent state alongside the
  KV cache, and the 2B cost 1.70–1.85× its file size resident against Bonsai's 1.30×.
- **Gate 2 has never been run on any model, including Bonsai.** There is no same-build extraction
  baseline yet, so the first pass produces the comparison, not a regression check.
- **The `<think>` question is untested.** Qwen3.5's chat template pre-fills an empty
  `<think>\n\n</think>` block into the *prompt* when `enable_thinking` is not set, so generation
  should start after it and a JSON grammar should be unaffected. That is a reading of the
  template, not a measurement — Gate 2a is what settles it. If `enable_thinking` ever gets turned
  on, the model would emit reasoning before the JSON and the grammar would fight it.
- **Day-one results `r0`–`r8` carry a stale run note.** See
  `docs/eval/qwen35_spike_run_conditions.md` for what those runs were actually taken under.

## Where things stood before this pass

Gates 0 and 1 only, day one, and two of the brief's three baseline figures were wrong.

| | Bonsai-4B TQ1_0 | Qwen3.5-2B Q4_K_M |
|---|---|---|
| Arch | `qwen3` | `qwen35` (hybrid, SSM + attention, MTP head) |
| Size | 1.02 GiB | 1.19 GiB |
| Load | 2,906 ms | 3,128–5,422 ms |
| RAM delta | +1.32 GiB (1.30×) | +2.02–2.19 GiB (1.70–1.85×) |
| Burst | 9.92 | 16.11–16.36 |
| 4.5-min steady | 7.53 | 11.74–11.89 |
| 20-min steady | not measured | 10.03 |
| Floors? | yes, ~7.5 | **no** — `tailDrift` −4.5% at 20 min |

The 2B's advantage decays with session length: 2.17× at burst, 1.56× at 4.5 min, 1.33× at 20 min,
1.24× on final samples — and it was still falling while Bonsai's floor held. It drives the phone
into `THROTTLING_SEVERE` and holds it there.
