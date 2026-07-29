# Task 24 — Product UI implementation

**Owner:** Sonnet (screens) + Opus (architecture / state wiring / the execution-API integration). **Carries `P`** — the timer, crash recovery, and the alarm primitive can only be validated on the S23 FE.
**Gates personal ship.** A minimal *functional* pass is the last thing between a confirmed backend and a usable app. The designed/polished pass is a beta gate.

**Blocked by: task 23 (design).** The design is substantially done — `docs/design/Main Screen.dc.html` + `docs/design/Coaching Screen.dc.html` are the interaction/visual spec (see `docs/eval/task23_review.md`). A minimal functional pass may begin against the settled flow before task 23's three residual follow-ups land, but build against the prototype as the reference, not from scratch.

**Read first:**
1. `docs/briefs/orientation_for_opus.md` — all of §3 (module contracts), §4 (constraints — **#11, #12, #13, #14 all bind here**), §7 (the three task-13 handoffs).
2. `docs/design/Main Screen.dc.html` and `docs/design/Coaching Screen.dc.html` — the interaction model and visual system. Every screen you build already exists here as a working prototype. Match it.
3. `docs/eval/task23_review.md` — what the design settled, what's mocked, and what task 24 must wire to the *real* backend.
4. `docs/eval/task13_findings_report.md` **§8** — the definitive `src/execution/` API contract. This is not optional; it is the behavioral spec for the whole work-session surface.
5. `src/execution/` (episodeService, timer, constants) and `src/planning/` (agenda, service) — the two subsystems you render. Read them; don't infer them.
6. `docs/reference/ADHD_Task_Management_App_Specification_v2.3.md` §6 (UI flows) — the functional spec the prototype realizes.

---

## 1. What this builds

The real product UI, in React Native, replacing `src/dev/` harness screens (which stay as dev tools). The screens, per spec §6.2 and the prototype:

- **Dashboard** — Add task · Start work · Review task list · Settings.
- **Add-task chat** — the conversational capture surface (the coaching chat component, titled for task input).
- **Work-session setup** — the check-in: energy → duration → context (spec §6.2), then a *hidden* plan is generated and the tools check runs.
- **Task-execution screen** — the dominant timer, the five-option end-of-block prompt, the always-present escape valve.
- **Coaching chat** — the same chat surface, titled for coaching, reached from the three triggers.
- **Task list / editor** — including the six-kind recurrence editor.
- **Metrics + Settings** — minimal for personal.

**Build the screens as a rendering layer over the existing services.** The prototype mocks agenda-building and the timer; you wire the real ones. Do not reimplement planning, scoring, the timer engine, or the completion fold — they exist and are confirmed.

## 2. The execution-API contract (the part most likely to go wrong)

Task 13's `src/execution/` owns all session runtime state. Task 24 renders it and calls it. From report §8:

- **`recoverOpenEpisode` runs at app launch, always, before anything else.** If it returns a recovered episode, the app opens to the right screen. This is the crash-recovery entry point; skipping it or running it late reintroduces the bug task 13 exists to prevent.
- **`startSessionRuntime`** after task 24 **creates the `sessions` row** — and the row is **born `'abandoned'`** (constraint #14), so a crash leaves the truthful status; a clean end calls `closeSession` to overwrite. Task 24 creates the row and owns nothing else on it; task 13 owns every post-creation write.
- **`startEpisode`** off an `AgendaTaskItem`; **`currentTimer`** for the display; **`endOfBlockPrompt`** for the five options; the **five outcome calls** each return a `TailDirective` you execute against the planner; **`checkSessionLapse`**; **`closeSession`**.

**Three things the report says explicitly not to get wrong:**
1. **Backgrounding must NOT call `pauseEpisode`.** Backgrounding is normal (music, phone-based work), not abandonment. Only an explicit user pause pauses.
2. **`parkEpisode` throws inside 60 s** — read `parkAvailable` and offer "Not this one" (a skip) instead when it's false. (The prototype uses 45 s; the *engine's* gate is 60 s — follow the engine.)
3. **The expiry alarm must be a platform primitive, not `setTimeout`** (constraint #13, confirmed on-device: JS timers fire 38–45 s late from background/doze). Schedule at `blockEndAtMs` via `AlarmManager`, notifee, or a foreground service. The `EpisodeExpiryScheduler` seam is already the right shape — supply the real platform call behind it.

## 3. Constraints that bite here

- **#11 — a park is not a skip.** The Pause affordance keeps progress and never writes a skip or enqueues coaching. Separate control, separate path from declining.
- **#12 — extend is two affordances.** `+5` (flat, uncapped, no timer-face change, **no nag ever**) and `Keep going` (hyperfocus, count-up, guardrail-B nudge). Don't merge them; don't cap `+5`.
- **#13 — the alarm is a platform primitive.** See §2.3.
- **#14 — `sessions` is born `'abandoned'`.** See §2.
- **Two-level scales (#6).** The energy check-in is task 24's, and it must project through `scales.ts` — never persist or surface a raw internal 1–5.
- **The plan is hidden (spec §2.2/§6).** Show one task at a time; never render the agenda.

## 4. The chat surface

The coaching-chat component is reused for task-input and all coaching (the prototype does this correctly). Behind it: task-input runs grammar-constrained extraction (task 5/7), coaching runs the resolution union + app-side dispatch (constraint #8, task 12). **Crisis detection is deterministic and app-side** (constraint: the 4B cannot self-detect distress) — the draft gate is already active and must remain gate-first. Do not route distress through the model.

## 5. Phase split

**Phase A (headless / emulator).** All screens, wired to the real services, testable without the alarm primitive: navigation, the check-in flow, agenda walk, the five outcomes against real `TailDirective`s, the recurrence editor persisting real `Recurrence` unions, the chat surface calling real extraction/coaching. Snapshot/interaction tests where practical.

**Phase B (device — closes the `P`).** On the S23 FE: the alarm primitive firing from background/doze (the thing `setTimeout` can't do); `recoverOpenEpisode` after a real force-kill mid-session showing the right screen; backgrounding not reading as pause; the timer correct across background/return; the full add→work→coach loop end-to-end on real hardware. Batch with task 32's residue sweep — same setup cost.

## 6. Definition of done (personal-ship bar)

- The end-to-end loop works on-device: add task → start session → check-in → execute with the timer → the five outcomes → coaching when triggered → summary.
- Wired to the real execution + planning + extraction services, not mocks.
- The alarm primitive validated firing from background on the S23 FE.
- `recoverOpenEpisode` validated after a real kill.
- Full suite + `tsc --noEmit` + `eslint .` clean.
- Findings report at `docs/eval/task24_findings_report.md`: what shipped, the 13/24 `sessions`-row boundary as built, the alarm primitive chosen, anything deferred to the beta (designed) pass, and anything left open.

*Note on scope discipline: this is the **functional** pass for personal ship. Polish, the full designed visual pass (task 23's tokens applied throughout), metrics depth, and settings breadth are beta-gate work — don't let them expand the personal-ship deliverable.*
