# Task 7 Phase B Findings — extraction correctness 10/16 → 15/16, and why

**Question:** Task 6 confirmed the provider produces *valid* structured output (4/4 JSON, 4/4
validator-passing, first attempt). Task 7's target is *correct* — right fields, right recurrence
type, right due date — which is empirical on a 4B and cannot be judged headless. This is the
draft→run→observe→adjust loop against the real Ternary-Bonsai-4B.

**Verdict: the extraction half is GREEN.** Critical-correct went **10/16 → 15/16** across five
prompt iterations, junk tags to ~0, and the D6 ask-don't-guess behavior from **0/5 (never asks)**
to **8/9 discriminated** (asks on ambiguity, stays quiet when the user was explicit). The
remaining single failure is a fixture whose own gold marks a clarifying question acceptable.
Coaching prompts are **not** covered here — that half of task 7 is still open.

**Date:** 2026-07-16 · **Device:** Samsung Galaxy S23 FE (`R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf` · **`llama.rn`:** 0.12.5 · Greedy (temp 0, top_k 1).

**Read first:** [`task6_phaseB_findings_report.md`](task6_phaseB_findings_report.md) (the provider
this runs on, and the Task 7 targets it handed over) and
[`docs/briefs/opus_batch_B_device.md`](../briefs/opus_batch_B_device.md).

---

## 1. The KPI, iteration by iteration

Measured over all 16 seed fixtures ([`extraction_fixtures_seed.jsonl`](extraction_fixtures_seed.jsonl))
through the **real** task-7 prompts (`assembleExtractionPrompt` / `EXTRACTION_FIELD_GUIDE`), the
real provider, the real D10 ladder, and the real validator. "Critical-correct" = every field in a
fixture's `critical` list is right — the headline. Scored by
[`src/dev/extractionScoring.ts`](../../src/dev/extractionScoring.ts) (pure, unit-tested).

| Run | Prompt change | valid | **critical-correct** | recurrence wrong | junk tags | avg tags |
|---|---|---|---|---|---|---|
| baseline | Phase A drafts as written | 16/16 | **10/16** | 6 | 2 | ~3 |
| iter 1 | abstention reframe; inverted recurrence tree | 16/16 | **12/16** | 4 | 0 | — |
| iter 2 | teach `count`; keep days in `scheduled_quota`; duration realism | 16/16 | **12/16** | 4 | 3 | ~3 |
| iter 3 | walk back duration_from_user; anti-tag-spam | 16/16 | **15/16** | **1** | 3 | **1.5** |
| iter 4/5 | D1 recap only (does not affect the constrained call) | 16/16 | 15/16 | 1 | — | — |

**Greedy decoding makes each run a clean measurement**: temperature 0 / top_k 1 is deterministic,
so an identical prompt yields identical output. Every delta above is attributable to the prompt
edit, not sampling variance — which is why single runs are trustworthy here.

**Both of the targets task 6 handed over are closed:** `due_resolved` went 2 wrong → **0** (the
`due:null`-despite-a-date miss is gone), and the junk `:`-prefixed tag elements largely
disappeared once the tag rules tightened.

## 2. The baseline was not what its headline said

Baseline critical-correct read 10/16, which looks like a passing grade. It wasn't: **the model
emitted `recurrence: null` on 13 of 16 fixtures.** Only 8 fixtures have gold `null`, so a model
that emitted `null` unconditionally scores 8/16. The 4B earned exactly **two** beyond that.

Every critical failure was the same shape — *should be non-null, said null*:

| Fixture | User said | Gold | Baseline |
|---|---|---|---|
| simple-scheduled-01 | "every Tuesday" | `scheduled{tuesday}` | `null` |
| trap-unsched-01 | "ongoing, I never really finish it" | `unscheduled` | `null` |
| trap-unsched-02 | "keep up indefinitely" | `unscheduled` | `null` |
| count-01 | "review it 10 times" | `count{10}` | `null` |
| count-vs-quota-trap-01 | "20 total, then I'm done" | `count{20}` | `null` |
| sched-vs-schedquota-01 | "every Mon, Wed and Fri" | `scheduled{m,w,f}` | `scheduled_quota` (invented quota) |

The two `trap-unsched-*` rows are the spec's **zero-tolerance** case: a silent `null` archives an
ongoing project after one work session.

**Diagnosis: the 4B over-asserts.** It filled every field with a plausible default rather than
abstaining — `energy` non-null 15/16, `importance_user` = 5 on 12/16 (the middle of the scale),
`duration_from_user` = true on 8 fixtures where the user stated nothing, and both `due` misses were
*invented* deadlines.

**And the Phase A prompt invited it.** It opened with *"Fill every field; use null where a value is
unknown"* — heard as "fill every field". Worse, for recurrence `null` does not mean "unknown" at
all: it is a **positive claim** ("one-off, finished forever once done"). The guide conflated the
two while listing the null branch **first** in a "pick the FIRST that fits" tree.

Iter 1 reframed the whole guide around abstention (null/`[]` are correct answers, not failures;
guessing allowed only where a field says so) and inverted the tree to ask "does this repeat?"
first with `null` last. That single change carried most of the gains: critical 10→12, junk 2→0,
energy wrong 16→7, importance 16→9.

## 3. The finding: upstream field noise degrades downstream correctness

After iter 2 the loop looked stuck — critical-correct sat at 12/16 twice, and the recurrence tree
was **ricocheting**: each nudge fixed one branch and broke another (`trap-unsched-02` passed in
iter 1, failed in iter 2; `sched-vs-schedquota-02` was wrong in three different ways across three
runs). The obvious read was a structural ceiling: recurrence is a 6-branch discrimination
generated **last**, ~80–100 tokens after its decision tree, by a 4B at temp 0. The natural
remedies were architectural — move recurrence earlier in the key order, or decide it in a
dedicated staged call.

**That call was wrong, and the device refuted it.** Iter 3 touched **only** the
`duration_from_user` and `context_tags` wording — **the recurrence tree was not modified** — and
recurrence went from **4 wrong to 1**, every trap passing.

The mechanism: `context_tags` is generated *before* `recurrence`, and iter 2 had the model dumping
the entire known tag vocabulary plus junk fragments into every task (`"take out the trash"` →
`["home","office","phone"]`). Once the upstream field emitted one or two precise tags instead of a
noisy spray, the downstream decision cleaned up. Average tags 3.0 → 1.5; recurrence 4 → 1.

> **Under a fixed-key-order, grammar-constrained generation, the fields are not independent.
> Garbage emitted early degrades the correctness of fields decided later in the same greedy pass.**

This is a load-bearing insight for tuning here: it means "key order = generation order" (strategy
D3) is not just a shape decision, and that the cheapest fix for a stubborn late field may be
cleaning up an unrelated early one. No grammar change was needed.

## 4. Prompt changes ricochet — measure every field, not the field you aimed at

Every iteration that fixed its target broke something else, and only a full per-field breakdown
caught it:

- **Iter 1** fixed abstention but made the model *lazy on the one field it is supposed to guess*:
  `estimated_duration_minutes` collapsed to a constant `10` (7/16), and `floor-duration-01`
  regressed — the user said *"it'll take at least an hour"* and it answered
  `duration_from_user: false`.
- **Iter 2** fixed `count` and duration, then over-corrected `duration_from_user` to **true nearly
  everywhere** (6 → 13 wrong) because the rule listed four examples of stated lengths.
- **Iter 2** also introduced the tag-vocabulary dumping that §3 turned out to hinge on.

A 4B at its capability ceiling responds to emphasis by overshooting. The per-field failure table
(not the headline KPI) is what makes this survivable.

## 5. Two oracle bugs found — one hiding a regression

The scorer is the thing every tuning decision keys off, so its own defects are expensive:

1. **`context_tags_must_include` is a SUBSET check** — so a model that dumps the entire known
   vocabulary passes it *every time*. Iter 2 did exactly that and the KPI reported `context_tags`
   as nearly fine. The regression was invisible. Fixed by tracking `tagCount`/`avgTagCount` as a
   **signal** rather than a score: `must_include` is a minimum, so extra tags cannot be called
   wrong without inventing gold. **A real `must_not_include` belongs in the fixtures — recommended
   for task 20's harness.**
2. **The ask probe had no negative arm** (see §6).

## 6. Ask-don't-guess: 0/5 → 8/9, and the probe that lied

**The constrained call can never ask** — the grammar forces a complete object, so a clarifying
question is structurally impossible there. The prose recap turn (D1) is the *only* place a question
can happen. If it doesn't ask there, the app guesses silently.

| Run | asked (5 ambiguous) | quiet (4 clear) | **discriminated** |
|---|---|---|---|
| iter 3 prompt | 0/5 | — (no control) | — |
| iter 4 | 5/5 | **0/4** | **5/9** |
| iter 5 | 4/5 | **4/4** | **8/9** |

- **0/5:** the recap instruction said only *"restate what you understood … just the sentence"* —
  later and more specific than the field guide's ASK rule, so restating won. It confidently
  recapped *"applying to 20 jobs is **a one-time thing**"* — the exact silent wrong guess D6
  exists to prevent. **The prompt structurally forbade the question.**
- **Iter 4 scored 5/5 and was still broken.** The probe set contained only ambiguous fixtures, so
  it could not detect the obvious over-correction: a model that asks about *everything* also
  scores 5/5. The control arm showed it asked on 4/4 **clear** inputs — including
  `simple-scheduled-01`, where the user had literally said "every Tuesday" and it still asked *"Is
  this a one-time thing, or something that happens regularly?"*. Without the control this would
  have shipped as "ask-don't-guess works".
- **Iter 5** made restating the default and asking a tested exception ("if their words already give
  the frequency … it IS settled — restate, do not ask"; "never ask about something the user
  already told you"). 8/9.

> **A probe with only positive cases cannot distinguish "works" from "always fires."** Every
> behavior probe needs its negative arm.

The one remaining non-ask (`sched-vs-schedquota-02`) is defensible: its gold marks
`clarify_ok`, i.e. a question is *acceptable*, not required — and its recap was accurate.

## 7. The last critical failure, and a lead worth pulling

`sched-vs-schedquota-02` ("I want to run 3 times a week, aiming for Monday, Wednesday and Friday")
is the only remaining critical miss: the constrained call emits `quota{3,week}` and **drops the
days**; gold is `scheduled_quota{3, week, m/w/f}`.

But its **prose recap understands it perfectly**: *"The task is to run 3 times a week, aiming for
Monday, Wednesday, and Friday."* Both facts, correctly held — in the turn that precedes the
constrained call.

**That is D1's thesis stated by the device**: run the recap, keep it in context, and let the
constrained pass *transcribe* the recap rather than re-derive the answer. The harness currently
measures the constrained call **without** a preceding recap turn, so the full D1 flow is untested.
Wiring recap→constrain and re-measuring is the obvious next move and may close the last gap.

## 8. Known-imperfect, deliberately left

- **`fully-correct` is 0/16 in every run.** It is driven entirely by NON-critical fields —
  `energy`, `importance_user`, `duration_from_user`. Some of this is genuine model weakness
  (importance still invented on 8/16). Some is **gold subjectivity**: gold expects `energy: "high"`
  for "hit the gym" but `null` for "take out the trash" — both are inferences from task nature, and
  the boundary is a judgment call. The prompt was deliberately **not** tuned to chase a subjective
  oracle on a non-critical field; that would be over-fitting.
- **The extraction guide is now over its ~250-token budget** (strategy §5.2). The abstention rules
  and the recurrence tree earned their tokens; trimming should be measured, not assumed.
- **Junk elements are not fully gone** (~2–3/run: `"],"`, `":inspected"`). The validator legally
  permits them (it does not police tag semantics), so they remain a tracked signal.

## 9. One-line call

**GREEN on extraction** — 15/16 critical-correct, both handed-over targets closed, ask-don't-guess
discriminating 8/9. The gains came from reframing the prompt around **abstention** and from
cleaning **upstream** noise, not from grammar changes. **Task 7 is not complete**: the coaching
prompts (tone, scope, disposition, crisis path) are untested, and the D1 recap→constrain flow (§7)
is unmeasured.

## 10. Reproduction

- Harness: [`src/dev/Task7PromptScreen.tsx`](../../src/dev/Task7PromptScreen.tsx) — the default
  "Task 7" screen. **Quick (4)** for iteration, **Full (16)** for the KPI (~10 min),
  **Ask-don't-guess** for the D6 probe (both arms).
- Oracle: [`src/dev/extractionScoring.ts`](../../src/dev/extractionScoring.ts) + tests;
  fixtures via `node scripts/gen-extraction-fixtures.js` (generated from the .jsonl — never
  hand-transcribed, since a hand-copied oracle is how you get a scorer that lies).
- Loop: edit `src/llm/prompts/fieldGuides.ts` → relaunch → re-run → compare KPI. One commit per
  iteration, so each KPI movement is attributable (`git log --oneline --grep "Task 7"`).
- Results log as chunked `[T7RESULT:*]` lines; capture with `adb logcat -s ReactNativeJS:*`.
