# Task 42 — Crisis-stream teardown + consent and controls for the surviving capture

**Owner:** **Opus** implements; **Jason** ruled the scope (§0).
**Status:** ⬜ open. 🔴 **HARD CLOSED-BETA GATE.** *(Open-beta and GA pruning is task 43.)*
**Depends on:** 41 (there must be something to govern), 21 (crisis review — they now share an evidence base as well as a gate).

---

## 0. The rulings this task executes

**Ruled 2026-08-07 (Jason), across two passes — the second correcting an over-extension in the first:**

1. **Log everything in alpha.** *"In alpha I'm basically hiding my actions from myself if I don't log them — something that is not true once we are in beta."*
2. **All logging software is written with an eye to potentially being removed.** This is a **general architectural principle**, not a scoped instruction — it now lives as a settled decision in orientation §5 and applies to every capture stream 41 builds.
3. **Only the crisis-gate stream is deleted before beta.** The rest of the capture facility **ships into beta and records beta testers** — so it needs real consent and controls, not removal.
4. **Everything Jason personally generated is kept**, for testing and training. Including his own alpha crisis-gate log.

**So this task is two jobs, not one:**

| | Job | Applies to |
|---|---|---|
| **A** | **Teardown.** Remove the crisis-gate capture stream; verify it records nothing in a beta build. | crisis-gate stream only |
| **B** | **Governance.** Consent, controls, retention, export/delete for the streams that ship. | everything else |

*(An earlier revision of this brief scoped Job A to the entire capture facility. That was wrong — it read "the log is deleted before beta" as covering all of capture when it covered the crisis stream. Recorded here because the earlier framing is in the git history and a future session shouldn't have to re-derive which one is current.)*

---

## 1. Job A — the crisis-gate stream

**Why this stream and not the others.** For a beta tester, a crisis-gate log is a record of their worst moments sitting in a file on their phone. There is no consent flow that makes that a good idea for a small test group, and the value it would return is not worth the exposure.

**What "deleted" means here, precisely:**

- The crisis capture stream's **code is removed**, not flagged off. 41 builds each stream to be independently removable (§2 below) exactly so this is a deletion rather than an excavation.
- **No beta build ever records a crisis-gate firing.** Verified, per §3.
- **Jason's own alpha crisis-gate log is retained** — moved out of the app to the private archive (§4), not purged. It is task 21's only real evidence and deleting it would be throwing away the one thing that gate has ever had.

⚠ **This changes task 21.** Task 21 was briefed to review the detector's coverage on judgment alone, because there was no real data. There will now be an alpha corpus of actual firings and near-misses. **21 should be re-briefed to review against that evidence** rather than cold. It's a soft dependency, not a hard one — 21 can still proceed without it — but doing 21 before the alpha log accumulates wastes the best input it will ever get.

---

## 2. Job B — governance for the streams that ship

Because capture now records people who are not Jason, the material cut from the earlier revision comes back:

**a. Consent.** A first-run screen, built in task 23's design language. It must say plainly: what is recorded, that it **never leaves the device** (a real selling point, not a disclaimer), how to turn it off, and how to delete it.

**b. Controls.** A default plus an "advanced" disclosure beats a wall of per-category toggles. But the categories must exist underneath — conversations, model I/O, performance — because "off" meaning different things to different testers is how you get a useless dataset and an angry one.

**c. Retention.** ⚠ **Migration 001 created `data_retention (table_name, retention_policy, last_cleanup_at, records_cleaned)` with policies `detailed_30_days` / `summary_90_days` / `permanent`, and nothing has ever written to it or acted on it.** It has been implying a guarantee the app doesn't make since day one. This task implements it and extends it to cover 41's out-of-band logs, or retires it in a migration. It does not stay as-is.

**d. Export and delete.** A delete path that doesn't reach the capture logs is worse than no delete path. Both stores, provably (§3).

**e. Defaults.** What a tester gets if they accept everything without reading. That default is the real policy; the toggles are decoration. Recommend: performance and model I/O on, raw conversation transcripts **off** unless explicitly enabled, crisis stream nonexistent.

---

## 3. What must be verified, not believed

On a beta-candidate build:

1. **Grep the bundle for crisis-capture symbols.** Zero hits.
2. Run a **full session end to end**, including a deliberate crisis-gate trigger. Confirm the gate still *fires* and still shows the referral — **the detector is untouched; only its logging is gone** — and that nothing was written anywhere.
3. Toggle each capture control off, run a full session, **pull storage and confirm the corresponding streams are empty.** Every switch verified to actually stop the thing it names.
4. Run export, then delete. Confirm both reach the product DB **and** the capture logs.
5. Confirm retention actually prunes on schedule, or that `data_retention` was retired.

A findings report asserting any of these without evidence does not close this task.

---

## 4. The private archive (spans both jobs)

Jason's retained data — alpha capture logs, the alpha crisis-gate log, and task 31's corpus item text — needs somewhere to live that **is not the git repository.**

The reason is narrow and worth stating: the repo travels. A beta tester with source access, a contractor, a future open-sourcing, any cloned laptop. Retained-forever plus committed-to-git means a verbatim record of Jason's life, and his worst moments, ships with the source.

**Recommended split:**

- **In the repo:** the corpus *schema*, split assignment, stratum labels, item IDs, counts, and the capture format contract. Everything needed to reproduce and audit an evaluation.
- **Outside the repo (gitignored path or separate private store):** the item text, the raw logs, the crisis log.

Cost: a fresh clone can't re-run the bake-off without the data file. That is the normal situation for any project with a private dataset, and it is worth it.

---

## 4b. Egress and anonymization — the pipeline this task builds

**Ruled 2026-08-07: nothing leaves a tester's device un-anonymized.** Anonymization runs **at the source, before egress** — not after collection on Jason's laptop. So the export path is a **distinct pipeline from the capture path**, consuming 41's redaction seams (41 §2g).

**Closed beta is the last rung at which free-text egress is defensible, and only because the volume permits review.** Recommendation, Jason's to rule: free-text egress permitted but **per-item reviewed before it leaves**, not bulk-scrubbed and shipped. Structured streams (performance, timings, outcomes, model-I/O metadata, thermal) anonymize essentially completely and can be pulled freely.

**Three things this task must write into the record, so nobody later over-trusts the word:**

1. **Anonymizing free-text is best-effort and cannot be fully solved.** Names, employers, places, health and relationship details are embedded in prose. **"Anonymized" must never be read as "safe to publish."**
2. **Re-identification by combination is the real risk, not proper nouns.** A person's task list is close to a fingerprint — what they avoid, when, how often — even fully scrubbed. This is why task 43 drops free-text *structurally* at open beta instead of relying on better scrubbing.
3. **The structured/free-text asymmetry is what makes the whole ladder principled** rather than an arbitrary line drawn at a convenient scale.

## 5. Record corrections this task owes

- **`interactions.conversation_summary`'s schema comment** reads `-- AI-generated, grammar-constrained; raw transcript never stored`. Task 41 makes that false. Correct it to describe what actually happens, and fix the spec text that repeats it. *(Note this is now a permanent correction, not a temporary one — transcripts are captured in beta too, under consent.)*
- **Constraint #7 needs one clause.** "Local-only — no cloud training, no telemetry" remains true throughout, and 41 never violated it, because **the distinction is *transmission*, not recording** — nothing leaves the device. State it explicitly so a future reader who finds a verbose transcript log doesn't conclude the constraint was broken.
- **`data_retention`** — see §2c.

---

## 6. Deliverables

1. Job A executed and verified.
2. Job B built: consent surface, controls, retention, export/delete.
3. The private archive established, with the repo/non-repo split of §4 applied.
4. `docs/eval/task42_findings_report.md` carrying §3 step by step, with evidence.
5. The §5 corrections landed.
6. A note in orientation §5 recording what shipped, what was removed, and where the retained data went.

---

## 7. Done means

- No crisis-capture code or data exists in a beta build or on any device running one — **verified, not asserted.**
- A person who is not Jason can install the app, understand what it records, and change it, **before** it records anything.
- Every control verified to stop what it names; export and delete verified to reach both stores.
- No schema comment, spec line, or constraint text asserts a privacy property the code doesn't have.
- Jason's retained data is intact, out of the repo, and usable by tasks 21, 31, 38 and 40.
- Reviewed in the same pass as task 21.
