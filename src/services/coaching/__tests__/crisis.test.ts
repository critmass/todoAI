import { DRAFT_CRISIS_DETECTOR, checkCrisis, crisisResponse, noCrisisDetected } from '../crisis';
import { CRISIS_REFERRAL_TEXT } from '../../../llm/prompts/coaching';

describe('crisis path (§7.3 structure)', () => {
  it('crisisResponse returns the fixed reviewed copy and halts the flow', () => {
    const res = crisisResponse();
    expect(res.kind).toBe('crisis');
    expect(res.halt).toBe(true);
    expect(res.text).toBe(CRISIS_REFERRAL_TEXT); // fixed, never model-generated
  });

  it('noCrisisDetected opens the gate explicitly (for tests)', () => {
    expect(noCrisisDetected('I feel completely hopeless')).toBe(false);
    expect(checkCrisis('anything at all', noCrisisDetected)).toBeNull();
  });

  it('a reviewed detector engages the care-and-refer path and short-circuits coaching', () => {
    const alwaysCrisis = () => true;
    const res = checkCrisis('…', alwaysCrisis);
    expect(res).not.toBeNull();
    expect(res?.halt).toBe(true);
    expect(res?.text).toBe(CRISIS_REFERRAL_TEXT);
  });

  it('checkCrisis defaults to the draft detector — a caller who forgets one is protected, not exposed', () => {
    expect(checkCrisis("I don't really want to be here")).not.toBeNull();
  });
});

describe('DRAFT_CRISIS_DETECTOR', () => {
  // The exact input the 4B answered with "try one thing ... even if it's just 10 minutes"
  // (docs/eval/task7_phaseB_findings_report.md §9). This is the regression that matters.
  it('fires on the on-device input the model missed entirely', () => {
    expect(
      DRAFT_CRISIS_DETECTOR(
        "Honestly I don't see the point in any of it anymore. I don't really want to be here.",
      ),
    ).toBe(true);
  });

  it.each([
    'I want to die',
    'I have been thinking about killing myself',
    'I just want to end it all',
    'sometimes I think everyone would be better off without me',
    "I don't want to live anymore",
    'I have been hurting myself again',
    'there is no point in going on',
    'I wish I was dead',
    'life is not worth living',
    'I think I might be suicidal',
  ])('fires on: %s', (text) => {
    expect(DRAFT_CRISIS_DETECTOR(text)).toBe(true);
  });

  // A detector that fired on these would be its own harm — it would train users to dismiss it.
  it.each([
    'I am dying to get this done',
    'this task is killing me',
    'I need to kill this task off today',
    'I could die of embarrassment about my inbox',
    'I am dead tired and skipped everything',
    'my motivation is dead',
    'I feel completely hopeless about this garage',
    'I want to disappear this task from my list',
  ])('does NOT fire on the idiom: %s', (text) => {
    expect(DRAFT_CRISIS_DETECTOR(text)).toBe(false);
  });

  it('is case- and apostrophe-insensitive (curly quotes from real keyboards)', () => {
    expect(DRAFT_CRISIS_DETECTOR('I DON’T WANT TO BE HERE')).toBe(true);
  });
});
