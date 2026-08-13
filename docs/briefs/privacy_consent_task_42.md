# Task 42 — Privacy reconsideration, consent, and capture controls

**Owner:** **Jason** rules the product intent; **Opus** proposes and implements.
**Status:** ⬜ open. 🔴 **HARD BETA GATE.**
**Depends on:** 41 (there must be something to govern), 21 (crisis review — they overlap on the most sensitive data).

---

## 0. Why this is a gate and not a nice-to-have

Task 41 makes the app record everything, deliberately, because in alpha the only person the data could be hidden from is Jason. **That reasoning expires the instant a second person installs it**, and it expires silently — nothing breaks, no test fails, the app just quietly becomes a device that transcribes a stranger's private thoughts about the things they're avoiding.

This is the same structure as the crisis-review deferral (task 21): safe for personal *only* because the sole user is the developer, and dangerous the moment that stops being true. Both are pinned to beta for the same reason, and they should be reviewed together — the crisis-gate log is the single most sensitive artifact the app produces.

---

## 1. What has to be decided

**a. What does the app store at all, by default, for someone who isn't Jason?** Task 41's answer is "everything." Beta's answer probably isn't. The likely shape: product data always, diagnostic capture opt-in, raw conversation transcripts off unless explicitly enabled. But that's a proposal, not a ruling.

**b. What does consent look like?** A first-run screen, or a settings default, or both. What it must say plainly: what's recorded, where it lives (on the device, never transmitted — that's a genuine selling point, not a disclaimer), how to turn it off, and how to delete it.

**c. Granularity of the controls.** One master switch is honest but blunt; per-category switches (conversations / model I/O / performance / crisis) are more useful and more confusing. Recommend a default plus an "advanced" disclosure rather than a wall of toggles.

**d. Retention and purge.** ⚠ **The schema already has an unused mechanism for this.** Migration 001 created `data_retention (table_name, retention_policy, last_cleanup_at, records_cleaned)` with policies `detailed_30_days` / `summary_90_days` / `permanent`. **Nothing has ever written to it or acted on it.** This task either implements it, extends it to cover task 41's out-of-band logs, or retires it — but it must stop being a designed-and-abandoned table that implies a guarantee the app doesn't make.

**e. Export and delete-my-data.** Orientation §8 already lists "full data-lifecycle hardening (export / deletion / corruption recovery)" as a *general*-ship gate. Decide how much of it moves forward to beta. A delete button that doesn't reach the capture logs is worse than no button.

**f. The crisis log specifically.** Task 41 §1.8 captures crisis-gate firings and near-misses, because task 21 is a hard beta gate with no real data behind it. For a beta tester that is a record of their worst moments sitting in a file. This needs its own answer, and it is the one item here where "just make it opt-in" may not be sufficient.

---

## 2. Corrections this task must make regardless of the rulings

- **`interactions.conversation_summary`'s schema comment is now false.** It reads `-- AI-generated, grammar-constrained; raw transcript never stored`. After task 41 that is no longer true, and a stale comment asserting a privacy property the code doesn't have is worse than no comment. Fix it in the migration that implements this task's decisions, and correct the spec text that repeats it.
- **Constraint #7 needs one clause.** "Local-only — no cloud training, no telemetry" is still true and task 41 doesn't violate it (nothing leaves the device). But a reader who finds a verbose transcript log will reasonably wonder. State explicitly that local capture is not telemetry, and that the distinction is *transmission*, not *recording*.
- **Task 41's redaction seams get switched on**, or removed if the rulings make them unnecessary.

---

## 3. Deliverables

1. The rulings from §1, written down where they bind — spec section, not just chat.
2. Consent surface (first-run and/or settings), built against task 23's design language.
3. Capture controls wired to task 41's module through its existing seams.
4. Retention: `data_retention` implemented, extended, or retired — with the choice recorded.
5. Export + delete paths that provably reach **both** the product DB and the capture logs.
6. `docs/eval/task42_findings_report.md`, including a verification that turning capture off actually stops every writer — tested by running a full session with it off and confirming the logs are empty.

---

## 4. Done means

- A person who is not Jason can install the app, understand what it records, and change it, before it records anything.
- Every switch has been verified to actually stop the thing it names.
- No schema comment, spec line, or constraint text asserts a privacy property the code doesn't have.
- Reviewed alongside task 21, since they govern the same worst-case data.

---

## 5. What this task is not

It is not a general-ship privacy programme. Encryption at rest, threat modelling, and regulatory posture are beyond beta. This task exists to make sure the alpha ruling — "record everything, privacy is not a concern" — cannot leak into a build that reaches a stranger.
