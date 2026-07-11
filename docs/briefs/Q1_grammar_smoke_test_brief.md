# Sonnet Brief — Eval Q1: Does grammar-constrained decoding work on this stack?

---

## ⚠ SESSION HANDOFF v2 (read this first)

**Everything below this box is the original brief, unchanged.** This box is a live status
update, now updated by a second session that confirmed (and overturned) the first session's
open item. Delete this box once Q1 is fully closed out. Full machine-readable findings:
`docs/eval/q1_results.json`.

**TL;DR:** The `{m,n}`-expansion fix from the first session **does not work** — confirmed live
on-device, at three granularities (full grammar, a 2-rule fragment, duration alone), all
failing identically to the unfixed grammar (`Error: failed to parse grammar`, parse-time). A
second round of live bisection then fully root-caused it: **it was never about `{m,n}`, nesting
depth, or inline-vs-named character classes** (all three individually tested and refuted
on-device this session). The actual trigger is narrower and stranger: **a mandatory character
class immediately followed by an optional/repeated character-class-derived continuation**
(`[1-9] [0-9]{0,3}` and every hand-expansion of it) fails to parse, regardless of how that
optionality is spelled — while the same character classes with no optionality at all
(`[1-9] [0-9]`), and optional/nested groups built purely from string literals, both parse and
generate correctly. This is not task_extraction-specific: task 5's `boundedIntRule` primitive
generates exactly this shape for every bounded integer field across all four schemas (duration,
`days_int`, `quota_int`, `target_int`, etc.). Everything is committed on `main`; nothing lost.

### What's confirmed, on real hardware (not simulated)

- **Model loads fine.** `Ternary-Bonsai-4B-TQ1_0.gguf` (already pushed to
  `/sdcard/Android/data/com.todoai/files/` on the device) loads in ~0.8s warm / ~2.6s cold —
  matches the spike's documented 1–4s range. Header check (`loadLlamaModelInfo`) also passes;
  it's a Qwen3-architecture base, 4B, per its GGUF metadata.
- **Stage 0 PASSES.** `root ::= "yes" | "no"` correctly constrained output to exactly `"no"`.
  `llama.rn`'s `completion()` accepts and applies a `grammar` param — the fundamental Q1
  question is answered yes.
- **Stage 1 PASSES as-authored.** A bounded string micro-grammar (`jchar{1,20}`, i.e. `{m,n}`
  applied to a *named rule*) worked first try, producing `"Short and sweet!"`. No expander
  fallback needed for this specific pattern.
- **Stage 2 FAILS — root cause isolated.** Instantiating the real
  `task_extraction.v1.gbnf` via `buildGrammar` and running it against any of the 4 picked seed
  fixtures throws `Error: failed to parse grammar` immediately (parse-time, not generation-time
  — fails in <20ms after model load, before any tokens are produced). Live bisection (see
  `runBisect` in `src/dev/Q1GrammarSpikeScreen.tsx`) narrowed it precisely:
  - `title` alone: **PASS**
  - `title + description`: **PASS**
  - `title + estimated_duration_minutes` (which is `[1-9] [0-9]{0,3}`) : **FAIL**

  The difference from Stage 1's passing case: Stage 1 applied `{m,n}` to a **named rule**
  (`jchar{1,20}`); this applies it directly to an **inline character class** (`[0-9]{0,3}`).
  That looks like the actual boundary of what this `llama.cpp` build's GBNF parser accepts.
  Reproduced 3 times identically.

- **A more severe, separate finding: this failure mode is not always safely catchable.**
  Bisection candidate D (`due`, which also contains an un-expanded `[0-9]{0,2}` in
  `days_int`) doesn't throw a catchable JS error like the duration case did — it **kills the
  entire app process** (confirmed 3 times: `adb shell ps` shows the process gone entirely,
  no Java-level FATAL/AndroidRuntime crash log, no native tombstone found in the searches run
  so far — genuinely unclear yet whether this is a native crash in llama.cpp's grammar
  parser or something else). **This is worth its own line in the eventual Q1 report.** Note:
  this session's `fixonly` run (full grammar, fully expanded, includes the same `due` field)
  did **not** crash — it failed with a normal catchable JS error instead. Not re-tested enough
  to call the crash non-reproducible, just noting the one data point.

### The fix — confirmed NOT to work, root cause fully characterized (this session)

`expandAllBoundedRepetitionOccurrences()` in `Q1GrammarSpikeScreen.tsx` (task 5's
`boundedRepetition.ts` generalized to also catch bracket-expression and parenthesized-group
forms) was tested live on-device at three granularities — full grammar (`fixonly`), a 2-rule
`title`+`duration` fragment (`smallfragment`), and `duration` alone (`durationonly`) — **all
three fail identically to the unfixed grammar**, ruling out aggregate grammar size and
`title`'s exceptional 79-level nesting as explanations.

A second round of minimal, targeted probes then isolated the actual trigger (all in
`Q1GrammarSpikeScreen.tsx`, all logged in `docs/eval/q1_results.json`):

| Probe | Grammar | Result |
|---|---|---|
| `nameddigit` | `[1-9] (digit (digit (digit)?)?)?`, `digit ::= [0-9]` | **FAIL** — naming the class first doesn't help |
| `bareoptional` | `"a" ("b")?` | **PASS** — single-level optional groups work |
| `nestedliterals` | `"a" ("b" ("c" ("d")?)?)?` | **PASS** — same 3-level nesting as the failing duration case, but pure literals |
| `zerominhypothesis` | `"x" [0-9]{4}` and `"x" [0-9]{0,4}` | **both PASS** — a lone character class, zero-min or not, is fine |
| `adjacentclasses` | `[1-9] [0-9]` (no repetition at all) | **PASS** — mandatory adjacent classes are fine |

**Conclusion:** none of {m,n}, nesting depth, zero-minimum repetition, or inline-vs-named
character classes is the trigger in isolation — each was directly tested and refuted. The
actual failure shape is a **mandatory character class immediately followed by an
optional/repeated character-class-derived continuation**, independent of how that optionality
is expressed. This is the exact shape of `boundedIntRule` (`src/llm/grammar/primitives.ts`),
used for every bounded-integer field in all four of task 5's schemas — not just
`estimated_duration_minutes`.

**This spike stops diagnosis here, per its own scope** ("any change to task 5's grammars... a
finding to report, not a license to rewrite task 5"). No working grammar shape for bounded
integers was found within Q1's scope — that redesign, if wanted, is task 5/6 work, not this
spike's.

**Remaining open steps** (not done — need Jason + a design conversation, not more solo
device iteration):
1. Read `docs/eval/q1_results.json` and this box together and reach a GREEN/YELLOW/RED verdict
   per the rubric below. Given no working bounded-integer grammar shape exists yet, this is
   very likely **RED for §3.3 as currently designed** — not "YELLOW, flip on the expander,"
   since the expander doesn't fix it. The fallback conversation (prompt-JSON + strict
   validation + retry) or a redesigned integer-field grammar shape (e.g. alternation of
   fixed-width branches instead of optional trailing digits — untested, a hypothesis only)
   needs to happen before tasks 6/7/12 build further on the grammar path.
2. Stage 2 (real fixture pass/fail + validator numbers) and Stage 3 (overhead) were **never
   run for real** — there's no working grammar to run them against yet. If a redesigned
   integer shape is found and confirmed, `runStage2`/`runStage3` (still using the *original*
   unexpanded grammar) need updating and a real run.
3. Once the path forward is decided: delete the diagnostic-only functions/buttons
   (`runBisect`, `runTestFixOnly`, `expandAllBoundedRepetitionOccurrences`, and the 7 probe
   functions added this session) — none of them are part of the four real stages, and the
   brief says to keep this harness small.

### Resuming — environment state & gotchas hit this session

- **Device:** Samsung Galaxy S23 FE, serial `R5CWC240D5H`, connected via USB, authorized.
  Check with `adb devices -l`.
- **Model:** already pushed to `/sdcard/Android/data/com.todoai/files/Ternary-Bonsai-4B-TQ1_0.gguf`
  (confirmed present, correct size, 1091638048 bytes).
- **App:** installed (`com.todoai`), built successfully once already this session (Gradle,
  not `react-native run-android` — see gotcha below).
- **⚠ Run `adb`/build commands from PowerShell, not Git Bash.** Git Bash (MSYS) mangles
  device-side absolute paths (`/sdcard/...`) into bogus Windows paths (`C:/Program
  Files/Git/sdcard/...`) for `adb push`, `adb shell uiautomator dump`, and similar — this bit
  `adb push` (silently pushed to the wrong place) and `uiautomator dump` (silently dumped
  nowhere useful) this session. It also broke `gradlew.bat` when invoked indirectly through
  `react-native run-android`'s CLI wrapper — that wrapper appears to have a Windows
  `child_process.spawn()` bug independent of the path-mangling issue. **Workaround used all
  session: build via `cd android && ./gradlew.bat installDebug` directly (PowerShell), run
  Metro via `npx react-native start` separately, don't use `npm run android`.**
- **⚠ Metro can silently die on a long session.** At one point Metro's process had exited
  with no crash message visible in the captured output, leaving the dev-server port
  orphaned. Symptom: every bundle request in the Metro log shows `0%` and immediately resets;
  the app shows "Unable to load script." Diagnose with `netstat -ano | Select-String ":8081"`
  — if it shows `SYN_SENT` (not `LISTENING`/`ESTABLISHED`), nothing is actually listening.
  Fix: kill and restart Metro fresh (`npx react-native start --reset-cache`), then
  `adb reverse tcp:8081 tcp:8081` again (reverse forwards don't survive an adb server
  restart), then relaunch the app.
- **⚠ The app can get killed while backgrounded.** It holds ~1GB+ of model memory once
  loaded; if it loses foreground (phone call UI, home button, Samsung's aggressive
  "sleeping apps" battery management), the OS may kill the process outright. Check
  `adb shell dumpsys activity activities | grep topResumedActivity` and
  `adb shell "ps -A | grep todoai"` before assuming a result is a real crash vs. an
  environmental kill — this session saw both, and they look identical from logcat alone.
- **UI interaction:** no accessibility-label-based tooling was available for this native
  screen (unlike a browser), so all interaction was screenshot + `adb shell input tap x y`,
  with coordinates estimated from screenshots (a `~1.17×` scale factor between the displayed
  and actual 1080×2340 image worked reliably for buttons well within the screen). Button
  coordinates shift whenever the button list changes — **always re-screenshot before tapping**,
  don't reuse coordinates from earlier. **New gotcha this session:** buttons near the very
  bottom of a long list land in/near the OS gesture-navigation zone (roughly the bottom ~150px
  of actual screen height) — a tap there can background the app via a system gesture instead
  of hitting the button (happened once; recovered cleanly with
  `adb shell am start -n com.todoai/.MainActivity`, same PID, no state lost). Scroll the list up
  first (`adb shell input swipe <x> <low-y> <x> <high-y> 500`, ~500ms+ duration — short/fast
  swipes were observed to sometimes not register as a scroll at all) so the target button sits
  well above that zone before tapping.
- **Results capture:** no filesystem-write library was added (deliberate — flagged to Jason,
  he agreed to skip it). `logResultJson()` logs tagged, chunked JSON via `console.log`;
  `scripts/q1-reassemble.js` (added this session) reconstructs a full `adb logcat -d` dump back
  into one JSON file — but only if logcat isn't cleared between runs. This session cleared
  logcat before each probe (needed to isolate each result), so `docs/eval/q1_results.json`
  was compiled by hand from each probe's individually-captured output instead; the script is
  still the right tool for an uninterrupted multi-stage run (e.g. a real Stage 2 over all 4
  fixtures in one sitting).
- **Git state:** all code changes are committed on `main` — manifest capture, the reassembly
  script, and the bisection probes are each their own commit. Nothing uncommitted, nothing at
  risk.

---

**For:** a Sonnet coding session (Claude Code) in the todoAI repo, run as a **live loop with Jason** — Sonnet writes the harness, Jason runs it on the S23 FE and reports numbers, together you interpret.
**Binding authority:** `docs/briefs/structured_output_strategy_task_4.md` §6.6–§6.7 (Q1 is defined there). Spike context: the original findings doc (chat-template requirement, storage path, ~5.2 tok/s CPU baseline). Toolchain + gotchas: `README_build.md`.
**Prereqs (all met):** task 5 shipped `src/llm/extraction/task_extraction.v1.gbnf` (a template), `buildGrammar`, and the extraction validator; the `BonsaiSpikeScreen` harness already loads the 4B and calls `completion()`; `docs/eval/extraction_fixtures_seed.jsonl` exists.

This is a **throwaway/dev spike, not production code.** It does **not** need task 6 (the provider), and building it must not wait for it. It reuses the existing spike-screen loading path and adds a `grammar` param to the call.

---

## Why this is the pivotal measurement

Fable's entire §3.3 structured-output strategy — grammars, bounded fields, greedy decoding, the whole reliability story — rests on one untested assumption: that GBNF constrained decoding actually works on `llama.rn` 0.12.5 + the 4B/TQ1_0, on-device. The spike proved the model produces *coherent, syntactically-valid JSON when chat-templated* — but with **no grammar applied**, and with **inconsistent shape** across prompts. That's the gap grammars are supposed to close, and nobody has fired one yet.

If Q1 passes, §3.3 stands and tasks 6/7/12 build on solid ground. **If Q1 fails** (grammars error, or output is still invalid, or the overhead is crippling), the whole approach falls back to a different, worse world — prompt-JSON + strict validation + retry, with no hard constraint — and we need to know that *now*, before Opus builds a batch that leans on it. This is the §3.3 equivalent of what the original loading spike was for §3.1: one cheap measurement that de-risks everything after it.

---

## The four questions Q1 must answer (from strategy §6.7)

1. **Do grammars work at all?** Does `llama.rn`'s `completion()` accept a `grammar` param and actually constrain output, without erroring or crashing?
2. **Does the real extraction grammar work?** Does `task_extraction.v1.gbnf` (instantiated from its template) load, compile, and produce **valid, correctly-shaped JSON** that passes task 5's validator?
3. **What's the overhead?** Grammar-compile time, and constrained vs. unconstrained tok/s on the same prompt.
4. **Is bounded `{m,n}` repetition supported?** Or must task 5's `boundedRepetition.ts` expander be switched on?

---

## Division of labor

- **Sonnet builds:** a dev-only screen/harness (`Q1GrammarSpikeScreen.tsx`, spiritual successor to `BonsaiSpikeScreen`) that runs the protocol below and writes a results JSON to the app files dir. Sonnet cannot run it — no device.
- **Jason runs:** builds to the S23 FE, pushes the model, runs each stage, reads the on-screen/results output, `adb pull`s the results file, pastes numbers back.
- **Together:** read the numbers against the decision bands and decide green/yellow/red.

---

## What Sonnet builds — the harness

Reuse `BonsaiSpikeScreen`'s model-load path verbatim (same model file, the `messages` API with the chat template — **non-negotiable**, per the spike; a grammar cannot rescue un-templated output). Add a `grammar` argument to the completion call. Then implement the protocol as a sequence of buttons/stages, each printing its result to screen and appending to an in-memory results object that's written to `/sdcard/Android/data/com.todoai/files/q1_results.json` at the end.

**All constrained calls use greedy decoding (temp 0, no penalties)** — matches production intent (strategy D9) and makes the numbers reproducible. The unconstrained baseline call uses the same temp 0 so the only variable is the grammar.

Capture a **manifest** with the results (strategy §6.6 — "a number without its manifest is a rumor"): model filename + SHA-256, the exact grammar string hash for each stage, `llama.rn` version (0.12.5), device label, and a thermal/run note (cold vs. warm, minutes into use). A helper that hashes the strings and reads the model file is fine.

### Stage 0 — Trivial grammar (isolates "does the param work")
Before anything complex, prove the mechanism. Hardcode a dead-simple grammar, e.g. `root ::= "yes" | "no"`, and a prompt that would otherwise ramble. **Pass =** output is exactly one of the two literals, call returns without error. This separates "llama.rn accepts and applies a grammar" from "my big grammar is correct" — if Stage 0 fails, nothing else matters and it's a stack/binding problem, not a grammar-authoring problem.

### Stage 1 — `{m,n}` support (isolates the D3.5 risk)
A micro-grammar using bounded repetition, e.g. a JSON-safe string capped at `{1,20}`. Run it. **If it compiles and constrains → `{m,n}` is supported**, task 5's grammars run as authored, the expander is dead insurance. **If it errors →** import task 5's `boundedRepetition.ts`, expand the same rule to nested optionals, run again; if *that* works, the fallback path is live and every checked-in grammar must be expanded before use. Report which branch you're in — this single bit decides whether the grammars ship as-is.

### Stage 2 — The real extraction grammar (the money shot)
Instantiate `task_extraction.v1.gbnf` from its template with `buildGrammar` (it has a dynamic `context_tags` slot — inject a small fixed vocab like `["home","office","phone","computer"]`). Feed 3–5 prompts drawn from `extraction_fixtures_seed.jsonl` (use the `turns`; a couple of simple + one trap like `trap-unsched-01` + one date case). For each:
- record the raw output, whether it **parses as JSON**, and whether it **passes task 5's extraction validator** (import it — don't re-implement);
- record grammar-compile time (first use) and generation tok/s.

**Pass =** valid, validator-passing JSON on the first try across the samples. This is the result that either confirms or kills §3.3.

### Stage 3 — Overhead (constrained vs unconstrained)
Same prompt, run it twice: grammar **off** (baseline) and grammar **on**, temp 0 both. Record tok/s for each and the ratio, plus grammar-compile time separately from generation. This is the "is the overhead crippling" number. *(This also incidentally captures a first, tiny Q2 signal — grammar-on vs -off output — but do not scope-creep into Q2's field-accuracy comparison; that's a later, larger run.)*

---

## What Jason runs & reports

1. Build to the S23 FE (`npm run android`), model already in `/sdcard/Android/data/com.todoai/files/` (see `README_build.md`).
2. Run Stage 0 → 1 → 2 → 3 in order. Stop and report immediately if Stage 0 or Stage 1 hard-fails — no point continuing.
3. Note the thermal context (run it a couple minutes in, not just cold — steady-state is the honest condition, per the original spike's plateau finding).
4. `adb pull /sdcard/Android/data/com.todoai/files/q1_results.json` and paste it back, plus a one-line gut read ("felt fine" / "visibly slower" / "errored").

**Results template** (the harness should emit this; fill any gaps by hand):

| Field | Value |
|---|---|
| Stage 0 trivial grammar — constrains? | yes / no / error: ___ |
| Stage 1 `{m,n}` — works as-authored? | yes / needed expander / neither |
| Stage 2 — valid JSON first try (n/N) | ___ / ___ |
| Stage 2 — passes task-5 validator (n/N) | ___ / ___ |
| Grammar compile time (extraction) | ___ ms |
| Unconstrained tok/s (baseline) | ___ |
| Constrained tok/s (grammar on) | ___ |
| Overhead ratio (unconstrained ÷ constrained) | ___× |
| Thermal note (cold/warm, mins in) | ___ |
| Manifest (model SHA, grammar hashes, llama.rn ver) | ___ |

---

## How to read the result

- **GREEN — §3.3 stands.** Stage 0 constrains; Stage 2 is valid + validator-passing across samples; overhead is tolerable (constrained tok/s stays in the usable range — as a rough band, within ~2× of unconstrained is fine; the 5.2 tok/s baseline is the reference); `{m,n}` works or the expander does. → Tasks 6/7/12 proceed on the grammar path as designed; task 6's brief flips from "build Q1-ready" to "grammars confirmed."
- **YELLOW — proceed with a noted adjustment.** Works but with a caveat: `{m,n}` needs the expander (flip task 5's grammars to expanded form); or overhead is noticeable but livable (shrink output budgets / stage outputs smaller); or occasional invalid that the retry ladder will catch. → Proceed, record the adjustment.
- **RED — escalate before the batch builds on it.** Stage 0 errors/crashes (binding/stack problem), or Stage 2 output is still invalid despite the grammar, or overhead is crippling (grammar-on is many times slower, or unusable at 5 tok/s). → The fallback world: **prompt-JSON + strict validation + one-retry, no hard constraint.** This is a real change to §3.3 and to task 6's shape; stop and redesign that seam rather than pushing 7/9/12 on top of a broken assumption.

Whichever bucket, the numbers + manifest go back into the orientation doc so task 6 is built against a *measured* stack, not a hoped-for one.

---

## Out of scope (do not build)

- The production `TernaryBonsaiProvider` / task 6. This is a throwaway spike; it may crib loading code from the provider if it exists, but it is not the provider.
- The full eval harness, dev/holdout split, or scoring pipeline (task 20 track). Q1 is a smoke test on a handful of prompts, not the fixture run.
- Q2 (grammar-on-vs-off field accuracy at scale), Q3 (recap value), Q4 (prefill economics) — separate, later measurements. Don't let Stage 3 grow into them.
- Any change to task 5's grammars, validators, or `buildGrammar` — import and use them. If Stage 1 shows `{m,n}` is unsupported, that's a *finding to report*, not a license to rewrite task 5 here.

Keep the harness small and readable — it's a throwaway whose only job is to produce four trustworthy numbers and a go/no-go on §3.3.
