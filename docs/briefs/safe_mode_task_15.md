# Task 15 — Edge cases / Safe Mode (§8.3)

**Owner:** Opus sets the pattern; **Sonnet** fills the repetitive handlers once the shape is set. **Carries `P`** — the failure modes it handles only occur on-device (model unavailable mid-session, health-check failures, real degradation).
**Not on the personal-ship path**, but it's what makes the app *degrade gracefully* instead of breaking when the model or the device misbehaves — a beta necessity.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` §1 (the confirmed on-device failure modes), §3 (`src/llm/`, the provider, the startup guard), §4 (constraint #3 the grammar startup guard, #8 coaching is app-dispatched).
2. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §8.3 — Safe Mode and the edge-case catalog.
3. `docs/eval/task6_phaseB_findings_report.md` — the startup guard's real behavior (catches a broken grammar, disables the path, app stays alive). Safe Mode is the *user-facing* half of that.
4. `docs/eval/task12_phaseB_findings_report.md` — the deterministic crisis gate and the app-side dispatch Safe Mode must preserve.

---

## 1. What this builds

**Safe Mode:** the app remains useful when the AI is unavailable — model won't load, health check fails, grammar path disabled by the startup guard, or the device is too hot/low to run inference.

- **Finish a session without AI.** The timer, the agenda walk, the five outcomes, park/skip — none of these need the model. A session already in progress must complete cleanly with the model gone.
- **Queue what would have been coached.** A coaching trigger that fires while AI is down enqueues (it already persists to `coaching_queue`); the conversation happens when the model returns. Nothing is lost, nothing blocks.
- **Health check before new AI sessions.** Before a flow that *needs* the model (task capture, coaching), check availability; if down, offer the degraded path (manual task entry via the editor, which already exists) and say why.

**The edge-case catalog (§8.3)** — the handlers Sonnet fills against Opus's pattern: model file missing/corrupt at load; OOM/thermal kill mid-inference; a grammar that fails the startup guard (fall back to prompt-JSON + validation, already the guard's behavior — Safe Mode surfaces it); a session interrupted by any of the above; storage pressure short of task 14's full-corruption case; a coaching resolution that can't be dispatched.

## 2. The relationship to what already exists (don't rebuild these)

- **The startup guard (task 6, constraint #3) already** compiles every grammar at first model use and disables the grammar path on failure. Safe Mode is its **user-facing surface** — the "running without AI features" state and banner — not a reimplementation.
- **The crisis gate (task 12) is deterministic and app-side** and must keep working in Safe Mode — it needs no model, so distress detection is *never* degraded. Verify this explicitly.
- **Task 24 already handles** the model-loading "getting ready" state and the no-grammar fallback (its report §4.6, §7). Safe Mode extends that into a persistent degraded *mode*, not just a transient load state.
- **The manual editor** (task 24) is the AI-free task-capture path. Safe Mode routes to it; it doesn't build a new one.

## 3. Decisions to make and record

**a. Sticky vs per-attempt.** Is Safe Mode a latched state (entered on failure, exited on an explicit "try AI again") or re-evaluated per flow? Recommendation: latched with a manual retry, because thrashing in and out on a thermal boundary is worse than a stable degraded mode. Record the choice.

**b. What "healthy" means.** Define the health check concretely: model file present + loads a header (the spike's `loadLlamaModelInfo` diagnostic isolates "won't load" from "prompting wrong") + the startup guard passed. Don't run a full generation just to check health — that's expensive and hot.

**c. How much the user is told.** ADHD-minimal: a calm, non-alarming banner ("AI features are resting — everything else works"), not a modal wall. Coordinate the copy with task 23's tone.

## 4. Constraints that bite here

- **#3** — never first-parse a grammar in front of a user; Safe Mode is partly the *consequence* of that guard firing. Don't weaken it.
- **Crisis detection never degrades** — it's deterministic and app-side. This is a safety invariant, not a feature.
- **#8** — coaching resolution is app-dispatched; a queued coaching item resolves through the same dispatch when AI returns.
- **A session in progress must finish** — Safe Mode entering mid-session must not strand the user; the timer and outcomes carry them to the summary.

## 5. Phase split

**Phase A (headless).** The Safe Mode state machine, the health check (mockable provider), the "finish a session with the provider yanked mid-way" path, the queue-and-resume of coaching, and every edge-case handler against injected failures.

**Phase B (device — closes `P`).** On the S23 FE: pull/corrupt the model file and confirm the app opens in Safe Mode and the editor still captures tasks; force a thermal/OOM kill mid-inference and confirm the session survives; confirm the crisis gate still fires with the model absent; confirm a queued coaching conversation resumes when the model returns.

## 6. Definition of done

- Safe Mode + the edge-case catalog implemented; Opus sets the pattern, Sonnet's repetitive handlers match it.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- Phase B on the S23 FE: model-absent Safe Mode, mid-inference kill survival, crisis-gate-still-works, coaching resume. **No Phase B, no done.**
- Findings report at `docs/eval/task15_findings_report.md`: the (a)–(c) decisions, what real thermal/OOM kills did on device, and anything left open.
