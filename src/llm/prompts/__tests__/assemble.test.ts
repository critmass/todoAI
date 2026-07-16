import type { ChatMessage } from '../../provider/types';
import {
  assembleBreakdownPrompt,
  assembleCoachingPrompt,
  assembleExtractionPrompt,
  assembleSummaryPrompt,
} from '../assemble';
import {
  RECURRENCE_DECISION_TREE,
  SCOPE_TO_OBSERVABLE_RULE,
} from '../fieldGuides';
import { buildCoachingSystemPrompt } from '../coaching';
import { weekdayName } from '../systemPrompts';

const conversation: ChatMessage[] = [
  { role: 'user', content: 'take out the trash' },
  { role: 'assistant', content: 'Recurring?' },
  { role: 'user', content: 'every tuesday' },
];

describe('assembleExtractionPrompt', () => {
  it('puts a system prompt first, then the whole conversation (incl. the recap turn)', () => {
    const messages = assembleExtractionPrompt({ todayISO: '2026-07-15', conversation });
    expect(messages[0].role).toBe('system');
    expect(messages.slice(1)).toEqual(conversation);
  });

  it("injects today's date and weekday into the extraction system prompt", () => {
    const messages = assembleExtractionPrompt({ todayISO: '2026-07-15', conversation: [] });
    expect(messages[0].content).toContain('2026-07-15');
    expect(messages[0].content).toContain(weekdayName('2026-07-15')); // Wednesday
  });

  it('includes the recurrence decision tree and scope-to-observable rule (the field guide)', () => {
    const [sys] = assembleExtractionPrompt({ todayISO: '2026-07-15', conversation: [] });
    expect(sys.content).toContain(RECURRENCE_DECISION_TREE);
    expect(sys.content).toContain(SCOPE_TO_OBSERVABLE_RULE);
    // ask-don't-guess is load-bearing (null vs unscheduled)
    expect(sys.content).toContain('ASK one short question');
  });
});

describe('assembleBreakdownPrompt / assembleSummaryPrompt', () => {
  it('produce a system-first message shape', () => {
    expect(assembleBreakdownPrompt({ conversation })[0].role).toBe('system');
    expect(assembleBreakdownPrompt({ conversation }).slice(1)).toEqual(conversation);
    expect(assembleSummaryPrompt({ conversation: [] })).toHaveLength(1);
    expect(assembleSummaryPrompt({ conversation: [] })[0].content).toContain('summary_schema_version');
  });
});

describe('assembleCoachingPrompt (skill-injection seam)', () => {
  const base = buildCoachingSystemPrompt('task_skipped');

  it('leaves the skill slot empty-but-present when no skills are injected', () => {
    const messages = assembleCoachingPrompt({ base });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    // base tone/safety present…
    expect(messages[0].content).toContain('supportive task coach');
    // …but no skill section leaks in when empty (hidden-from-user, spec §5.5)
    expect(messages[0].content).not.toContain('learned approaches');
    expect(messages[0].content).toBe(base); // empty injection is a clean no-op
  });

  it('injects skills into the system prompt when provided (task 18 producer)', () => {
    const messages = assembleCoachingPrompt({
      base,
      injectedSkills: ['Offer a 2-minute starter step when they stall.'],
    });
    expect(messages[0].content).toContain('learned approaches');
    expect(messages[0].content).toContain('2-minute starter step');
    // stays hidden from the user
    expect(messages[0].content).toContain('do not mention them to the user');
  });

  it('appends the conversation after the system prompt', () => {
    const messages = assembleCoachingPrompt({ base, conversation });
    expect(messages[0].role).toBe('system');
    expect(messages.slice(1)).toEqual(conversation);
  });

  it('varies purpose by trigger (session_recalibration vs task_skipped)', () => {
    expect(buildCoachingSystemPrompt('session_recalibration')).toContain('Stop serving tasks');
    expect(buildCoachingSystemPrompt('app_reorientation')).toContain('back after a few days');
  });
});
