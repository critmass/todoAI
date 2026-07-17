# Build Allocation — who builds what (updated for Spec v2.2, mid-build)

*Companion to `docs/briefs/orientation_for_opus.md`, which is the **canonical** source for live status, the task list, and the ship gates (its §2, §8, §9). This doc is the "who builds what and why" view — the model-allocation philosophy plus a status-grouped matrix. Read orientation first; where the two ever disagree, orientation wins.*

> **Numbering note (read this):** the `#` in the matrix below is a **build-order/dependency** index, *not* a task ID. The canonical task IDs live in orientation §2 (0–24). This doc cross-references them but doesn't renumber them. An earlier version of this matrix drifted into its own numbering — that's now reconciled to orientation's IDs.

---

## Part 0 — Prep: what it was, and where it stands now

The original prep list (ordered by leverage) has largely done its job. Status of each, because the *learnings* are what shaped the build:

1. **De-risk the core dependency** — ✅ **done** for the 4B. The spike loaded Ternary-Bonsai-4B and taught us the truths the rest rests on: the format is **TQ1_0** (mainline) / **Q2_0** (fork-only), *not* Q1_0; **CPU-only** on Android via stock `llama.rn`; the **chat-template `messages` API is mandatory**; models live in app-private storage. 8B/1.7B remain untested (no mainline quant). This was the single highest-value thing, and it paid off exactly as predicted.
2. **Define the device envelope** — ⬜ **still open**, now a **beta gate** (orientation §8). One device tested. Fine for personal; required before strangers.
3. **Provide realistic data** — 🟡 **partial**. 16 seed fixtures exist and drove task 7's tuning (10/16→15/16). The fuller 20–30 real-task set + coaching transcripts + friction episodes are still worth collecting — they're the input for task 18 (skill distillation) and task 20 (eval harness).
4. **Dev env + toolchain** — ✅ **done** (`README_build.md`).
5. **Reference material in project** — ✅ **done** (`docs/reference/`, `docs/briefs/`).
6. **Success criteria for the hard parts** — 🟡 **partial**. The structured-output bar is exercised (valid 4/4; critical-correct 15/16); the coaching bar is exercised; tiering thresholds are moot under 4B-only.
7. **Lock the soft decisions** — ✅ **done**: stock `llama.rn` + 4B, no cloud, Expo ruled out, build order set.
8. **Be the empirical feedback loop** — ✅ **ongoing, and decisive**. The entire Q1 arc and task 7's tuning were exactly this loop; it's what turned "believed" into "confirmed" repeatedly.

**Biggest lesson the prep didn't anticipate:** an entire de-risking arc (Q1 → Q1b → Q1c) was needed just to prove GBNF grammars work on this build — a native-parser quirk (no underscores in rule names) masqueraded as three separate "structural" bugs. Grammars are now GREEN at ~0% overhead. That arc wasn't a task in the original plan; it belongs in the record as the highest-leverage device work after the loading spike.

---

## How to read the split (unchanged, and it held true)

Opus is strong enough to build almost all of this. **Fable is reserved for the few places a merely-good answer could be subtly and expensively wrong** — novel work with no reference implementation, model-behavior reasoning, high-leverage decisions costly to unwind. The original estimate was ~85% Opus-and-Sonnet with a few Fable cores, and that's how it played out. Rule of thumb: clear pattern → **Sonnet**; serious engineering against a clear spec → **Opus**; subtle-and-expensively-wrong → **Fable**; needs the device or a human judgment → **You**.

---

## Fable — status of the reserved work

- **F2. Structured-output strategy + eval design (§3.3, task 4)** — ✅ **done**. Fable produced the strategy doc; Q1 then confirmed it on-device (valid output, ~0% overhead). The "does it work on-device" core — settled.
- **F3. Scoring composition review (§5.1–5.2, task 10)** — ⬜ **pending**. Task 9 is built; the Fable pass whose only job is "find inputs where uncapped-neglect × banding × derived-urgency × weights produces pathological orderings" has **not** been confirmed. Still worth it before session planning (11) and learning (17) build on the ranking.
- **F1. Skill-injection layer design + distillation (§5.5, task 18)** — ⬜ **upcoming**, and still the one genuinely novel core: skill representation, distillation prompts, and the confidence math (grows on corroboration, decays on contradiction, threshold so a two-bad-days skill can't harden into a rule). Wiring it in afterward (task 19) is Opus.

> **The safeguards note held.** Fable ships with conservative safeguards that route a fraction of sessions to Opus; the concern was that skill-layer work *looks* adjacent to LLM R&D. In practice nothing got routed and all Fable work ran clean. If a task 18 request ever does get redirected, that's the safeguard working and Opus is a fine fallback — don't read it as a problem.

---

## Opus — the bulk (most of it now done)

**Done and device-confirmed:** the provider + D10 ladder + startup guard (6), the task-input/coaching system prompts (7), coaching flows + resolution dispatch (12). **Built:** scoring (9). **Remaining Opus work:** session planning (11), the timer + crash recovery (13), data backup/restore + corruption recovery (14), edge cases / Safe Mode (15, → Sonnet for repetitive handlers), numeric learning loops (17), skill-layer integration (19), and the app architecture/state-management behind the new UI (24). The tiering ladder (8) is **deferred** — 4B-only means one rung; it's gated on the 8B/1.7B quants existing.

---

## The new tasks (21–24) and who builds them

- **21 — Crisis detector review + referral localization** → **Human.** Not a model task. Coverage judgment + referral-text localization; hard **beta gate** (orientation §9).
- **22 — `which:"next"` weekday semantics** → **Opus or Sonnet.** Small: a decision (define "next" as "the coming one," or teach the guides to prefer `which:"this"`) plus a small change in shared `resolveDue` + a fixture.
- **23 — UI/UX design (interaction + visual system)** → **Opus (with the frontend-design skill), or a human designer.** This is the design gap the plan never had — it assumed "screens *from a design*" with nothing producing the design. ADHD-specific design *thinking* is the high-value part, which is why it's Opus/human, not Sonnet, and not really Fable (it's taste and interaction judgment, not subtle-compounding-correctness). Can start early; cheap now, expensive to retrofit.
- **24 — Product UI implementation (real screens)** → **Sonnet** for the screens once the design/flow is settled, **Opus** for the architecture and state management. There is **no product UI yet** — only `src/dev/` harness screens — so a **minimal functional pass gates personal ship**; the designed pass (consuming 23) gates beta.

---

## Summary matrix (status-grouped)

Canonical task IDs from orientation §2. `Build with`: You / Fable / Opus / Sonnet / Human. **`Dep`** = the tasks a row is unblocked by (its prerequisites). *(Task 16 — the old "screens from a design" — was retired and split into 23 (design) + 24 (implementation), so there is no 16.)*

### ✅ Done
| Task | Component | Built with | Dep | Note |
|---|---|---|---|---|
| 0 | Core dependency spike | **You** | — | 4B validated on-device; 8B/1.7B untested |
| 1 | Dev env + toolchain | **You** | 0 | — |
| 2 | Data layer (migrations + access) | **Sonnet** | 1 | ran on hardware; `POWER()` confirmed absent |
| 3 | TypeScript types (row/domain/scales) | **Sonnet** | 2 | Recurrence union authoritative |
| 4 | Structured-output strategy + eval design | **Fable** | 0, 1 | Q1 later confirmed it on-device |
| 5 | Schemas + GBNF grammars + validators + mappers | **Sonnet** | 3, 4 | — |
| Q1 | Grammar smoke-test arc (does GBNF work on-device) | **You + Sonnet** | 1, 5 | GREEN; ~0% overhead; the big de-risk |
| 6 | Provider + D10 ladder + startup guard | **Opus** | 1, 3, 5, Q1 | device-confirmed; guard proven for catchable failures |
| 7 | System prompts (task input + coaching) | **Opus** | 4, 6 | tuned 10/16→15/16; crisis path → task 21 |
| 9 | Scoring (§5.1–5.2) | **Opus** | 2, 3 | built Phase A; documented in `scoring_review_task_10.md` |
| 12 | Coaching flows + resolution dispatch | **Opus** | 6, 7 | device-confirmed; crisis review → task 21 |

### ⬜ Remaining
| Task | Component | Built with | Dep | Note |
|---|---|---|---|---|
| 10 | Scoring composition review | **Fable** (review) | 9 | pending — **do before 11/17 build on the ranking** |
| 11 | Session planning (§5.3) | **Opus** | 9, 10 | consumes the scored list; wants 10's rulings first |
| 13 | Timer + crash recovery (§8.2) | **Opus** | 6, 11 | surfaces through the task-24 execution screen |
| 14 | Data backup/restore + corruption recovery (§8.4) | **Opus** | 2 | state-machine care |
| 15 | Edge cases / Safe Mode (§8.3) | **Opus** → **Sonnet** | 6, 12 | Opus sets pattern; Sonnet fills |
| 17 | Numeric learning loops (§5.4) | **Opus** | 9, 11, 13 | needs real completion/skip data flowing |
| 18 | Skill-injection layer design + distillation (§5.5) | **Fable** | 4, 7, 12 | last big novel core |
| 19 | Skill-layer integration | **Opus** | 12, 18 | after 18 |
| 20 | Eval harness | **Sonnet** | 4, 5, 7 | parallel; reuse task-5 validators + task-7 scorer |
| 8 | Tiering ladder (§3.1) | **Opus** | 6 (+ 8B/1.7B quants) | ⏸ deferred — 4B-only; also gated on the quants existing (external) |

### 🆕 New (this planning update)
| Task | Component | Built with | Dep | Gate |
|---|---|---|---|---|
| 21 | Crisis detector review + referral localization | **Human** | 7, 12 | 🔴 beta |
| 22 | `which:"next"` weekday semantics | **Opus/Sonnet** | 5 | any target (small) |
| 23 | UI/UX design (interaction + visual system) | **Opus (frontend-design) / Human** | spec §6 (start now) | beta (polish); start early |
| 24 | Product UI implementation (real screens) | **Sonnet** + **Opus** | 23, 6, 9, 12, 13 | **functional → personal**; designed → beta |

### ♻️ Ongoing
| Component | Built with | Dep |
|---|---|---|
| Unit tests, `MockLLMProvider`, fixtures | **Sonnet** | alongside each task |
| Docs, comments, README, refactors/renames | **Sonnet** | ongoing |

*Dependency reading of what's left: **10 gates 11** (and 11 gates 13, which gates a full 24); **9→11→13→17** is the scoring→planning→timer→learning spine; **18→19** is the skill core (needs 4/7/12, all done, so 18 can start whenever Fable's free); **20** (eval harness) is parallel and unblocked now. For **personal ship**: 10 → (fix scoring if 10 rules pathology) → minimal 13 + 24 over the done 6/9/12 backend. 23 and 8 sit off the personal path entirely; 21 and the device envelope are beta gates.*

---

*Critical path to **personal ship**, per orientation §8: confirm task 9 + Fable review (10) → build a **minimal functional** task 24 over the confirmed 6/7/9/12 backend (including the task-13 timer) → a usable app. Design (23), crisis review (21), and the device envelope are **beta** concerns, not personal ones.*
