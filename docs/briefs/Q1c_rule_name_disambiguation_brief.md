# Sonnet Brief — Q1c: The rule-name bug is (probably) underscores, not key-matching

**For:** a Sonnet session in todoAI, run as a **live loop with Jason** — Sonnet builds the probe screen, Jason runs it on the S23 FE, together you read the result.
**Prior findings:** `docs/eval/Q1b_findings_report.md` + `q1b_results.json`, and the probe code in `src/dev/DateStrProbeScreen.tsx` (read the probe comments — they're the real record).
**Do §1 first and report before doing anything else.** §2–§4 depend on which theory §1 confirms.

---

## §0 — Why we're reopening a "solved" bug

Q1b concluded: *"a `jchar{m,n}`-based rule must be named to match its own JSON key exactly."* The debugging that produced it was genuinely excellent — nine hypotheses raised and refuted, poisoning/non-determinism/jinja-override all properly ruled out first. **But the conclusion is almost certainly wrong**, and it's wrong in a way that will actively break the next three fixes if we act on it.

### The confound

The decisive pair was M vs N:

| Probe | JSON key | Rule name | Bound | Result |
|---|---|---|---|---|
| M | `foo` | `foo_str` | `{1,80}` | **FAIL** |
| N | `foo` | `foo` | `{1,80}` | **PASS** |

Only the rule name changed — so the name is provably the variable. But renaming `foo_str` → `foo` changed **two things simultaneously**:
1. the name became identical to the JSON key, **and**
2. the name **lost its underscore**.

Q1b attributed the pass to (1). **(2) was never isolated.**

### The mechanism that makes (2) far more likely

llama.cpp's GBNF parser lexes rule names with an `is_word_char` predicate that accepts **letters, digits, and `-`** — and **not `_`**. An underscore in a rule name terminates the identifier early, and the parser then chokes on the stray `_` → `failed to parse grammar`. That's a real, mundane, mechanical bug.

By contrast, **"the rule name must match its JSON key" has no mechanism at all.** GBNF rule names are arbitrary identifiers; the parser has no concept of which key a rule is used under. Nothing in the format could implement that rule.

### The underscore theory explains every single data point; key-matching does not

**Every failing probe carries an underscore in a rule name:** C1/D1/D2/D3 (`date_str`, `md_str`, `x_str`, `t_str`), E1–E4 (all keep `date_str`; E4 adds `month_dash`, `day_dash`), G, H, I, J (all `date_str`), K, M, O (all `foo_str`). **The nine "failed structural fixes" all failed because every one of them rearranged the grammar while leaving an underscored rule name in place — the bug was never touched.**

**Every passing probe has no underscore anywhere in a rule name:** Stage 0 (`root`), Stage 1 (`jchar`), Q1b Probe A (`intval`, `i4`–`i1`), L (`title`), N (`foo`), P (`date`).

And key-matching is **directly falsified by grammars we already know parse**: `jchar` is not a JSON key. `weekday` is used under the key `day`. `which`, `d1`, `d2`, `d3`, `intval`, `digit` are not keys. All parse fine.

### Why this is urgent, not academic

The two theories make **opposite predictions** for the very fields we're about to fix — and the schemas are full of underscore-bearing keys (`estimated_duration_minutes`, `context_tags`, `tool_requirements`, `duration_from_user`, `importance_user`):

- **Key-matching says:** name the rule `estimated_duration_minutes` (matching its key).
- **Underscore theory says:** that name is exactly what breaks the parser.

**They cannot both be satisfied.** Acting on the wrong one means renaming three coaching fields into a shape that still doesn't parse — and shipping it into task 12's live coaching path. One 10-minute probe settles it.

### The bonus prize

If underscores are the bug, then **Q1's original "bounded-integer shape is broken" conclusion is probably also wrong** — that field's rule was almost certainly named `estimated_duration_minutes` or `duration_int` (underscored!), and the digit-width fix in Q1b Probe A "worked" partly because `intval`/`i4`/`i3` happen to have no underscores. The `[1-9] [0-9]{0,N}` shape may be **completely fine**. §3 tests that, and if it holds, `boundedIntRule` needs no structural change at all — just a name that parses.

---

## §1 — The decisive probe (build a NEW screen; run these four; report before proceeding)

### Build `src/dev/RuleNameProbeScreen.tsx`

**A new screen, not more buttons on the existing ones.** Follow the precedent `DateStrProbeScreen.tsx` already set (and its header comment's reasoning): `Q1GrammarSpikeScreen` is ~20 buttons deep and hard to drive by `adb` tap coordinates on a real device; this is a distinct investigative thread. Same conventions as `DateStrProbeScreen`:

- Same model-load block (`MODEL_PATH`, `initLlama`, `ensureModelLoaded`), duplicated intentionally — throwaway spike, not a shared module.
- Same `logResultJson` tagged/chunked logging so `scripts/q1-reassemble.js` can pull results; use a distinct tag prefix (`Q1CRESULT:probeQ1` etc.).
- Same `runCompletion` (temp 0, `top_k` 1), same one-button-per-probe layout, same `extractTimings`.
- Wire it into `App.tsx` the same way `DateStrProbeScreen` was.
- Header comment: state that this reopens Q1b's conclusion, name the M-vs-N confound, and cite the `is_word_char` mechanism — so anyone reading it cold knows why.

### The four probes

All four hold **everything** constant except the rule name: same body (`"\"" jchar{1,80} "\""`), same 2-level indirection, same self-owned quotes, same `{1,80}` bound (all proven-safe from Probes L/N). **Fresh native context per run** — keep Q1b's discipline.

| # | JSON key | Rule name | Underscore? | Matches key? | Key-matching predicts | Underscore predicts |
|---|---|---|---|---|---|---|
| **Q1** | `foo_bar` | `foo_bar` | yes | **yes** | **PASS** | **FAIL** |
| **Q2** | `foo` | `xyzzy` | no | **no** | **FAIL** | **PASS** |
| Q3 | `foo` | `foo-bar` | no (dash) | no | FAIL | PASS |
| Q4 | `foo` | `foo_str` | yes | no | FAIL | FAIL |

**Q1 and Q2 are the whole experiment** — they are constructed so the two theories predict *opposite* results. Q3 additionally tests whether `-` (which `is_word_char` *does* accept) is safe, which matters for naming conventions. Q4 is the known-failing control that proves the harness reproduces the bug.

Example (Q1 — vary only the name across the four):

```gbnf
root    ::= "{\"foo_bar\":" foo_bar "}"
foo_bar ::= "\"" jchar{1,80} "\""
jchar   ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
```

### How to read it

- **Q1 FAILS and Q2 PASSES → underscore theory confirmed, key-matching is dead.** (Expected.) The rule is simply: **no `_` in GBNF rule names.** Names are otherwise free. Proceed to §2–§4.
- **Q1 PASSES and Q2 FAILS →** key-matching somehow holds. Extraordinary, but empirically binding: adopt it, and **immediately flag the contradiction** — underscore-bearing keys (`estimated_duration_minutes`) would then be unfixable, so we'd need a different plan for those fields. Stop and report.
- **Both PASS →** neither theory is the trigger; something else (bound value? context state?) is. Stop and report.
- **Both FAIL →** the harness isn't reproducing the known-good baseline. Re-run Probe N/L to check the environment before trusting anything.

---

## §2 — If underscores are confirmed: fix the naming, everywhere (with a lint)

The fix is **mechanical and global**, not per-field:

- **Rename every GBNF rule containing `_` → an underscore-free name** across `task_extraction.v1.gbnf`, `task_breakdown.v1.gbnf`, `coaching_resolution.v1.gbnf`, and anything `primitives.ts` / `buildGrammar` emits. Use camelCase or dashes (Q3 tells you if `-` is safe; prefer camelCase if unsure). **JSON keys are untouched** — only *rule names* change. `"estimated_duration_minutes"` stays as a key; its rule becomes e.g. `estimatedDurationMinutes`.
- **This includes the three fields Q1b left untested** (`changes_notes`, `reason120`, `condition120`) — under this theory their problem is `changes_notes`'s underscore, and `reason120`/`condition120` (digits, no underscore) may have been **fine all along**. Test, don't assume.
- **Add a lint/unit test** over every checked-in `.gbnf` **and** over `buildGrammar`'s output for dynamic templates: **no rule name may contain `_`**. This is the regression guard — it makes the constraint mechanical instead of tribal.
- Revert Q1b's `date_str` → `date` rename to a *principled* name if you like, but it already satisfies the rule — leave it if it's clean.

## §3 — Re-test the bounded-integer shape (it may never have been broken)

With naming fixed, retest the **original** `[1-9] [0-9]{0,3}` shape under an underscore-free rule name (e.g. `durationMinutes`).

- **If it parses:** Q1's structural conclusion was a misdiagnosis, and **`boundedIntRule` needs no structural change** — leave the simple `{0,N}` form. (The digit-width alternation still works and is harmless, so keep it if already applied; just don't build further ceremony on a bug that wasn't real.)
- **If it still fails:** the digit-width alternation from Q1b Probe A is the fix. Apply it to `primitives.ts` with the regression test (this was already validated on-device; the hold on it is lifted either way).

Report which — it determines whether `primitives.ts` gets simpler or keeps the alternation.

## §4 — Then close out Q1 properly

Once naming is fixed and integers are settled:

- **Fire every affected grammar on-device** — the three coaching fields, the full `due` union (Probe F's shape, with underscore-free names), and the real `task_extraction.v1` template via `buildGrammar`. A rename applied on inference and never fired is exactly what surfaces later as a mid-coaching crash — and `coaching_resolution` is what task 12 fires **at users during a skip conversation**. It gets fired here.
- **Run Stage 2 and Stage 3 at last** (both were blocked purely on the parse failure): seed fixtures through the real extraction grammar (valid JSON? passes task 5's validator?), and constrained-vs-unconstrained tok/s. Capture with the manifest (model SHA, `llama.rn` version, thermal note).
- **Update `src/llm/README.md`** with the *real* constraint — "**no underscores in GBNF rule names on this build** (llama.cpp's `is_word_char` excludes `_`); JSON keys may contain them freely" — and explicitly retract the key-matching rule so nobody reinstates it. Note that it is a **build quirk, not GBNF semantics**, so nobody "fixes" the workaround later thinking it's wrong.
- Full suite (244+) stays green; `tsc` clean.

---

## §5 — Standing task-6 requirement (record, don't build)

We have now found grammar parse failures that are **silent, name-dependent, and in one case killed the app process uncatchably** (Q1's `due` case: no JS error, no tombstone). D10's retry ladder cannot recover from a process death.

> **Never first-parse a grammar in front of a user.** Task 6 must compile **every** registered grammar at startup — including dynamically-built ones against representative slot values — and if any fail, disable the grammar path and fall back to prompt-JSON + validation **before any user session begins.**

This turns an uncatchable crash into a caught startup condition. Carry it into the task-6 brief.

---

## Out of scope

- Changing §3.3, the schemas, validators, mappers, or field **bounds**. (Rule *names* are not schema changes.)
- The task-6 provider; the eval harness (task 20); Q2/Q3/Q4 evals.
- Re-litigating Q1b's properly-excluded hypotheses (poisoning, non-determinism, jinja override) — settled.
- Cleaning up accumulated diagnostic buttons (later chore).

---

## Report back

| Item | Result |
|---|---|
| §1-Q1 `foo_bar` rule under `foo_bar` key (underscore, matches key) | PASS / FAIL |
| §1-Q2 `xyzzy` rule under `foo` key (no underscore, no match) | PASS / FAIL |
| §1-Q3 `foo-bar` (dash) | PASS / FAIL |
| §1-Q4 `foo_str` control (known-fail) | PASS / FAIL |
| **The actual rule, stated precisely** | ___ |
| §2 all rule names de-underscored + lint test added? | ___ |
| §3 does `[1-9] [0-9]{0,3}` parse with a clean name? | ___ |
| §3 → does `boundedIntRule` keep the alternation, or revert? | ___ |
| §4 three coaching fields fired on-device? | ___ |
| §4 full `due` union + real extraction grammar fired? | ___ |
| §4 Stage 2 (valid + validator-passing, n/N) | ___ / ___ |
| §4 Stage 3 (unconstrained vs constrained tok/s) | ___ vs ___ |
| Suite green / `tsc` clean? | ___ |

Plus a one-line call: **green** (naming rule isolated, all grammars parse and fire → tasks 6/12 proceed) · **partial** (some fields fall back to validator-only) · **red** (something else is unsafe — stop and re-plan).
