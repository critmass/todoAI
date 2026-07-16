import { checkCrisis, crisisResponse, noCrisisDetected } from '../crisis';
import { CRISIS_REFERRAL_TEXT } from '../../../llm/prompts/coaching';

describe('crisis path (§7.3 structure)', () => {
  it('crisisResponse returns the fixed reviewed copy and halts the flow', () => {
    const res = crisisResponse();
    expect(res.kind).toBe('crisis');
    expect(res.halt).toBe(true);
    expect(res.text).toBe(CRISIS_REFERRAL_TEXT); // fixed, never model-generated
  });

  it('the default detector never triggers (no false positives headless)', () => {
    expect(noCrisisDetected('I feel completely hopeless')).toBe(false);
    expect(checkCrisis('anything at all')).toBeNull();
  });

  it('a reviewed detector engages the care-and-refer path and short-circuits coaching', () => {
    const alwaysCrisis = () => true;
    const res = checkCrisis('…', alwaysCrisis);
    expect(res).not.toBeNull();
    expect(res?.halt).toBe(true);
    expect(res?.text).toBe(CRISIS_REFERRAL_TEXT);
  });
});
