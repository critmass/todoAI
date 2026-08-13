# Task 43 — Capture ladder: pruning from closed beta to open beta to general release

**Owner:** **Opus** implements; **Jason** rules each rung.
**Status:** ⬜ open. 🔴 **Gates OPEN BETA, and again GENERAL RELEASE.** Not a closed-beta gate — task 42 owns that rung.
**Depends on:** 42 (which establishes the closed-beta baseline this prunes from).

---

## 0. The ruling

**Ruled 2026-08-07 (Jason):**

> Any data we decide to keep, if we pull it, every effort to anonymize will be made before that information leaves their device. The logging will be future pruned/dropped as we move from closed beta to open beta to general release.

Capture is therefore **not binary and not static.** It is a ladder that narrows at each stage, and each narrowing has a trigger. This task exists so those narrowings are pinned to their triggers instead of being remembered — the project's own standing habit is that dependencies which aren't tasks rot.

---

## 1. The mechanism, which is the whole reason the ladder exists

It is tempting to read "prune as we scale" as caution, or as tidiness. It isn't. There's a specific thing that breaks:

> **The safeguard at closed beta is human review of a small volume of data from a small number of known people. That safeguard does not scale, and it fails silently.**

At closed beta, Jason can look at what's being captured, review what's leaving a device, and notice when something is wrong. At open beta that is no longer physically possible — the volume is too large, the people are strangers, and nobody is reading any of it. **The stream must narrow at exactly the point the safeguard stops working**, because otherwise the safeguard is gone and the collection isn't.

So the pruning is not scheduled by scale. It is scheduled by **which protections remain real at each rung.**

---

## 2. The ladder (proposed — each rung is Jason's to rule)

| Stage | Audience | Captured | What protects it |
|---|---|---|---|
| **Alpha** | Jason only | **Everything, raw.** No exclusions, redaction or sampling. | The subject is the developer. Nothing to protect against. |
| **Closed beta** *(task 42)* | Small, known, consented | All streams **except crisis-gate**. Free-text conversations on, under explicit consent. | Consent + controls + **human review of every egress** + small known cohort. |
| **Open beta** *(this task)* | Strangers, at scale | **Free-text conversation capture dropped.** Structured streams retained: performance, timings, outcomes, model I/O *metadata* (not content), thermal, errors. | Structural — there is nothing sensitive left to review, which is the point. |
| **General release** *(this task)* | Public | **Minimal:** crash/error reporting and aggregate counters, if anything at all. | Structural, plus whatever the privacy model at that stage requires. |

**The load-bearing row is open beta.** Free-text is where the sensitive content lives, and it is the stream whose only real protection was review. Structured streams survive because they carry the signal tasks 17, 19 and 20 want (durations, skips, extensions, outcomes, latency) with almost none of the exposure.

**Recommended default at each rung: drop, don't disable.** Consistent with the settled decision that every stream is independently removable — a stream that ships dormant is a stream a later change re-enables.

---

## 3. ⚠ The consequence nobody has priced yet

**The window for collecting real free-text captures closes at open beta.**

Task 31's corpus, task 38's training data, and task 40's held-out eval all depend on real conversational input. After the open-beta rung, that supply stops permanently — the ladder drops the only stream that produces it.

**So the training corpus is built during alpha and closed beta, or it is largely not built at all.** Every later LoRA iteration, every re-run of the bake-off, every future model migration draws on a corpus whose collection window has already shut.

This is an argument for starting task 41 sooner rather than later, and for closed beta being generous rather than minimal about free-text capture while the consent and review protections are still real. It is not an argument for extending the window — the mechanism in §1 doesn't bend. It is an argument for using it.

---

## 4. Egress and anonymization

*(Task 42 builds this; this task inherits and tightens it at each rung.)*

**The rule: nothing leaves a tester's device un-anonymized.** Anonymization happens **at the source, before egress** — not after collection on Jason's laptop. Practically this means the export path is a distinct pipeline from the capture path, and 41's redaction seams are its consumer.

**Three things the record must say plainly, so a future session doesn't over-trust the word "anonymized":**

1. **Anonymizing free-text is best-effort and cannot be fully solved.** Names, employers, places, health details and relationships are embedded in prose. Named-entity scrubbing is mitigation, not a guarantee. "Every effort" is the right standard and the right phrasing; **"anonymized" must never be read as "safe to publish."**
2. **Re-identification through combination is the real risk, not names.** A person's task list is close to a fingerprint — the shape of what someone is avoiding, when, and how often, identifies them even with every proper noun stripped. This is why the open-beta rung drops free-text *structurally* instead of relying on better scrubbing.
3. **Structured streams anonymize essentially completely; free-text does not.** Durations, outcomes, latencies and thermal samples carry no identity. This asymmetry is what makes the ladder work — it isn't an arbitrary line.

**Recommendation for closed beta (Jason's call, recorded in 42):** free-text egress permitted but **per-item reviewed before it leaves**, not bulk-scrubbed and shipped. At the volumes closed beta implies, that's tractable. It is the last rung at which it is.

---

## 5. Deliverables

1. Each rung's ruling, recorded where it binds — orientation §5, not chat.
2. The open-beta pruning: streams dropped, code removed, verified per the §6 test.
3. The GA pruning, same.
4. Egress policy tightened at each rung, inheriting 42's pipeline.
5. `docs/eval/task43_findings_report.md` per rung, with the verification evidence.

---

## 6. Done means (per rung)

- The streams that should be gone are **gone from the build**, not disabled — grep the bundle, run a full session, pull storage, confirm empty.
- The streams that remain are the ones the ruling names, and no others.
- The egress path for that rung is built and verified, including that anonymization actually runs before anything leaves.
- The record states what was dropped, when, and why — so the ladder is legible rather than archaeological.

---

## 7. Open for Jason

- **Ruling per rung**, when each stage is actually approached rather than all now — but the *triggers* are pinned here so they can't be missed.
- **Whether GA keeps anything at all.** A zero-capture GA is defensible and simplest; it also means shipping blind. Worth deciding deliberately rather than by omission.
