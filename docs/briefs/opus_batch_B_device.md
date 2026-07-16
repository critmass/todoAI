# Opus Batch — Phase B: On-device pass (PHONE required)

**For:** an Opus + Jason session in todoAI, run as a live loop — Opus drives changes, Jason runs on the Samsung Galaxy S23 FE and reports what the real 4B actually does.
**Prereq:** `docs/briefs/opus_batch_A_headless.md` substantially complete — the provider, prompts, coaching wiring, and scoring are built and mock-tested. This phase turns "believed done" into "confirmed," and does the one thing that can only happen on hardware: tune and prove the model-touching behavior.
**Read first:** `docs/briefs/orientation_for_opus.md` (constraints), and the Phase A brief (what's built).

**Why a device is non-negotiable here.** Prompt quality on a 4B, whether a grammar truly parses on this build, and whether the startup guard catches an *uncatchable* crash are all properties that only exist on the phone. No desktop reasoning substitutes — this stack has already surprised us twice at the parser level. Treat every model-touching thing Phase A produced as unconfirmed until the S23 FE says otherwise.

**Order:** **6 first** (the spine — confirm the provider before tuning prompts against it), then **7** (the iteration-heavy loop), then **12** (needs confirmed prompts + provider).

**Device discipline (from the Q1 arc):** run a couple minutes in, not just cold, so numbers reflect the ~5.2 tok/s steady state, not the 8.5 burst. Fresh app context when a result could be poisoned by a prior failure. Model at `/sdcard/Android/data/com.todoai/files/` (`README_build.md`).

---

## Task 6 — confirm the provider on-device (then it's done)

1. **A grammar-constrained, chat-templated call returns validated structured output on the S23 FE** — the real extraction grammar (via `buildGrammar`) through the real provider, validated by task 5's validator. This is the core "the provider works" proof.
2. **Re-run task 5's Stage 2 / Stage 3 through the real `TernaryBonsaiProvider`** (not the standalone spike harness): confirm the seed fixtures still come back valid/validator-passing and the constrained overhead still lands around the ~3% Q1c measured. If the numbers have drifted, that's a finding.
3. **Prove the startup grammar-validation guard — this is Phase B's highest-value single check.** Deliberately register a broken grammar (e.g. one with an underscore in a rule name — the known process-killer) and confirm the guard **catches it at startup and falls back to prompt-JSON + validation**, rather than the app dying uncatchably mid-session. The guard's entire reason to exist is a failure mode that only reproduces on-device; this is where it's earned or found wanting.
4. **Record thermal/health metrics** from real runs (load time, tok/s, battery delta, thermal headroom behavior).

**Done when:** 1–4 all hold on the device. Only now is task 6 complete.

---

## Task 7 — the prompt-tuning loop (the iteration-heavy one)

This is a **draft → run → observe → adjust** cycle against the real 4B. Budget device time; it does not close in one pass.

- **Start from the two known targets** (Q1c Stage 2 evidence, the earliest real signal of where the 4B needs scaffolding):
  - it chose **`due:null` despite a date** in the prompt → needs explicit date-interpretation grounding;
  - it emitted **junk `context_tags` array elements** → needs tag/tool field guidance.
- **Then the harder correctness targets:** recurrence **ask-don't-guess** actually producing a *question* on ambiguity (not a silent `null`-vs-`unscheduled` pick); scope-to-observable-work holding; the recap turn (D1) actually suppressing valid-but-wrong output.
- **Measure valid-AND-correct across the seed fixtures on-device.** Valid is already 4/4 from Q1c; *correct* is the target here (right fields, right recurrence type, right due date). Track it like a KPI as you iterate.
- **Coaching prompts:** confirm they run supportive, on-scope, and reach a concrete disposition; confirm the crisis path behaves.

**Done when:** extraction hits a solid valid-and-correct rate on-device, recurrence ambiguity yields a question, and coaching conversations land dispositions in the right tone.

---

## Task 12 — confirm coaching end-to-end on-device (then it's done)

With provider (6) confirmed and prompts (7) tuned:

- **Each trigger fires the right conversation at the right moment** on-device: single skip → next-start; 3-in-session → immediate recalibration; 5+ days → re-orientation.
- **The resolution union comes back valid from the real 4B and dispatches correctly** through the repositories (modify / eliminate / defer / break_down staged / no_change), with the **right completion primitive** per recurrence type (the `unscheduled`-vs-one-off boundary, live).
- **Coaching conversations reach sensible dispositions;** the crisis path behaves under a distress input.
- **Confirm the skill-injection seam is present and inert** — `injectedSkills = []` doesn't break the live flow (it's task 18's future hook, just verify it's wired without effect).

**Done when:** all three triggers, real dispatch, disposition quality, and the crisis path hold on the device.

---

## Reminders for this phase

- Chat-template `messages` API and greedy temp-0 are still mandatory (constraints #1, #4) — verify they're what's actually firing.
- The startup-guard proof (Task 6 step 3) is the single most important check in this phase; don't let it slip past as "probably fine."
- When the device contradicts a Phase A assumption, the device wins — log it as a finding and adjust, the same way the Q1 arc did.
- Small commits; report device results back in a table per task so the "confirmed" calls are grounded, not eyeballed.
