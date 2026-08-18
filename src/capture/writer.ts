// Task 41 — the writer seam.
//
// `record()` (./record.ts) depends on THIS interface and nothing else, which is the property that
// makes the force-kill acceptance test possible: the test drives the real record() path over a
// Node `fs` writer double in a child process it can SIGKILL, and neither record.ts nor this file
// imports `react-native`. The native writer (./nativeWriter.ts) is installed by ./install.ts.
//
// 🔴 `append` IS SYNCHRONOUS AND MUST STAY SYNCHRONOUS. Brief §5b: "lossless means synchronous at
// the event", and the acceptance test is a force-kill that loses nothing. A Promise-based append
// (react-native-fs) performs its write(2) on a background executor; the window between record()
// returning and the bytes reaching the kernel is sub-millisecond but REAL, and the events living
// in it are precisely the ones immediately before a crash — the single most valuable capture this
// facility will ever take (constraint #3: llama.cpp can kill this process with no JS error and no
// tombstone). A blocking write(2) means that when record() returns the bytes are in the KERNEL
// PAGE CACHE, which `am force-stop`, `kill -9` and a native SIGSEGV all leave untouched.
//
// If anyone ever makes this async "for performance", design §7.3's ordering guarantee dies with
// it: JS is single-threaded and record() is synchronous end to end, so `seq` assignment and the
// write cannot interleave and no lock is needed.

export interface CaptureWriter {
  /**
   * Appends one complete NDJSON line — trailing `\n` INCLUDED IN THE SAME BUFFER, so a line is
   * never torn by interleaving (design §2). Throws on failure; record() catches and counts.
   */
  append(dir: string, day: string, line: string): void;
  /**
   * `SystemClock.elapsedRealtime()` on device. NOT `performance.now()`: elapsedRealtime counts
   * across deep sleep (which this app's whole hard problem lives in) and is stable across process
   * restarts within a boot, so it orders the pre-crash and post-crash runs against each other
   * (design §3.4). `performance.now()` resets per process and would be useless for exactly the
   * case that matters.
   */
  monoMs(): number;
  /** Total bytes under `capture/`, for the ceiling check. Cheap enough at a background
   *  transition, far too expensive per append. */
  sizeOnDisk(): number;
  /** Deletes one whole day directory across every stream. Rotation deletes days, never parts of
   *  a file (design §6 rule 4). Returns the number of files removed. */
  deleteDay(day: string): number;
  /** Day directories present on disk, ascending. */
  listDays(): string[];
}
