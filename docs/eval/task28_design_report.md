# Task 28 Design Report — multi-session work & hyperfocus extension

**Verdict: design complete** at `docs/design/multisession_task28_design.md`, ready for Opus to
implement without further design input, **except one escalated ruling** (the hyperfocus guardrail,
below) which gates only the UI surface of extend, not the data model or the migration.

**Read first:** the design itself; this report is the paper trail — positions taken, the ruling
Jason owes, what was deliberately left open, and the sequencing recommendation the brief asked for.

---

## 1. The five §2 questions, answered

**a. Where the in-progress state lives:** a new `tasks.work_state` axis (`none | in_progress`)
orthogonal to `status` — the task stays `status='active'` throughout, so no pool query, filter, or
ranker changes. A new `'in_progress'` status value was rejected because every pool read is
`WHERE status='active'` and one missed query means tasks silently vanish from the pool — the
constraint-#5 failure class. *Paused* = in-episode timer pause (transient, §8.2, unchanged).
*Parked* = episode ended in the new `progress` outcome, intent to resume. *Skipped* = declined
without work. *Abandoned* = an episode/session ending without a user decision — **tasks are never
abandoned by inference**; only an explicit coaching disposition writes off in-progress work.
Park writes no `skip_count`, enqueues no coaching, and cannot feed the 3-skip recalibration —
structurally, not by policy check.

**b. Cumulative duration:** minutes accrue in `tasks.accumulated_minutes`; at completion,
`completeTask` folds accumulated + final episode into **exactly one** `actual_duration_history`
entry, for every recurrence type, at one choke point before primitive dispatch (constraint #7
untouched). `average_actual_duration` = mean total work time per completion — needed no
redefinition, only the fold discipline. The §5.4 model-guess replacement **waits for the fold**;
no partial updates (partial times are censored data). The "estimate is obviously blown" problem is
handled in planning arithmetic (see c), not by mutating stored data; a named seam
(`accumulated ≥ estimate` as an early signal) is left for task 17.

**c. Open-ended duration mode:** `tasks.duration_type = 'estimate' | 'floor'`. A floor task keeps
`estimated_duration NOT NULL` (it holds the floor value — "at least an hour" → 60), the timer
counts **up**, and the planned boundary comes from the session block, not the task — so an overrun
is definitionally not an estimation error. Declared, never inferred from magnitude. One elegant
consequence: an estimate-typed task whose accumulated time exceeds its estimate is *treated as a
floor for placement* (it has proven open-ended) without any stored field changing.

**d. Extend:** one affordance, task-triggered, session-extending — no separate session-level
control. +25-minute quanta (named tunable); session end moves with it when crossed
(`sessions.extended` flips TRUE); when the stretch ends, the agenda tail is **regenerated** via
`replanRemaining` (the escape valve / break-overrun primitive gains a third caller) rather than
shifted or shrunk — a shifted tail is stale (energy and context have moved) and the plan was never
shown to the user anyway. Whether extend needs a limit: **escalated** (§3 below).

**e. Re-entry into planning:** at most **one** in-progress task per session gets first claim on the
deep-focus block; picked by most-recent `last_worked_at` (continuity decays with time away;
neglect already champions the old ones through the normal shuffle). Everything else — including
other in-progress tasks — flows through the untouched novelty pipeline. Quick sessions claim
nothing. Remaining time = `estimate − accumulated` for estimate types; floors fill their block and
are only placeable in blocks ≥ the floor. Neglect: **working a task re-anchors its clock**
(`last_worked_at` joins a three-way max anchor in `listActiveByNeglect`) and then grows unbounded —
a start condition in R8's exact sense, never a cap; a parked task mathematically cannot hide
(§5 of the design has the full argument). R7: a broken-down parent keeps its accumulated time and
folds it at the confirmed check-off; `count`: each increment folds its own multi-sitting total —
no special case.

## 2. Positions on the three tensions (taken, not split)

1. **Resume-continuity vs. novelty — novelty keeps the session, continuity gets one structural
   slot.** The deep-focus block is where returning lives (long work is definitionally deep-focus
   work); the front of every session stays novelty-shuffled. No resume factor enters scoring —
   that would reopen the task-10 GREEN composition to serve what is really a session-structure
   need (the same reasoning that kept fork 3's energy asymmetry out of scoring).
2. **Hyperfocus vs. self-care — escalated with a recommendation** (§3). What is *not* escalated:
   the break-first rule after a ≥50-minute stretch in the regenerated agenda, which is §5.3.4
   planning hygiene and lands regardless of the ruling.
3. **The fail-safe vs. open-ended work — re-anchor, never pause, never cap.** The clock restarts
   on genuine attention (a work episode is a stronger "decision" than the coaching conversation
   §5.2 already lets reset the clock) and grows without bound afterward. Explicitly on the
   start-condition side of R8's line, and stated as such in the design so no refactor drifts it.

## 3. The ruling Jason owes — the extend guardrail

Presented as three options in design §4.3: **A** unlimited-and-quiet, **B** nudge cadence
(every 2nd extend carries a one-tap self-care line; a stretch > 2× the original block queues a
gentle next-start coaching row; nothing ever blocks), **C** soft cap (rejected-by-recommendation
as a wall wearing a cardigan). **Recommendation: B** — the only option that honors both §5.3.4
(deliberate self-care) and §10.3 (coaching over forcing) instead of sacrificing one. The three
mechanisms are independent switches, so ruling A or B (or anything between) is config, not
redesign, and the ruling gates **only task 24's extend surface** — migration, primitives, and
planner work proceed either way.

## 4. Sequencing recommendation (the retrofit bill)

**Land 28's implementation before task 11.** The bill (design §10, itemized): task 11 takes **6
structural touches** — item sizing must route through `plannedMinutes`, deep-focus allocation
gains the resume step 0, and the agenda item type must carry block kind (countdown vs open block)
from day one or it becomes a breaking change to task 24's consumption. Tasks 13 (5 touches) and
24 (5 touches) are additive — their items become ordinary requirements if 28 precedes them.
Task 17 (3 touches) is purely definitional — it doesn't exist yet either way. So the retrofit
cost is concentrated almost entirely in 11, which is exactly the task 28 would delay least: 28's
implementation is a migration, one repo primitive, the fold in `completeTask`, the anchor SQL,
and one grammar field — small, headless, and it removes the task-11 brief's §3 "build against
today's model, leave a seam" clause entirely.

Coordination note: whichever of 25 (R8) and 28 lands second makes the one-line anchor merge in
`listActiveByNeglect` (design §5); both briefs' successors should carry the flag.

## 5. Deliberately left open (stated, not silently resolved)

1. **The guardrail ruling** — escalated above; the one true blocker, and only for 24's surface.
2. **Floor-typed subtasks in the breakdown grammar** — cut from v1 to keep the 4B's breakdown
   output unchanged. The mokRadio shape is served via breakdown + `modify_task`, or in practice by
   the blown-estimate planning rule. Revisit when a real breakdown demands floors. (Design §9.)
3. **Floor tuning policy** (does learning ever raise a floor, or convert a stable floor to an
   estimate?) — task 17's call; v1 never auto-lowers a user-stated floor. Seam named.
4. **The 25-minute extend quantum and the 60-second park gate** — reasoned defaults, named
   tunables; personal use will calibrate them. Not worth pre-tuning.
5. **A stale-parked coaching trigger** — considered and cut (design §9): the re-anchored neglect
   clock already guarantees resurfacing with unbounded pressure; revisit only on field evidence.
6. **Channel-B attribution of `progress`** (a park after a coached fire = corroboration) — flagged
   to task 19 (design §8); it's 19's design to confirm, since the skill layer owns its evidence
   rules.

## 6. What this design did not touch (verified, not assumed)

- `src/scoring/` — zero changes; no new factor, no multiplier, `historicalSuccessFactor`'s `n`
  excludes parks by construction. The task-10 review's subject matter is byte-identical.
- The completion primitives and their §4.2 semantics — the fold is service-layer, pre-dispatch.
- The coaching trigger table — park enqueues nothing; no new `trigger_type` value in migration
  003 (the §4.3-B long-extend follow-up reuses `pattern_detected` with `trigger_data`).
- Constraint #5 — nothing saturates; both new clock behaviors (re-anchor, R8 composition) are
  start conditions with unbounded growth after, and the design says so at each site.
