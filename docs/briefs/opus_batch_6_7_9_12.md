# Opus Batch — Tasks 6, 7, 9, 12 (index)

**This brief was split by phone-access requirement. Read the two phase briefs instead:**

1. **`opus_batch_A_headless.md`** — everything buildable and unit-testable with **no device**: all of task 9 (fully done), plus the built-and-mock-tested portions of tasks 6, 7, and 12. Do this first, unattended.
2. **`opus_batch_B_device.md`** — the **on-device** confirmation and prompt-tuning that *finishes* tasks 6, 7, and 12: the real grammar-constrained call, the startup-guard proof, the prompt-tuning loop, and live coaching dispatch.

**The split, at a glance:**

| Task | Phase A (headless) | Phase B (phone) |
|---|---|---|
| 9 Scoring | ✅ complete here + Fable review (10) | — |
| 6 Provider | build all of it; mock-test the ladder + guard logic | confirm real call; **prove the startup guard**; Stage 2/3 numbers |
| 7 Prompts | draft prompts + assembly scaffolding | the draft→run→observe→adjust tuning loop |
| 12 Coaching | triggers, dispatch wiring, skill seam, crisis structure | live conversations, real dispatch, disposition quality |

Only **task 9** closes in Phase A. Tasks 6/7/12 exit Phase A as *built, believed correct, pending device confirmation* and are completed in Phase B.

Both phase briefs assume `orientation_for_opus.md` (project state + non-negotiable constraints) has been read first.
