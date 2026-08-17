# Task 41 — capture format: Jason's rulings on §12

**Amendment to `docs/design/capture_format_task41.md`.** Same pattern as
`multisession_task28_design_amendment_extend.md` — the parent document is left as written (it is the
record of what was asked, and §12 is the question list as it stood); this document carries the
answers and states what each one changes. Where the two disagree, **this one wins.**

**Ruled by Jason, 2026-08-17**, across two passes in the Phase-1 review session.
**Phase 2 is not started.** Nothing exists in `src/` — the only artifacts are the parent design
document and this one.

---

## 1. The rulings

| § | Question | Ruling | Changes in the parent |
|---|---|---|---|
| 12.1 | Storage mechanism | **(a) A new app-owned TurboModule with a synchronous append.** | §1 — option A is now the design, not a recommendation. |
| 12.2 | Stream splits | **(a) Split — twelve streams, one egress class each.** | §4, §5 stand as written. |
| 12.3 | Crisis near-miss | **(c) Log every turn the gate ran on, hit or clear.** | §5.9 superseded — see §2 below. |
| 12.4 | Actor attribution | **`user` / `coach` / `system` / `planner`** — see §3. | §5.5's `user \| model \| system` superseded. |
| 12.5 | `runtime` thermal seam | **(b) Build in-app thermal/battery sampling in task 41.** Jason's explicit instruction. | §4.3's recommendation superseded — see §4. |
| 12.6 | Retention | **Keep everything**, plus a single black-swan ceiling warning — no second trigger. | §8.2 extended — see §5. |
| — | The stale worktree (parent §13) | **Leave it.** Flag in the findings report; a separate cleanup task later. | §13's flag stands; §6 below adds the verification. |
| — | `fsync` policy (parent §1.2) | **Per event for alpha**, reverting to boundary-only for beta as a pinned future decision. | §1.2's "no fsync per event" superseded for alpha — see §7. |

---

## 2. Ruling 12.3 — every turn the gate ran on

**Ruled (c).** The crisis stream records the gate's input and verdict on every turn it runs on, not
only on firings.

**The reasoning, recorded because the recommendation changed during the review and a future session
should not re-derive it.** The Phase-1 document recommended (b), a deliberately loose watch list.
Steelmanning the alternatives broke that recommendation on its own terms:

1. **(b)'s central promise doesn't survive the detector's own documentation.** `crisis.ts`'s comment
   states the known gap as *"literal phrasing only — it will miss indirect, metaphorical, or coded
   expressions, which are common."* A near-miss watch list is **also a phrase list**. It catches more
   *literal* distress, which the real gate largely already catches, and it structurally cannot catch
   the failure class the detector is documented as missing. It would have produced a large noisy pile
   that reads like reviewed coverage evidence and isn't.
2. **(c) satisfies (a)'s strongest objection and (b)'s goal simultaneously.** (a)'s best argument was
   *don't build a second, unreviewed matcher on the safety path* — and (c) has no matcher at all.
   (b)'s goal was evidence about false negatives — and (c) captures the complete superset those can
   be found in, by a human reading, which is the only method that works on non-literal expression.
3. **(c) has no definitional risk.** There is no "what counts as near" to argue about. Every other
   option is a sampling policy chosen before anyone has looked at the data, on a one-shot collection
   window.
4. **Two gates, not one.** `runCoachingResolution` runs its own `checkCrisis` at disposition time, on
   a different surface. Under (a) or (b) a cleared turn there leaves no crisis-stream trace at all.
5. **Task 21's evidence base.** Task 42 §1 retains this log and moves it to the private archive as
   task 21's only real evidence. Under (c) that evidence is one self-contained stream a reviewer can
   read to answer both "did it fire when it shouldn't" and "did it fail to fire when it should",
   without joining to `conversation` — which has a different deletion schedule.

**Revised event type, superseding parent §5.9:**

```ts
type CrisisEvent = {
  stream: 'crisis';
  type: 'gate';
  verdict: 'hit' | 'clear';
  text: string;                                    // verbatim, exactly as typed
  surface: 'chat_send' | 'coaching_resolution';
  purpose: 'task_input' | 'coaching';
};
```

**`patternIndex` is dropped**, and this is a consequence of (c) worth recording. Parent §5.9 had the
crisis record carry which `CRISIS_PATTERNS` entry fired. Getting that would mean either widening
`checkCrisis`'s return type — touching a safety-gate file for a logging convenience — or re-running
the patterns inside capture, which reintroduces exactly the matcher (c) was chosen to avoid. Under
(c) the reviewer has the verbatim text and the twelve regexes are in the repo, so matching offline is
trivial. **The detector is now untouched in the strictest possible sense: capture reads its verdict
and writes nothing back.**

**Cost accepted:** the crisis stream becomes a full transcript with verdicts rather than a short list
of firings. In alpha the subject is Jason; the stream is deleted before closed beta regardless
(task 42 Job A). Volume is negligible — a few hundred bytes per turn.

---

## 3. Ruling 12.4 — actor vocabulary, and the one value still open

**Ruled:** tasks created through the chat are `actor: 'coach'`. Tasks created directly by the user
are `actor: 'user'`. A task created **any other way** is `actor: 'planner'` — *"I don't expect that
that last one will be used, but I want to be able to capture it if it happens."*

This supersedes the parent document's `'user' | 'model' | 'system'`. `'model'` was the wrong word:
the thing acting is the coaching surface, not the inference engine, and `coach` is the vocabulary the
rest of the app already speaks (`ChatMessageView.from: 'coach'`).

**`planner` is a sentinel, and it earns a second job.** Its expected count is zero, so a non-zero
count is itself the finding. `src/planning/`'s `PlanAdjustment` hook is a **stated but unenforced**
contract — orientation §3 records that nothing validates a hostile adjuster and that a consumer must
never resurrect a filtered task, with task 19 owning a guard that does not exist. A `planner` row
appearing in `mutation` would be direct evidence of that contract being violated, from a log that
was going to be written anyway.

### The fourth value — `system`. **Ruled 2026-08-17.**

*(Question and reasoning kept below as asked, so the record shows what was put to Jason and why.)*

The creation ruling answers task **creation**. The `mutation` stream also records every field-level **change**,
and two frequent, expected writers fit none of the three values:

- the recurrence sweep (`advanceRecurrence` rolling `next_due_at` and `last_period_shortfall`, at app
  open *and* session start), and
- the completion fold (`taskCompletion.completeTask`, plus the episode-close writes).

Reading them as `planner` is wrong twice: they are not the planner, and it would fill the bucket
whose emptiness is the whole point.

**The actor union, as ruled — four values, final:**

| Actor | Writers |
|---|---|
| `user` | the editor; direct task creation |
| `coach` | chat extraction; coaching-resolution dispatch (`modify_task`, `defer_task`, `add_dependency`) |
| `system` | the recurrence sweep; the completion fold; episode-close writes |
| `planner` | catch-all sentinel — any write reaching a task through a path not enumerated above. Expected count: zero. |

```ts
type MutationActor = 'user' | 'coach' | 'system' | 'planner';
```

**Enforcement note for Phase 2.** `planner`'s value is entirely in its emptiness, so nothing may be
attributed to it by default or by a fallback branch that a future writer silently lands in. Every
enumerated writer is attributed explicitly at the wiring point in `appServices.ts`, and `planner` is
what a repository wrapper records when it is invoked through a bundle that named no actor. A
`planner` row is therefore always a fact about the code, never a shrug.

---

## 4. Ruling 12.5 — in-app thermal, and the deviation it carries

**Ruled (b): build it here.** Jason's words: *"The coordinator likes to keep actions in their tasks
(as I've prompted it to be) but this falls under logging as far as I'm concerned, so it can go here."*

🔴 **This is a deviation from a settled record and will appear under "Deviations from human
decisions" in `docs/eval/task41_findings_report.md`, attributed explicitly:** orientation §8 pins the
thermal sampler to **task 19** ("assigned to 19 so it can't fall between them"), and Jason instructed
on 2026-08-17 that thermal sampling is logging and therefore task 41's. It is recorded as his
instruction, not the builder's judgment, so the audit trail cannot later be misread as scope drift.
*(Orientation §8's pin should be amended to point at 41 once this lands — that is a coordinator edit,
not a builder one.)*

**Two things it buys beyond the `runtime` stream:**

1. It fills `TernaryBonsaiProvider`'s `thermalStatusSampler`, which has defaulted to `() => 0` since
   task 6 with a comment saying it would be wired "in Phase B". That is a live product seam standing
   empty, and `currentThermalHeadroom()` / `activeTier()` are built on top of it.
2. It de-confounds the findings report's central measurement. Capture-on vs capture-off tok/s cannot
   be separated from the 8.3 → 5.8 cold-to-warm drift without sampling heat alongside.

**Scope, held tight:** `PowerManager.getCurrentThermalStatus()` and a `BatteryManager` read on the
capture TurboModule, surfaced into the `runtime` stream's already-declared fields (parent §5.10) and
into the provider's sampler. **No thermal *policy*** — no tier degradation, no deferral logic, no
background-work gating. Those remain task 19's and task 8's, and building them here would be a second
deviation nobody has ruled on.

---

## 5. Ruling 12.6 — retention, and the warning surface

**Ruled: keep everything**, with *"a warning screen when getting close to the ceiling so I can dump
logs to the laptop for processing."* Parent §8.2's 512 MB ceiling and oldest-day-first rotation
stand as the backstop.

**Three design constraints on the warning surface, all consequences of decisions already made:**

1. **It must live inside `src/capture/`**, rendered by a single line in the shell. Otherwise deleting
   capture leaves a dangling screen and breaks the removability property ruling 12.2 was chosen to
   protect.
2. **It must never interrupt mid-episode.** App open or session close only. This is an ADHD app and
   capture is not permitted to compete with focus — the same reasoning that makes backgrounding not
   a pause (constraint per task 13 §8).
3. **It is a warning, not a block.** Brief §5c and parent §8.3: capture degrades where the product
   database blocks. Capture is never a reason a session cannot start.

### One warning only. **Ruled 2026-08-17.**

At the projected ~250 KB/day, **512 MB is roughly five years away**, so the ceiling warning will on
that projection never fire. A second trigger on uncollected volume since the last pull was proposed
on the grounds that it would be the one that actually fires.

**Ruled against, and the reason belongs in the record because it changes what the feature is:** Jason
dumps logs regularly without needing to be told. *"The warning is probably never going to be
triggered and is there for long-tail/black-swan."*

So the ceiling warning is **not** a workflow prompt and must not be built as one. It is a
**last-resort net for the case where the volume projection is wrong by orders of magnitude** — a
runaway retry loop, a pathological prompt, a stream that fires far more than modelled. Two
consequences for Phase 2:

- **It should be rare enough to be alarming.** No progress bars, no percentage nag, nothing that
  trains the eye to dismiss it. If it ever appears, something is wrong and the number on it is the
  finding.
- **Its non-firing is not evidence of anything** and must not be reported as such. The findings
  report's volume figure comes from the device measurement, not from the absence of a warning.

No second trigger, and no capture volume surfaced in the ordinary UI.

---

## 6. The duplicate test suite — verified, not assumed

Jason: *"I assume that these are duplicate tests? Unless it's hurting something I'd leave it be for
now… if the two test suites are really just duplicates, flag it in your report."*

**Verified.** `.claude/worktrees/interesting-shirley-e10fa1` is a git worktree at `d3ead86`
(detached); `main` is `a5d4107`. Diffing `src/`, `__tests__/`, `package.json` and `jest.config.js`
between the two commits yields **exactly one file**: `src/dev/ModelBaseSpikeScreen.tsx`, present on
`main`, absent in the worktree, and it has no test. Suite counts are **68 and 68**. The test content
is identical.

**Therefore `main`'s real suite is 68 suites / 794 tests** — the number the record has always quoted
— and the observed 1588 is that suite run twice. Nothing is broken; the cost is run time (~7 s → ~15 s).

**Leaving it in place per the ruling.** It goes in the findings report with the note that **any test
count quoted from this tree needs halving until the worktree is removed**, since "1588 green" is a
statement about two different commits.

---

## 7. `fsync` — per event for alpha

**Ruled:** *"Lets do it on event for alpha, but flag a future decision to revert to your decision for
beta."* Supersedes parent §1.2's boundary-only recommendation, for alpha.

**Pinned future decision:** revert to `fsync` on episode boundaries and `AppState` background
transitions at the closed-beta build. Owner: task 42, which is already touching every capture
surface for consent and controls. If the app-open measurement (below) is bad, the revert should come
earlier.

**What this actually buys, stated so the guarantee is not misread.** Per-event `fsync` does **not**
improve the force-kill acceptance test. `am force-stop`, `kill -9` and a native SIGSEGV destroy the
process but not the kernel page cache; a synchronous `write(2)` already survives all three, which is
the mechanism parent §1.2 selected the TurboModule for. `fsync` buys durability against **power loss
and kernel panic** — a different guarantee.

**And there is a real argument for wanting it on this hardware.** The S23 FE reaches SKIN
`status=3` (SEVERE) by ~20 minutes under load, and PowerManager status 6 is SHUTDOWN. A thermal
shutdown mid-session is a power-loss-class event and is plausible on this device rather than
theoretical — and it is the failure mode where the surrounding records are most diagnostic and the
page cache does not help.

**Cost to measure in Phase 2:** ~1–5 ms per event on f2fs. Negligible on the model path (~4 records
per model call against a ~25 s generation). The exposure is **bursts** — the recurrence sweep at app
open can fire many `mutation` records back to back, and per-event `fsync` would turn that into a
visible launch stall. **The findings report must measure app-open time with capture on and off**;
that number decides whether the beta revert should be pulled forward.

---

## 8. Builder calls still standing, unratified

Per the deviation rule (handoff §4.3): *a deviation is provisional until Jason rules it, and does not
enter orientation §5 as settled.* These four were explained in review and not ruled on. They stand as
the design unless overruled, and they are **marked provisional, not canon.**

| Call | Standing decision | Reversibility |
|---|---|---|
| Composed `messages` stored **verbatim**, not content-addressed | ~80% of projected volume, and task 31 reads a conversation as a conversation rather than a join | Fully reversible after the device measurement — a `v` bump on new records, not a re-collection |
| Grammar stored as **id + sha8 + slot values**, not full text | 5,090 bytes/attempt to store a constant that is in git; the hash answers the only question anyone asks (pre- or post-task-37) | Reversible; the risk accepted is an unmatched hash from an uncommitted local grammar edit |
| **`v` global** across streams, not per-stream | Four consumers (31, 20, 40, 42) each maintaining a twelve-stream version matrix is four places to get it subtly wrong | Not cheaply reversible — decide before Phase 2 writes records |
| **Ambient correlation context**, not threaded parameters | `chatController` has no session; threading means changing its signature, `App.tsx` and its suite to carry data it has no use for. Safe structurally: one session, `active_episode` singleton by DB CHECK, single-threaded JS | Reversible but invasive |

---

## 9. Sequencing note — task 37 before Phase 2

Jason is running **task 37** (the grammar separator hole) before Phase 2 resumes. Two observations,
neither blocking:

- **The tracks are file-disjoint.** 37 touches `src/llm/extraction/task_extraction.v1.gbnf`, its
  embedded copy in `src/llm/grammar/grammarText.ts`, and possibly
  `src/llm/extraction/validator.ts`. Task 41 Phase 2 touches `src/capture/` (new),
  `src/llm/errors.ts`, `src/llm/provider/ladder.ts`, `src/app/`, `src/execution/`, `src/specs/`, the
  Android Kotlin sources, `scripts/` and `jest.setup.js`. They overlap in `src/llm/` but not in any
  file. *(Handoff §4: parallel tracks must be file-disjoint and both briefs should say so.)*
- **One interaction, benign.** If 37 tightens `validateTaskExtraction` it will construct
  `LlmOutputValidationError`. Task 41 widens that constructor with an **optional** third parameter
  (parent §5.4), so every existing and new construction site compiles unchanged.
- **The ordering is right.** 37 is a live bug in shipped extraction, and the handoff says fix it
  before the next alpha capture. Capture records the grammar's sha8 per attempt, so the pre- and
  post-37 grammars are distinguishable in the log — but with 37 landing first, alpha simply never
  collects a corpus contaminated by the hole.

---

## 10. Where this leaves task 41

**Phase 1: complete, and fully ruled.** `docs/design/capture_format_task41.md` plus this amendment.
**Every open question is closed** — the eight of §1, plus the two follow-ups in §3 and §5 ruled
2026-08-17. Nothing in the format design is now waiting on a decision. The four provisional builder
calls in §8 remain provisional by the deviation rule; they are the design unless overruled and must
not enter orientation §5 as settled.

**Phase 2: not started.** Nothing in `src/`. In order: the force-kill test first (parent §14), then
the TurboModule, `record()` and the writer, then the call sites per brief §6, then the widened
`LlmOutputValidationError`, then `scripts/pull-capture.js`, then Jason's device run for the measured
volume and overhead that `docs/eval/task41_findings_report.md` requires.

**The findings report already owes three specific items**, recorded here so they are not lost in the
gap: the thermal deviation (§4), the halved test count (§6), and app-open time with capture on and
off (§7).
