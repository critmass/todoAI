// Task 41 — the stream table.
//
// THE RULE THIS FILE ENFORCES (design §4.1, ruled 12.2 on 2026-08-17): every stream has exactly
// one egress class and exactly one ladder fate. A stream that would need two is split into two
// streams. That is not tidiness — orientation §5 settles that pruning happens by DROPPING, not
// disabling, so a stream whose records are only PARTLY free text could never be dropped; it could
// only be filtered, field by field, by code that would then have to be written, tested and
// trusted at exactly the rung where nobody is reviewing it any more.
//
// Removing a stream is: delete its entry here, delete its member from the CaptureEvent union in
// ./events.ts, delete `src/capture/streams/<name>.ts` if it has one, and let `tsc` name every call
// site (design §11). You do not grep for call sites; the compiler enumerates them.

export type EgressClass = 'structured' | 'free_text';

export type LadderFate =
  /** Task 42 Job A, before closed beta. */
  | 'removed_before_closed_beta'
  /** Task 43, at open beta. */
  | 'dropped_at_open_beta'
  | 'survives';

export interface StreamDefinition {
  /** The directory under `capture/`. On-disk contract, design §6 rule 1 — task 42's acceptance
   *  test enumerates these paths to prove a stream is empty. */
  dir: string;
  egress: EgressClass;
  fate: LadderFate;
}

export const STREAMS = {
  // ── free text ────────────────────────────────────────────────────────────────────────────
  conversation: { dir: 'conversation', egress: 'free_text', fate: 'dropped_at_open_beta' },
  modeltext: { dir: 'modeltext', egress: 'free_text', fate: 'dropped_at_open_beta' },
  mutationtext: { dir: 'mutationtext', egress: 'free_text', fate: 'dropped_at_open_beta' },
  crisis: { dir: 'crisis', egress: 'free_text', fate: 'removed_before_closed_beta' },
  // ── structured ───────────────────────────────────────────────────────────────────────────
  modelio: { dir: 'modelio', egress: 'structured', fate: 'survives' },
  validation: { dir: 'validation', egress: 'structured', fate: 'survives' },
  mutation: { dir: 'mutation', egress: 'structured', fate: 'survives' },
  episode: { dir: 'episode', egress: 'structured', fate: 'survives' },
  planning: { dir: 'planning', egress: 'structured', fate: 'survives' },
  coaching: { dir: 'coaching', egress: 'structured', fate: 'survives' },
  runtime: { dir: 'runtime', egress: 'structured', fate: 'survives' },
  lifecycle: { dir: 'lifecycle', egress: 'structured', fate: 'survives' },
} as const satisfies Record<string, StreamDefinition>;

export type StreamName = keyof typeof STREAMS;

/** The stream set compiled into THIS build. Recorded once per run in `lifecycle.boot`, because a
 *  gap analysis over the global `seq` is only valid against the stream set that was compiled
 *  (design §3.4) — once task 42 removes `crisis` and task 43 removes the free-text streams, later
 *  builds have permanent legitimate gaps. This cannot be retrofitted. */
export const STREAM_NAMES = Object.keys(STREAMS) as StreamName[];

/** The record format version, global across every stream — ratified by Jason 2026-08-17
 *  (orientation §5; rules in design §9). One version axis for all twelve streams, because the
 *  corpus consumers join streams by correlation ID rather than reading one. */
export const CAPTURE_FORMAT_VERSION = 1;

/** The directory capture owns entirely, under the app-private external files dir (constraint
 *  #10). Nothing else writes here; removing all of capture is removing this directory and
 *  `src/capture/`. */
export const CAPTURE_ROOT_DIR = 'capture';
