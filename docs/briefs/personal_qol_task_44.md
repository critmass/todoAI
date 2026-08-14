# Task 44 — Personal-use QoL pass

**Owner:** **Sonnet** for the screens; **Jason** rules §3 and §4 first.
**Status:** ⬜ open. `P`. **Gates nothing** — pure quality-of-life for Jason's own alpha use.
**Sequencing:** batch onto **task 41's device session** rather than paying device setup twice. Kept a separate task so 41's diff stays reviewable and 41 never blocks on a product ruling it has nothing to do with.

---

## 0. Why these aren't part of task 41

Requested alongside 41, deliberately numbered apart:

- **41 is on the critical path with a closing window.** The corpus can only be collected before task 43 drops free-text capture at open beta. Anything bolted onto 41 slows the one task whose clock is actually running.
- **41 is capture infrastructure; this is product UI.** Different files, different failure modes, different reviewer.
- **Two of these four need a ruling from Jason before they can be built.** Bundling them would block capture on decisions about session semantics.

The batching benefit is real and is preserved by scheduling, not by merging: both want the same device session.

---

## 1. Model warm-up on coaching-screen open

**Ask:** load the model when the coaching screen opens, not after the first prompt is sent.

**This is compatible with the existing design and is the smallest item here.** `src/app/chat/modelHost.ts` already exposes `ensure()` and a `phase()` of `'idle' | 'loading' | 'checking_grammars' | 'ready' | 'failed'`, built precisely so "a 3-second load is explained rather than felt." The change is *when `ensure()` is called* — on screen mount rather than on first send.

**Constraint #3 is not at risk.** The startup guard compiles every grammar before any token is generated; calling `ensure()` earlier moves the guard earlier too, which is strictly safer. The deliberate decision it must not undo is loading at *process launch* — a timer-only session never needs the 4B, and `modelHost.ts`'s comment records that reasoning (~3 s and real heat on this hardware). Screen-open is the right middle.

**Watch for:** mount-then-immediately-navigate-away leaving a load in flight. `ensure()` already dedupes via `inFlight`; confirm the failure path still surfaces `'failed'` to a screen that's no longer mounted without throwing.

---

## 2. The timer dial — ⚠ your premise is wrong, and the fix has a cost

**Ask:** "at some point the dial countdown got turned into a linear bar, can we bring back the dial?"

**Nothing regressed. The dial has never existed in the app.** `src/app/screens/WorkScreen.tsx`, lines 1–5:

> *"There is no conic-gradient in RN without a new dependency, so progress renders as a plain horizontal bar under the circle rather than a fragile hand-rolled arc (explicitly acceptable — preferable, even — per the task brief)."*

The dial you remember is in **task 23's HTML prototype** (`Main Screen.dc.html` line 821), where `conic-gradient` is one line of CSS and free. React Native has no equivalent. Task 24 made a documented, brief-sanctioned choice; it did not drift.

**So this is not a bug fix — it's implementing a prototype element the functional pass consciously deferred**, which puts it in **task 23/24's designed visual pass**, already a beta gate.

**Two paths, and the cost is real:**

| Path | Cost | Risk |
|---|---|---|
| **`react-native-svg`** — the standard answer, gives a clean arc | A **new native dependency** in a bare RN 0.86 New Architecture build | ⚠ Task 24 §9.6 documented a `.cxx` codegen **build trap** when adding a native module; it's in `README_build.md`. Not fatal, but it bit once already. |
| **Hand-rolled arc** from plain `View`s (two rotated half-circle overlays, the standard RN trick) | No dependency | Exactly the "fragile" option the existing comment rejected. Fiddly at boundaries, and worse with the count-**up** hyperfocus mode, which has no fixed denominator. |

**Recommendation: don't do this in task 44.** Fold it into the designed visual pass, where a dependency decision gets made once for the whole visual layer rather than for one control. If you want it sooner anyway, that's legitimate — pick the path, and expect the build trap.

---

## 3. Launch a session for one specific task 🔴 needs a ruling

**Ask:** a button on the task view that starts a session for that task, skipping the normal workflow.

**The plumbing is easy; the semantics are a contract question.** `runSelectionBoundary` is documented as **"the pool's only entry"** — capability pre-filter → dependency pre-filter → ranker, with both reject sets retained. A direct launch walks around it.

**What must be ruled — what happens when the chosen task is filtered:**

- **Dependency-blocked** (it has an incomplete prerequisite). Does the button start it anyway, refuse, or offer the blocker? Starting it silently means the app now serves a task its own scoring says can't be done — and U1's pre-filter exists specifically because ordered chains served out of order was a real defect (task 10/25).
- **Capability-filtered** (wrong context or missing tools for this session). Lower stakes — Jason knows why — but it should be a deliberate override, not an accident.
- **Held out for `breakdown_complete`** (R7: a parent awaiting the user's check-off is deliberately out of the pool). Direct launch would resurrect exactly what R7 holds back.

**Recommendation:** launch honours the **dependency** filter (refuse with a "blocked by X" affordance) and **overrides** the capability filter with a visible note. That keeps the one filter whose bypass causes real harm and relaxes the one that's advisory. But it's a product-intent call and it's yours.

**Also decide:** does the direct-launch session get the normal check-in flow (energy, context, duration) or jump straight to the timer? "Skipping the normal workflow" suggests the latter — but `sessions` needs `user_energy_start`, and 24 owns those two user-supplied fields. If check-in is skipped they're null, which is legitimate but should be an intentional null rather than a hole.

---

## 4. Mark a task done that you finished away from the app 🔴 needs a ruling

**Ask:** a button to mark a task complete when it was finished outside the app.

**The completion primitive already exists and must be reused, not re-implemented.** `src/services/taskCompletion.ts` → `completeTask()` already branches correctly between `tasks.update({status:'completed'})` and `tasks.recordUnscheduledCompletion()` by recurrence type — that's constraint #7 (`null`/one-off ≠ `unscheduled`, opposite completion semantics), and it also runs the cumulative fold from task 33 and interacts with task 36's recurrence advance. **Do not hand-roll a second completion path.** The button calls `completeTask`.

**What must be ruled — what an out-of-app completion means to the learning layer:**

- **Does it write an `interactions` row?** There was no episode, no duration, no energy. A `task_completion` interaction with null runtime fields is honest; inventing a duration is not.
- **Does it count toward `completion_count` / `success_rate`?** Those have **no writer anywhere** today — `historicalSuccessFactor` scores every task off a permanent n=0, and **task 17 owns that writer** (task 13 report §7). So this button is a candidate *first* writer, which makes the ruling load-bearing: a completion with no episode is a success by outcome but carries no evidence about *estimation*, which is what the loop is trying to learn. Counting it as a normal success would poison duration learning with a sample that has no duration.
- **Recurrence:** completing a `scheduled` task out-of-app must still advance `next_due_at` through task 36's engine, or urgency goes stale — the exact bug 36 fixed.

**Recommendation:** write the `interactions` row with explicit null runtime fields and a distinguishing marker, and **exclude it from duration-estimation learning while counting it for completion/neglect**. Then task 17 inherits a clean signal instead of a contaminated one. Yours to rule.

---

## 5. Deliverables

1. §1 wired; §3 and §4 built against the rulings; §2 deferred or built per the §2 decision.
2. `TaskListProps` / task-view contracts extended for the two new actions — the screens stay presentational (`screens/contracts.ts`; no screen imports a repo, a service, `src/execution`, `src/planning`, or a clock).
3. Tests for the new controller paths, in the existing headless style against `better-sqlite3`.
4. `docs/eval/task44_findings_report.md` — short. Must record the §3/§4 rulings as built, so task 17 inherits them rather than re-deriving.

---

## 6. Done means

- All four items confirmed **on the S23 FE**, DB-verified in the project's usual way — the out-of-app completion in particular, checked against the pulled DB for correct primitive, correct recurrence advance, correct `interactions` row.
- No second completion path exists.
- No screen gained an import it isn't allowed to have.
- The rulings are written down where the learning loops will find them.
