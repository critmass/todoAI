# Task 6 Phase B Findings — the provider is confirmed on-device; two assumptions died

**Question:** Task 6 left Phase A as *built, unit-tested, believed correct, pending device
confirmation*. Phase B's job was to turn that into "confirmed" against the real 4B — and, above
all, to prove the startup grammar-validation guard (constraint #3) actually catches a
deliberately-broken grammar and falls back, rather than the app dying uncatchably mid-session.

**Verdict: GREEN. All four of the brief's Task 6 requirements hold on the S23 FE, driven through
the real `TernaryBonsaiProvider` + real `runConstrained` ladder + real `runStartupGuard` + real
`buildGrammarRegistry` — not a standalone spike.** The priority check passed: a broken grammar is
**caught** at startup, the grammar path is disabled, and the app survives. Two assumptions were
refuted along the way (§3, §4); both are logged here and the code adjusted, device wins.

**Date:** 2026-07-15/16 · **Device:** Samsung Galaxy S23 FE (serial `R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf`, SHA-256
`da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c` · **`llama.rn`:** 0.12.5

**Read first:** [`docs/briefs/opus_batch_B_device.md`](../briefs/opus_batch_B_device.md) (the work
order) and [`Q1c_findings_report.md`](Q1c_findings_report.md) (the arc this continues, and whose
Stage 2 seeded the retraction in §3).

---

## 1. The four requirements

| # | Brief requirement | Result | Evidence |
|---|---|---|---|
| 1 | A grammar-constrained, chat-templated call returns validated structured output | **PASS** | Real `task_extraction.v1` via `buildGrammar` → `runConstrained` → `validateTaskExtraction`: `OK (attempts=1)` — validated on the first attempt, no retry needed |
| 2 | Re-run task 5's Stage 2/3 through the real provider; overhead still ~3% | **PASS** | Stage 2: **4/4 valid JSON, 4/4 validator-passing**. Stage 3: unconstrained 5.79 tok/s vs constrained 5.78 → **1.00x** (Q1c measured 1.03x) |
| 3 | **Prove the startup guard catches a broken grammar and falls back** | **PASS** | See §2 — the priority check |
| 4 | Record thermal/health metrics | **PASS** | See §5 |

## 2. §3 — the priority check: the guard is earned (for catchable failures)

Two deliberately-broken grammars were registered, each run as the first action on a
**freshly force-stopped/relaunched app** (fresh native context, per the Q1b/Q1c discipline —
these checks induce compile failures and are exactly the poisoning-sensitive case):

| Probe | Break | App survived? | `grammarEnabled` | `attempted` | Caught failure |
|---|---|---|---|---|---|
| C2 | underscore in a rule name (`foo_str`) | **yes** (pid alive) | **false** | 5 | `summary — failed to parse grammar` |
| C2b | unbalanced syntax (`root ::= "a" (`) | **yes** (pid alive) | **false** | 5 | `summary — failed to parse grammar` |
| C1 (control) | none — the 4 real grammars | yes | **true** | 4 | none (0 failures) |

Both broken grammars were **caught**: `runStartupGuard`'s try/catch converted them into a
`GrammarCompileFailure`, disabled the grammar path, and left the app running — which is precisely
the constraint-#3 contract ("convert an uncatchable crash into a caught startup condition").
`attempted=5` also confirms the guard does **not** stop at the first failure: it tried the broken
entry *and* all four good ones in one pass, so a real startup would name every broken surface at
once.

**C3 — the fallback the guard falls back *to*** was exercised separately: an extraction with no
grammar (prompt-JSON + validation). The output **parsed but failed validation**
(`context_tags` came back a string, `duration_from_user` absent, `recurrence` invalid) — and the
app stayed functional, surfacing the validation error the D10 ladder is built to absorb rather
than crashing. That is the correct behavior, and it doubles as a sharp argument for why the
grammar path exists at all: unconstrained, this 4B does not reliably emit the schema.

## 3. Finding: the `#`-comment strip was never needed — RETRACTED

A Phase-B pass added a `#`-comment strip to the provider grammar path, on the inference that
Q1c's GREEN run had required one. The inference came from `Q1GrammarSpikeScreen.tsx`'s Stage 2,
which strips comments before compiling and carries the note: *"this real grammar is full of `#`
comments and is failing to parse ... a strip-before-use step belongs in task 6."* Phase A never
built that step, which looked like a real gap sitting in Task 6's path.

**Probe H refutes it.** Compiling the real substituted extraction grammar both ways, on a fresh
context:

| Variant | Size | Result |
|---|---|---|
| RAW (as authored, `#` comments included) | 4758 chars | **COMPILED** |
| STRIPPED (comments/blank lines removed) | 2081 chars | COMPILED |

**This build's GBNF parser accepts `#` line comments.** The Stage 2 strip was a leftover
hypothesis from the era when *underscore rule names* were breaking every grammar; the Q1c rename
(§4 of that report) fixed the real cause, and the comment theory was never re-tested afterwards —
it simply rode along and got mistaken for load-bearing. **This is the same confound shape as
Q1b's "rule name must match its JSON key" claim:** two variables changed at once, the wrong one
got the credit.

**The strip is reverted**, and not merely as dead weight — it carried a latent correctness
hazard. `buildGrammar` substitutes slot values into the grammar **as literals**, so a
hashtag-style context tag (`#home` — entirely plausible in a task app, and reachable through the
`newTag` escape) would have been silently truncated from `#` to end-of-line, corrupting the
grammar. A workaround for a bug that does not exist, guarding nothing, breaking something real.

Notes were left at each site (`ternaryBonsaiSupport.ts`, `ternaryBonsaiProvider.ts`) so it is not
re-added, and Stage 2's misleading comment in `Q1GrammarSpikeScreen.tsx` is now explicitly
retracted in place. Production sends grammar **as authored**.

**Re-verified after the revert** (not assumed — the revert changes what the parser receives):
Check A `OK (attempts=1)` at 8.32 tok/s, and C1 `grammarEnabled=true`, 4/4 compile. The latter
matters independently: probe H only proved the *extraction* grammar parses raw, while
`task_breakdown`, `coaching_resolution`, and `summary` also carry comments and had only ever been
compiled *with* the strip.

## 4. Finding: the underscore break is catchable — scope the guard's proof honestly

The brief describes the underscore rule name as "the known process-killer." **On this build it is
not.** It surfaced as a JS-visible, catchable `failed to parse grammar` (§2), which is why the
guard's try/catch handled it cleanly. Q1c's own data agrees in hindsight: its underscore probes
(Q1, Q4) *logged* FAIL results, which an uncatchable death cannot do. The genuine process death
in the original Q1 session was a **different** shape — candidate D's `due` sub-grammar.

So, precisely:

- **Proven:** the guard converts a *catchable* grammar-parse failure into a caught startup
  condition and falls back. This is the common case and it works.
- **Not proven:** that the guard contains a *truly uncatchable* process death. Against that, its
  defense was never the try/catch — it is the pre-session **timing** (the death happens at
  startup, not in front of a user mid-session). That failure mode could not be reproduced here;
  post-Q1c it may no longer exist on this grammar set. It remains unproven-by-absence, not
  disproven.

This does not weaken constraint #3 — "never first-parse a grammar in front of a user" still
stands on the Q1 observation, and the guard's timing is still the reason it holds. It just means
the C2 evidence supports the *catchable* half of the claim, and the docs should not over-read it.

## 5. §4 — thermal / health

| Metric | Value |
|---|---|
| Model load, cold | 2926 ms / 3157 ms |
| Model load, warm (OS page cache) | **677–787 ms** |
| tok/s, cold burst | **8.32** |
| tok/s, warm/steady | **5.78–5.79** |
| Constrained vs unconstrained | 5.78 vs 5.79 → **1.00x** |
| Prompt eval | ~13.5 tok/s (20.9 s for the Stage-2 prompt) |
| `activeTier()` | `4B` |
| `currentThermalHeadroom()` | `ok` — **but see below** |

Two health notes worth carrying:

- **The thermal sampler is still a stub.** `TernaryBonsaiProvider`'s default
  `thermalStatusSampler` returns 0 (NONE), so `currentThermalHeadroom()` is hardcoded-optimistic;
  the native PowerManager wiring (spec §3.5) is not built. The honest throttling signal today is
  the **8.32 → 5.78 tok/s drift** between a cold and a warm run, which tracks the orientation's
  documented "~39% peak→steady, plateauing not collapsing" envelope. Anything that *acts* on
  thermal headroom is currently acting on a constant.
- **Warm load is ~4x faster than cold** (page cache). Cold-start budgets should assume ~3 s, not
  the 0.7 s a second run suggests.

## 6. Carried forward to Task 7 (not Task 6 defects)

Live output from Check A, `simple-scheduled-01` ("I need to take out the trash" / "Yes, every
Tuesday") — **valid and validator-passing, but wrong**:

```json
{"title":"Take out the trash","estimated_duration_minutes":60,"duration_from_user":false,
 "due":null,"context_tags":["trash",":every_tuesday"],
 "tool_requirements":["trash can",":lack of trash",":access to trash",":time"],
 "importance_user":5,"recurrence":null}
```

- **`recurrence: null` despite an explicit "every Tuesday"** — should be
  `{"type":"scheduled","days":["tuesday"]}`. A one-off vs. scheduled error, i.e. exactly the
  `null`-vs-recurrence boundary the spec treats as load-bearing.
- **Junk `:`-prefixed array elements** (`":every_tuesday"`, `":time"`, `":lack of trash"`) — the
  same class Q1c saw (`"],"`), now with a colon flavor, in both `context_tags` and
  `tool_requirements`.
- `estimated_duration_minutes: 60` for taking out the trash is a poor guess (flagged
  `duration_from_user:false`, so legal — but it feeds scoring).

These are **prompt-quality**, not provider or grammar defects: the grammar constrained the shape
correctly and the validator passed it. They are Task 7's opening targets, and they confirm the
brief's premise that *valid* is already solved while *correct* is not.

## 7. One-line call

**GREEN** — the provider, the D10 ladder, and the startup guard are confirmed on-device; grammar
overhead is nil (1.00x); the guard catches broken grammars and falls back with the app alive.
**Task 6 is complete.** Two assumptions were refuted and corrected (the comment strip, the
"uncatchable" underscore), which is the phase working as intended.

## 8. Reproduction

- Harness: [`src/dev/Task6DeviceScreen.tsx`](../../src/dev/Task6DeviceScreen.tsx) — the default
  screen in `App.tsx`'s switcher ("Task 6"). Drives the real provider/ladder/guard/registry.
  Buttons: `H` hygiene, `A` provider works, `B` Stage 2/3, `C1`/`C2`/`C2b` guard, `C3` fallback,
  `Health`.
- JS-only change: `npm start` + relaunch is enough; no native rebuild. Model at
  `/sdcard/Android/data/com.todoai/files/` (`README_build.md`).
- Results are logged as tagged, chunked `[T6RESULT:*]` lines (logcat truncates long lines) —
  capture with `adb logcat -s ReactNativeJS:*`. Same convention as the Q1 harness; note the
  Windows `\r\n` caveat in Q1c §8 if reassembling.
- **Fresh-context discipline matters for H/C2/C2b specifically** — they induce compile failures,
  the poisoning-sensitive case. Force-stop and relaunch before each:
  `adb shell am force-stop com.todoai && adb shell am start -n com.todoai/.MainActivity`.
  A/B/C1/C3 use only good grammars and safely share one session.
- Driven end-to-end over `adb` (`input tap` + `logcat`), the same way Q1c's §3/§4 probes were.
