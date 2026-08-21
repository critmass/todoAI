# Task 50 — pin the `energy` field definition (Jason + Opus)

**Brief written by the coordinator, 2026-08-21.** 🔴 **This task GATES task 31** and must precede it.
It is not a build task — it is a **definition** task, run as a working conversation between Jason and
Opus, ending in one pinned paragraph. No code is required to *decide* it; a tiny prompt-string edit
and a gold-labeling rubric are the downstream products.

**Format (from the board):** *Jason and Opus hammer it out together, not a document handed over.* The
session is a back-and-forth that converges on a definition, not Opus producing a doc for Jason to
approve. The init prompt at the bottom sets that up.

---

## 1. Why this exists, and why it's first

`energy` scored **6–14/16 on every model measured, including Bonsai** — the best extractor on the
board. When *all* models fail a field at that rate, the cause is an **ambiguous field definition**,
not weak models (a LoRA would paper over it; a clearer definition fixes it for free, with no
migration). Two hard consequences make it first, not parallel, with task 31:

- **Writing 100+ golds against an ambiguous definition bakes the ambiguity in permanently.** Task 31's
  corpus is the measuring instrument for the whole model-migration decision (`31 → 38 → 40`). If the
  `energy` golds encode a definition nobody can read consistently, every downstream number for that
  field is noise dressed as signal.
- **The collection window closes at open beta** (task 43 drops free-text capture). There is no second
  pass at the corpus, so there is no second pass at this.

## 2. What the field is *now* (read the real text, then criticise it)

- **Field guide** — `src/llm/prompts/fieldGuides.ts:51`:
  > `- energy: "low" | "med" | "high" ONLY if the user described the effort or energy. Otherwise null. Most tasks → null.`
- **Scale** — `src/types/scales.ts`: user `low/med/high` → internal `1/3/5`. **Internal 2 and 4 are
  reserved for the app's behavioural discounting off learned `average_energy_cost` (spec §4.1/§5.4),
  assigned by scoring logic — never user-entered, never model-emitted.** Extraction can only produce
  1/3/5. (constraint #6: never write a user-facing value directly; always project through `scales.ts`.)

## 3. The two ambiguities to resolve (this is the actual work)

**A — What does "energy" mean?** The guide says "the effort or energy" and stops. For an ADHD app that
underdetermines the answer, and the candidates genuinely diverge:
- **physical exertion** — "hit the gym" is high, "take out the trash" is low;
- **cognitive / executive load** — "reconcile the bank statement" is high, "hit the gym" is low;
- **activation / initiation cost** (the ADHD-native reading) — "take out the trash" can be *high*
  despite trivial physical and cognitive load, because the barrier is starting.

These are not shades of one thing; they rank the same task oppositely. **Pick one, or a stated blend
with a tie-break rule** — and say why it serves *this* app (the scoring model, the coaching, the
`energy` check-in seam at session start, spec §6.2). This is the load-bearing decision.

**B — The null convention: intrinsic property, or only-if-stated?** The current guide says energy is
recorded **only if the user described it** ("Otherwise null. Most tasks → null"). But the seed gold set
behaves inconsistently: it expects **`high` for "hit the gym"** (inferred from the task's nature —
the user did *not* state energy) and **`null` for "take out the trash"** (not stated). Gym's energy was
no more "described by the user" than the trash's. **So the gold set itself encodes the contradiction**,
and this is very likely a large share of the 6–14/16. Decide one:
- **(i) intrinsic** — energy is a property of the task the model *infers* whenever it reasonably can
  (gym→high, trash→per the §3A definition), sparingly null; or
- **(ii) only-if-stated** — energy is null unless the user actually voiced effort/energy, and gym→null
  too (matching the guide as written).

Whichever wins, **the gold set must be re-labelled to obey it** — the current mixed labels cannot
stand. Task 7 Phase B *deliberately did not tune this* (it judged chasing a subjective oracle on a
non-critical field to be over-fitting) — which is exactly why it is still open and yours to settle.

## 4. The scope decision (small, likely quick)

Confirm that **internal energy 2 and 4 are out of extraction scope** — extraction emits only
`low/med/high` (→ 1/3/5); 2/4 are app-assigned discounting and are never a label the model or the gold
set produces. (Recommend: yes — this is already how `scales.ts` is built; just make it explicit so
task 31 never writes a 2 or 4 gold.)

## 5. Deliverable

1. **One paragraph a human and a 4B read the same way** — the pinned `energy` definition. It becomes
   (a) the replacement for `fieldGuides.ts:51`'s energy line (keep it **tight** — the extraction guide
   is already over its ~250-token budget, strategy §5.2), and (b) the **gold-labeling rubric** task 31
   labels every `energy` gold against.
2. **The null-convention ruling** (§3B, i or ii) and **the re-labeling note** — what changes in the
   existing seed golds (at minimum the gym/trash pair), so task 31 starts from a consistent set.
3. **The scope confirmation** (§4).
4. **The escape hatch, if taken:** if no definition survives scrutiny as crisply readable, the ruled
   fallback is to **mark `energy` NON-CRITICAL for the corpus** — task 31 tags it non-critical and the
   bake-off (task 40) excludes it from the critical-field resolution. Legitimate and cheap; say so
   explicitly rather than shipping a fuzzy definition.

Write the result into **`docs/design/energy_definition_task50.md`** (a short design record), and note
in it the two downstream consumers: the `fieldGuides.ts:51` edit and `docs/briefs/real_task_corpus_task_31.md`.

## 6. Guardrails

- **Do not over-tune to Bonsai.** The whole point of `31 → 40` is to *measure* models against each
  other; a definition reverse-engineered to make the incumbent score well contaminates the very axis
  the bake-off exists to read. Define what's *right for the app*, then let 40 measure who extracts it
  best.
- **No migration, no schema change** — `energy_requirement`'s domain (1–5) is unchanged; this is a
  definition + a prompt string.
- **Project through `scales.ts`** (constraint #6). The two-level scale stays; you are defining what the
  user-facing `low/med/high` *means*, not changing the numbers.

## 7. Read these, in order

1. This brief.
2. `src/llm/prompts/fieldGuides.ts:51` (the current guide) and `src/types/scales.ts` (the scale + the
   2/4 note).
3. `src/llm/extraction/task_extraction.v1.gbnf` — the `energy` slot as the grammar constrains it.
4. `docs/eval/task7_phaseB_findings_report.md` — how the extraction guide was tuned and *why energy was
   left alone*; the gym/trash gold expectation lives in this lineage.
5. Spec `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md` — §4.1 (two-level scale),
   §5.4 (learned `average_energy_cost` / the 2-4 discounting), §6.2 (the energy check-in seam at
   session start — a *different* energy field, the user's current energy, but read it so the two
   don't get conflated).
6. `docs/briefs/real_task_corpus_task_31.md` — the consumer, so the definition lands in a form 31 can
   label against.

---

## SESSION-INIT PROMPT (copy-paste into the new session)

> You are Opus, working directly with Jason to settle **task 50 of the todoAI project: pinning the
> `energy` field definition.** This is a definition conversation, not a build — we hammer it out
> together and converge on one paragraph; you do not hand me a finished doc to approve. Task 50 **gates
> task 31** (the model-migration corpus), so getting it crisp matters.
>
> Read first, in this order: `docs/briefs/energy_definition_task_50.md` (your work order — it has the
> full framing), then `src/llm/prompts/fieldGuides.ts:51`, `src/types/scales.ts`,
> `src/llm/extraction/task_extraction.v1.gbnf` (the `energy` slot), `docs/eval/task7_phaseB_findings_report.md`
> (why energy was deliberately left untuned; the gym/trash gold pair), and spec §4.1/§5.4/§6.2 in
> `docs/reference/ADHD_Task_Management_App_Specification_v2.4.md`.
>
> The core of the problem (the brief expands it): `energy` scores 6–14/16 on *every* model including
> Bonsai, which means the **definition** is ambiguous, not the models. Two ambiguities to resolve with
> me: **(A)** what "energy" actually means for this app — physical exertion vs cognitive/executive load
> vs activation/initiation cost (they rank the same task oppositely; "take out the trash" is the test
> case); and **(B)** the null convention — is energy an intrinsic task property the model infers, or
> recorded only when the user states it? The current guide says only-if-stated, but the seed gold set
> expects `high` for "hit the gym" (inferred) and `null` for "take out the trash" — an internal
> contradiction that is probably a big share of the 6–14/16.
>
> Start by putting the sharpest version of both questions to me, with your own recommendation and the
> tradeoffs, and let's converge. The deliverable is: **one tight paragraph a human and a 4B read the
> same way** (it will replace `fieldGuides.ts:51`'s energy line AND become task 31's gold-labeling
> rubric), plus the null-convention ruling, the re-labeling note for the existing golds, and the
> confirmation that internal energy 2/4 stay out of extraction scope. If we can't make it crisply
> readable, the honest fallback is to mark `energy` non-critical for the corpus — name that explicitly
> rather than ship a fuzzy definition. Write the result to `docs/design/energy_definition_task50.md`.
> Don't over-tune the definition to make Bonsai score well — define what's right for the app; the
> bake-off (task 40) measures who extracts it best.
