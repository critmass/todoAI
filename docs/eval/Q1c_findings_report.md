# Q1c Findings Report — the rule-name bug is underscores, not key-matching

**Question:** Q1b concluded that a `jchar{m,n}`-based GBNF rule must be named to match its own
JSON key exactly, or it fails to parse on this device's `llama.cpp` build. That conclusion
rested on one probe pair (M vs. N) that changed two variables at once. Q1c's job was to isolate
which variable actually mattered before that conclusion got built into a global rename.

**Verdict: Q1b's conclusion was wrong. The real rule is narrower and more mundane: no
underscore (`_`) may appear anywhere in a GBNF rule name on this build.** Confirmed by the
decisive pair (Q1 fails, Q2 passes) predicting in the opposite direction from key-matching, with
Q3/Q4 corroborating. Key-matching is refuted by this session's own live data, not just by the
brief's a-priori mechanism argument. **The brief's full §1–§4 arc is now closed: the global
rename is applied and lint-guarded, `boundedIntRule` needed no structural change, and every
renamed grammar — including the three coaching fields Q1b flagged but never tested, the full
`due` union, and the real `task_extraction.v1` template — has been fired on-device. One-line
call: GREEN.** See §4 below for the §2–§4 results; §1–§3 below document the original
disambiguation.

**Date:** 2026-07-14 · **Device:** Samsung Galaxy S23 FE (serial `R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf`, SHA-256 `da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c`
· **`llama.rn`:** 0.12.5 · Machine-readable data: [`q1c_results.json`](q1c_results.json) (§1) and
[`q1c_part2_results.json`](q1c_part2_results.json) (§3/§4).

**Read first:** [`Q1b_findings_report.md`](Q1b_findings_report.md) (the conclusion this reopens)
and [`docs/briefs/Q1c_rule_name_disambiguation_brief.md`](../briefs/Q1c_rule_name_disambiguation_brief.md)
(what this session was asked to do — the full brief, §1 through §4, is now closed; see §4
onward below).

---

## 1. Why Q1b's conclusion needed reopening

Q1b's decisive comparison was M vs. N, both run on fresh native contexts:

| Probe | JSON key | Rule name | Bound | Result |
|---|---|---|---|---|
| M | `foo` | `foo_str` | `{1,80}` | FAIL |
| N | `foo` | `foo` | `{1,80}` | PASS |

Renaming `foo_str` → `foo` changed **two things at once**: the name became identical to the
JSON key, *and* it lost its underscore. Q1b attributed the flip to the first; the second was
never isolated.

The competing theory, laid out in the Q1c brief: `llama.cpp`'s GBNF parser lexes rule names
with an `is_word_char` predicate that (per the brief's citation) accepts letters, digits, and
`-`, but not `_`. An underscore terminates the identifier early and the parser then chokes on
the stray character. This has an actual mechanism. Key-matching has none — GBNF rule names are
arbitrary identifiers; nothing in the grammar format lets the parser know which JSON key a rule
happens to be used under.

The underscore theory also retroactively explains every prior data point without exception:
every failing probe across Q1b (`date_str`, `md_str`, `x_str`, `t_str`, `month_dash`,
`day_dash`, `foo_str`) carried an underscore in a rule name; every passing probe (`root`,
`jchar`, `intval`, `i4`–`i1`, `title`, `foo`, `date`) didn't.

## 2. The four probes

Built in a new screen, [`src/dev/RuleNameProbeScreen.tsx`](../../src/dev/RuleNameProbeScreen.tsx)
(wired into `App.tsx` as a third switcher option, alongside the Q1 harness and the `date_str`
probes), following the same conventions `DateStrProbeScreen.tsx` established. All four hold
everything else constant — same body (`"\"" jchar{1,80} "\""`), same 2-level indirection, same
self-owned quotes, same proven-safe `{1,80}` bound — and vary only the rule name. Each ran as
the **first call on a freshly force-stopped/relaunched app** (a brand-new native context),
matching Q1b's own discipline against context poisoning.

| # | JSON key | Rule name | Underscore? | Matches key? | Key-matching predicts | Underscore predicts | **Result** |
|---|---|---|---|---|---|---|---|
| Q1 | `foo_bar` | `foo_bar` | yes | **yes** | PASS | FAIL | **FAIL** |
| Q2 | `foo` | `xyzzy` | no | **no** | FAIL | PASS | **PASS** |
| Q3 | `foo` | `foo-bar` | no (dash) | no | FAIL | PASS | **PASS** |
| Q4 | `foo` | `foo_str` | yes | no | FAIL | FAIL | **FAIL** |

**Q1 and Q2 are the decisive pair** — constructed so the two theories predict opposite results.
Both landed on the underscore theory's side, in opposite directions from key-matching's
predictions:

- **Q1** (`foo_bar`/`foo_bar`) — name matches its key exactly, which key-matching says should
  pass. It **failed**. The only thing wrong with it, per the underscore theory, is the `_` in
  both the key and the rule name.
- **Q2** (`foo`/`xyzzy`) — name doesn't match its key at all, which key-matching says should
  fail. It **passed**. No underscore anywhere in the grammar.

Q3 confirms `-` (dash) is safe — `is_word_char` accepts it, unlike `_`, and this matters
directly for naming the fields that get renamed under this fix. Q4 is the known-fail control
(byte-for-byte Q1b's Probe M) and failed as expected, confirming the harness reproduces the
established bug before trusting Q1/Q2/Q3 against it.

One process note: Q2's first run was lost mid-probe when the phone was physically disconnected
from the machine — the app process died with no result logged. Re-run cleanly on a fresh
context once reconnected; it reproduced the same PASS.

## 3. The actual rule

> **No underscore (`_`) may appear anywhere in a GBNF rule name on this `llama.cpp` build.**
> Names are otherwise unconstrained — letters, digits, and `-` are all safe (Q3). A rule's name
> has no relationship to its own JSON key; Q1b's "must match the key" rule is dead.

Mechanism (per the brief's citation, not independently re-verified against `llama.cpp` source in
this session): the GBNF parser's `is_word_char` predicate excludes `_`, so an underscore inside
a rule name silently terminates the identifier early, and the parser then fails on the
now-malformed remainder. This is a **build quirk of this specific `llama.cpp`/`llama.rn`
version, not a property of GBNF as a format** — worth stating explicitly so nobody "fixes" the
workaround later thinking it's wrong.

## 4. §2 — the global rename + lint (done)

Every GBNF rule name containing `_` was renamed to camelCase (JSON keys and JSON string-literal
values are untouched — only bare rule identifiers change), across all four schema files:
`task_extraction.v1.gbnf`, `task_breakdown.v1.gbnf`, `coaching_resolution.v1.gbnf`, and
`summary.v1.gbnf`. This includes the three fields Q1b flagged but never tested —
`changes_notes` → `changesNotes` (the only one of the three that actually carried an
underscore; `reason120`/`condition120` were already clean, digits-only, no rename needed) — and
`summary.v1.gbnf`'s `key_points`/`key_point`/`energy_note`, which a first pass of this report
missed entirely and the new lint test below caught immediately.

`src/dev/extractionGrammarText.ts` (the Metro-importable byte-identical mirror of
`task_extraction.v1.gbnf`) was regenerated in lockstep and verified round-trip-identical to the
source file before committing; the existing drift-guard test confirms this on every run.

**Regression guard:** [`src/llm/grammar/__tests__/ruleNaming.test.ts`](../../src/llm/grammar/__tests__/ruleNaming.test.ts)
lints every checked-in `.gbnf` file and `buildGrammar`'s slot-substituted output for each
dynamic template against `/^[a-zA-Z][a-zA-Z0-9]*$/`. This is what caught the `summary.v1.gbnf`
miss above — it failed on first run, was fixed, then passed.

`src/llm/README.md` and the in-`.gbnf` header comments now state the underscore rule and
explicitly retract "must match the key."

**Verified:** `npx jest` — 30/30 suites, 251/251 tests pass. `npx tsc --noEmit` — clean.

## 5. §3 — boundedIntRule retest (done, on-device: PASS)

`src/llm/grammar/primitives.ts`'s `boundedIntRule` was never actually changed to Q1b Probe A's
digit-width alternation — Q1b validated that shape but explicitly held off applying it (see
Q1b's §6), so the function has always emitted the plain `[1-9] [0-9]{0,N}` form, same as every
real `.gbnf` field (`estimatedDurationMinutes`, `daysInt`, `quotaInt`, `targetInt`). The only
open question was whether that plain form parses under a name that satisfies the underscore
rule — Q1's original "bounded-integer shape is broken" verdict was reached before the naming
bug was known, so it may have been naming collateral all along.

**Probe R** (new, in `RuleNameProbeScreen.tsx`): `durationMinutes ::= [1-9] [0-9]{0,3}`,
referenced from `root ::= "{\"minutes\":" durationMinutes "}"` — the exact shape, under a clean
name.

**Result: PASS.** Parsed and generated `{"minutes":245}` on the first fresh-context run.

**Conclusion: confirmed. `boundedIntRule` needs no structural change.** Q1's original verdict
was indeed naming collateral, not a real limit on GBNF's `{m,n}` bounded-repetition support for
this shape.

## 6. §4 — firing everything for real (done, on-device: all PASS)

Four new probes in `RuleNameProbeScreen.tsx`, each byte-for-byte the real post-rename grammar
shape (not a simplified stand-in), plus a re-run of `Q1GrammarSpikeScreen.tsx`'s existing
Stage 2/3 (unmodified — it now benefits from the rename automatically, since it imports the real
`task_extraction.v1.gbnf` text and builds the real grammar via `buildGrammar`):

| Probe | Field | Real context | Result |
|---|---|---|---|
| S1 | `changesNotes` | `modify_task` / `changes` | **PASS** |
| S2 | `reason120` | `eliminate_task` | **PASS** |
| S3 | `condition120` | `defer_task` → `until` → `untilCondition` | **PASS** |
| T | full `due` union | `dueOnDate` / `dueInDays` / `dueWeekday`, `daysInt` plain form, `date` self-quoting | **PASS** (grammar parsed cleanly; the model itself chose the `due:null` branch despite a date in the prompt — a model-quality/prompting artifact, since this toy probe has no system prompt grounding date interpretation, not a grammar defect) |

**Stage 2** — the real `task_extraction.v1.gbnf`, substituted via `buildGrammar` with the app's
`context_tags_known` slot, fired over all 4 seed fixtures — **the first time this has ever
completed**, having been blocked purely on parse failures since the original Q1 session:

- **4/4 valid JSON, 4/4 validator-passing.**
- Minor, expected noise: two fixtures contain a junk second array element (the literal 2-character
  string `"],"`) in `context_tags`/`tool_requirements` — syntactically legal `jchar` content (the
  validator doesn't police tag/tool semantics), a model-quality artifact of the 4B TQ1_0
  quantization, not a grammar or parser defect.

**Stage 3** — constrained vs. unconstrained tok/s, same prompt, both temperature 0:
unconstrained 8.20 tok/s, constrained 7.98 tok/s → **overhead ratio 1.03x** (grammar constraint
costs roughly 3% throughput on this run).

Full raw data (grammars, raw model output, timings) for every probe and both stages:
[`q1c_part2_results.json`](q1c_part2_results.json).

**Verified after this session's on-device run:** working tree unchanged from the committed
renames (this was pure verification, no further code changes needed) — `npx jest` (30/30
suites) and `npx tsc --noEmit` from §2 still stand.

## 7. One-line call

**GREEN** — naming rule fully isolated and applied; every renamed grammar (all four schema
files, the three previously-untested coaching fields, the full `due` union, and the real
`task_extraction.v1` template) parses and fires correctly on-device, and `boundedIntRule` needed
no structural change. Tasks 6/12 may proceed on this basis.

## 8. Reproduction

- Harness (§1, §3, §4 probes R/S1/S2/S3/T): [`src/dev/RuleNameProbeScreen.tsx`](../../src/dev/RuleNameProbeScreen.tsx),
  reachable via the "Rule Name Probes" button in the switcher `App.tsx` added for it (alongside
  "Q1 Harness" and "date_str Probes"). Throwaway dev spike; diagnostic buttons left in place.
- Harness (§4 Stage 2/3): [`src/dev/Q1GrammarSpikeScreen.tsx`](../../src/dev/Q1GrammarSpikeScreen.tsx)'s
  existing "Stage 2: real extraction grammar" and "Stage 3: overhead (on vs off)" buttons,
  unmodified — re-run as-is against the renamed `task_extraction.v1.gbnf`.
- Raw data: [`q1c_results.json`](q1c_results.json) (§1) and [`q1c_part2_results.json`](q1c_part2_results.json)
  (§3/§4 — reassembled from a live `adb logcat` capture via `scripts/q1-reassemble.js`, not
  hand-transcribed; note that on Windows, `adb logcat` output has `\r\n` line endings, which
  `q1-reassemble.js`'s tag regex doesn't strip on its own — normalize with `tr -d '\r'` or
  equivalent before reassembling, or every tag comes back "missing chunks").
- Same fresh-context discipline as Q1b applies here: force-stop and relaunch
  (`adb shell am force-stop com.todoai && adb shell am start -n com.todoai/.MainActivity`)
  before trusting any single probe result — a reused native context can carry forward a prior
  failure's corrupted state (see [`Q1b_findings_report.md`](Q1b_findings_report.md)'s §3 for the
  full poisoning discussion, properly ruled out there and not re-litigated here). §3/§4's probes
  ran in the same app session, tapped in sequence via `adb shell input tap`, so only the very
  first probe (R) paid a fresh model-load cost — this doesn't undermine any result here since
  none of §3/§4's probes are sensitive to prior-context poisoning in the way §1's disambiguation
  was (each fires a structurally distinct, non-toy grammar exercising real production shapes).
