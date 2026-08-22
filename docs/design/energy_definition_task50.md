# Task 50 — `energy` field definition: rulings and report to the coordinator

**Status: CLOSED.** Settled in session between Jason and Opus, 2026-08-22.
**Gates:** task 31 (real-task corpus). Task 31 is unblocked by this document.
**Escape hatch NOT taken** — `energy` is defined, not marked non-critical.

This is the single record for task 50. Everything decided, discovered, or invalidated in that
session is here, including corrections to the project record that fall outside task 50's original
scope. Nothing was written into other docs or source files; the actions in §7 are for the
coordinator to dispatch.

---

## 1. The ruling in one line

`energy` is **how much it will cost the user to get the task done — making themselves start it and
getting through it — taking whichever of those two is higher.** It is **never null.** It is judged
from the task as described, and the personal/idiosyncratic part of that cost is deliberately *not*
extracted — it is learned by §5.4 and applied through the internal 2/4 discounting.

## 2. The pinned definition (deliverable 1)

This is both (a) the replacement for the `energy` line in `src/llm/prompts/fieldGuides.ts:51` and
(b) the gold-labeling rubric task 31 labels every `energy` gold against. The two must not diverge.

### 2a. Prompt form (the `fieldGuides.ts:51` replacement)

```
- energy: what it costs to get this done — making yourself START it and getting THROUGH it; take
  the higher. Higher if: no obvious first step, unpleasant, open-ended, a call or confrontation,
  hard focus, physically hard. low = just do it (trash, a text). med = needs a run-up or real
  effort (errands, an email thread). high = you psych yourself up for it, or need recovery after
  (gym, taxes, a hard conversation). ALWAYS pick one — never null.
```

**Token cost:** ~90 tokens, against the current line's ~30. The extraction guide is already over
its ~250-token budget (strategy §5.2; noted in the Phase B report §8). This field was carrying a
definition too thin to be applied consistently, so the spend is deliberate. If the budget must be
recovered, take it from `tool_requirements` and the `context_tags` example, not from here.

### 2b. Labeling form (the task 31 rubric — same rule, room to breathe)

Ask: *what will it cost this person to get this done, from deciding to begin through finishing?*
Weigh two things and **take the higher, never the average** — averaging pushes everything to `med`
and the field stops discriminating.

1. **Cost to begin** (the dominant driver). Raised by: no obvious first step; the task is
   unpleasant or aversive; it is open-ended with no clear finish; a decision must be made before
   any movement is possible; it involves a phone call, a confrontation, or social exposure; it is
   boring with no near payoff.
2. **Cost to get through.** Raised by: sustained focus; physical exertion; long duration; emotional
   weight.

Lowered by: short; obvious first step; routine or habitual; mildly rewarding.

| Band | Reads as | Anchors |
|---|---|---|
| `low` | you just do it, no run-up | take out the trash, send a text, dishes, water the plants |
| `med` | needs a run-up, or a real chunk of effort | errands, a short email thread, tidy a room, a load of laundry start to finish |
| `high` | you have to psych yourself up, or you need recovery after | hit the gym, do the taxes, call the insurance company, a hard conversation, a big cleanout |

**Worked test cases** (these two drove the decision; keep them as the rubric's calibration pair):

- **"hit the gym" → `high`.** Physically demanding and takes real recovery. Begin-cost is only
  moderate for many people (defined, habitual, rewarding) but the get-through cost is high, and the
  rule takes the higher. **Ruled explicitly by Jason.**
- **"take out the trash" → `low`.** Short, obvious first step, routine. Mildly aversive, which
  nudges begin-cost up but not out of the band. It is **not** null — see §3.

The trash case is the one that will feel wrong to an ADHD reader on a bad day, and that is
intentional: see §4. It is handled by learning, not by the definition.

## 3. Ruling: the null convention (deliverable 2)

**`energy` is never null. Extraction always emits `low`, `med`, or `high`. Every gold carries a
value.**

Never-null was Jason's intent from the start; it was simply never written down, and the guide as
written (`"ONLY if the user described the effort or energy. Otherwise null. Most tasks → null."`)
said the opposite. That is a documentation failure, not a design error — cheap to fix and now
fixed.

**It is also the only coherent reading of the code as built.** `src/llm/extraction/mapper.ts:59`
maps `energy: null` → `DEFAULT_ENERGY_INTERNAL` (3), and the column defaults to 3. There is no
abstain path: a null is stored as `med` and scored by `energyMatchFactor` as a full claim — 1.0
against a `med` session, 0.5 against a `low` or `high` one. So "most tasks → null" never meant
"unknown"; it meant **silently asserting `med` for the large majority of tasks.** A considered
judgment is strictly better than an accidental default that looks like abstention.

Three further payoffs: it deletes a decision branch for a 4B (usually raising accuracy, not
lowering it); it removes the null-boundary judgment from gold labeling entirely; and it eliminates
the class of contradiction that produced the gym/trash conflict.

**Watch item — abstention doctrine.** Phase B's single largest win was reframing the whole guide
around abstention (`null`/`[]` are correct answers; energy wrong 16→7, junk 2→0). This ruling
carves an exception to that doctrine, and exceptions leak. It is worded as an **enumerated,
closed** exception in the same shape the guide already uses for `estimated_duration_minutes` ("the
ONLY field you may guess"). Whoever edits `fieldGuides.ts` should preserve that shape — energy
becomes the second named field the model may judge, not a general softening. If `importance_user`,
`due`, or tag over-assertion regresses after this lands, this is the first place to look.

**No grammar change.** `task_extraction.v1.gbnf` keeps `energy ::= "null" | "low" | "med" | "high"`.
The grammar stays permissive and the mapper stays tolerant; the *guide* forbids null and the *golds*
never contain one. Do not "fix" the grammar to drop null — that turns a recoverable model slip into
a generation failure.

## 4. What `energy` means, and what it deliberately excludes (deliverable 1, rationale)

Three readings were on the table: physical exertion, cognitive/executive load, and
activation/initiation cost. They rank the same task oppositely, so a blend without a tie-break was
the actual defect.

**Activation cost is what the field was always trying to capture** (Jason's ruling), and the
architecture independently agrees:

- `energyMatchFactor(checkIn.energy, task.energyRequirement)` subtracts the task's value from the
  user's §6.2 session check-in. Both sides must be the same currency. When an ADHD user taps "low"
  at session start, they overwhelmingly mean *I can't make myself start things* — not *my muscles
  are tired*. So the user's side of that subtraction is activation capacity, and the task's side
  must be activation cost.
- **A skip is an initiation failure.** It happens when the task is served, not halfway through it.
  §7.2's three-skip recalibration fires when the app has misjudged capacity *to begin*. A pure
  drain measure would optimize against a failure mode the app never observes.

**The scoping rule — what extraction can and cannot see.** Activation cost splits cleanly:

- **Structural** — visible in the task text, raises begin-cost for essentially anyone wired this
  way: no obvious first step, aversive, open-ended, decision-blocked, socially costly, unrewarding.
  **This is extractable and is what §2 encodes.**
- **Idiosyncratic** — *this* person has avoided *this* thing for eight months for reasons in their
  history. Not in the text. Not knowable by a 4B, and no wording of the guide will make it
  knowable. **This is deliberately out of extraction scope.**

The idiosyncratic half is not dropped — it is routed to the organ built for it. §5.4's learned
`average_energy_cost` drives the internal **2 and 4** levels, which §4.1 describes as correcting the
match *without contradicting the user's own vocabulary*. That is precisely this job. The app does
not know you on day one, and is designed not to need to.

This is the answer to the trash case: on day one the app calls "take out the trash" `low` and a bad
day makes that a lie. The correction arrives as data accumulates, as 3→4 discounting, not as a
fuzzier definition. **Accepted cost, recorded knowingly:** the correction lags the first
observations.

## 5. Ruling: internal 2/4 out of extraction scope (deliverable 3)

**Confirmed. Extraction emits only `low`/`med`/`high` → internal 1/3/5. Internal 2 and 4 are
assigned by scoring logic off learned `average_energy_cost` and are never model-emitted, never
user-entered, and never a gold value. Task 31 must never write a 2 or a 4.**

This was expected to be a formality. It is not — §4 makes it **load-bearing**. The 2/4 band is now
the designated home for the idiosyncratic activation cost the definition deliberately excludes. If
anyone later proposes letting extraction reach 2/4, that is not a scope tweak; it re-opens task 50.

Constraint #6 is unaffected: values continue to project through `scales.ts`, never written directly.

## 6. Corrections to the project record (outside task 50's original scope — please action)

Two findings from this session invalidate things currently recorded elsewhere in the project. They
are reported here rather than edited into their source docs, per the single-record instruction.

### 6a. The 16-fixture bank was thermal-test scaffolding. Its expected values were never authored
as ground truth.

The 16-fixture eval bank was written quickly for **thermal testing** — realistic input strings to
make the model generate tokens under sustained load. Its expected-value column was scaffolding. The
bank then stayed in the project and was used for a preliminary bake-off, where that column was read
as an answer key. Nobody decided to do this; the artifact outlived its purpose and the next reader
assumed it was built for what they were using it for.

The expected values were also **model-generated** (by a different model than the one under test —
better than self-grading, but not much: neither model had a rule to apply, so the disagreements
measured two arbitrary choices, not capability).

**Consequence: `energy` 6–14/16 must stop being quoted as evidence of anything.** It is not a floor
on model capability and not a measurement of definitional ambiguity. It should be annotated at every
site where it appears — `docs/eval/task7_phaseB_findings_report.md` (§8 "Known-imperfect,
deliberately left"), `docs/briefs/energy_definition_task_50.md` §1, and the master task table if it
is quoted there — with one line recording the bank's provenance, so no argument gets rebuilt on it
in three months. **Not done in this session by instruction; flagged for coordinator dispatch.**

Also note this retires the "gold set encodes a contradiction" framing in the task 50 brief §3B. The
gym/trash inconsistency was real, but it was two ungoverned model choices, not a human's judgment
drifting.

### 6b. The task 50 brief's premise was wrong; its conclusion was right.

The brief argued: *every model scores 6–14/16, therefore the definition is ambiguous.* That
inference does not hold — against an arbitrary key, low scores say nothing about definitional
clarity. But the definition **was** ambiguous, on independent evidence: the written guide said
only-if-stated while the actual intent was never-null, and the field had three defensible meanings
with no tie-break rule. Task 50 needed doing. The number was not the reason. Worth recording so the
right lesson is carried forward — *the definition was never written down*, not *the models are weak
here*.

### 6c. Standing rule proposed: a model may draft eval inputs, never its own answer key.

Task 31 is already human-written and replaces the 16 (confirmed by Jason). This generalizes it:
generating capture strings with a model is fine — that is input text. Generating the expected values
is not, at any scale. If task 31 ever generates 100+ golds the way the 16 were made, the same
problem is rebuilt at six times the size and the bake-off (task 40) measures nothing. This is the
kind of constraint that silently reverts when someone is short an afternoon, so it belongs in
task 31's brief as a hard requirement, not a preference.

## 7. Actions for the coordinator

| # | Action | Owner / target |
|---|---|---|
| 1 | Replace the `energy` line in `src/llm/prompts/fieldGuides.ts:51` with §2a verbatim. Preserve the *enumerated-exception* wording shape (see §3 watch item). | prompt edit, trivial |
| 2 | Carry §2b into `docs/briefs/real_task_corpus_task_31.md` as the `energy` labeling rubric, including the gym/trash calibration pair. | task 31 |
| 3 | Add to task 31's brief: **no null energy golds; no 2/4 golds; golds are human-authored, models may draft input strings only** (§3, §5, §6c). | task 31 |
| 4 | Annotate the 6–14/16 figure at its three sites with the fixture-bank provenance (§6a). | doc hygiene |
| 5 | Retire the 16-fixture bank as an eval instrument when task 31's corpus lands. It remains valid as a **thermal** fixture set — that is what it was built for. | task 31 → task 38 |
| 6 | No schema change, no migration, no grammar change. `energy_requirement`'s 1–5 domain is unchanged. | — |

## 8. Open question surfaced, not resolved (for whoever owns task 10 follow-ups)

`REVIEW(task10)` in `src/scoring/factors.ts` flags that `energyMatchFactor`'s distance is
**symmetric** — a high-capacity session is penalized as much for a `low` task as a low-capacity
session is for a `high` one. That was noted as a defensible design fork. **This ruling sharpens it.**
Under a drain reading, symmetry is arguable ("spend the energy you have on matching work"). Under an
activation reading, it is harder to defend: a user with plenty of capacity to initiate can trivially
afford a low-activation task, so penalizing that match looks more like a bug than a preference. Not
in task 50's scope and not decided here — but the fork now leans asymmetric, and whoever picks it up
should know the definition moved under it.

## 9. Consumers of this document

- `src/llm/prompts/fieldGuides.ts:51` — the prompt-form definition (§2a).
- `docs/briefs/real_task_corpus_task_31.md` — the labeling rubric (§2b) and the gold constraints (§3, §5, §6c).
- Task 38 / task 40 — `energy` is a **defined, in-scope field** for the bake-off. The escape hatch
  (marking it non-critical) was available and was **not** taken.

## 10. Guardrail compliance

The definition was derived from the app's own seams — the §6.2 check-in, the §5.1 energy-match
subtraction, the §7.2 skip trigger, and the §4.1/§5.4 2/4 discounting — and from Jason's ruling on
what the field was for. **It was not shaped to make Bonsai score well**, and no measurement of any
model informed it. Task 40 measures who extracts it best; task 50 only says what "it" is.
