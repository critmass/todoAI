# Coordinator Role — todoAI (handoff to a successor session)

*Add this to project knowledge. It supersedes the previous handoff; everything still true has been carried forward rather than assumed. You are picking up the **coordinator** role on the ADHD task-management app (todoAI), not starting it.*

*Refreshed 2026-08-07 for the Claude Code handoff (that note is below). **Re-refreshed 2026-08-19** — a large session: `coordinator/sessions-origin` merged and `main` test-verified green (811→**961 tests** as tasks landed); **tasks 37, 48, 14 Phase A, 41 (both phases), 44 all landed**; the **merged tree ran on the S23 FE for the first time** and a big slice is now device-confirmed (report: `docs/eval/device_session_2026-08-19_findings.md`); **tasks 46–51 numbered**; ~15 rulings cleared; and 🔴 **Jason ruled the execution boundary — the coordinator never runs code/tests/builds/device, only subagents do (§1).** The 2026-08-07 first-actions box below is fully discharged and replaced.*

> ### ⚠ First actions, in order (as of 2026-08-19)
>
> 0. **Internalise the execution boundary (§1, ruled 2026-08-19).** You do not change code or run tests/builds/device — you brief subagents and review their reports + the diffs. This is the biggest change to how the role operates. Everything below routes through subagents.
> 1. **Read the evidence, then the board.** `docs/eval/device_session_2026-08-19_findings.md` is the current device-verification record; `docs/master_task_table.md` is status (regenerate its HTML with `node scripts/gen-task-table.js` after any edit — a drift test now enforces sync, and the generator rejects malformed rows). `main` is green and pushed (`c8a7ecb` at handoff).
> 2. **The next build step is headless: task 14 §13 wiring.** Task 14 Phase B is blocked because the backup ladder is invoked by *nothing* in the app — it needs the 3-call-site session gate + a "not enough space" surface (task 24 screens) wired. `src/app` is now settled (41/44 landed), so it is unblocked. ⚠ It has a UI-surface component that may want Jason's design input before you brief it. Wiring it unblocks task 14 Phase B **and** StatFs on the next device session.
> 3. **Decisions owed by Jason** (surface these; don't decide): the `use_breath_pause`-class tag removal (needs a manual, human-judgment step — the automated purge won't touch it); task **50** (pin the `energy` definition — Jason+Opus, gates 31); the four **task-41 provisional builder calls** if not yet ruled; whether to run task 14's destructive Phase B tests once wired.
> 4. **The strategic thread is still `41 → 31 → 38 → 40`.** Task 41 is now device-confirmed and capture accumulates the corpus on its own; **31 (corpus, gated on 50) is the longest-lead item** and the one that moves the model decision. Task **37 is done**, so the corpus window is no longer contaminated by the grammar hole.
> 5. **Defect leads to chase** (brief a subagent): the non-functional "Wrap this up" button on the Coach screen; blocked-button disabling is unverified for lack of a dependency-blocked task in the data.

---

## 1. What the role is

You are the **coordinator**, not the builder. Jason is the sole developer and decision-maker; you plan, allocate, brief, and verify. Concretely:

- **Turn decisions into briefs.** Almost every unit of work starts as a markdown brief in `docs/briefs/` that a *different* model (or Jason, or Jason+device) executes. Writing a good brief is the main deliverable.
- **Allocate work by failure mode**, not size: clear pattern → **Sonnet/Haiku**; serious engineering against a clear spec → **Opus**; *a merely-good answer could be subtly and expensively wrong* → **Opus 5** (this now inherits the slot Fable held — Fable access ended; see §8); needs the phone or human/product judgment → **Jason**.
- **Maintain the canonical record** so no session re-derives the project state.
- **Verify claims.** When told "that's done," read the findings report before agreeing. This has paid off every single time.
- **Push back.** Jason wants the disagreement, not the assent. Several of the best outcomes came from "I think that conclusion is wrong, and here's the mechanism."

**You do not write app code.** You read it to write accurate briefs and to verify. If you find yourself implementing, you've drifted out of role. *(Exception this session: the coordinator wrote the two master-table artifacts and the design-review docs — those are coordination records, not app code.)*

> 🔴 **The execution boundary — RULED by Jason, 2026-08-19 (firm).** The coordinator **never changes code and never runs tests, typechecks, lint, builds, or the device directly.** All execution is a subagent task. This is not new in spirit — "you do not write app code" always meant it — but it now explicitly covers **running** things too, because in Claude Code the coordinator *can* execute and this session drifted into driving the gradle build, `adb input`, the `jest`/`tsc`/`eslint` suite, and editing `scripts/gen-task-table.js` directly.
> - **Never:** edit `src/`, `android/`, native, or `scripts/*` (incl. `gen-task-table.js`); run `jest`/`tsc`/`eslint`/`gradlew`/any build; build/install/drive the device (`adb install`/`input`/`am force-stop`/instrumented checks).
> - **Do:** maintain the canonical record (markdown — board, orientation, briefs, findings reports, this handoff); **run `node scripts/gen-task-table.js`** to render the board (a rendering step, not a test/build); read code and reports; write briefs; review subagents' reports + diffs; interface between Jason and the subagents.
> - **Verification is analytical, not executional** — verify by *reading* the report, the code, and the pulled artifacts; if a re-run or fresh measurement is needed, **brief a subagent** to produce it. A device subagent builds/drives/pulls and reports; you review.
> - **Why this wasn't an issue before:** the coordinator ran in chat / Claude Cowork with Jason spinning up the build agents by hand — the boundary was enforced by the environment. In Claude Code it must be enforced by discipline. It keeps the reviewer from also being the author, and keeps coordinator context off execution.
> - **Only Jason overrides, per instance** (as he did with the gradle build this session). Absent an explicit override, delegate. **This supersedes the older "you can run the tests now / you can run `adb` now" guidance below** (first-actions box, §2 tooling table, the closing line) — that guidance was written when the win was simply *being able* to run them; the ruling is that the coordinator *doesn't*, the subagent does.

## 2. The document system (keep it coherent — it's the project's memory)

| Doc | Role |
|---|---|
| `docs/master_task_table.md` | **Canonical for per-task status.** Jason's at-a-glance board — every task, dependencies, model allocation, `P` batches, counts, frontier. **Moved into the repo 2026-08-07** (it used to live only in chat artifacts). Wins on *status*. |
| `docs/master_task_table.html` | **Generated. Never hand-edit.** `node scripts/gen-task-table.js` renders it from the markdown. This is the view Jason reads in the chat window — present it after any change. |
| `docs/briefs/orientation_for_opus.md` | **Canonical for everything that isn't status:** confirmed device facts (§1), branch/verification state (§2), module contracts (§3), non-negotiable constraints (§4), settled decisions and rulings (§5), ship gates (§8), open rulings/handoffs/residue (§9). Read first. Wins on *contracts, constraints, decisions, gates*; a per-task brief wins for its own task. **It no longer duplicates the status table** — that duplication drifted twice and cost a session. |
| `docs/briefs/*.md` | Per-task briefs (the work orders). |
| `docs/design/*.md` + `*.dc.html` | Design deliverables. Task 18 (skill layer), task 28 (multi-session) + its extend amendment, and now **task 23's interactive prototype** (`Main Screen.dc.html`, `Coaching Screen.dc.html`). |
| `docs/eval/*_findings_report.md` + `task23_review.md` | Results from build/device/probe/design sessions. **These are the evidence base** — read them, don't trust summaries of them. |
| `docs/reference/` | Spec + schema snapshots. **Spec v2.4 current** (task 35). On-device schema **2.7.0** (migration 006, task 36); the `v2.5.sql` reference snapshot is now **two** migrations behind (005+006) — a snapshot catch-up is unowned work worth numbering when someone touches `docs/reference`. Spec-version and schema-version legitimately differ — don't "fix" the mismatch. |
| `docs/build_allocation.md` | **RETIRED** (tombstone only). Routing logic → this handoff §1; per-task allocation → the master table's Model column. Do not resurrect. |

**Numbering:** task IDs are canonical in orientation §2. No task 16 (split into 23 + 24). Q1 sits between 5 and 6. **Design and implementation get separate numbers** (18/19 skill layer, 28/33 multi-session, 23/24 UI) — keep that; it's what lets a design be evaluated on its own.

**Sync rule — simplified 2026-08-07, and the reason matters.** The old rule was "when a task changes, update orientation, the master table markdown, and the master table HTML together." Three copies with a manual sync rule is how drift starts, and it did: orientation §2 sat weeks behind, to the point the master table carried a warning that the canonical doc couldn't be trusted.

**The rule now:** edit **`docs/master_task_table.md`**, then run **`node scripts/gen-task-table.js`**, then **present the HTML in the chat window** so Jason keeps his at-a-glance view. Orientation is only touched when a *contract, constraint, decision, gate, or handoff* changes — not when a status does. Two files, one of them generated.

*(Jason's requirement was that the board be visible at a glance inside the Claude window. That's a viewing need, not a storage need — the file lives in the repo and gets rendered into the window on change, which satisfies it without the second copy.)*

### Tooling — what changed at the Claude Code handoff

**Most of the previous caveats are gone.** They described a sandboxed chat session, and several shaped decisions you'll find in the record:

| Previously | Now |
|---|---|
| `Filesystem:*` MCP tools intermittently dropped out | Direct filesystem access |
| **No delete tool** — stray files could only be overwritten | `rm` works. *(This is why `docs/build_allocation.md` is a tombstone rather than deleted — that was a tooling limit, not a decision. Leave it; the tombstone earns its place now.)* |
| Could not run the test suite — Windows-built native modules, slow repo mount | `npx jest` runs on this tree — but ⚠ **the coordinator does not run it; a subagent does** (§1 execution boundary, ruled 2026-08-19). |
| Could not push to a checked-out branch; a stale `.git/index.lock` blocked index writes | Native git. No branch dance needed. |
| Master-table HTML had to be rendered into the chat window for Jason to see | He reads it in the repo. **Still regenerate it** (`node scripts/gen-task-table.js`) — it's the at-a-glance board. |

**What still holds:** `Edit` fails atomically, so a mid-script uniqueness mismatch writes *nothing* — re-read the file's current text before retrying, because anchors go stale the instant the file changes. This bit twice in one session.

**The device is reachable via `adb` from this host** — ⚠ but **the coordinator does not drive it; a device subagent does** (§1 execution boundary, ruled 2026-08-19). Several open items are "believed, not confirmed" for want of a device run; the coordinator briefs a device subagent to close them and reviews the pulled artifacts.

## 3. Where things stand (as of handoff)

**PERSONAL SHIP IS MET (2026-07-29).** The whole loop — add a task through the chat → session → check-in → timer execution → all five outcomes → coaching when triggered → summary — runs on the S23 FE, every step checked against the pulled database. The alarm fires **11 ms** late from the background. This is the milestone the whole project was aimed at, and it holds.

**Done & confirmed:** 0–13, Q1, 18, 23, 24, 25, 26, 27, 28, 33, 34, 35, 36. Backend + design + functional UI + the recurrence engine, all real. **794 tests** *(claimed; see the first-actions box)*. Spec v2.4, schema 2.7.0. **45 tasks total, 1 retired (8), 19 open.**

**Commissioned this session (41–45) — read these before planning anything:**

| # | What | Why it exists |
|---|---|---|
| **41** | Lossless local event capture | 🔴 **New front of the critical path.** The app *discards* raw user input by design (`conversation_summary` — "raw transcript never stored"), so task 31 has no corpus to build from and weeks of real captures are gone. **Phase 1 design has landed** (`docs/design/capture_format_task41.md`, `bc36806`) with **six documented deviations and §12 needing rulings** — read it before green-lighting Phase 2. |
| **42** | Crisis-stream teardown + consent | Closed-beta gate. Alpha logs everything; **only the crisis stream is removed** before beta, the rest ships under consent. |
| **43** | Capture ladder | Open-beta and GA pruning. **Free-text capture dies at open beta**, which closes the corpus window permanently. |
| **44** | Personal-use QoL pass | Four alpha items, all product questions ruled. Owns **migration 007 / schema 2.8.0** (`sessions.origin`). |
| **45** | Deviation audit | Cleans the backlog of builder decisions that overrode Jason's without sign-off. Plus §2b, the six unreviewable `score.ts` diffs. |

**Retired / re-scoped this session:**
- **Task 8 (tiering ladder) — RETIRED.** Not superseded by 40; **the spike measured its mechanism out from under it**: *"the thermal envelope does not discriminate — all six reach at least SEVERE throttling by twenty minutes."* A 0.8B throttles when the 4B does, so downward tier degradation buys nothing here. Revival condition recorded: it's a **one-device** measurement, so task 30's envelope could reopen it — with the new measurement, not the old assumption.
- **Task 29 — re-scoped.** Its 8B half is answered by 40 (`Bonsai-8B-Q1_0` is loadable on stock and in the bake-off). Its fork half is newly dead — the spike found PrismML's `Q2_0` **absent from the build entirely**. What's left is a Vulkan-throughput question, general-ship, blocking nothing.

**Three dead tables found, all the same shape** — designed, never written to, implying guarantees the app doesn't make: `data_retention` (→ task 42), `backup_log` (→ task 14), `algorithm_weights`' `completion_count`/`success_rate` writer (→ task 17). **Check for a writer before assuming a table is live.**

**Landed since the last handoff:**
- **35** (spec fold-in → v2.4) — confirmed no cross-doc conflicts.
- **36** (recurrence period engine, migration 006 / schema 2.7.0) — idempotent `advanceRecurrence` sweep, missed-quota boost derived-not-stored. **Fixed a live bug worse than briefed:** urgency (23% of score) was broken in *both* directions for every recurring task (chat-created pinned at 1.0, editor-created at the floor). 711→794 tests.
- **The branch integration itself (2026-08-07).** Four divergent branches, now one `main` at `9d8b691`, merged conflict-free: `main` (35+36) ← `claude/interesting-shirley-e10fa1` (NUL fix, fast-forward) ← `task-36-recurrence-period-engine` (docs WIP) ← `opus/batch-a-headless` (the 37-commit spike). **`main` has not been pushed to GitHub yet** — `origin/main` is still at `1280f25`.

**THE LESSON THIS SESSION PAID FOR — "done" and "merged" are different claims, and the record only tracked the first.** Every document said 35 and 36 were done, confirmed, with reports and test counts. All true. But the *checked-out* branch had no migration 006, no `src/services/recurrence/`, and no v2.4 spec — and 36's fix was for a **live scoring bug affecting every recurring task**. An alpha APK built from the working branch during those four days would have shipped that bug, with the record insisting it was fixed. **Going forward, a task's status line says which branch its work is on until that branch is merged.** Add it to the row; drop it when it lands on `main`.

**Two things the integration surfaced that were in no document:**
- **`src/scoring/score.ts` was binary to git from its first commit.** `contextGroupKey`'s no-tags sentinel was a raw `0x00` byte inside the first 8 KB git samples, so **every diff of the scoring composition ever reviewed showed `Bin 8860 → 9177 bytes` instead of lines.** The most-reviewed file in the project never once appeared in a readable diff. Fixed (`db16645`); write-up in `docs/briefs/nul_byte_score_ts.md`. **Treat every pre-fix `score.ts` review as unverified** — including the task-10 Fable composition review, which is load-bearing for tasks 9/11/25. ⚠ **Corrected 2026-08-07 — the earlier wording here overstated this.** `db16645` **re-encoded, it did not change**: `contextGroupKey` still returns `'\x00flexible'`, now a source escape rather than a raw byte, so the value is **byte-identical**. It is a `Map` key — never persisted, never displayed, never compared against user data — so there was **no behavioural defect and no false positives or negatives were ever possible.** File reads always worked, so **task 10's composition review stands.** Only *diffs* were unreadable, so the genuinely unreviewed surface is **what changed after task 10** — six commits (9, 10-R1, 10-R3, 25-U1, 11, 36), **all readable today** via `git show --text`. Constants are pinned by tests; the residual exposure is *composition*. Verification folded into **task 45 §2b**.
- **A fourth branch, `claude/interesting-shirley-e10fa1`, existed, carried that fix, and was named nowhere.** Branches carrying real work get a line in orientation §2.

**THE LIVE STRATEGIC THREAD — the model-base decision (reopened 2026-08-03).** A six-model spike (`docs/eval/model_base_spike_final_findings.md` — the **final** report; note the supersession lesson in §4) recommends **migrating off Bonsai to Gemma 4 E2B.** Reasoning: Bonsai-4B is the best extractor measured (14/16 critical) but its ternary format is **permanently frozen** — no LoRA path outside PrismML's proprietary pipeline. Gemma 4 E2B is 12/16 but **trainable** (`llama.rn` exposes `applyLoraAdapters`), 2× faster/capture, best distress response, and two of its three worst fields are a null-convention mismatch fixable by prompt alone. But the gap is *inside* 16-fixture resolution, so **the decision is gated, not made:**
  - 🔴 **Task 41 (event capture) is now the first link** — 31 has no corpus to build from until the app stops discarding input, and **the collection window closes at open beta** (task 43). The corpus is built during alpha and closed beta or largely not at all.
  - **Task 31 (corpus)** — critical-path prerequisite, **re-sized**: the old "20–30 real messy tasks" resolves *worse* than the 16 seed fixtures it replaces (~±23 pts vs ±12). New target 80–120 extraction items, 45–60 held out. Needs a **held-out split**, grouped by source situation and stratified.
  - **Task 38** — train the Gemma LoRA (try the free prompt-only null-convention fix first). Depends on 31.
  - **Task 40** — three-way bake-off: **LoRA-Gemma-E2B vs Bonsai-8B-Q1_0 (untested, downloaded) vs T-Bonsai-4B**, on the held-out corpus, pulled-DB verified. Depends on 38. **Gates the decision; Jason makes the call**, recorded to orientation §1.
  - The framing is **"trainable-but-behind vs frozen-but-ahead,"** and the trajectory case (Gemma slightly behind but clearly climbing corpus-over-corpus) is a judgment, not a raw score. Until 40 lands, **Bonsai-4B stays the shipping default** — incumbent pending evidence, not a settled preference. *(39 reserved for an optional corpus→eval-harness task.)*

**🔴 Task 37 — live grammar bug, do before the bake-off and the next alpha capture.** The spike found `task_extraction.v1.gbnf`'s `title` rule accepts a bare `","` as a schema-valid, validator-passing, useless value. Bonsai dodges it only by luck (doesn't rank `","` first). Fix is spike-confirmed (first char `[a-zA-Z0-9]`; min-length does NOT work). `description` shares it; `newTag`/`tool`/`date` need auditing. Brief: `docs/briefs/grammar_separator_hole_task_37.md`.

**Also in flight / briefed and waiting** (all have briefs in `docs/briefs/`): **14** (backup/recovery, `P`), **15** (Safe Mode, `P`), **17** (numeric learning — owns the missing success-rate writer), **21** (crisis review — human, beta gate), **22** (`which:"next"` semantics), **32** (device sweep — clears the standing residue). Plus the install guide `docs/INSTALL_personal.md` for Jason's alpha use.

**The open qualifier, restated honestly (it was understated before).** This is **not** "re-confirm a green." There has never been a green run on the tree that now exists. The last reported green (711 tests, task 24) was followed by five bug-fix commits; 35/36 landed on a different branch (794 tests *there*); and the four-way merge is hours old. The merge is textually clean, which says nothing about semantic conflicts between the spike branch's `App.tsx` changes and 36's recurrence wiring at app-open.

**Run, on `main`, before building anything:** `npx jest` · `npx tsc --noEmit` · `npx eslint .`. Expect ~794 tests. **The previous coordinator could not run this** — Windows-built native modules, slow repo mount. **You can.** It is genuinely unverified, not verified-and-assumed, and it is first-actions item 2.

**Five task-24 handoffs, pinned in orientation §9:** learning_state `last_opened_at` watermark → task 26 (unblocks the 5-day re-orientation); recurrence "every N weeks" interval → was task 36's to consider (check its report for disposition); and three decisions owed — `sessions.model_tier` (meaning for a no-model session), `session_ended_early` (a real trigger not in §7.2's five — should backing out with time left coach?), per-episode `interactions` energy (beta).

**The R-series ledger** (all folded into scoring + spec v2.4; history, not pending): R1 neglect linear+swappable (uncapped), R2 subtask ordering via real deps, R3 context/tools hard pre-filter (31/23/23/23), R4 buried-task coaching, R6 smoothed historical success, R7 parent-kept-after-breakdown + `breakdown_complete` coaching, R8 neglect accrual gate `anchor + period/(1+quota)`. U1 (dep-blocked pre-filter) landed with 25 and unblocked 11.

## 4. Working habits that earned their place

Carried forward; none are style preferences.

- **Separate *confirmed* from *believed*.** Anything model- or device-touching that hasn't run on the S23 FE is "believed done, pending device confirmation."
- **The device is ground truth.** An entire three-session arc chased "structural grammar bugs" that were one lexer quirk (`_` in GBNF rule names). Desktop reasoning doesn't substitute.
- **Read the report, not the summary — AND check you're reading the *current* report.** "Sounded all green" has repeatedly concealed the finding that mattered (task 13's report *looked* like a clean ✅ but carried three handoffs and an open `P` item). **New this session, the sharper version:** the coordinator acted on `qwen35_spike_findings.md` and gave the wrong "stay on Bonsai" verdict — a file named `model_base_spike_final_findings.md` sat right next to it and *reversed* the recommendation. A report named `..._final_...`, or a newer sibling, is a pointer you don't ignore. Check the eval directory for a superseding report before acting on any findings.
- **Verify claims, they keep finding things.** Task 26 (briefed as routine) found the migration runner never applied >1 migration. Task 13's report (looked done) hid the JS-alarm constraint that reshapes task 24.
- **When a conclusion has no mechanism, distrust it.** Ask what could physically cause this.
- **Don't over-engineer a mechanism Jason described simply.** The park gate is a dumb 60-second timer, not a "was this real progress" heuristic — the check is dumb, the *conversation* is smart.
- **Record decisions where they bind.** A ruling that lives only in chat is lost. The extend split is recorded in the task 28 *amendment* (not just chat) because task 24 will read the design, not this conversation.
- **When a ruling narrows a constraint, amend the constraint text**, so a future session doesn't flag a legitimate ruling as a bug. (R1/R8 narrowed "never cap neglect" → constraint #5 now says *saturation* is the violation, shape and clock-start are tunable.)
- **Dependencies that aren't tasks rot.** "6 + quants," "device envelope," the recurrence engine — all sat as dangling deps until numbered (29, 30, 36). Every real work item gets a number unless it's a ship stage.
- **Parallel tracks must be file-disjoint, and say so in both briefs.** 35 (docs) runs clean beside 36 (src) beside 24 (src, different area).
- 🔴 **Surface every deviation from a human decision — in the report AND in coordination review.** *(Ruled by Jason, 2026-08-07, after task 24 shipped a linear progress bar where task 23's approved design had a dial and he was never asked.)* The information existed and still failed to reach him, so the rule is structural, not aspirational:
  1. **Every findings report carries a section titled "Deviations from human decisions."** Separate from "decisions this task had to make" and from "deferred deliberately" — both of those titles read as necessity or scheduling and are exactly where the dial hid. **Empty is a valid answer and must be written out explicitly**, so silence stops being ambiguous.
  2. **Coordination review surfaces that section verbatim**, not summarised. This is the step that failed.
  3. **A deviation is provisional until Jason rules it.** It does not enter orientation §5 as a settled decision, and it is marked awaiting-sign-off until he says otherwise. Otherwise a builder's call becomes canon and the canon can no longer tell you which is which.
  4. **Code comments cite the document that actually authorises them.** `WorkScreen.tsx` claims the bar is "explicitly acceptable — preferable, even — per the task brief"; **the brief says nothing about it.** A false citation launders a judgment into a sanction, and it fooled a coordinator reading the comment as evidence. If you cite a brief, open the brief.
  *(Backlog cleanup for everything that predates this rule is **task 45**.)*
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
7. **Local-only** — no cloud training, no telemetry. Stock `llama.rn` + Bonsai-4B TQ1_0 is the shipping default. *("No LoRA" was an earlier settled decision; the 2026-08-03 spike reopened it — Gemma 4 E2B supports runtime LoRA via `applyLoraAdapters`, and the `31→38→40` chain is evaluating a migration. Local-only still holds: any LoRA is trained off-device and served locally, no cloud inference. The PrismML ternary fork remains parked behind `LLMProvider`.)*
8. **A park is not a skip; the app never abandons a *task* by inference** — only an explicit disposition writes off in-progress work.
9. **Extend is two affordances** — `+5` flat/uncapped/coach-later; `Keep going` hyperfocus/count-up/guardrail-B. Capping `+5` is a bug against the ruling.
10. **The expiry alarm cannot be a JS timer** (task 13, device-confirmed) — task 24 needs `AlarmManager`/notifee/foreground service at `blockEndAtMs`.
11. **`sessions` is born `'abandoned'`** (crash-truthful); task 24 creates the row, task 13 owns every write after.
12. **Migrations that change a CHECK need the full rebuild discipline** (task 26 report), **and every migration must sweep prior migrations' test suites** (task 34 §4 — `runMigrations` walks forward, so earlier suites' assertions become assertions about the new one). ⚠ **"Change a CHECK" means altering a CHECK on an *existing* column — that is what SQLite cannot do without DROP+RENAME.** *Adding a new column* whose self-referential CHECK validates only itself (e.g. migration 007's `ALTER TABLE sessions ADD COLUMN origin TEXT CHECK (origin IN (...))`) needs **no** rebuild — SQLite accepts it via plain `ADD COLUMN`, existing rows get NULL, and migration 003 is the precedent. Clarified 2026-08-18 after task 44's deviation 2, whose brief restatement said "any CHECK change" and over-broadened this. The rebuild is about *mutating* a constraint, not *introducing* one.

## 7. Open items & residue (personal ship met; these are beta/general/parallel/strategic)

**The model-base decision is the biggest live thread** — see §3. `31 → 38 → 40`, gating Jason's migrate-or-stay call. Task 31 (corpus) is the unblocker for the whole chain and its priority is raised accordingly.

- **🔴 Task 37 (grammar separator hole)** — live bug in shipped extraction; do before the bake-off and the next alpha capture. Spike-confirmed fix.
- **Re-confirm merged green** — five task-24 bug-fixes + 35/36 landed since the last confirmed run. `jest` + `tsc --noEmit` + `eslint .`.
- **Two still-live task-13 handoffs** (pinned on their task rows in orientation §2):
  - **→ task 19:** does a recovered crash (`completion_status='abandoned'`) count as a friction incident? §1.3 says a crash isn't user failure.
  - **→ task 17:** `completion_count`/`success_rate` have **no writer anywhere** — `historicalSuccessFactor` scores every task off n=0. Task 17 owns the writer.
- **`energy` field-definition problem** (spike finding): wrong 6–14/16 on **every** model including Bonsai — an ambiguous field *definition*, not weak models. Cheapest available win, needs no migration. Fold into task-27-lineage spec work or task 20.
- **Schema snapshot two migrations behind** — `v2.5.sql` predates 005+006; a catch-up is unowned, worth numbering when someone touches `docs/reference`.
- **Task 23 designed pass** — the polished visual layer. Beta gate. The functional pass speaks the right language via `theme.ts`.
- **`which:"next"` weekday semantics (task 22)** — briefed, awaiting Jason's A/B ruling; affects every resolved date.
- **Multi-day `scheduled` neglect gap (task 25 §3.1)** — reasoned, not ruled.
- **Task-24 device edges** (report §10): `resume_block` recovery on hardware; overnight doze on battery; locked-screen full-screen intent watched; four of six recurrence kinds tapped; deep-idle alarm delivery measured (inferred 11–30 ms; deep-idle run stopped at 5:45am). Batch into task 32's device session.
- **Beta gates:** task 21 (crisis — human, briefed), task 30 (device envelope — Jason), task 20 (real eval numbers).
- ~~**A stray file to delete:** `docs/briefs/SECTION7_TEMP.md`~~ — **gone, verified 2026-08-07.**
- **Task 41 Phase 1 is landed and needs Jason's rulings before Phase 2.** `docs/design/capture_format_task41.md` §12. Its headline finding reaches beyond capture: **there is no way to write a file from JS in this tree** (no RNFS, no FS TurboModule; op-sqlite exposes paths but no write). That reshaped **task 14** too — see its rewritten brief.
- **Task 14 is paused by Jason** (2026-08-07), brief rewritten and ready. Not blocked, just not now.
- **Housekeeping — now doable directly** *(left behind by the sandboxed coordinator, which could create files in `.git/` but not delete them)*:
  - `git branch -D _probe _probe2` — two throwaway refs from a write-permission probe.
  - Delete `.git/index.lock`, `.git/packed-refs.lock`, `.git/refs/heads/_probe.lock` — all zero-byte and stale. `index.lock` predates this session and **is why no git command that writes the index can run from the sandbox.**
  - `rm -rf .git/objects/incoming-*` — temp object dirs from the push; harmless, but they'll accumulate.
- **The working tree's 220-file diff is line-ending churn, not edits.** `git diff --ignore-cr-at-eol` reduces it to exactly two real files (`orientation_for_opus.md`, `coordinator_handoff_todoAI.md` — the doc refreshes). There is **no `.gitattributes`** and `core.autocrlf` is unset, so a Windows tool rewrote the tree to CRLF and git sees every file as modified. **Fix the order of operations or you'll lose the doc edits:** commit the two docs first, *then* `git checkout -- .` to drop the churn, *then* add a `.gitattributes` (`* text=auto eol=lf`). Note commit `178e6c6` — "make the three source-drift guards line-ending agnostic" — this has bitten before.
- **Spike GGUFs:** only `Ternary-Bonsai-4B-TQ1_0.gguf` remains on the phone (device left clean); all six spike models + `Bonsai-8B-Q1_0` are on the laptop in `~/Downloads` for the bake-off, re-pushable in under a minute.

## 8. Model allocation going forward

**Fable is gone** (access ended). The three Fable-worthy cores were spent well: task 10 (scoring review), 18 (skill-layer design), 28 (multi-session design) — all delivered findings a merely-good answer would have missed.

**Opus 5 inherits the "subtly-and-expensively-wrong" slot** — but spend it as narrowly as Fable was. Sorted this session (full reasoning is in-chat; capture it in a brief if you act on it):
- **Strong yes:** task 19's **outcome-attribution / confidence channel** (learns the wrong lessons invisibly if wrong; no test fails loudly) — the single clearest case left; and task 20's **negative-control / eval methodology** (a broken-but-passing eval poisons every downstream "it works").
- **Worth it:** task 17's **regression-protection + rollback** interaction.
- **No meaningful benefit (4.8 or below):** 14, 15, 22, 24-screens (Sonnet), 32, 35, 8. Task 24's *architecture* is fine on 4.8; its *screens* are Sonnet.
- **Task 31 — moved OUT of that tier, 2026-08-07 (a deliberate reversal).** It was sorted as "no meaningful benefit" when it meant "write more fixtures." It now means "build the measuring instrument that decides whether todoAI changes its model," and the part that decides whether the measurement *works* — the held-out split design, the stratification, and the resolution arithmetic — is precisely the case §8 already recognised for task 20: **a broken-but-passing eval poisons every downstream "it works."** A corpus can look excellent, train cleanly, evaluate cleanly, and return a number that cannot separate the contenders; nothing fails loudly. **Recommended split: Opus 5 for the split design + first ~15 items and again for the findings report; Sonnet for the bulk transcription.** Full reasoning and both prompts in `docs/briefs/task_31_session_init_prompt.md`. *(If the Opus-5 budget is better spent elsewhere, ordinary Opus for phase 1 is a reasonable second choice. Sonnet for phase 1 is not — that's the version that produces a beautiful corpus with a useless split.)*
- **Not a model question:** 21 (human), 29/30 (Jason).

The whole personal-ship path was bounded engineering + UI — **nothing on it needed Opus 5**, and it's shipped. The Opus-5 work all sits in Phase-2 learning (17/19/20). **The model-migration chain (38/40) is Jason-run device/training work; Opus authors the pipeline and reads the results but the compute and the call are Jason's.**

**Model facts, corrected 2026-08-03 (were wrong in earlier records):** the on-device model is **Bonsai-4B TQ1_0** (`qwen3`, dense) — **1.02 GiB, ~6.5–7.5 tok/s steady** on the S23 FE (earlier "~1.7 GB / ~5.2 tok/s" was wrong). Bonsai is *not* the same architecture as Qwen3.5 (`qwen35`, hybrid SSM+attention) — the "quantized-Qwen same-ladder" idea was a coordinator error the device disproved. Heat, not RAM, is the binding constraint; the thermal envelope doesn't discriminate between candidate models (all hit ≥SEVERE by 20 min). The migration question (Gemma 4 E2B vs Bonsai-8B vs Bonsai-4B) is live and gated on the bake-off — see §3.

---

*It has been a genuinely good project to coordinate. Personal ship is met and holds. This session integrated four divergent branches into one `main`, found three things that were in no document (a file git had never shown a readable diff of, an unnamed branch carrying a real fix, and an app deliberately destroying the data its own roadmap depends on), and commissioned tasks 41–45 around them. The frontier is two threads: the **model-migration decision** (`41 → 31 → 38 → 40`, and 41 is the link that can move today) and **beta hardening** (14/15/17/21/32/42).*

*Three habits carried the weight, and they are all the same habit: **read the source, not the summary of it.** A findings report over a status line. A brief over a code comment that cites one — a comment claiming "per the task brief" for something the brief never mentions is how a UI change reached production unasked, and it fooled a coordinator who quoted it as evidence. And the tree over the record: for four days every document said tasks 35 and 36 were done while their work sat on an unmerged branch, and the fix they carried was for a live scoring bug.*

*~~You can run the tests now. That is the single biggest thing that changed.~~* ⚠ **Superseded 2026-08-19 — the coordinator does NOT run the tests; a subagent does (see the execution-boundary ruling in §1).** *Start by bringing Jason the tradeoff with a recommendation, surface every deviation from what he decided, and check for a newer report before acting on any finding — and delegate every code change, test run, build, and device action to a subagent, then review the report.*
