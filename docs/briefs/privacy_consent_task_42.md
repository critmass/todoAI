# Task 42 — Capture teardown and privacy reconciliation before beta

**Owner:** **Opus** implements; **Jason** rules the one open question in §1.
**Status:** ⬜ open. 🔴 **HARD BETA GATE.**
**Depends on:** 41 (there must be something to tear down), 21 (crisis review — same worst-case data, review together).

---

## 0. The ruling this task exists to execute

**Ruled 2026-08-07 (Jason):**

> Log everything for now. That log will be **completely turned off and deleted** before beta. In alpha I'm basically hiding my actions from myself if I don't log them — something that is not true once we are in beta.

This is a cleaner ruling than the consent-and-toggles design this brief originally proposed, and it should be respected as such. **Capture is an alpha-only facility. It is removed, not governed.** No consent screen, no per-category switches, no retention policy for capture data — because none of it survives to beta.

Two consequences worth stating up front:

- **Task 41's out-of-band design pays off here.** Because capture writes append-only JSONL to its own directory and never touches the product database, the teardown is a directory delete plus a code removal. No migration, no risk to product data, nothing to disentangle. The design decision and the ruling reinforce each other — keep them that way; if 41 ever starts writing capture data into the product DB, this task gets much harder and much less certain.
- **"Deleted" has to be *verified*, not intended.** A teardown that everyone believes happened is exactly the class of thing this project has already been burned by twice this month. §3 makes it an acceptance test.

---

## 1. The one open question — Jason rules before this task starts

🔴 **Does the ruling reach task 31's corpus?**

The corpus (`docs/eval/corpus_extraction_v1.jsonl` and siblings) is *derived from* the capture logs. Deleting the logs does not delete the corpus, and the corpus contains **Jason's real task text, verbatim, committed to the repository.** It also has to survive indefinitely — task 38 trains on it, task 40 evaluates on it, task 20 uses it as fixtures, and a bake-off you can't re-run is a bake-off you can't defend.

So there are two readings and they diverge sharply:

| Reading | What it means | Cost |
|---|---|---|
| **(a) Delete the raw logs; the corpus survives** *(assumed default)* | Capture teardown is scoped to the log files and the capture code. The corpus persists as a normal project artifact. | Jason's real, unedited task text lives permanently in git, and goes wherever the repo goes — a beta tester with source access, a future open-sourcing, a contractor, a laptop. |
| **(b) Delete everything derived from the private data** | The corpus goes too. | 38, 40 and 20 lose their basis; the model decision becomes unreproducible and unre-runnable. Effectively fatal to the chain. |

**Recommendation: (a), with the corpus kept out of the repository.** Commit the *schema*, the split assignment, the stratum labels, the per-item IDs and the counts — everything needed to reproduce and audit the evaluation — and keep the item text itself in a gitignored local path or a separate private store. The eval stays reproducible for anyone with the data; the repo stops carrying a verbatim record of Jason's life. Cost is that a fresh clone can't re-run the bake-off without the data file, which is the normal situation for any project with a private dataset and is worth the trade.

**If (a)-without-that-precaution is the ruling, that's legitimate — but it should be a decision, not a default.** The failure mode is quiet and late: nobody notices until the repo is somewhere it wasn't meant to be.

---

## 2. Scope of the teardown

**a. The capture data.** Every JSONL log on the device and every copy pulled to the laptop. Enumerate the locations — this is why task 41 must document its on-disk layout.

**b. The capture code.** Remove it, rather than leaving it dead behind a disabled flag. "Completely turned off" is the ruling, and a dormant capture module is a thing a future change can re-enable by accident.

⚠ **One tradeoff to rule on while doing this:** removing capture entirely means that when a beta tester hits a bug, there is *no* diagnostic capability at all — no crash log, no error trace, nothing but their description. That may be the right call for a small trusted group. If it isn't, the answer is **not** to keep task 41's capture; it's a separate, minimal, consented error/crash log designed for beta from scratch, which would be its own task. Don't let 41's facility survive by being retitled.

**c. Anything capture leaked into the product DB.** Should be nothing, by 41's design. **Verify rather than assume** — that's the point.

---

## 3. What must be verified, not believed

The acceptance test, run on a beta-candidate build:

1. Build the beta artifact. **Grep the bundle for capture symbols** — the module, the event-type names, the log path. Zero hits.
2. Run a **full session end to end** on the device: chat capture → session → timer → all five outcomes → coaching → summary.
3. Pull the device's app-private storage. **Confirm no capture files exist and none were created.**
4. Pull and inspect the product DB. Confirm no capture-shaped rows.
5. Confirm the prior log directory is gone, on device and on every machine a copy was pulled to.

A findings report that says "removed" without steps 1–5 having been run does not close this task.

---

## 4. Record corrections this task owes regardless

These are stale-or-soon-to-be-stale claims in the permanent record. They are listed here because they must be true again by beta, and because a future session reading them in the interim should know they are known.

- **`interactions.conversation_summary`'s schema comment.** It reads `-- AI-generated, grammar-constrained; raw transcript never stored`. Task 41 makes that false; this task makes it true again. Confirm the comment matches reality at beta and correct the spec text that repeats it.
- **Constraint #7 needs one clause.** "Local-only — no cloud training, no telemetry" is still true throughout, and task 41 never violated it, because **the distinction is *transmission*, not recording** — nothing ever left the device. State that explicitly so a future reader who finds a verbose transcript log doesn't conclude the constraint was broken.
- ⚠ **`data_retention` is a designed-and-abandoned table.** Migration 001 created `data_retention (table_name, retention_policy, last_cleanup_at, records_cleaned)` with policies `detailed_30_days` / `summary_90_days` / `permanent`. **Nothing has ever written to it or acted on it.** It implies a retention guarantee the app does not make. This task implements it, or retires it in a migration — but it stops being a table that lies. *(Note this is about the product database, not capture; it survives the teardown and needs an answer on its own terms.)*

---

## 5. Deliverables

1. Teardown executed per §2, with the §1 ruling applied to the corpus.
2. `docs/eval/task42_findings_report.md` carrying the §3 verification, step by step, with evidence.
3. The §4 record corrections landed.
4. A one-line note in orientation §5 recording that capture was an alpha-only facility, when it was removed, and what became of the corpus — so the history is legible to whoever picks this up later.

---

## 6. Done means

- No capture code and no capture data exist in a beta build or on any device running one, **verified by §3, not asserted.**
- The corpus disposition matches Jason's §1 ruling.
- No schema comment, spec line, or constraint text asserts a privacy property the code doesn't have.
- Reviewed in the same pass as task 21.

---

## 7. What this task is not

Not a general-ship privacy programme — encryption at rest, threat modelling, and regulatory posture are beyond beta. Not a consent-and-toggles design, which the 2026-08-07 ruling replaced with removal. Its entire job is to make sure the alpha ruling — *record everything, privacy isn't a concern because I'm only hiding data from myself* — **cannot survive contact with a user who isn't Jason.**
