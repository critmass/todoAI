# Task 12 Phase B Findings — coaching confirmed on-device, and the data layer's first run on hardware

**Question:** Task 12 exited Phase A as built-and-mock-tested. Phase B had to show the three §7.2
triggers firing at the right moment, the resolution union coming back valid from the real 4B and
**dispatching through real repositories**, sensible dispositions, and the crisis path behaving —
all on the S23 FE.

**Verdict: GREEN.** All criteria hold on-device. Along the way this was also **the first time
`src/db/` has ever executed on hardware** (every prior device session — Q1, Q1b, Q1c, Tasks 6/7 —
touched only `llama.rn`), which settled a standing `TODO(device verification)` and surfaced one
real prompt defect that only appeared once dispatch went looking for a persisted write.

**Date:** 2026-07-16 · **Device:** Samsung Galaxy S23 FE (`R5CWC240D5H`) · **Model:**
`Ternary-Bonsai-4B-TQ1_0.gguf` · **`llama.rn`:** 0.12.5 · **op-sqlite:** 17.1.2

**Read first:** [`task7_phaseB_findings_report.md`](task7_phaseB_findings_report.md) (the prompts and
the crisis-path work this builds on) and [`docs/briefs/opus_batch_B_device.md`](../briefs/opus_batch_B_device.md).

---

## 1. The data layer's first run on hardware (the de-risk spike)

`src/db/` was "done" in exactly the sense Tasks 6 and 7 were done before the device contradicted
them twice: built and unit-tested on the dev host, never executed on the phone. So it got a
standalone spike before anything was built on it.

**Cheapest possible de-risk first:** the scenario that would have blown the schedule was the
installed APK not containing the op-sqlite native module (that needs a gradle rebuild, not a Metro
reload). Thirty seconds of `unzip -l` settled it — `lib/arm64-v8a/libop-sqlite.so` **is** in the
APK, and the device's `lastUpdateTime` (2026-07-10 13:27:50) matches the local build exactly.

| Check | Result |
|---|---|
| Open real op-sqlite connection | ✅ |
| `runMigrations` on a fresh DB | ✅ schema version **2.2.0** |
| Repository round-trip (`create` → `getById`) | ✅ id=1, title and duration intact |
| `PRAGMA foreign_keys` | ✅ **`{"foreign_keys":1}`** — actually ON, on hardware |
| `listActiveByNeglect` | ✅ returns rows, TS-side multiplier computed |
| `POWER()` availability | ❌ **`no such function: POWER`** |

**`tasks.ts`'s `TODO(device verification)` is settled: `POWER()` genuinely does not exist on this
op-sqlite build.** Bypassing the `active_tasks_with_neglect` view and squaring `weeksNeglected` in
TypeScript is **required**, not a cargo-culted workaround. The TODO can be closed and the comment
demoted from "expected to be unavailable" to "confirmed unavailable, 2026-07-16".

## 2. The three triggers (§7.2)

Against real SQLite, via `enqueueCoachingTrigger`:

| Trigger | Urgency | Expected | |
|---|---|---|---|
| `task_skipped` (single skip) | `next_start` | `next_start` | ✅ |
| `session_recalibration` (3-in-session) | `immediate` | `immediate` | ✅ |
| `app_reorientation` (5+ days away) | `next_open` | `next_open` | ✅ |

The `coaching_priority_queue` view also orders urgency-first on real SQLite:
`[session_recalibration:immediate, app_reorientation:next_open, task_skipped:next_start]` — which is
chronologically coherent, since an app *open* precedes a session *start*.

## 3. Real dispatch — and why the first pass proved less than it looked

The first run looked like a clean pass: the real 4B returned a valid union on the **first attempt**
and picked the correct target row over a decoy (`{"action":"break_down_task","taskId":3,"staged":true}`).
But the row came back **unchanged** — correctly, because `break_down_task` is a **staged stub** (D8):
it calls `requireTask` and returns. So that run exercised the **read** path only; no write was ever
proven to land in SQLite. Task 7's earlier coaching probe had the same blind spot (it ran against
fabricated deps and also drew `break_down_task`).

Three scenarios steered at the **mutating** actions, each re-reading the row afterwards:

| Scenario | Action chosen | Row after | |
|---|---|---|---|
| "change its duration to 15 minutes" | `modify_task` | `estimatedDuration: 45 → **15**` | ✅ |
| "the offsite was cancelled — get rid of it" | `eliminate_task` | `status: **deleted**` (soft-delete, **not** a completion) | ✅ |
| "can't touch it until next Monday" | `defer_task` | `nextDueAt: **null**` | ❌ → §4 |

With §4's fix: **3/3**, `defer` → `nextDueAt: 2026-07-27`. Dispositions are now sampled at n=4
(`break_down_task`, `modify_task`, `eliminate_task`, `defer_task`) and each chose the sensible
action for its input, on the correct enumerated candidate.

## 4. Finding: the coaching resolution guide never got Task 7's tuning

`defer_task` picked the right *action* but emitted `until: null` for *"I can't touch task 7 until
next Monday"* — the outcome was `{"action":"defer_task","deferredUntil":null}` with **no
`condition` field**, so it was a plain null, not the (legitimate) condition branch.

This is **the `due:null` miss again**, from the same cause. Compare:

```
extraction (tuned in Task 7 → due_resolved 0 wrong):
  due: ... {"kind":"weekday","day":"friday","which":"this"} ...
       Transcribe what was said; do not do calendar math. No deadline mentioned → null.

resolution (never tuned):
  defer_task: not now — set "until" (a date, in N days, a weekday, or a plain-language condition).
```

Task 7 tuned the **extraction** guide and measured it hard, but its coaching probe only ever
exercised `break_down_task` — an action with no fields to get wrong. So the resolution guide's
under-specified fields were never exercised, and the defect only surfaced when real dispatch went
looking for a **persisted write**. Fixed with the same medicine (explicit union variants, a
transcribe rule, a worked example, null reserved for "no when at all"), verified 3/3 on re-run.

**Generalisable:** a probe that only exercises the *stub* action of a union cannot test the union.
The other untested resolution fields (`modify_task.changes.*`, `add_dependency`) are now sampled
once each at most — `add_dependency` and `add_missing_task` remain **unexercised on-device**.

## 5. Known-imperfect: the this/next weekday ambiguity

`defer` now resolves, but *which* Monday is arguable. Today was **Thursday 2026-07-16**; the model
emitted `which:"next"` for "next Monday", so `resolveDue` returned **2026-07-27** — the Monday after
the coming one (11 days out) rather than **2026-07-20** (4 days). It is a Monday, and the DueSpec
contract (D5: model transcribes, code resolves) was honoured literally. But from a Thursday, most
people saying "next Monday" mean the 20th.

Not fixed here: it is a genuine English ambiguity, it sits in shared `resolveDue`/DueSpec semantics
(task 5's contract, not task 12's), and the same question applies to extraction's `due`. **Flagged
for a decision** rather than silently patched — the honest options are to define `which:"next"` as
"the coming one" in `resolveDue`, or to teach both guides to prefer `which:"this"` for a bare "next
<weekday>".

## 6. The completion-primitive boundary — and the brief pointing at the wrong module

The brief asks Task 12 to confirm "the **right completion primitive** per recurrence type (the
`unscheduled`-vs-one-off boundary, live)". **That boundary is not reachable through resolution
dispatch.** `dispatch.ts` is explicit: no resolution action completes a task, and `eliminate_task`
is a soft-delete *deliberately not* a completion — completion lives in `services/taskCompletion.ts`
(task 9's territory). So the criterion was aimed at the wrong module.

Exercised directly on the repositories instead, live:

| Recurrence | Primitive | Row after | |
|---|---|---|---|
| one-off (`recurrence: null`) | `update(status:'completed')` | `status: **completed**` — it closes | ✅ |
| `unscheduled` | `recordUnscheduledCompletion` | `status: **active**`, `lastCompletedAt` set — clock resets, stays in the pool | ✅ |

The constraint-#7 boundary holds on real SQLite: the two primitives have opposite effects, and the
`unscheduled` task correctly survives its own completion.

## 7. The skill-injection seam

Exercised inert throughout: `assembleCoachingPrompt` with `injectedSkills` defaulted to `[]` runs
the live flow with no effect on output. Task 18's hook is present and harmless.

## 8. A note for whoever adds a dev screen next

Statically importing `src/db` from a screen **breaks the Jest suite**. `connection.ts` imports
`@op-engineering/op-sqlite` at module top level and that entrypoint throws the moment it is
evaluated without `NativeModules.OPSQLite` — so `App.tsx` importing the screen made
`__tests__/App.test.tsx` fail to parse (observed, then fixed). `Task12DeviceScreen` lazy-`require`s
the data layer inside its handlers, keeping the native module off App's static graph. The barrel's
"importing this module never touches the native module by itself" claim holds for `db/index.ts`'s
lazy `getRepositories()`, but **not** for `connection.ts`'s top-level import.

## 9. One-line call

**GREEN — Task 12 is complete.** All three triggers fire at the right urgency, the real 4B's
resolution union dispatches through real repositories with writes that provably persist, dispositions
are sensible across four action types, the crisis path short-circuits with zero model calls, the
skill seam is inert, and the `null`-vs-`unscheduled` completion boundary holds on hardware. The data
layer's first-ever hardware run passed and closed the `POWER()` TODO.

**Open, and owned by a human, not by code:** the crisis detector's coverage and
`CRISIS_REFERRAL_TEXT`'s localisation (both `REVIEW(human)`-marked — see the Task 7 report §9), and
the this/next weekday decision (§5). **Unexercised on-device:** `add_dependency` and
`add_missing_task`.

## 10. Reproduction

- Harness: [`src/dev/Task12DeviceScreen.tsx`](../../src/dev/Task12DeviceScreen.tsx) — the "Task 12"
  screen. Buttons: **1** DB spike, **2** triggers, **3** real dispatch, **3b** mutating scenarios,
  **4** completion boundary. Run **1 first** — everything else assumes the DB opened and migrated.
- JS-only; `npm start` + relaunch suffices (op-sqlite and llama.rn are both already in the APK).
- Results log as chunked `[T12RESULT:*]` lines; capture with `adb logcat -s ReactNativeJS:*`.
- The probes seed and soft-delete their own rows, so repeated runs don't pollute the pool — but the
  DB persists on the device between runs (`todoai.db`, app-private).
