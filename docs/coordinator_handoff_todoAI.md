# Coordinator Role — todoAI (handoff to a successor session)

*Add this to project knowledge. It supersedes the previous handoff; everything still true has been carried forward rather than assumed. You are picking up the **coordinator** role on the ADHD task-management app (todoAI), not starting it.*

*Refreshed 2026-07-29 — **personal ship is met.** Task 24 (product UI) landed and the whole loop is confirmed on the S23 FE; task 13 (timer/lifecycle) and task 23 (design) landed before it.*

---

## 1. What the role is

You are the **coordinator**, not the builder. Jason is the sole developer and decision-maker; you plan, allocate, brief, and verify. Concretely:

- **Turn decisions into briefs.** Almost every unit of work starts as a markdown brief in `docs/briefs/` that a *different* model (or Jason, or Jason+device) executes. Writing a good brief is the main deliverable.
- **Allocate work by failure mode**, not size: clear pattern → **Sonnet/Haiku**; serious engineering against a clear spec → **Opus**; *a merely-good answer could be subtly and expensively wrong* → **Opus 5** (this now inherits the slot Fable held — Fable access ended; see §8); needs the phone or human/product judgment → **Jason**.
- **Maintain the canonical record** so no session re-derives the project state.
- **Verify claims.** When told "that's done," read the findings report before agreeing. This has paid off every single time.
- **Push back.** Jason wants the disagreement, not the assent. Several of the best outcomes came from "I think that conclusion is wrong, and here's the mechanism."

**You do not write app code.** You read it to write accurate briefs and to verify. If you find yourself implementing, you've drifted out of role. *(Exception this session: the coordinator wrote the two master-table artifacts and the design-review docs — those are coordination records, not app code.)*

## 2. The document system (keep it coherent — it's the project's memory)

| Doc | Role |
|---|---|
| `docs/briefs/orientation_for_opus.md` | **Canonical.** Live status table (§2), module contracts (§3), non-negotiable constraints (§4), settled decisions (§5), ship gates (§8), open tasks (§9). Read first; update when reality changes. **It wins on any conflict**, except a per-task brief wins for its own task. |
| `todoAI_master_task_table.{md,html}` | Jason's at-a-glance board. **Lives in chat artifacts, outside the repo** (by design). Defers to orientation on conflict. Keep **both** formats synced. |
| `docs/briefs/*.md` | Per-task briefs (the work orders). |
| `docs/design/*.md` + `*.dc.html` | Design deliverables. Task 18 (skill layer), task 28 (multi-session) + its extend amendment, and now **task 23's interactive prototype** (`Main Screen.dc.html`, `Coaching Screen.dc.html`). |
| `docs/eval/*_findings_report.md` + `task23_review.md` | Results from build/device/probe/design sessions. **These are the evidence base** — read them, don't trust summaries of them. |
| `docs/reference/` | Spec + schema snapshots. **Spec v2.3 current** (v2.4 pending task 35); **schema snapshot v2.5**, but **on-device schema is 2.6.0** (migration 005). Spec-version and schema-version legitimately differ — don't "fix" the mismatch. |
| `docs/build_allocation.md` | **RETIRED** (tombstone only). Routing logic → this handoff §1; per-task allocation → the master table's Model column. Do not resurrect. |

**Numbering:** task IDs are canonical in orientation §2. No task 16 (split into 23 + 24). Q1 sits between 5 and 6. **Design and implementation get separate numbers** (18/19 skill layer, 28/33 multi-session, 23/24 UI) — keep that; it's what lets a design be evaluated on its own.

**Sync rule Jason asked for explicitly:** when a task changes, update **orientation, the master table markdown, and the master table HTML** together. A status living in three places with no sync rule is how drift starts.

**A filesystem-tool caveat learned this session:** the `Filesystem:*` MCP tools intermittently drop out of the loaded tool set (a `tool_search` for them sometimes returns only Google Drive tools). When that happens, `write_file`/`edit_file` are briefly unavailable; wait and retry, or work through chat artifacts. There is **no delete tool** — a stray file can only be overwritten, not removed. (There is one such stray now: see §7.)

## 3. Where things stand (as of handoff)

**PERSONAL SHIP IS MET (2026-07-29).** The whole loop — add a task through the chat → start a session → check in → execute with the timer → all five outcomes → coaching when triggered → summary — runs on the S23 FE, every step checked against the pulled database, not the screen. The alarm fires **11 ms** late from the background (vs 38–45 s for `setTimeout`). This is the milestone the whole project was aimed at.

**Done & confirmed:** 0–13, Q1, 18, 23, 24, 25, 26, 27, 28, 33, 34. Backend + design + functional UI, all real.

**Task 24 landed this session** (`src/app/`, `docs/eval/task24_findings_report.md`): the product surface in four non-leaking layers (controllers / presentational screens / shell / alarm), an `AlarmManager.setAlarmClock` TurboModule that discharges constraint #13, and Phase B on the device that found **five bugs and one build trap, four of them silent** — all fixed. 636→711 tests. It also **closed task 23's three follow-ups for free** (the engine already had each behaviour).

**The one open qualifier on "met":** five bug-fix commits followed the reported 711-green run, so **re-confirm the merged green** (`jest` + `tsc --noEmit` + `eslint .`) before building on it. Do this first.

**In flight, headless, parallel-safe (set-and-forget):**
- **Task 35** — spec fold-in v2.3→v2.4, docs-only. `docs/briefs/spec_foldin_task_35.md`.
- **Task 36** — recurrence period engine (a live bug: `scheduled` tasks never advance `next_due_at`). Headless. `docs/briefs/recurrence_period_engine_task_36.md`. Migrates as **006 / 2.7.0** (13 took 005).

**Five handoffs task 24 raised, pinned in orientation §9** (don't let them rot):
- **→ task 26:** its `learning_state` table is what unblocks spec §6.1's 5-day re-orientation — needs a `last_opened_at` watermark (`sessions.started_at` answers a different question). Task 24 wired everything but the watermark.
- **→ task 36:** the recurrence editor's "every N weeks" interval was dropped — the `scheduled` union carries weekdays only; adding an interval is a schema change here.
- **Decisions owed:** `sessions.model_tier` (never written — what does it mean for a no-model session?); `session_ended_early` (a real trigger type but not one of §7.2's five — should backing out with time left coach?); per-episode `interactions` energy left null (beta if the learning loop wants it).

**The frontier is now beta + general work** (orientation §8): the designed/polished visual pass of task 24, task 21 (crisis — human), task 30 (device envelope — Jason), task 20 (real eval numbers), task 32 (device residue — one item, `add_missing_task`, was on the personal path and is now the natural first beta sweep). Task 24 already **wired** D1's recap→constrain flow in the product; measuring it is still task 32's.

**The R-series ledger** (all folded into scoring + spec v2.3; history, not pending): R1 neglect linear+swappable (still uncapped), R2 subtask ordering via real deps, R3 context/tools as a hard pre-filter (weights 31/23/23/23), R4 buried-task coaching, R6 smoothed historical success, R7 parent-kept-after-breakdown + immediate `breakdown_complete` coaching, R8 neglect accrual gate `anchor + period/(1+quota)`. U1 (dep-blocked pre-filter) landed with task 25 and unblocked 11.

## 4. Working habits that earned their place

Carried forward; none are style preferences.

- **Separate *confirmed* from *believed*.** Anything model- or device-touching that hasn't run on the S23 FE is "believed done, pending device confirmation."
- **The device is ground truth.** An entire three-session arc chased "structural grammar bugs" that were one lexer quirk (`_` in GBNF rule names). Desktop reasoning doesn't substitute.
- **Read the report, not the summary.** "Sounded all green" has repeatedly concealed the finding that mattered. This session: task 13's report *looked* like a clean ✅ but carried three handoffs and an open `P` item — all of which would have been lost on a summary read.
- **Verify claims, they keep finding things.** Task 26 (briefed as routine) found the migration runner never applied >1 migration. Task 13's report (looked done) hid the JS-alarm constraint that reshapes task 24.
- **When a conclusion has no mechanism, distrust it.** Ask what could physically cause this.
- **Don't over-engineer a mechanism Jason described simply.** The park gate is a dumb 60-second timer, not a "was this real progress" heuristic — the check is dumb, the *conversation* is smart.
- **Record decisions where they bind.** A ruling that lives only in chat is lost. The extend split is recorded in the task 28 *amendment* (not just chat) because task 24 will read the design, not this conversation.
- **When a ruling narrows a constraint, amend the constraint text**, so a future session doesn't flag a legitimate ruling as a bug. (R1/R8 narrowed "never cap neglect" → constraint #5 now says *saturation* is the violation, shape and clock-start are tunable.)
- **Dependencies that aren't tasks rot.** "6 + quants," "device envelope," the recurrence engine — all sat as dangling deps until numbered (29, 30, 36). Every real work item gets a number unless it's a ship stage.
- **Parallel tracks must be file-disjoint, and say so in both briefs.** 35 (docs) runs clean beside 36 (src) beside 24 (src, different area).
- **Verify your own edits.** This session's master-table scripts failed uniqueness checks twice on stale anchors; each time the fix was to read the exact current markup first. `str_replace`/`edit_file` anchors go stale the moment the file changes — re-read before re-editing.

## 5. How Jason works

- Makes the **product-intent calls** (curve aggression, filter-vs-weight, extend guardrails, ship gates, the extend split into +5/hyperfocus). Bring him the tradeoff and a recommendation; don't decide for him.
- **Rules fast and precisely** on a clean question — the `period/(1+quota)` gate, the extend guardrail, the "+5 uncapped, coach later" call all came back in one line. Ask crisply, get a crisp answer.
- Corrects you directly when you're wrong — take it, adjust, don't grovel. He flags when *he* misspoke too (e.g. "you mean 23 and 24?" caught a real coordinator error), so re-check assumptions when he does.
- **ADHD app for himself first** — three ship targets: **personal**, **beta**, **general** (orientation §8). Pin deferrals to the gate that actually blocks them.
- Runs device sessions himself. **Sequence headless work and device batches separately**; hand him headless set-and-forget batches when he's away from the phone.
- Works from a phone sometimes (so filesystem tools may be unavailable on his end too). Wants the master table readable **without horizontal scrolling** and kept current in **both** formats.

## 6. Standing constraints (violating these is a real bug — full list in orientation §4)

The ones that bite most, including the two newest:
1. **Chat template mandatory** — `messages:[{role,content}]`, never raw `completion()`.
2. **No underscores in GBNF rule names** (build quirk, lint-enforced — don't "fix" the workaround).
3. **Never first-parse a grammar in front of a user** — startup guard, fall back to prompt-JSON.
4. **Neglect never saturates.** Curve *shape* (R1) and clock *start* (R8) are tunable; a ceiling is not.
5. **`null`/one-off ≠ `unscheduled`** — opposite completion semantics; different repo primitives.
6. **Two-level scales** — importance 1–1000, energy 1–5 internally; always via `scales.ts`.
7. **Local-only** — no cloud, no LoRA. Stock `llama.rn` + 4B; the fork is parked behind `LLMProvider`.
8. **A park is not a skip; the app never abandons a *task* by inference** — only an explicit disposition writes off in-progress work.
9. **Extend is two affordances** — `+5` flat/uncapped/coach-later; `Keep going` hyperfocus/count-up/guardrail-B. Capping `+5` is a bug against the ruling.
10. **The expiry alarm cannot be a JS timer** (task 13, device-confirmed) — task 24 needs `AlarmManager`/notifee/foreground service at `blockEndAtMs`.
11. **`sessions` is born `'abandoned'`** (crash-truthful); task 24 creates the row, task 13 owns every write after.
12. **Migrations that change a CHECK need the full rebuild discipline** (task 26 report), **and every migration must sweep prior migrations' test suites** (task 34 §4 — `runMigrations` walks forward, so earlier suites' assertions become assertions about the new one).

## 7. Open items & residue (personal ship is met; these are beta/general/parallel)

- **Re-confirm merged green** — five task-24 bug-fix commits followed the reported 711-green run. One clean `jest` + `tsc --noEmit` + `eslint .`. **Do this first.**
- **Two still-live task-13 handoffs** (pinned on their task rows in orientation §2, repeated here so they don't vanish):
  - **→ task 19:** decide whether a recovered crash (`completion_status='abandoned'`) counts as a friction incident — §1.3 says a crash isn't user failure.
  - **→ task 17:** `completion_count`/`success_rate` have **no writer anywhere** — `historicalSuccessFactor` scores every task off a permanent n=0; 17 is the natural owner.
- **Five task-24 handoffs** — see §3 (learning_state watermark → 26; recurrence interval → 36; model_tier / session_ended_early / per-episode energy decisions).
- **Task 23 designed pass** — the polished visual layer (task 23's tokens applied throughout, motion, dark mode). Beta gate. The functional pass already speaks the right visual language via `theme.ts`.
- **`which:"next"` weekday semantics (task 22)** — still an open decision; affects every resolved date.
- **Multi-day `scheduled` neglect gap (task 25 §3.1)** — reasoned, not ruled; revisit with real multi-day schedules.
- **Task-24 device edges not covered** (report §10): `resume_block` recovery on hardware (tested, not device-run); overnight doze on battery; the locked-screen full-screen intent as a watched behaviour; four of six recurrence kinds tapped; deep-idle alarm delivery (inferred at 11–30 ms for shallower states, run stopped at 5:45am before the deep-idle fuse blew).
- **Verification residue → task 32:** `add_missing_task` dispatch (was personal-path per R7, now the natural first beta sweep), `add_dependency` dispatch, D1 recap→constrain **measurement** (task 24 wired the flow; measuring it is 32's).
- **Beta gates:** task 21 (crisis coverage — human), task 30 (device envelope — Jason), task 20 (real eval numbers).
- **A stray file to delete:** `docs/briefs/SECTION7_TEMP.md` — created by accident when the edit tool was briefly down; overwritten with a "DELETE ME" tombstone but **there is no delete tool**, so Jason must `rm` it by hand. Harmless until then.

## 8. Model allocation going forward

**Fable is gone** (access ended). The three Fable-worthy cores were spent well: task 10 (scoring review), 18 (skill-layer design), 28 (multi-session design) — all delivered findings a merely-good answer would have missed.

**Opus 5 inherits the "subtly-and-expensively-wrong" slot** — but spend it as narrowly as Fable was. Sorted this session (full reasoning is in-chat; capture it in a brief if you act on it):
- **Strong yes:** task 19's **outcome-attribution / confidence channel** (learns the wrong lessons invisibly if wrong; no test fails loudly) — the single clearest case left; and task 20's **negative-control / eval methodology** (a broken-but-passing eval poisons every downstream "it works").
- **Worth it:** task 17's **regression-protection + rollback** interaction.
- **No meaningful benefit (4.8 or below):** 14, 15, 22, 24-screens (Sonnet), 32, 35, 31, 8. Task 24's *architecture* is fine on 4.8; its *screens* are Sonnet.
- **Not a model question:** 21 (human), 29/30 (Jason).

The whole personal-ship path (task 24) is bounded engineering + UI — **nothing on it needs Opus 5.** The Opus-5 work all sits in Phase-2 learning (17/19/20).

---

*It has been a genuinely good project to coordinate. The record is coherent, the frontier is a single well-briefed task, and the backend under it is real and confirmed. Pick it up with confidence — and keep reading the reports, not the summaries.*
