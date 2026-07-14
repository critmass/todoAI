# Q1c Findings Report — the rule-name bug is underscores, not key-matching

**Question:** Q1b concluded that a `jchar{m,n}`-based GBNF rule must be named to match its own
JSON key exactly, or it fails to parse on this device's `llama.cpp` build. That conclusion
rested on one probe pair (M vs. N) that changed two variables at once. Q1c's job was to isolate
which variable actually mattered before that conclusion got built into a global rename.

**Verdict: Q1b's conclusion was wrong. The real rule is narrower and more mundane: no
underscore (`_`) may appear anywhere in a GBNF rule name on this build.** Confirmed by the
decisive pair (Q1 fails, Q2 passes) predicting in the opposite direction from key-matching, with
Q3/Q4 corroborating. Key-matching is refuted by this session's own live data, not just by the
brief's a-priori mechanism argument.

**Date:** 2026-07-14 · **Device:** Samsung Galaxy S23 FE (serial `R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf`, SHA-256 `da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c`
· **`llama.rn`:** 0.12.5 · Full machine-readable data: [`q1c_results.json`](q1c_results.json).

**Read first:** [`Q1b_findings_report.md`](Q1b_findings_report.md) (the conclusion this reopens)
and [`docs/briefs/Q1c_rule_name_disambiguation_brief.md`](../briefs/Q1c_rule_name_disambiguation_brief.md)
(what this session was asked to do — only §1 of it; §2–§4 are still open, see §4 below).

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

## 4. What this report does not cover — still open

Per the explicit instruction this session ran under ("report the table before touching any
grammar or `primitives.ts`"), only §1 of the Q1c brief was executed. The brief's §2–§4 are
**not started**:

- **§2 — the global rename + lint.** Every GBNF rule name containing `_` needs renaming
  (JSON keys stay untouched — only rule names change) across all three affected schema files
  and anything `primitives.ts`/`buildGrammar` emits, plus a regression-guard test asserting no
  checked-in rule name contains `_`. This includes the three fields Q1b flagged but never
  tested (`changes_notes`, `reason120`, `condition120`) — under this theory, `reason120` and
  `condition120` (digits only, no underscore) may have been fine all along; only
  `changes_notes` is implicated. Test each, don't assume.
- **§3 — re-test the original bounded-integer shape.** With a clean, underscore-free rule name,
  the plain `[1-9] [0-9]{0,3}` form may parse without needing Q1b Probe A's digit-width
  alternation at all — Q1's original "structural" verdict may itself have been a
  naming-collateral misdiagnosis. Not yet tested.
- **§4 — fire everything for real, then run Stage 2/3.** The three coaching fields, the full
  `due` union, and the real `task_extraction.v1` template via `buildGrammar`, all under
  corrected names, on-device. Then task 5's Stage 2 (fixture pass/fail + validator rate) and
  Stage 3 (constrained vs. unconstrained tok/s) — both blocked since Q1 purely on parse
  failures, never run for real.
- **`src/llm/README.md`** needs the retraction: replace any trace of a "match the key" rule
  with "no underscores in GBNF rule names on this build."

Given §2–§4 depend on §1's outcome and were explicitly out of scope for this pass, none of
`primitives.ts`, the `.gbnf` files, or `buildGrammar` were touched in this session.

## 5. Reproduction

- Harness: [`src/dev/RuleNameProbeScreen.tsx`](../../src/dev/RuleNameProbeScreen.tsx), reachable
  via the "Rule Name Probes" button in the switcher `App.tsx` added for it (alongside "Q1
  Harness" and "date_str Probes"). Throwaway dev spike; diagnostic buttons left in place.
- Raw data: [`q1c_results.json`](q1c_results.json).
- Same fresh-context discipline as Q1b applies here: force-stop and relaunch
  (`adb shell am force-stop com.todoai && adb shell am start -n com.todoai/.MainActivity`)
  before trusting any single probe result — a reused native context can carry forward a prior
  failure's corrupted state (see [`Q1b_findings_report.md`](Q1b_findings_report.md)'s §3 for the
  full poisoning discussion, properly ruled out there and not re-litigated here).
