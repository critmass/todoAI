# Task 21 — Crisis detector review + referral localization

**Owner:** **Human (Jason).** This is not a code task — it is two human judgments about safety. A model can *draft*, but the calls here are Jason's to make and own.
🔴 **HARD BETA GATE.** The moment a non-Jason user can install the app, "the developer knows the limits" stops protecting anyone. Nothing ships to a stranger until this is resolved.

**Read first:**
1. `docs/eval/task7_phaseB_findings_report.md` §9 and `docs/eval/task12_phaseB_findings_report.md` §9 — where the crisis findings live.
2. The committed `DRAFT_CRISIS_DETECTOR` and `CRISIS_REFERRAL_TEXT` in the code (coaching path).
3. `docs/briefs/orientation_for_opus.md` §1 — **the load-bearing fact: the 4B cannot detect distress** (it answered suicidal ideation with a productivity tip). This is *why* detection is deterministic, app-side, and gate-first, and why it must never be handed to the model.

---

## 1. Why this exists

The app talks to people about why they're stuck. Sometimes "I can't make myself do anything" is executive dysfunction; sometimes it's despair. Getting that distinction wrong in the despair direction — handing a person in crisis a productivity tip — is the worst thing this app could do. The 4B provably makes exactly that error, so the safety net is a **deterministic, app-side, gate-first** check that runs before any coaching resolution and short-circuits to referral content on a match. It is committed and active (so even personal use runs protected), but it is a **draft** and it is deliberately over-triggering: a false positive shows care; a false negative is the failure that matters.

## 2. The two judgments (both Jason's)

**(a) Coverage.** The draft is phrase-matching. Phrase-matching catches direct statements and misses the indirect, coded, and euphemistic expressions that are the *common* form of how distress actually surfaces. The judgment: **is phrase-matching sufficient for beta, or does it need a richer approach?** Options to weigh —
- Keep phrase-matching, broaden the phrase set (fast, still brittle on indirect language).
- Add a small dedicated classifier that is *not* the 4B (the 4B is disqualified — it can't do this).
- Accept phrase-matching for a *small, known* beta group with an explicit in-app disclaimer about limits, and revisit before wider release.
There is no clean answer; this is a risk-tolerance call about who the beta users are and what they're told.

**(b) `CRISIS_REFERRAL_TEXT`.** It currently names **no specific hotline, by design** — fabricating or hard-coding an emergency number is itself harmful (numbers vary by country, change, and a wrong one is worse than none). The judgments: what does the referral actually say; is it localized for the beta audience's region(s); does it point at a real, current, appropriate resource (or at the user's own local emergency services generically) rather than a guessed number. **Use up-to-date, verified resources** — do not let a model invent a hotline.

## 3. What a model MAY do here (bounded)

A model can *assist*, but does not decide:
- Draft candidate phrase-set expansions for Jason to review (never auto-merge).
- Draft candidate referral copy for Jason to verify against real resources.
- Summarize how comparable local-first / offline apps handle the same gate.

A model must **not**: mark this task done, weaken the gate-first ordering, hand any part of detection to the 4B, or fabricate a hotline number or claim a resource is current without verification.

## 4. Definition of done (Jason signs off)

- A ruling on (a) recorded: the coverage approach for beta, and its accepted limits, written down.
- `CRISIS_REFERRAL_TEXT` finalized and, if the beta audience warrants, localized — pointing at verified, current resources.
- The gate confirmed still **gate-first and deterministic** (no regression that routes distress through the model), ideally re-checked on-device against a distress transcript (task 24 confirmed zero model calls on such a transcript — keep that true).
- A short note at `docs/eval/task21_review.md`: the coverage decision and its rationale, the referral content and its sources, and the residual risk Jason is accepting for beta.

*This task does not "complete" in the way a code task does — it resolves into a documented, owned decision. Its value is that the decision was made deliberately by a person, not defaulted by an algorithm.*
