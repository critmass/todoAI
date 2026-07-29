# Task 23 — UI/UX design review

*Coordinator review of the design prototype, 2026-07-27. Status: **design substantially done**, three small follow-ups open (§4). The prototype is the interaction + visual deliverable task 24 consumes.*

---

## 1. What exists

Two interactive prototype files in `docs/design/`, built in Claude Design:
- **`Main Screen.dc.html`** — the full app flow: dashboard, task list, task editor, the session check-in (energy → duration → context), tools check, the focus/timer screen, the end-of-block prompt, the session summary, and routing into coaching.
- **`Coaching Screen.dc.html`** — a reusable chat surface, correctly used for *both* task-input and coaching (distinguished by a `title` prop), matching the spec's single-conversational-surface principle.

These are **clickable prototypes with real state**, not static mocks — the timer runs, hyperfocus flips to count-up, the editor round-trips. That makes them a genuine interaction spec, not just a visual one.

## 2. History (why there was a second pass)

The **first** prototype was built quickly to get something clickable and predated several locked rulings. Coordinator review found six divergences; **none were conscious rewrites of the backend** (confirmed with Jason), so it was a reconciliation, not a rethink. A follow-up Claude Design prompt was issued, and the current files are the result. The six reconciliations:

1. **Hidden multi-task agenda.** The first pass served one random task at a time (`Math.random`), which contradicts the hidden-plan model (spec §2.2/§6): the app builds an ordered session agenda and walks the user through it, never showing the whole list. Now: `buildAgenda` builds an ordered slice at check-in, `advance` walks it, exhaustion routes to a real summary. No randomness.
2. **The five-option end-of-block prompt** (Done · +5 · Keep going · Pause · Something easier), replacing a three-button Yes/No/+5 debrief and a separate work-screen hyperfocus toggle. Matches the task 28 extend amendment.
3. **Park ≠ skip** (constraint #11). "Give up" is gone; parking keeps progress (`inProgress: true`) and reads as "comes back later," while declining reads as "the match was wrong, not you."
4. **The escape valve** — an always-present, low-emphasis "this isn't landing → something easier" on the focus screen (design principle #2).
5. **Recurrence editor** rebuilt as the six mutually-exclusive kinds (one-time / schedule / quota-per-period / quota-on-schedule / ongoing / target-count), each revealing only its own fields — replacing a count+recurring combo the data model can't express.
6. **Coaching from repeated skips**, not only low energy — the session-recalibration trigger now has a path.

## 3. Verified correct (read against the code, not the change log)

All six reconciliations are genuinely implemented in the component logic, not merely described. Specifically confirmed:
- `buildAgenda` / `advance` / summary screen — no `Math.random` anywhere.
- `promptPlusFive` adds a flat 300 s, forces `timerMode:'countdown'`, has **no cap, no confirmation, no nag** — exactly the ruling, including the "no friction" clause.
- `promptKeepGoing` flips to `countup` with a `+25 min` target.
- `promptPause` sets `inProgress:true`; pause is gated behind `pauseUnlockSeconds` (45 s) via `canPause`, and under that threshold the prompt shows "Not this one" (a skip) instead — implementing the "bail in the first stretch is a skip" nuance.
- `sessionSkips` accumulates and routes to a coaching check-in at threshold.
- Six recurrence kinds are mutually exclusive; the old combo is gone.
- Tone does the constraint-#11 work: *"Nothing landed this time — that means the plan was off, not you."*

**Not touched, correctly:** the visual system (single green `#3A5A40`, consistent radii, restrained), the chat reuse, the dependency-protected delete, the per-session check-in structure, the timer-as-pause-control interaction. No importance field (importance is coach-inferred, not user-set) — correct.

## 4. Residual gaps (all minor; all "make a ruled behavior visible", not rework)

These are the subject of a short follow-up Claude Design prompt (§5). None blocks task 24 from starting.

1. **Guardrail B is not represented.** The extend amendment §4 rules a self-care nudge every *second* consecutive hyperfocus quantum (~50 min). The prototype chains `Keep going` silently. As the design of record, it should at least show the nudge, or a reader will assume unlimited silent hyperfocus is intended.
2. **The repeated-`+5` → coaching half is invisible.** `+5` is correctly uncapped in the moment, but pressing it 3× (or ≥50% over estimate) is supposed to queue a `repeated_extension` conversation *at task close*. The prototype shows no downstream consequence, so half the ruling is missing from the picture.
3. **Skip threshold is 2, should be 3.** `skipsBeforeCoaching` defaults to 2; the spec's session-recalibration trigger is **3 skips**. One-value fix (it's a tunable prop).

## 5. Follow-up prompt for Claude Design (to close §4)

> Three small changes to `Main Screen.dc.html`, all making an already-decided behavior visible — no rework:
> 1. **Hyperfocus self-care nudge.** When "Keep going" (hyperfocus) has been chained twice in a row (~50 min of count-up), the next end-of-block prompt should carry one extra calm line — e.g. *"You've been in flow a while — water, stretch, still going?"* — with the same options still one tap away. Never blocking, never a wall. It appears only on the hyperfocus path, never after +5.
> 2. **Repeated +5 → a note that a chat comes later.** Keep +5 uncapped and frictionless in the moment. But once +5 has been pressed three times on one task in a session, show a small, non-blocking note at the *session summary* (not mid-task) like *"'[task]' ran long a few times — want to revisit its estimate?"* that routes into the coaching chat. This represents the "conversation at task close" half of the rule; the in-the-moment button stays untouched.
> 3. **Skip threshold to 3.** Change the repeated-skip coaching trigger from 2 skips to **3** (`skipsBeforeCoaching`).
> Leave everything else exactly as is.

## 6. Recommendation

Treat the **design** of task 23 as done once §5 lands. The visual language and interaction model are right and consistent with every ruling. What a prototype *can't* settle — and what's worth a real look when task 24 renders on-device — is the **recurrence editor's usability**: six kinds is a lot of choice for an ADHD-minimal surface, and the pill-that-reveals-fields pattern needs to feel light in practice, not just in the mock.

## 7. Handoff to task 24

Task 24 (product UI implementation) consumes both prototype files as the interaction/visual spec, and separately consumes task 13's `src/execution/` API as the behavioral contract (report §8). The prototype's timer is a `setInterval` — fine for a mock, but **the real expiry alarm must be a platform primitive** (constraint #13). The prototype's agenda-building and easier-path are mocked (first-N / shortest-first); the real selection logic is task 11's `runSelectionBoundary` and `replanRemaining`. Task 24 wires the real ones behind the same screens.
