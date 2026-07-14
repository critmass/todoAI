# Sonnet Brief — Q1b: Repair the bounded-integer grammar shape

**For:** a Sonnet coding session (Claude Code) in the todoAI repo, run as a **live loop with Jason** — Sonnet extends the existing Q1 harness, Jason runs it on the S23 FE and reports, together you read the result.
**Prior finding this responds to:** the Q1 findings report. Read it first, in full — its five probes and the trigger condition they isolated are the entire basis for this brief.
**Harness:** extend `src/dev/Q1GrammarSpikeScreen.tsx` (already exists, already has the probe machinery, already loads the model). Do **not** start a new one.
**Time budget:** this should be ~15 minutes of device time. It is three micro-probes and, if they pass, a one-primitive fix. Resist scope growth.

---

## Where we actually stand (read this before concluding anything)

Q1's verdict was RED, but the shape of that red matters enormously and is easy to over-read:

- **Grammars work on this stack.** Stage 0 (`"yes"|"no"`) constrained cleanly. `llama.rn` 0.12.5 accepts and applies a `grammar` param. This is *not* a binding/stack failure.
- **One primitive is broken**, and it's used everywhere: `boundedIntRule` in `src/llm/grammar/primitives.ts` emits `[1-9] [0-9]{0,N}` for every bounded integer. That shape does not parse on this device's llama.cpp build.
- **The `{m,n}` expander does not fix it** — because this was never an `{m,n}` problem. The isolated trigger is *structural*: **a mandatory character class immediately followed by an optional/repeated character-class-derived continuation.** Expanding `{0,N}` into nested `(...)?` preserves that exact structure, which is precisely why it failed identically at all three granularities.
- **The blast radius is bounded integers only.** Three of four schemas are affected (`summary.v1` has no bounded ints). Enums, string bounds, the recurrence discriminated union, structural shape — all use confirmed-working constructs.
- **Losing hard constraint on integers is the cheapest possible loss.** Per D3 the grammar's job on `estimated_duration_minutes` was runaway prevention; the *real* bound (≤1440) was always the validator's job under D10. Had this hit the recurrence union or the enums, it would be serious. It didn't.

So: this is a surgical repair, not a redesign. Do not treat it as a mandate to rethink §3.3.

---

## Probe A — the digit-width alternation (the money probe)

**Hypothesis.** Express a bounded integer as an **alternation over fixed digit-widths**, where every branch is entirely mandatory classes. The vulnerable position — mandatory class followed by *optional* class-derived tail — then never exists anywhere in the rule, because no branch has an optional tail. The length choice lives in the alternation instead.

```gbnf
root   ::= "{\"n\":" intval "}"
intval ::= i4 | i3 | i2 | i1
i4     ::= [1-9] [0-9] [0-9] [0-9]
i3     ::= [1-9] [0-9] [0-9]
i2     ::= [1-9] [0-9]
i1     ::= [1-9]
```

**Why this should work, grounded in Q1's own probes** (this is a *reasoned* hypothesis, not a proven one — that's what the probe is for):
- Probe 5 confirmed `[1-9] [0-9]` — two adjacent mandatory classes — parses and generates fine.
- Stage 0 confirmed alternation between literals works; Stage 1 confirmed `{m,n}` over a *named alternation* rule works.
- Every branch here is only mandatory classes; the only optionality is alternation between whole branches. The isolated trigger condition is structurally absent.

**Order branches longest-first** (`i4 | i3 | i2 | i1`). GBNF alternation is first-match; leading with `i1` risks the model committing to a single digit and closing early.

**Run it with a prompt that must produce a multi-digit number** (e.g. "How many minutes does a 2-hour task take? Reply as JSON."). We need to see a 2–4 digit value actually generated, not just `{"n":7}` — a single digit would also be emitted by a broken-but-parsing grammar and would tell us nothing about the multi-digit branches.

**Pass =** grammar parses **and** a multi-digit integer is generated. Record both facts separately; parse-only is a partial result.

## Probe B — confirm the array shape the report *inferred* was safe

The Q1 report reasoned — correctly, but explicitly **without testing** — that array fields (`("," rule){0,N}` where `rule` is a named alternation like `jchar` or `weekday`) are structurally closer to the working Stage 1 pattern than to the failing one. That inference is load-bearing for `context_tags`, `tool_requirements`, `weekday_array`, and `key_points`. **Test it, don't assume it.**

```gbnf
root  ::= "[" (day ("," day){0,2})? "]"
day   ::= "\"monday\"" | "\"tuesday\"" | "\"friday\""
```

**Pass =** parses and emits a valid 1–3 element array. If this *fails*, the damage is materially wider than integers and we stop and re-plan before touching `primitives.ts` — so run it even though we expect a pass. A cheap probe that could overturn a load-bearing inference is worth 90 seconds.

## Probe C — the process-death case, under the fix

Q1 found something more alarming than a parse error: one grammar (`due`, containing `[0-9]{0,2}` in `days_int`) **killed the app process** — no catchable JS error, no tombstone, inconsistently reproducible (3× dead, then once a normal catchable failure). That's an uncatchable failure mode, and it breaks a load-bearing D10 assumption.

Rebuild the `due` sub-grammar with Probe A's digit-width shape substituted for its `days_int`, and run it. **Pass =** parses, generates, **and does not kill the process.**

If it still dies, that's the single most important finding of this session — report immediately and stop; it means something beyond the integer shape is unsafe on this build.

---

## The fix (apply only if Probe A passes — and B doesn't fail)

Edit **`boundedIntRule`** in `src/llm/grammar/primitives.ts` to emit the digit-width alternation instead of `[1-9] [0-9]{0,N}`. Generate the branches programmatically from the field's max (e.g. max 1440 → 4 branches; max 10 → the existing special-cased `[1-9] | "10"` is already safe and can stay). Keep the emitted rule names collision-free per field.

**Scope discipline:**
- This is a **one-primitive change**. `boundedIntRule` is the only vulnerable emitter; every affected field in all three schemas routes through it, so fixing it repairs `task_extraction.v1`, `task_breakdown.v1`, and `coaching_resolution.v1` at once.
- **Do not change** the JSON Schemas, the zod validators, the mappers, or the *bounds themselves*. The grammar caps digit count; the validator still enforces the true ceiling (≤1440 etc.) exactly as D10 specifies. The contract between them is unchanged.
- Regenerate/hand-tighten the affected `.gbnf` files, update their header comments, and **re-run task 5's existing grammar tests** — they must still pass.
- Add a unit test asserting `boundedIntRule` never emits the vulnerable pattern (a mandatory class immediately followed by an optional/repeated class-derived tail). This is the regression guard that stops the shape silently coming back.
- **`boundedRepetition.ts` stays** — Stage 1 proved `{m,n}` works on named-alternation rules, so it's still valid for those; it was simply never the fix for *this* problem. Leave it alone.

Then, with the real grammar finally parsing, **run the Stage 2 and Stage 3 that Q1 never reached**: the seed fixtures through the real extraction grammar (valid JSON? passes task 5's validator?), and constrained-vs-unconstrained tok/s. Those were blocked purely on the parse failure. Capture them with the manifest discipline from the original brief.

---

## If Probe A fails: the surgical fallback (do NOT jump to the full RED path)

If no working bounded-integer grammar shape exists, **do not abandon grammars.** The correct response is the *partial* fallback (option 2 in the Q1 report), not the full one:

- **Keep grammars for everything they demonstrably do well:** enums, closed alternations, the recurrence discriminated union, string bounds, structural JSON shape. That is the overwhelming majority of §3.3's value and all of its highest-stakes surface (the `null`-vs-`unscheduled` boundary lives in the enum/union machinery, not in integers).
- **For integer fields only:** emit an unconstrained-but-bounded-ish token space in the grammar (or leave the field's value loose) and let **the existing zod validator + D10's one-retry ladder** enforce the real range. The validator already does this; nothing new is needed.
- Report the result and stop. Don't redesign §3.3 in this session.

---

## Architectural finding to carry forward regardless of outcome

The process-death case (§3.3 of the Q1 report) has a consequence that holds **whatever these probes show**, and it belongs in task 6's brief:

> **Never first-parse a grammar in front of a user.** A malformed grammar can kill the process uncatchably, which D10's retry/fallback ladder cannot recover from. Every grammar the app ships must be **parse-confirmed on-device ahead of time** — a startup/health-check guard that attempts to compile every registered grammar (including dynamically-built ones, against representative slot values) and, if any fail, disables the grammar path and falls back to prompt-JSON + validation **before** any user session begins.

This turns an uncatchable runtime crash into a caught startup condition. Note it in the results; it becomes a task 6 requirement.

---

## Out of scope

- Any change to §3.3, the schemas, validators, mappers, or bounds.
- The task-6 provider, the eval harness (task 20), Q2/Q3/Q4.
- Cleaning up the Q1 harness's accumulated diagnostic buttons (a later chore; leave them).
- Hand-enumerating giant literal alternations (`"1"|"2"|...|"1440"`) — the digit-width shape exists precisely to avoid that.

---

## Report back

| Probe | Result |
|---|---|
| A — digit-width int: parses? | yes / no |
| A — multi-digit value generated? | yes / no — value: ___ |
| B — array shape parses + emits? | yes / no |
| C — `due` w/ fix: parses, generates, **no process death**? | yes / no |
| Fix applied to `boundedIntRule`? | yes / n/a |
| Task 5 grammar tests still green? | yes / no |
| Stage 2 (now unblocked): valid + validator-passing (n/N) | ___ / ___ |
| Stage 3: unconstrained vs constrained tok/s | ___ vs ___ |
| Manifest (model SHA, grammar hashes, llama.rn ver, thermal note) | ___ |

Plus a one-line call: **green** (fix works, grammars whole, tasks 6/12 proceed on the grammar path) · **partial** (integers fall back to validator-only, grammars keep everything else) · **red** (something beyond integers is unsafe — stop and re-plan).
