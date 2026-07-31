# Task 32 — Device verification sweep

**Owner:** **You (Jason) + Opus.** **Entirely `P`** — this task *is* device work; the model's job is to prepare the exact steps and read the pulled-DB results, Jason's is to run them on the S23 FE.
**Not on the personal-ship path** (personal ship is met), but it's the **natural first beta sweep** — it clears the standing verification residue that's been carried as a footnote across sessions, batched into one device session so setup cost is paid once.

**Read first:**
1. `docs/eval/task12_phaseB_findings_report.md` §4 — the `add_dependency`/`add_missing_task` dispatch residue.
2. `docs/eval/task24_findings_report.md` §9.13, §10, §8 — task 24 **wired** D1's recap→constrain flow and confirmed the *path* on device; what remains is **measuring extraction quality**, and §10 lists the device edges task 24 didn't cover.
3. `docs/eval/task7_phaseB_findings_report.md` §7 — why the recap→constrain flow may close the last extraction gap (the `quota`-drops-days case the recap understood but the constrained pass re-derived wrong).
4. `docs/briefs/structured_output_strategy_task_4.md` §6 — the eval methodology, if measuring extraction quality formally (this overlaps task 20).

**Method discipline (non-negotiable, and it's why this task exists):** every claim is checked by **pulling `databases/todoai.db` off the device and querying it**, not by reading the screen. Tasks 13 and 24 both did this and both caught silent bugs the UI hid. Same rule here.

---

## 1. The residue to clear (one batched device session)

**a. `add_missing_task` dispatch (raised in priority by R7).** When a breakdown-confirmation coaching resolves to "no, it's not actually done," the resolution is `add_missing_task`. Its dispatch has **never been exercised on-device**. Confirm: the coaching resolution union emits it, the app dispatches it to a real repository write, and the new task lands with correct fields. This was on the personal-ship path per R7; it's the first thing to verify.

**b. `add_dependency` dispatch.** Same class — a coaching resolution that adds a dependency edge, unexercised on-device. Confirm the edge is written and the dependency-blocked pre-filter (U1) then respects it.

**c. D1 recap→constrain — MEASURE it (task 24 already wired it).** Task 24 confirmed the *flow* runs in the product (the prose turn runs the recap/clarify instruction; the constrained extraction runs over the whole conversation including that turn). What's unmeasured is **how often the fields come back right** — task 24's one live capture got duration and recurrence right but the **title** (whole sentence, not "Call the dentist") and **`next_due_at`** (null despite "tomorrow") wrong. Run the extraction-quality fixtures through the real device path and quantify. This is where the last extraction gap either closes or gets characterized. *(If done formally, this is shared scope with task 20's harness — coordinate so it's measured once.)*

**d. Task 19's two new grammars** (`skill_distill.v1`, `skill_refine.v1`) **when they land** — the on-device grammar pass for the skill layer. Only if task 19 has shipped by the time this sweep runs; otherwise defer this item to a later sweep.

## 2. Device edges task 24 explicitly left (report §10) — fold in if cheap

These are task-24 residue that a device session is the only way to close; batch them here rather than paying setup again:
- **`resume_block` recovery on hardware** — force-kill *before* the block end, relaunch, resume the *same* block. Tested in unit, not device-run.
- **Overnight doze on battery** with a session left open (also task 13's one open `P` item) — the real version of the forced-deep-idle proxy.
- **The locked-screen full-screen intent as a watched behavior** — the alarm fires with the screen off (confirmed), but nobody has *watched* the device light up and present the app from a locked screen.
- **Four of six recurrence kinds** tapped through the editor on device (one-time + the switch were exercised).
- **Deep-idle alarm delivery** — measured at 11–30 ms for states short of sustained deep idle; the deep-idle run was stopped at 5:45am before the fuse blew. One clean deep-idle delivery would convert the last inference into a measurement.

## 3. How to run it (Opus prepares, Jason executes)

Opus's job before the session: produce the **exact adb/sqlite command sequence** for each item — how to seed the precondition, what to do in the app, which table/columns to pull and query afterward, and what the correct row looks like. Jason's job: run it on the S23 FE and paste back the query output. Then Opus reads the output against the expected rows and writes the report.

**Leave the device clean** (task 24's discipline): runtime tables 0/0/0, no pending `com.todoai` alarm, no posted notification, forced doze/battery state reverted (`deviceidle unforce`, `battery reset`, `stayon false`). Note which test rows remain.

## 4. Definition of done

- Items (a), (b), (c) confirmed on the S23 FE, each checked against the pulled DB; (d) if 19 has landed.
- The §2 device edges cleared as far as one session allows; anything not reached stated plainly (don't silently drop it).
- Device left clean, with residual test rows noted.
- Findings report at `docs/eval/task32_findings_report.md`: per-item pulled-DB evidence, the recap→constrain extraction-quality numbers (and whether the last gap closed or is now characterized), and anything still open.
