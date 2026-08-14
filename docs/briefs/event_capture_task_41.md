# Task 41 — Lossless local event capture

**Owner:** **Opus 5** for §3 (event schema + stream boundaries), **Opus** for implementation, **Jason** for the device run.
**Status:** ⬜ open. **Gates task 31**, therefore 38 → 40 and the model-migration decision. `P`.
**Ship stage:** built for alpha. **Task 42** governs it at closed beta; **task 43** prunes it at open beta and GA. Neither is this task's problem to solve — but §4's removability requirements exist because of them.

---

## 0. Read first

1. This brief in full.
2. `docs/briefs/orientation_for_opus.md` — §1 (confirmed device facts), §4 (constraints), §5 (settled decisions, including **capture is built to be removed** and **the capture ladder**).
3. `docs/briefs/privacy_consent_task_42.md` §1–2 and `docs/briefs/capture_ladder_task_43.md` §2 — what happens to what you build, and when. You are building for a facility that gets pruned; §4 is how.
4. `src/llm/provider/types.ts`, `ladder.ts`, `errors.ts` — the model path you're instrumenting.
5. `docs/eval/task24_findings_report.md` §8 and `docs/eval/task13_findings_report.md` §8 — the runtime contracts you're hooking.

---

## 1. Why this exists

Task 31 needs real captures. There are none, because the app throws them away. Migration 001:

```sql
conversation_summary TEXT, -- AI-generated, grammar-constrained; raw transcript never stored
```

**Every real capture since personal ship — weeks of exactly the material the corpus needs — is gone and unrecoverable.**

A second instance, worse because it's silent: `LlmOutputValidationError` (`src/llm/errors.ts`) carries `surface` and `issues` but **not the payload that failed**. `runAttempt` in `src/llm/provider/ladder.ts` catches it, retries, and the malformed generation — the single most diagnostic artifact the system produces — is discarded. Task 37's grammar hole (a bare `","` passing as a schema-valid title) needed a dedicated six-model spike to find. With capture it is a log line the first time it fires.

🔴 **And the window is finite.** Task 43's ladder drops free-text capture at open beta. The corpus that trains every future LoRA and re-runs every future bake-off is collected during alpha and closed beta **or largely not at all.** That is the argument for doing this now rather than after beta hardening, and it is also why §3 gets the careful model: *you cannot re-collect data you captured in the wrong shape.*

---

## 2. What gets captured

**Ruled 2026-08-07: log everything in alpha. No exclusions, no redaction, no sampling.** In alpha the only person the data could be hidden from is Jason, and hiding it from him is what created this problem.

Organised as **streams**, because §4 requires each to be independently removable and task 43 removes them at different rungs.

| Stream | Contents | Egress class | Ladder fate |
|---|---|---|---|
| `conversation` | Every turn both directions, **verbatim** — user text exactly as typed, no trimming or normalisation (the typos and abbreviations *are* the signal for 31). Clarifying questions and their answers tagged as such, matching the seed fixtures' `clarify_answers`. | free-text | dropped at open beta |
| `modelio` | 🔴 The composed `ChatMessage[]` as sent, the **raw completion string before any parsing**, grammar id, D10 rung, attempt count, `GenerationTimings`, model identity. | free-text (content) / structured (metadata) | content dropped at open beta; metadata survives |
| `validation` | 🔴 Every `LlmOutputValidationError` **including the offending payload**. | free-text | dropped at open beta |
| `mutation` | Field-level task changes: what, from, to, by whom (`user` \| `model` \| `system`), through which surface. | structured | survives |
| `episode` | Planned vs actual minutes, the five outcomes, `+5` presses, hyperfocus quanta, parks, skips, resulting `TailDirective`, crash recoveries, credit written. | structured | survives |
| `planning` | The candidate pool with per-factor scores, neglect multiplier, final score, chosen agenda, **and both reject sets with reasons.** | structured | survives |
| `coaching` | Trigger type + `trigger_data`, queued row, the resolution union emitted, what the app dispatched, observed outcome. | mixed | content dropped at open beta |
| `crisis` | Every `checkCrisis` hit **and near-miss on the phrase list.** | free-text | 🔴 **removed entirely before closed beta** (task 42 Job A) |
| `runtime` | Thermal samples and tok/s alongside model calls, time-since-cold, battery/charging, doze transitions. | structured | survives |
| `lifecycle` | Launch, startup grammar-guard result, crash-recovery firing, alarm scheduled/fired/missed with actual delta, migration runs. | structured | survives |

**Declare the egress class in the stream's definition, in code** — not in a policy document that drifts away from it.

---

## 3. The event schema and stream boundaries — do this first, on the good model

**This is the one-shot decision.** Data captured in the wrong shape cannot be re-collected once the window closes, and a schema that can't reconstruct a timeline produces a corpus that looks fine and can't answer anything. Design it before writing call sites.

- **Correlation IDs on every record**: `sessionId`, `episodeId`, `taskId`, plus a **monotonic sequence number** and **both** a wall-clock and a monotonic timestamp. Wall-clock alone is not enough — the device's clock moves, and DST arithmetic already bit task 36.
- **`"v":1` on every record**, matching the `learning_data` convention. The format will change; 31's tooling has to survive it.
- **One event-type union**, exhaustively typed, so a new stream can't be added without declaring its egress class and ladder fate.
- **Stream identity is first-class**, not a `type` string on an undifferentiated firehose. §4 depends on this.

---

## 4. 🔴 Removability — a settled decision, not a preference

Orientation §5: *all logging software is written with an eye to potentially being removed, and every stream must be removable independently.* Task 42 deletes **one** stream while the others keep running, and must prove it. So:

- **Streams separately scoped**, each writing to its own path under one directory capture owns. Removing a stream is deleting its module, its call sites, and its directory — not an excavation.
- **One module, one entry point** (`record(event)`). Capture logic never diffuses into the code it instruments; call sites pass data and know nothing else.
- **The on-disk layout is a written contract** (§6.3), because task 42's acceptance test enumerates locations to prove they're empty and can only do that against a document.
- **No dormant-flag design for `crisis`.** Don't build an off switch and plan to flip it; 42 removes the code, and a disabled module is something a later change re-enables by accident. *(Streams that survive into beta do get runtime controls — that's 42 Job B — but those are user-facing consent controls, not a developer flag standing in for deletion.)*
- **The crisis *detector* is untouched.** `checkCrisis` and the referral path are product behaviour and a hard beta gate in their own right (task 21). Only its logging is removable.

---

## 5. Storage and failure behaviour

**a. Out-of-band, append-only, never in the product database.** Capture must not corrupt, slow, lock or migrate the app's SQLite — and must *survive* that DB being corrupt, which is precisely when you want it. **Newline-delimited JSON on app-private external storage** (`/sdcard/Android/data/com.todoai/files/`, constraint #10), partitioned by stream and day. Crash-safe by append, one `adb pull`, greppable, no migration burden. A second SQLite DB is worse on every axis.

**b. Lossless means synchronous at the event.** A buffer loses exactly the events surrounding a crash, which are the ones worth having. Append synchronously for everything low-frequency; buffer **only** high-frequency telemetry (thermal samples) and flush on every episode boundary.

**c. Failure never breaks the app, and never goes silent.** Wrap every write so it cannot propagate; maintain a dropped-event counter written into the log on the next successful append. A silently lossy logger is worse than none — it produces confident wrong conclusions.

**d. Size, rotation, no-space.** `modelio` is verbose; the device has 8 GB with a 1 GB model on it. State a cap and a rotation policy. **Resolve the tension with task 14 explicitly:** 14 blocks *sessions* on no space; capture blocking the app is unacceptable. Capture degrades (drops, counts, warns) where the product DB blocks.

**e. Redaction seams, unimplemented, with a named consumer.** The consumer is the **egress** path, not `record()`. Ruled: nothing leaves a tester's device un-anonymized, and anonymization runs at the source before export (task 42 §4b). Capture writes raw locally — fine, it never leaves. Put the seam at the export boundary.

---

## 6. Integration points

These are real and current; verify before writing against them.

- **`src/llm/provider/ladder.ts` → `runConstrained()`** is the choke point for every constrained call, and `LadderResult` already carries `raw`, `attempts` and `response`. **`runAttempt()` is where the failed payload is currently dropped** — widen `LlmOutputValidationError` (`src/llm/errors.ts`) to carry it, then capture it.
- **`src/llm/provider/types.ts` → `LLMProvider.generateResponse()`** is the single generation entry point per the §3.6 contract, so it catches unconstrained calls too (`runUnconstrained`). `LLMResponse` and `GenerationTimings` already carry what `modelio` and `runtime` need.
- **`src/app/chat/chatController.ts`** — `send()` is the conversation turn entry; `checkCrisis` is called there; `saveTask()` runs extraction. Conversation, crisis and part of modelio hook here.
- **`src/execution/episodeService.ts`** — `startSessionRuntime`, `startEpisode`, `pauseEpisode`, `resumeEpisode`, `endOfBlockPrompt`, `applyShortExtension`, `applyHyperfocusExtension`, `completeEpisode`, `closeSession`. All exported async functions; a clean surface for `episode`.
- **`src/planning/planner.ts` → `runSelectionBoundary()`** already returns `eligible`, `capabilityRejects` and `dependencyRejects`. **It just never persists them.** That's the `planning` stream, nearly free.
- **`src/db/repositories/*.ts`** and **`src/services/recurrence/advance.ts`**, **`src/services/taskCompletion.ts`**, **`src/services/coaching/`** — `mutation` and `coaching`. Attribute the actor correctly: the recurrence sweep and the completion fold are `system`, coaching dispatch is `model`, the editor is `user`.

---

## 7. Deliverables

1. `src/capture/` — one module, one `record()` entry point, the event-type union, per-stream writers.
2. Call sites wired per §6, including the widened `LlmOutputValidationError`.
3. `docs/design/capture_format_task41.md` — the event union, correlation-ID contract, on-disk layout, egress classes, versioning rule. **Task 31's tooling, task 20's harness, task 40's analysis and task 42's acceptance test all read this.**
4. `scripts/pull-capture.js` — fetch logs off the device, filter by stream, session or date.
5. `docs/eval/task41_findings_report.md` with **measured** log volume per session and **measured** capture overhead on the model path, on the S23 FE. If capture costs meaningful tok/s, that's a finding that changes the design.

---

## 8. Done means

- A full personal session on the S23 FE reconstructs end to end from the logs: every turn, every mutation, every model call with raw output, every outcome.
- 🔴 **A deliberate force-kill mid-episode loses no event before the kill.** This is the acceptance test that matters — buffering bugs surface nowhere else.
- Each stream verified independently removable: delete `crisis`, rebuild, confirm the app runs and the other streams are unaffected.
- Volume and overhead measured, not estimated.
- Task 31 can point tooling at the documented format and start harvesting.

---

## 9. Open for Jason

- **Retention during alpha** — keep everything forever, or rotate? Everything-forever is simplest; the findings report will say whether volume makes that untenable.
- **Whether to backfill anything.** Nothing is recoverable, but the existing `tasks` rows are real and can seed task 31's reconstruction interviews. Not this task's deliverable — flagging it so it isn't forgotten.
