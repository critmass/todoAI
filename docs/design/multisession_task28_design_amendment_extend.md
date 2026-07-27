# Amendment to the Task 28 Design — Extend splits into two affordances

**Status:** ruling, 2026-07-20. **Ruled by:** Jason. **Recorded by:** coordinator.
**Amends:** `docs/design/multisession_task28_design.md` §4.1, §4.2, §4.3.
**Binds:** task 13 (state, §1.4 of its brief), task 24 (surface), task 17 (a new estimate signal).
**Everything in the design not named here stands unchanged** — the park primitive, the fold, the neglect re-anchor, the resume claim, and the regenerate-don't-shift rule for long stretches are all untouched.

---

## 1. What changed

The design specified **one** extend affordance ("Keep going", +25-minute quanta). That collapsed two different user intents into one control:

- *"I'm ninety seconds from done."*
- *"I'm in flow — don't stop me."*

They want opposite things from the app. The first wants the countdown to hold still for a moment and the plan left alone; the second is a genuine change in the session's shape. Jason's ruling splits them.

**The end-of-block prompt becomes five options, not four:**

> **Done · +5 minutes · Keep going · Pause for later · Something easier**

| | **+5 minutes** | **Keep going** (hyperfocus) |
|---|---|---|
| Quantum | flat **5 min**, every block size | **25 min**, chainable |
| Timer face | unchanged — a countdown stays a countdown | switches to **count-up** |
| Agenda tail | **shifted** (absorbed into the 25% buffer where there's slack) | **regenerated** (design §4.2, unchanged) |
| Session end | moves only if there is no slack left | moves with the block |
| `sessions.extended` | **not set** | set `TRUE` |
| Guardrail (§4.3) | **exempt** | **governed — option B** |
| Meaning for learning | an **estimate signal** (task 17) | explicitly **not** an estimation error |

## 2. The `+5` path is never capped, and that is load-bearing

No cap, no nudge, no "are you sure", and **no promotion to hyperfocus after N presses** (a promotion rule was proposed and rejected).

Jason's reasoning, recorded because it must survive future refactors: *not knowing how much longer something will take is the executive-function symptom this app exists to absorb, not a behavior to correct.* A cap on `+5` would turn the control into a small accusation delivered at the exact moment the user is trying to finish something. Any future friction added to this path is a bug against this ruling, not a tuning choice.

What happens instead is a **conversation later** (§3) — the same "nudge in the flow, coaching at the seam" pattern the three original triggers already use.

## 3. Repeated `+5` → `repeated_extension` coaching

**Trigger.** Within one session on one task, whichever comes first:
- **Count arm** — the 3rd `+5` press.
- **Percentage arm** — cumulative `+5` minutes ≥ **50% of `estimated_duration`**, with a **≥10 cumulative minutes floor** so a 10-minute task cannot trip on a single press.
- **Floor-typed tasks and blown estimates being treated as open blocks: count arm only.** A floor has no ceiling to be past.

*(The ≥10-minute floor and the floor-typed exclusion are coordinator defaults on top of Jason's "3 or 50%, whichever comes first". Both make the trigger fire strictly less often. Flagged here so they're visible, not buried.)*

**Enqueue at task close, not at press** — the useful conversation needs the real total, which doesn't exist until the task ends. **One row per task per session**, deduplicated.

**Row:** `pattern_detected`, `trigger_data: {kind: 'repeated_extension', presses, cumulativeMinutes, estimatedDuration}`, urgency `next_start`. The trigger type already exists in `coaching_queue`'s CHECK — **this needs no migration.**

**Resolution:** the existing `modify_task(duration)` tool. The conversation is the human route to a better estimate; task 17's time-estimation loop is the automatic one. They corroborate rather than compete — and per spec §5.4, a `duration_source='model_guess'` estimate should yield to either one readily.

**Framing:** not a skip, not a failure, not a scolding. The system misjudged the task, not the user.

## 4. The guardrail question (§4.3) — RULED: B, hyperfocus only

Option **B — nudge cadence, never a wall.** Ship the design's three switches **on**:

1. A one-line self-care check on the prompt every **second consecutive** hyperfocus quantum (~50 min). One tap still continues; never blocking.
2. A stretch beyond **2× the original block** queues `pattern_detected` with `trigger_data: {kind: 'long_extend'}`, urgency `next_start`.
3. All three remain independent flags, so cadence stays tunable without a redesign.

**The guardrail never touches `+5`.** The split is what makes B safe to ship: the "almost done" case can no longer be caught by a self-care nudge aimed at hyperfocus.

## 5. Why this is better than the single button

Worth keeping, because it's the argument for not quietly re-merging them later:

- **The guardrail stops being a compromise.** A single button forced one policy onto both intents; whatever you chose was wrong for one of them.
- **`+5` is clean data.** A task that needs +5 three sessions running has a bad estimate — a far better signal for task 17 than the design's fallback of inferring it from a blown estimate. Hyperfocus, by contrast, is explicitly *not* an estimation error, especially on floor-typed work. The split separates two signals that were previously indistinguishable.
- **The tail-handling difference is real.** Regenerating the agenda after five minutes is churn; shifting it after a 75-minute hyperfocus stretch is stale. One button had to pick one behavior for both.

## 6. Downstream

- **Task 13** — brief §1.4 rewritten around both paths; owns the state, both mutations, and the `repeated_extension` enqueue.
- **Task 24** — five-option prompt; two distinct controls with distinct weight (`+5` is the light, frequent one). Microcopy must not make `+5` feel like a concession.
- **Task 17** — `repeated_extension` rows and the resulting `modify_task` edits are an estimate-quality signal; the `accumulated >= estimated_duration` seam named in design §2.3 now has a companion.
- **Task 35** — folds this amendment into the spec's §8.7 / §6.2.
- **`EXTEND_QUANTUM_MINUTES = 25`** stands; add `SHORT_EXTENSION_MINUTES = 5` beside it.
