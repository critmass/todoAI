// Task 41 — THE ONE ENTRY POINT (brief §4: "one module, one entry point (`record(event)`); capture
// logic never diffuses into the code it instruments; call sites pass data and know nothing else").
//
// Where capture touches instrumented code, exhaustively (design §11):
//
//   Everywhere                                       one `record({...})` statement
//   episodeService's session/episode entry points   + `captureContext.setSession/setEpisode`
//   appServices.ts                                   repository bundles wrapped per consumer
//   App.tsx                                        + `installCapture()`, the AppState records and
//                                                    one line rendering the ceiling notice
//
// Removing ALL of capture is: delete `src/capture/`, delete `src/specs/NativeCaptureLog.ts` and the
// three Kotlin lines that register it, and let `tsc` name every call site. Removing ONE stream is
// design §11's five steps.

export { record, lastSeq, captureHealth, currentRunId, localDayISO } from './record';
export type { CaptureHealth } from './record';
export { captureContext, episodeIdOf } from './context';
export type { CaptureFrame, SessionOrigin } from './context';
export { STREAMS, STREAM_NAMES, CAPTURE_FORMAT_VERSION, CAPTURE_ROOT_DIR } from './streams';
export type { EgressClass, LadderFate, StreamName, StreamDefinition } from './streams';
export type * from './events';
export { installCapture } from './install';
export type { CaptureInstallation } from './install';
export { withMutationCapture } from './streams/mutationCapture';
export {
  checkCeilingAndReportHealth,
  pendingCeilingWarning,
  dismissCeilingWarning,
  CAPTURE_CEILING_BYTES,
  CAPTURE_WARN_BYTES,
} from './retention';
export type { CaptureCeilingState } from './retention';
export { CaptureCeilingNotice } from './CaptureCeilingNotice';
export {
  sampleThermal,
  thermalStatusSampler,
  captureRootPath,
  // Task 14's free-space query, exposed here and consumed by nothing in task 41.
  availableBytesFor,
  normaliseAvailableBytes,
} from './nativeWriter';
export type { ThermalSample } from './nativeWriter';
export { recordModelCall, recordValidationFailure, type ModelCallCapture } from './streams/modelCall';
export { sha8 } from './sha256';
