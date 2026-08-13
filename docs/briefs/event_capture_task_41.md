# Task 41 — Lossless local event capture

**Owner:** **Opus** (design + implementation), **Jason** (device run).
**Status:** ⬜ open. **Gates task 31**, and therefore 38 → 40 and the model-migration decision. `P`.
**Ship stage:** personal/alpha. **Task 42 revisits every decision here before beta.**

---

## 0. Why this exists, stated plainly

Task 31 needs real captures. I went looking for them in the dogfooding database and found this, in migration 001:

```sql
conversation_summary TEXT, -- AI-generated, grammar-constrained; raw transcript never stored
```

**The app deliberately discards raw user input.** Every real capture since personal ship — weeks of exactly the material task 31 needs — is gone and unrecoverable. The best source of truth for the corpus has been destroying itself the whole time.

There is a second, worse instance. `LlmOutputValidationError` (`src/llm/errors.ts`) carries `surface` and `issues` but **not the payload that failed.** So when the D10 ladder retries, the malformed model output — the single most diagnostic artifact the system produces — is thrown away. Task 37's grammar hole (a bare `","` passing as a valid title) had to be found by a dedicated six-model spike. With capture in place it would have shown up in a log line the first time it fired.

**The ruling for alpha is that nothing is discarded.** Privacy is not a concern at this stage — the only person the data could be hidden from is Jason, and hiding it from him is what created this problem. Task 42 owns the reconsideration before anyone else installs the app.

---

## 1. What must be captured

Jason named three. The rest are proposed — take them or cut them, but cut them deliberately.

### Named

1. **Conversation logs.** Every turn, both directions, verbatim. User text exactly as typed (no trimming, no normalisation — the typos and abbreviations *are* the signal for task 31). Assistant text as rendered. Clarifying questions and their answers, tagged as such, because the seed-fixture schema has a `clarify_answers` field that needs a real counterpart.
2. **Task changes — user-made and model-made, distinguished.** Every field-level mutation: what changed, from what, to what, by whom (`user` | `model` | `system`), through which surface (chat extraction, task editor, coaching resolution dispatch, recurrence sweep, completion fold). `task_updates` already exists in the schema; this is a superset and should not be jammed into it (see §2).
3. **Task performance.** Every episode: planned vs. actual minutes, the five outcomes, `+5` presses and hyperfocus quanta, parks, skips, the `TailDirective` that resulted, crash recoveries, and the credit actually written.

### Proposed additions, in rough order of value

4. 🔴 **Raw model I/O.** The exact composed prompt (system + chat-template messages as sent), the **raw completion string before any parsing or validation**, the grammar used, the D10 rung reached, retry count, token counts, latency, and model identity. This is the highest-value item on the list and it is the one that makes task 20's eval harness and task 40's bake-off cheap instead of expensive. It also turns "extraction was wrong" into "here is precisely what it emitted."
5. 🔴 **Validation failures with payload.** Every `LlmOutputValidationError` including the offending output. Requires widening the error type — a small change, and the reason task 37 cost a spike.
6. **Scoring and planning snapshots.** At plan time: the full candidate pool with per-factor scores, the neglect multiplier, the final score, the chosen agenda, **and both reject sets with reasons.** `runSelectionBoundary` already retains the capability and dependency rejects — it just never persists them. This is task 17's training input and the answer to "why did it show me *that*."
7. **Coaching lifecycle.** Trigger type and `trigger_data`, the queued row, the resolution union the model emitted, what the app dispatched, and the observed outcome. Task 19's distillation needs the fired-outcome channel and currently has no source.
8. **Crisis-gate firings and near-misses.** Every `checkCrisis` evaluation that hits, plus ones that come close on the phrase list. Task 21 is a hard beta gate with *zero* real data behind it today; this is the only way it gets any. Handle with care in task 42.
9. **Runtime and device conditions.** Thermal samples and tok/s alongside model calls, time-since-cold, battery/charging state, doze transitions. Feeds the thermal sampler stub (assigned to 19) and settles the alarm-delivery questions task 13 and 24 could only infer.
10. **App lifecycle.** Launch, the startup grammar guard's result, crash-recovery firing, alarm scheduled / fired / missed with actual delta, migration runs.

---

## 2. Design constraints — these are the part that's easy to get wrong

**a. Out-of-band, append-only, not in the product database.** The capture log must not be able to corrupt, slow, lock, or migrate the app's SQLite. It must also *survive* the product DB being corrupt, since that's precisely when you want the log. **Recommended: newline-delimited JSON files on app-private external storage, one per day, appended.** Crash-safe by construction, pullable in one `adb pull`, greppable, and it adds no migration burden. A second SQLite database is the alternative and is worse on every one of those axes.

**b. Lossless means synchronous at the event, not buffered-and-flushed.** A buffer loses exactly the events surrounding a crash, which are the events worth having. Append synchronously for everything low-frequency; buffer *only* high-frequency telemetry (thermal samples), and flush that on every episode boundary.

**c. Capture failure must never break the app — but must never be silent either.** Wrap every write so it can't propagate, and maintain a dropped-event counter that gets written into the log itself on the next successful append. A silent lossy logger is worse than none, because it produces confident wrong conclusions.

**d. Correlation IDs on every record.** `session_id`, `episode_id`, `task_id`, plus a monotonic sequence number and a wall-clock and monotonic timestamp pair. Without these the streams can't be reconstructed into a timeline, and the timeline is the whole point for tasks 17 and 19.

**e. Version every record** — `"v":1`, matching the convention `learning_data` already uses. This file format will change and task 31's tooling has to survive that.

**f. Size, rotation, and the no-space rule.** Raw model I/O is verbose and the device has 8 GB with a 1 GB model on it. State a size cap, a rotation policy, and behaviour when storage runs out. **Align with task 14's block-on-no-space rule** — but note the tension and resolve it explicitly: task 14 blocks *sessions* when there's no space, and a capture log that blocks the app is unacceptable. The likely answer is that capture degrades (drops, counts, warns) where the product DB blocks.

**g. Redaction hooks now, unused.** Don't implement redaction — alpha doesn't want it — but put the seam where task 42 can switch it on without touching every call site.

---

## 3. Deliverables

1. The capture module (`src/capture/` or similar) with a single typed `record(event)` entry point and one event-type union.
2. Call sites wired at every source in §1, including the widened `LlmOutputValidationError`.
3. A documented on-disk format — the event-type union, the correlation-ID contract, and the versioning rule — in `docs/design/`, because task 31's tooling, task 20's harness, and task 40's analysis all read it.
4. A pull/inspect script (`scripts/`) that fetches the logs off the device and can filter by type, session, or date.
5. `docs/eval/task41_findings_report.md` — including a real measurement of **log volume per session** and **capture overhead on the model path**, taken on the S23 FE. If capture costs meaningful tok/s, that's a finding that changes the design.

---

## 4. Done means

- A full personal session runs on the S23 FE and the log reconstructs it end to end: every turn, every mutation, every model call with raw output, every outcome.
- A **deliberate force-kill mid-episode** loses no event before the kill. This is the acceptance test that matters — buffering bugs only show up here.
- Volume and overhead measured, not estimated.
- Task 31 can point its tooling at the format and start harvesting.

---

## 5. Sequencing

- **37 first if convenient**, so the capture isn't full of a grammar bug you already know about — but 37 doesn't block this, since capture records raw *input*, upstream of the grammar. Capturing the bug firing is arguably useful.
- **41 then runs in the background of everything else.** Once it's on, the corpus accumulates while Jason does other work. It is the only task-31 input that grows without effort, which is why it gates 31 rather than running beside it.
- **Realistic expectation:** two to three weeks of normal use converts into a held-out split of real captures. Task 31's interview and reconstruction work should run *during* that window, not after it — the two are parallel, and 31's train split doesn't need to wait.

---

## 6. Ruled 2026-08-07

> **Log everything for now. That log will be completely turned off and deleted before beta.** In alpha I'm basically hiding my actions from myself if I don't log them — something that is not true once we are in beta. — *Jason*

So: **no exclusions, no redaction, no sampling. Everything in §1, including the crisis-gate log.** Retention during alpha is keep-everything; the findings report reports volume, and rotation only becomes a question if that volume turns out to be a problem.

**This ruling is a design constraint, not just a permission — build for the teardown.** Task 42 has to delete all of this and *prove* it deleted it, so:

- **Every byte capture writes lives under one directory it owns.** Nothing scattered, nothing interleaved with product data, nothing in the SQLite DB. §2a already says this for corruption-survival reasons; the teardown requirement makes it non-negotiable.
- **Capture is one module with one entry point** (§3.1), so removal is a deletion plus the call sites, not an excavation. Don't let capture logic diffuse into the call sites it instruments.
- **Document the on-disk layout precisely** (§3.3) — task 42's acceptance test enumerates locations to verify they're empty, and it can only do that from a written contract.
- **No dormant-flag design.** Don't build an off switch and plan to flip it; task 42 removes the code. A disabled capture module is a thing a later change can re-enable by accident.

⚠ **One consequence that reaches beyond this task:** the corpus task 31 builds is *derived* from these logs and will outlive them — 38 trains on it, 40 evaluates on it, 20 uses it as fixtures. Deleting the logs does not delete the corpus, and the corpus contains Jason's real task text verbatim. **Task 42 §1 carries that open question; it is not this task's to answer, but this task should not assume the corpus inherits the logs' fate.**
