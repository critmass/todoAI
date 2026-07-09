import {
  internalToUserEnergy,
  internalToUserImportance,
  userToInternalEnergy,
  userToInternalImportance,
  type UserEnergy,
  type UserImportance,
} from '../scales';

describe('importance scale', () => {
  it('round-trips every user value 1-10 without loss', () => {
    for (let user = 1; user <= 10; user++) {
      const internal = userToInternalImportance(user as UserImportance);
      expect(internal).toBe(user * 100);
      expect(internalToUserImportance(internal)).toBe(user);
    }
  });

  it('collapses subtask-band values (701-799) to the parent decade (7)', () => {
    expect(internalToUserImportance(700)).toBe(7);
    expect(internalToUserImportance(701)).toBe(7);
    expect(internalToUserImportance(799)).toBe(7);
    expect(internalToUserImportance(800)).toBe(8);
  });

  it('handles the boundaries (1 and 1000)', () => {
    expect(internalToUserImportance(1)).toBe(1);
    expect(internalToUserImportance(1000)).toBe(10);
  });

  it('rejects out-of-range or non-integer user values', () => {
    expect(() => userToInternalImportance(0 as UserImportance)).toThrow();
    expect(() => userToInternalImportance(11 as UserImportance)).toThrow();
    expect(() => userToInternalImportance(5.5 as UserImportance)).toThrow();
  });

  it('rejects out-of-range or non-integer internal values', () => {
    expect(() => internalToUserImportance(0)).toThrow();
    expect(() => internalToUserImportance(1001)).toThrow();
    expect(() => internalToUserImportance(500.5)).toThrow();
  });
});

describe('energy scale', () => {
  it('round-trips low/med/high without loss', () => {
    const cases: Array<[UserEnergy, 1 | 3 | 5]> = [
      ['low', 1],
      ['med', 3],
      ['high', 5],
    ];
    for (const [user, internal] of cases) {
      expect(userToInternalEnergy(user)).toBe(internal);
      expect(internalToUserEnergy(internal)).toBe(user);
    }
  });

  it('rejects unknown user energy labels', () => {
    expect(() => userToInternalEnergy('extreme' as UserEnergy)).toThrow();
  });

  it('rejects internal values outside the odd anchors (2 and 4 are app-assigned, not user labels)', () => {
    expect(() => internalToUserEnergy(2 as 1 | 3 | 5)).toThrow();
    expect(() => internalToUserEnergy(4 as 1 | 3 | 5)).toThrow();
  });
});
