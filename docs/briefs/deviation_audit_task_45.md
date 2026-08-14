# Task 45 — Deviation audit: what changed a human decision without sign-off

**Owner:** **Opus** produces the list; **Jason** rules each item.
**Status:** ⬜ open. Gates nothing directly, but **everything downstream reads orientation §5 as settled** — and some of it isn't.
**Headless.** No device work.

---

## 0. Why this exists

Task 24's execution screen shipped a linear progress bar where task 23's approved design had a dial. Jason was never asked. The failure had three parts, and the third is the one worth fixing:

1. **The code comment cited an authorization that doesn't exist.** `WorkScreen.tsx` says the bar is *"explicitly acceptable — preferable, even — per the task brief."* Task 24's brief never mentions it. A builder's judgment got written into the source as though a brief had sanctioned it.
2. **The report filed it as a deferral, not a decision.** Findings report §6 is titled *"Deferred to the beta (designed) pass — deliberately, not forgotten"* — which reads as scheduling. It was a change to something a human approved.
3. **Nobody surfaced it in coordination review.** This is the real failure. The information existed; the process never put it in front of the person whose decision it overrode.

**Jason's ruling, 2026-08-07:** *"Any deviation from human-made decisions should at least be flagged in a report AND explicitly surfaced during coordination review."* The standing rule now lives in the coordinator handoff §4. **This task cleans up the backlog that accumulated before it existed.**

---

## 1. The specific risk being audited

Two section titles have been quietly absorbing overrides:

- **"Decisions this task had to make"** — reads as necessity. Task 24's report has **eight**.
- **"Deferred to the beta pass — deliberately, not forgotten"** — reads as scheduling. Task 24's report has **six**, including the dial.

Neither is named in a way that would make Jason look, and **some of these have already been folded into orientation §5 and §3 as settled decisions** — where they are now indistinguishable from things Jason actually ruled. That is the specific harm: *a builder's call becomes canon, and the canon can't tell you which is which.*

---

## 2. Scope

Audit the findings reports of every task that made product-visible choices, against (a) Jason's recorded rulings, (b) the spec at the version current when the task ran, and (c) task 23's approved design where applicable.

**Start here — task 24's report §4 and §6.** Three §4 items are known to change a human decision and are the seed of the list:

- **§4.1 — "Ending a block EARLY offers three options, not five."** The five-option end-of-block prompt was a ruling. The three-option variant may well be right at a non-boundary exit, but it is a change to a ruled behaviour.
- **§4.2 — "Tools are optimistic at planning time, confirmed per task."** The report itself notes this reorders spec §6.2.
- **§4.6 — "The startup guard runs on first model use, not at process launch."** Constraint #3's literal text says "at startup, before any user session." The argument for the change is good — a timer-only session never loads the 4B — and **it is already folded into orientation §3 as though settled.** That is exactly the pattern; a defensible decision is still a decision.

Then the same pass over: **13** (timer/lifecycle), **11** (planning), **33** (multi-session), **36** (recurrence), **12** (coaching), **7** (prompts).

---

## 3. Deliverable

`docs/eval/task45_deviation_audit.md` — one table, ordered by how load-bearing the deviation is:

| Column | Contents |
|---|---|
| What changed | The behaviour as built |
| What it deviates from | The ruling, spec section, or design element, quoted |
| Where it was recorded | Report section — or "nowhere" |
| Whether it entered the canon | Is it in orientation §3/§4/§5 as settled? |
| Argument for it | The builder's reasoning, fairly stated |
| Recommendation | Ratify / revert / revisit |

**Fairness matters here.** Most of these are probably good calls made by someone with more context on the code than the brief had. The task is not to relitigate them — it is to make sure Jason *chose* them. Present the argument for each as strongly as its author would.

**Then Jason rules each.** Ratified items are relabelled in orientation §5 as ruled-by-Jason-on-date. Reverted items become work. Anything left unruled stays explicitly marked provisional.

---

## 4. Done means

- Every product-visible deviation in the audited reports is listed, with its record location or "nowhere."
- Each has a recommendation and Jason's ruling beside it.
- **Orientation §5 distinguishes what Jason ruled from what a builder decided.** Right now it cannot, and that is the defect this task exists to close.
- Any deviation Jason reverts is filed as a numbered task.

---

## 5. Note on scope discipline

This is an audit, not a rewrite. It produces a list and a set of rulings. It does not change behaviour — reverts become their own tasks, so the audit stays cheap and readable and doesn't turn into an open-ended refactor.
