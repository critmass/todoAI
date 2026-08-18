// Task 41 — the free-space query added for task 14 (ruled by Jason 2026-08-18).
//
// The property under test is the one the coordinator singled out and the one a blocking decision
// depends on: "free space is 40 MB" and "I cannot tell you" must never collapse into the same
// value. Collapsing them into 0 would make a missing native module look like a full disk, which is
// the worst available confusion for a gate that stops the user working.

import { availableBytesFor, normaliseAvailableBytes } from '../nativeWriter';

describe('normaliseAvailableBytes', () => {
  it('passes a real measurement through, including a genuine zero', () => {
    expect(normaliseAvailableBytes(41_943_040)).toBe(41_943_040);
    // 🔴 Zero is a REAL answer — the volume is full — and must survive as a number.
    expect(normaliseAvailableBytes(0)).toBe(0);
  });

  it('maps the native "unknown" sentinel to null, not to zero', () => {
    expect(normaliseAvailableBytes(-1)).toBeNull();
  });

  it('treats anything absent or non-finite as unknown rather than passing it on', () => {
    expect(normaliseAvailableBytes(null)).toBeNull();
    expect(normaliseAvailableBytes(undefined)).toBeNull();
    expect(normaliseAvailableBytes(NaN)).toBeNull();
    expect(normaliseAvailableBytes(Infinity)).toBeNull();
  });

  it('keeps byte counts exact at phone-sized volumes', () => {
    // Doubles hold integers exactly to 2^53 (~9 PB), so a 512 GB volume is exact. Pinned because
    // the representation choice is stated in the spec and should fail here if it ever changes.
    const halfTerabyte = 512 * 1024 * 1024 * 1024;
    expect(normaliseAvailableBytes(halfTerabyte)).toBe(halfTerabyte);
    expect(Number.isSafeInteger(halfTerabyte)).toBe(true);
  });
});

describe('availableBytesFor', () => {
  it('degrades to null when the native module is absent', () => {
    // This is the state under Jest, and the state on a JS bundle running against an APK built
    // before the method existed. It must be legible as "cannot tell", never a launch crash and
    // never a fabricated number — the binding is TurboModuleRegistry.get, not getEnforcing.
    expect(availableBytesFor('/mock/external-files')).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    expect(() => availableBytesFor('')).not.toThrow();
  });
});
