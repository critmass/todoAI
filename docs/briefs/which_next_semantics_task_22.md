# Task 22 — `which:"next"` weekday semantics

**Owner:** Opus/Sonnet to propose, **Jason to rule** (it's a small product-semantics call). **Headless**, small, any target.
**Not on the personal-ship path**, but it affects **every date the app resolves** — extraction and deferral alike — so it's cheap and high-reach.

**Read first:**
1. `docs/eval/task12_phaseB_findings_report.md` §5 — the observed bug.
2. `src/llm/` — `resolveDue` and the `DueSpec`/relative-date union (task 5's contract). This is where the fix lands *or* which the guides must be taught to avoid.
3. `docs/briefs/structured_output_strategy_task_4.md` — the relative-date union design (D-series), so a fix doesn't fight the strategy.
4. **Coordination:** `docs/briefs/recurrence_period_engine_task_36.md` — task 36 does adjacent date arithmetic and is told explicitly *not* to fix or contradict this. Keep them consistent.

---

## 1. The bug

On a **Thursday**, the 4B emitted `which:"next"` for the phrase "next Monday" and `resolveDue` turned it into a date **11 days out** — the Monday of the *following* week. Most people saying "next Monday" on a Thursday mean the **coming** Monday, 4 days out. Because this lives in the shared `resolveDue`, the error is not confined to task capture: any deferral, any coaching-set date, any recurrence anchor that routes through the relative-date union inherits it.

## 2. The decision

Two clean options; pick one and apply it consistently:

**Option A — define `which:"next"` in `resolveDue`.** Treat `which:"next"` as "the coming occurrence of that weekday" (the nearest future one), and reserve the +1-week meaning for an explicit `which:"following"` or a count. The model keeps emitting `next`; the *resolver* fixes the interpretation. **Advantage:** one place, deterministic, no dependence on model behavior. **Cost:** if a user genuinely meant "not this Monday, the one after," they're now off by a week in the other direction — but that's the rarer intent, and coaching/editing can correct it.

**Option B — teach the guides to prefer `which:"this"`.** Have the extraction and coaching system prompts steer a bare "next \<weekday\>" toward `which:"this"` (the coming one), reserving `which:"next"` for genuinely week-after phrasing. **Advantage:** the emitted spec matches intent. **Cost:** it's a *model-behavior* claim — it must be confirmed on-device (a `P` creeps in), and the 4B may not comply reliably, which is exactly the class of problem the deterministic layer exists to absorb.

**Recommendation: A.** The whole architecture's principle is that determinism catches what the model gets wrong (constraint #3, the grammar guard, the app-side crisis gate). A date-resolution ambiguity is squarely a "fix it in the deterministic layer" case, and it avoids a device round-trip. Option B is defensible only if there's evidence the resolver can't disambiguate without losing a legitimate meaning — argue that in the proposal if so.

## 3. Scope guard

- **This is `resolveDue`'s ambiguity, not task 36's.** Task 36 advances recurrence periods and does adjacent weekday math; it is told to consume whatever `resolveDue` decides, not to re-litigate it. Whatever this task rules, task 36 inherits.
- **Add a fixture** either way — a Thursday→"next Monday" case pinned to the ruled interpretation, so a future change can't silently regress it.
- If Option B, **it needs a Phase-B device check** that the guide actually changes the emitted `which`; Option A needs only a unit fixture.

## 4. Definition of done

- A proposal (A or B, with reasoning) put to Jason; the ruling recorded.
- The fix applied in `resolveDue` (A) or the guides (B), consistent across extraction and deferral.
- A fixture pinning the ruled interpretation; full suite + `tsc --noEmit` + `eslint .` clean.
- If B: a device confirmation the emitted spec changed.
- One-paragraph note at `docs/eval/task22_findings_report.md`: the ruling, where it landed, and confirmation task 36 is consistent with it.
