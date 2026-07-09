// Two-level scales (spec §4.1). Pure, side-effect-free projections between the user-facing
// coarse scale and the internal fine scale actually used in scoring. Never write a user-facing
// value directly into `importance`/`energy_requirement` — always go through these.

export type UserImportance = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type UserEnergy = 'low' | 'med' | 'high';

/**
 * User 1–10 -> internal 100–1000 (exact multiples of 100). The internal value is the real
 * number used everywhere in scoring; this is purely an input projection.
 */
export function userToInternalImportance(user: UserImportance): number {
  if (!Number.isInteger(user) || user < 1 || user > 10) {
    throw new Error(`userToInternalImportance: user importance must be an integer 1-10, got ${user}`);
  }
  return user * 100;
}

/**
 * Internal 1–1000 -> user 1–10 (display-only projection). The 1-99 band beneath each hundred
 * (e.g. 701-799 under a 700 parent) orders subtasks and collapses back to the parent's decade
 * on the way up — that collapse is intentional, not lossy in the sense that matters: a value
 * produced by `userToInternalImportance` always round-trips back to the same user value.
 */
export function internalToUserImportance(internal: number): UserImportance {
  if (!Number.isInteger(internal) || internal < 1 || internal > 1000) {
    throw new Error(`internalToUserImportance: internal importance must be an integer 1-1000, got ${internal}`);
  }
  const decade = Math.floor(internal / 100);
  return Math.min(10, Math.max(1, decade)) as UserImportance;
}

/**
 * User low/med/high -> internal 1/3/5. Internal 2 and 4 are reserved for the app's behavioral
 * discounting off learned `average_energy_cost` (spec §4.1/§5.4) and are assigned by scoring
 * logic (out of scope here) — they are never user-entered and this module does not project
 * them back to a user label; energy_requirement's full domain is 1-5 (see InternalEnergy).
 */
export type InternalEnergyOdd = 1 | 3 | 5;
export type InternalEnergy = 1 | 2 | 3 | 4 | 5;

const USER_TO_INTERNAL_ENERGY: Record<UserEnergy, InternalEnergyOdd> = {
  low: 1,
  med: 3,
  high: 5,
};

const INTERNAL_TO_USER_ENERGY: Record<InternalEnergyOdd, UserEnergy> = {
  1: 'low',
  3: 'med',
  5: 'high',
};

export function userToInternalEnergy(user: UserEnergy): InternalEnergyOdd {
  const internal = USER_TO_INTERNAL_ENERGY[user];
  if (internal === undefined) {
    throw new Error(`userToInternalEnergy: unknown user energy "${user}"`);
  }
  return internal;
}

export function internalToUserEnergy(internal: InternalEnergyOdd): UserEnergy {
  const user = INTERNAL_TO_USER_ENERGY[internal];
  if (user === undefined) {
    throw new Error(`internalToUserEnergy: expected 1, 3, or 5, got ${internal}`);
  }
  return user;
}
