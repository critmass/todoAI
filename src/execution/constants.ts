// Task 13 — named tunables for the timer engine and episode lifecycle. Every threshold the
// design or its extend amendment fixes lives here as a named constant, so a cadence change is a
// number, not a redesign (task 28 design §4.3's explicit implementation note).

/** Hyperfocus quantum: one "Keep going" press (task 28 design §4.1). Chainable, unbounded. */
export const EXTEND_QUANTUM_MINUTES = 25;

/** The `+5 minutes` quantum (task 28 amendment §1). FLAT on every block size, on purpose — it is
 *  a "just let me finish" gesture, not a proportional one. Ruled; never make it a percentage. */
export const SHORT_EXTENSION_MINUTES = 5;

/** The ONE dumb check gating the park affordance (task 28 design §1.3): you cannot have made
 *  progress on work you did not start. There is no threshold above this, no minimum-minutes rule
 *  and no "was this real progress" heuristic — past 60 seconds, park is park because the user
 *  says so. The check is dumb; the conversation is smart. */
export const PARK_GATE_MS = 60_000;

/** Spec §8.2: an episode more than this fraction paused queues a coaching conversation. Computed
 *  over the EPISODE, and parked time is never paused time (a parked task has no running
 *  episode) — a definition to honor, not new machinery. */
export const PAUSE_COACHING_RATIO = 0.2;

// ── The §4.3 guardrail — RULED option B: nudge cadence, never a wall, HYPERFOCUS ONLY ──────────
// Three independent switches, shipped ON, kept independent so the cadence stays tunable without a
// redesign (design §4.3; amendment §4). None of them can reach the `+5` path: they read
// `hyperfocusQuanta`, which counts "Keep going" presses only. Nudging someone who is finishing a
// task is precisely the wrong moment, and the split exists so that cannot happen.

/** Switch 1: show the one-line self-care check on the end-of-block prompt. */
export const GUARDRAIL_SELF_CARE_NUDGE = true;
/** Switch 2: apply the "beyond N x the original block" long-stretch threshold. */
export const GUARDRAIL_LONG_EXTEND_THRESHOLD = true;
/** Switch 3: enqueue the `long_extend` coaching row when that threshold is crossed. */
export const GUARDRAIL_LONG_EXTEND_COACHING = true;

/** Cadence of the self-care check: every Nth consecutive hyperfocus quantum (~50 min at 2x25).
 *  One tap still continues. Never blocking. */
export const SELF_CARE_NUDGE_EVERY_QUANTA = 2;

/** A stretch beyond this multiple of the original block queues the `long_extend` conversation for
 *  the NEXT session — a conversation at the seam, never an interruption mid-flow. */
export const LONG_EXTEND_BLOCK_MULTIPLE = 2;

// ── Repeated `+5` → a conversation at task close (amendment §3) ────────────────────────────────
// Not a cap, not a nudge, not a failure. The system misjudged the task, not the user.

/** Count arm: the Nth `+5` press within one session on one task. */
export const REPEATED_EXTENSION_PRESS_COUNT = 3;

/** Percentage arm: cumulative `+5` minutes at or beyond this fraction of `estimated_duration`. */
export const REPEATED_EXTENSION_ESTIMATE_FRACTION = 0.5;

/** Floor under the percentage arm, so a 10-minute task cannot trip on a single press — a
 *  near-miss is not a pattern. (A coordinator default on top of Jason's "3 or 50%, whichever
 *  comes first"; it makes the trigger fire strictly less often.) */
export const REPEATED_EXTENSION_MINUTES_FLOOR = 10;
