// Barrel for the coaching service layer (task 12). Triggers→urgency enqueue, the grammar-union
// resolution dispatcher, the D10-laddered disposition step, and the crisis-path structure.
export {
  urgencyForTrigger,
  enqueueCoachingTrigger,
  type EnqueueCoachingInput,
} from './triggers';

export {
  dispatchResolution,
  type ResolutionDispatchDeps,
  type ResolutionContext,
  type DispatchOutcome,
} from './dispatch';

export {
  runCoachingResolution,
  RESOLUTION_MAX_TOKENS,
  type RunCoachingResolutionArgs,
  type CoachingResolutionResult,
} from './resolveCoaching';

export {
  crisisResponse,
  checkCrisis,
  noCrisisDetected,
  type CrisisResponse,
  type CrisisDetector,
} from './crisis';
