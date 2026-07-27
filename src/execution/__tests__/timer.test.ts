import type { ActiveEpisode, Task } from '../../types/domain';
import type { EpisodeBlockKind } from '../../types/db';
import type { BlockKind } from '../../planning/agenda';
import {
  MS_PER_MINUTE,
  hyperfocusExtensionEnd,
  longExtendThresholdCrossed,
  minutesFromMs,
  pauseCoachingDue,
  pauseRatio,
  recoveryCreditMs,
  repeatedExtensionArm,
  selfCareNudgeDue,
  shortExtensionEnd,
  timerSnapshot,
  workedMs,
} from '../timer';

// The planner produces the block kind, the runtime table stores it, and types/ may not import
// from planning/ — so the two unions are declared separately. This is the compile-time proof
// that they have not drifted apart: if either gains a member, `blockKindsAgree` stops typing.
type Extends<A, B> = A extends B ? true : false;
type BlockKindsAgree = Extends<EpisodeBlockKind, BlockKind> & Extends<BlockKind, EpisodeBlockKind>;
const blockKindsAgree: BlockKindsAgree = true;

const T0 = Date.UTC(2026, 6, 26, 9, 0, 0);
const min = (n: number) => n * MS_PER_MINUTE;

function makeEpisode(overrides: Partial<ActiveEpisode> = {}): ActiveEpisode {
  return {
    sessionId: 's1',
    taskId: 1,
    blockKind: 'countdown',
    plannedMinutes: 25,
    startedAtMs: T0,
    blockEndAtMs: T0 + min(25),
    pausedAtMs: null,
    pausedMs: 0,
    pauseCount: 0,
    hyperfocusQuanta: 0,
    longExtendEnqueued: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'A task',
    description: null,
    importance: 500,
    urgencyLevel: 3,
    nextDueAt: null,
    estimatedDuration: 30,
    durationSource: 'model_guess',
    actualDurationHistory: [],
    averageActualDuration: null,
    energyRequirement: 3,
    averageEnergyCost: 0,
    contextTags: [],
    toolRequirements: [],
    status: 'active',
    parentTaskId: null,
    createdAt: null,
    updatedAt: null,
    completionCount: 0,
    skipCount: 0,
    skipReasons: [],
    lastCompletedAt: null,
    successRate: 0,
    durationType: 'estimate',
    workState: 'none',
    accumulatedMinutes: 0,
    lastWorkedAt: null,
    ...overrides,
  };
}

describe('the block-kind vocabulary', () => {
  it("keeps the planner's BlockKind and the stored EpisodeBlockKind identical", () => {
    expect(blockKindsAgree).toBe(true);
  });
});

describe('minutesFromMs', () => {
  it('rounds to the nearest minute so every consumer reports the same number', () => {
    expect(minutesFromMs(0)).toBe(0);
    expect(minutesFromMs(29_000)).toBe(0);
    expect(minutesFromMs(30_000)).toBe(1);
    expect(minutesFromMs(min(24) + 40_000)).toBe(25);
    expect(minutesFromMs(-5_000)).toBe(0);
  });
});

describe('timerSnapshot (spec §8.2 — remaining comes from the wall clock, never a tick count)', () => {
  it('counts a countdown block down and raises the boundary exactly at zero', () => {
    const episode = makeEpisode();

    const early = timerSnapshot(episode, T0 + min(10));
    expect(early.face).toBe('countdown');
    expect(early.remainingMs).toBe(min(15));
    expect(early.boundaryReached).toBe(false);

    const atZero = timerSnapshot(episode, T0 + min(25));
    expect(atZero.remainingMs).toBe(0);
    expect(atZero.boundaryReached).toBe(true);

    // Past the boundary with the prompt unanswered: remaining goes negative, nothing ends.
    const past = timerSnapshot(episode, T0 + min(31));
    expect(past.remainingMs).toBe(min(-6));
    expect(past.boundaryReached).toBe(true);
  });

  it('counts an openBlock UP, and its boundary raises the prompt rather than ending anything', () => {
    const episode = makeEpisode({ blockKind: 'openBlock', plannedMinutes: 60, blockEndAtMs: T0 + min(60) });

    const mid = timerSnapshot(episode, T0 + min(45));
    expect(mid.face).toBe('countup');
    expect(mid.workedMs).toBe(min(45));
    expect(mid.boundaryReached).toBe(false);

    expect(timerSnapshot(episode, T0 + min(60)).boundaryReached).toBe(true);
  });

  it('switches a countdown face to count-up once a hyperfocus stretch is running (design §3.1)', () => {
    const stretch = makeEpisode({ hyperfocusQuanta: 1, blockEndAtMs: T0 + min(50) });
    expect(timerSnapshot(stretch, T0 + min(30)).face).toBe('countup');
  });

  it('leaves the face alone for a +5: a countdown stays a countdown (amendment §1)', () => {
    // The +5 has moved the block end but added no hyperfocus quanta — that is the whole
    // distinction, and it is what keeps the guardrail off this path.
    const plusFive = makeEpisode({ blockEndAtMs: T0 + min(30), hyperfocusQuanta: 0 });
    expect(timerSnapshot(plusFive, T0 + min(26)).face).toBe('countdown');
  });

  it('freezes worked time and remaining time while paused', () => {
    const paused = makeEpisode({ pausedAtMs: T0 + min(10) });

    const justPaused = timerSnapshot(paused, T0 + min(10));
    const muchLater = timerSnapshot(paused, T0 + min(40));

    expect(justPaused.workedMs).toBe(min(10));
    expect(muchLater.workedMs).toBe(min(10)); // 30 minutes of pause added no work
    expect(muchLater.remainingMs).toBe(min(15)); // and consumed no block
    expect(muchLater.paused).toBe(true);
    expect(muchLater.pausedMs).toBe(min(30)); // the open pause is still counted as pause
  });

  it('subtracts closed pauses from worked time', () => {
    const episode = makeEpisode({ pausedMs: min(4), blockEndAtMs: T0 + min(29) });
    expect(workedMs(episode, T0 + min(20))).toBe(min(16));
  });
});

describe('the 60-second park gate (design §1.3 — the ONE dumb check)', () => {
  it('opens at exactly 60 seconds of WORKED time, not wall time', () => {
    const episode = makeEpisode();
    expect(timerSnapshot(episode, T0 + 59_999).parkAvailable).toBe(false);
    expect(timerSnapshot(episode, T0 + 60_000).parkAvailable).toBe(true);
  });

  it('does not open on a minute spent entirely paused', () => {
    // Paused after 10 seconds: three minutes of wall time later, only 10 seconds were worked.
    const episode = makeEpisode({ pausedAtMs: T0 + 10_000 });
    expect(timerSnapshot(episode, T0 + min(3)).parkAvailable).toBe(false);
  });
});

describe('the two extension mutations (amendment §1)', () => {
  it('+5 adds a flat five minutes on every block size — never a percentage', () => {
    expect(shortExtensionEnd(T0 + min(10)) - (T0 + min(10))).toBe(min(5));
    expect(shortExtensionEnd(T0 + min(120)) - (T0 + min(120))).toBe(min(5));
  });

  it('chained +5 presses are never capped, promoted, or resisted (ruled)', () => {
    let end = T0 + min(25);
    for (let i = 0; i < 10; i++) end = shortExtensionEnd(end);
    expect(end).toBe(T0 + min(75)); // ten presses, ten times five minutes, no ceiling
  });

  it('Keep going adds a 25-minute quantum and chains', () => {
    expect(hyperfocusExtensionEnd(T0) - T0).toBe(min(25));
    expect(hyperfocusExtensionEnd(hyperfocusExtensionEnd(T0)) - T0).toBe(min(50));
  });
});

describe('the guardrail — option B, hyperfocus only', () => {
  it('nudges on every SECOND consecutive quantum and never on the first', () => {
    expect(selfCareNudgeDue(0)).toBe(false);
    expect(selfCareNudgeDue(1)).toBe(false);
    expect(selfCareNudgeDue(2)).toBe(true);
    expect(selfCareNudgeDue(3)).toBe(false);
    expect(selfCareNudgeDue(4)).toBe(true);
  });

  it('crosses the long-extend threshold only past 2x the ORIGINAL block', () => {
    expect(longExtendThresholdCrossed(25, 1)).toBe(false); // 25 + 25 = exactly 2x, not beyond
    expect(longExtendThresholdCrossed(25, 2)).toBe(true); // 25 + 50 = 3x
    expect(longExtendThresholdCrossed(50, 2)).toBe(false); // 50 + 50 = exactly 2x
    expect(longExtendThresholdCrossed(50, 3)).toBe(true);
  });

  it('CANNOT be reached by +5 presses, however many (amendment §4)', () => {
    // The threshold is expressed against quanta, not against the block end — which +5 also moves.
    // Ten +5 presses on a 25-minute block is a 75-minute stretch, well past 2x, and it stays
    // silent. Nudging someone who is finishing a task is precisely the wrong moment.
    expect(longExtendThresholdCrossed(25, 0)).toBe(false);
    expect(selfCareNudgeDue(0)).toBe(false);
  });
});

describe('repeated +5 → repeated_extension (amendment §3)', () => {
  it('trips the count arm on the 3rd press', () => {
    const task = makeTask({ estimatedDuration: 120 }); // percentage arm far out of reach
    expect(repeatedExtensionArm({ presses: 2, minutes: 10 }, task)).toBeNull();
    expect(repeatedExtensionArm({ presses: 3, minutes: 15 }, task)).toBe('count');
  });

  it('trips the percentage arm at 50% of the estimate', () => {
    const task = makeTask({ estimatedDuration: 20 });
    expect(repeatedExtensionArm({ presses: 1, minutes: 5 }, task)).toBeNull();
    expect(repeatedExtensionArm({ presses: 2, minutes: 10 }, task)).toBe('percentage');
  });

  it('holds the percentage arm below the 10-minute floor — a near-miss is not a pattern', () => {
    // A 10-minute task: one press is already 50% of the estimate, but only 5 cumulative minutes.
    const task = makeTask({ estimatedDuration: 10 });
    expect(repeatedExtensionArm({ presses: 1, minutes: 5 }, task)).toBeNull();
    expect(repeatedExtensionArm({ presses: 2, minutes: 10 }, task)).toBe('percentage');
  });

  it('uses the COUNT ARM ONLY for a floor-typed task — a floor has no ceiling to be past', () => {
    const floorTask = makeTask({ durationType: 'floor', estimatedDuration: 60 });
    expect(repeatedExtensionArm({ presses: 2, minutes: 60 }, floorTask)).toBeNull();
    expect(repeatedExtensionArm({ presses: 3, minutes: 15 }, floorTask)).toBe('count');
  });

  it('uses the count arm only for a blown estimate already treated as an open block', () => {
    const blown = makeTask({
      estimatedDuration: 30,
      workState: 'in_progress',
      accumulatedMinutes: 35,
    });
    expect(repeatedExtensionArm({ presses: 2, minutes: 25 }, blown)).toBeNull();
    expect(repeatedExtensionArm({ presses: 3, minutes: 25 }, blown)).toBe('count');
  });
});

describe('pause accounting (spec §8.2 — >20% paused queues coaching)', () => {
  it('is strictly greater than 20%: exactly 20% does not queue', () => {
    const exactly = makeEpisode({ pausedMs: min(5) }); // 5 of 25 wall minutes
    expect(pauseRatio(exactly, T0 + min(25))).toBeCloseTo(0.2);
    expect(pauseCoachingDue(exactly, T0 + min(25))).toBe(false);

    const over = makeEpisode({ pausedMs: min(6) });
    expect(pauseCoachingDue(over, T0 + min(25))).toBe(true);
  });

  it('counts a still-open pause toward the ratio', () => {
    const episode = makeEpisode({ pausedAtMs: T0 + min(1) });
    expect(pauseCoachingDue(episode, T0 + min(25))).toBe(true);
  });

  it('is 0 for a zero-length episode rather than dividing by zero', () => {
    expect(pauseRatio(makeEpisode(), T0)).toBe(0);
  });
});

describe('recoveryCreditMs (design §1.4) — elapsed minus known pause time', () => {
  it('credits elapsed minus pauses when the relaunch happens inside the block', () => {
    const episode = makeEpisode({ pausedMs: min(3) });
    expect(recoveryCreditMs(episode, T0 + min(20))).toBe(min(17));
  });

  it('BOUNDS the credit at the block end — a three-day-later relaunch credits one block', () => {
    // Without the bound this would credit three days of "work" into accumulated_minutes and
    // poison the one actual_duration_history entry the fold eventually writes.
    const episode = makeEpisode();
    expect(recoveryCreditMs(episode, T0 + min(3 * 24 * 60))).toBe(min(25));
  });

  it('treats time dead-while-paused as pause, erring toward crediting LESS work', () => {
    const episode = makeEpisode({ pausedAtMs: T0 + min(4) });
    // Died 4 minutes in while paused, relaunched at minute 20: only the first 4 minutes worked.
    expect(recoveryCreditMs(episode, T0 + min(20))).toBe(min(4));
  });

  it('bounds the open pause at the block end too, never producing a negative credit', () => {
    const episode = makeEpisode({ pausedAtMs: T0 + min(10) });
    expect(recoveryCreditMs(episode, T0 + min(500))).toBe(min(10));
    expect(recoveryCreditMs(makeEpisode({ pausedMs: min(99) }), T0 + min(20))).toBe(0);
  });

  it('credits a crash in the first seconds as zero minutes, not a negative', () => {
    expect(recoveryCreditMs(makeEpisode(), T0 + 5_000)).toBe(5_000);
    expect(minutesFromMs(recoveryCreditMs(makeEpisode(), T0 + 5_000))).toBe(0);
  });
});
