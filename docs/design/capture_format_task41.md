# Task 41 — the capture format

**Status:** ⬜ **Phase 1 deliverable, awaiting Jason's sign-off.** Nothing in `src/` has been written
against this yet, by instruction. §12 is the list of things that need a ruling before Phase 2 starts.

> ⚠ **§12 has been ruled — read `capture_format_task41_amendment_rulings.md` alongside this.** Jason
> ruled all eight questions on 2026-08-17, plus two follow-ups. The amendment states what each
> ruling changes here, and **where the two documents disagree the amendment wins.** This document is
> left as written on purpose — it is the record of what was asked. Sections superseded in whole or
> part: **§1.2** (fsync), **§4.3** (thermal), **§5.5** (actor vocabulary), **§5.9** (crisis events),
> **§8.2** (retention warning), **§12** (all of it).

**Who reads this:** task 31's harvesting tooling, task 20's eval harness, task 40's bake-off
analysis, and task 42's acceptance test (which enumerates §6's paths to prove they are empty).
It is the on-disk contract, not a summary of one.

**Read with:** `docs/briefs/event_capture_task_41.md` (the work order), orientation §4/§5,
`docs/briefs/privacy_consent_task_42.md` §1–2, `docs/briefs/capture_ladder_task_43.md` §2.

---

## 0. What changed relative to the brief, up front

Six things. Each is argued in place; this is the index so nothing hides in a subsection.

| # | Change | Where |
|---|---|---|
| 1 | **There is no way to write a file from JS in this tree.** No `react-native-fs`, no FS TurboModule, and `op-sqlite` exposes paths but no write API. Capture needs a new native module or a new dependency before a single byte can be appended. | §1 |
| 2 | **One egress class per stream, enforced in the type.** `modelio`, `validation`, `coaching` and `mutation` are classified "mixed" or misclassified in brief §2; a mixed stream can only be *filtered* at a ladder rung, and §4 says prune by deleting. Four streams split or reclassified. | §4 |
| 3 | **`runId` added to the correlation contract.** Brief §3 lists `sessionId`/`episodeId`/`taskId`/`seq`/two clocks. Without a per-process id you cannot separate the pre-crash process from the relaunch in the same day's file — which is the acceptance test. | §3.2 |
| 4 | **`todayISO` is a required field on every extraction record.** Not in any list. Without it every relative due date in the corpus ("next Tuesday") is unresolvable and task 31's date-bearing items are unusable. | §5.2 |
| 5 | **The `runtime` stream's thermal/battery/doze half has no source.** `thermalStatusSampler` defaults to `() => 0`, thermal is not readable from JS, and orientation §8 pins the sampler to task 19. Recommendation is to *not* build it here. | §4.3 |
| 6 | **`crisis` near-miss is undefined and I am not defining it.** It is a safety-intent call. Options and a recommendation in §12. | §12.3 |

---

## 1. 🔴 The blocker: nothing in this tree can write a file

Found while verifying brief §6 against the tree. Stated first because it is upstream of everything
else in this document, and because §5a of the brief specifies NDJSON on app-private external storage
as though the mechanism existed.

**Verified facts:**

- `package.json` dependencies are `@op-engineering/op-sqlite`, `llama.rn`, `react`, `react-native`,
  `react-native-safe-area-context`, `zod`. **No filesystem library.**
- `@op-engineering/op-sqlite`'s TurboModule spec (`src/NativeOPSQLite.ts`) exposes
  `IOS_DOCUMENT_PATH`, `IOS_LIBRARY_PATH`, `ANDROID_DATABASE_PATH`, `ANDROID_FILES_PATH`,
  **`ANDROID_EXTERNAL_FILES_PATH`**, `install()` and `moveAssetsDatabase()`. Path constants and a
  DB-asset mover. **No general write.**
- React Native core has no file-write API. `fetch('file://…')` reads; it does not append.
- The six-model spike's thermal JSONL was **not written by the app** — `src/dev/ModelBaseSpikeScreen.tsx`
  says so explicitly: *"thermal sensors cannot be read from JS without a native module, so
  `scripts/thermal-sampler.js` polls them host-side"* and the app's own output went out through
  `console.log` + `adb logcat` in tagged chunks. There is no precedent for in-app file writing
  because there has never been any.

### 1.1 The options

**A. A new app-owned TurboModule, `NativeCaptureLog`, with a *synchronous* append.** ⭐ recommended.

**B. Add `@dr.pogodin/react-native-fs`** (the maintained fork; the original is archived) and use
`appendFile`.

**C. `console.log` + `adb logcat`**, as the spike did.

### 1.2 Why A, and the mechanism

The brief's §5b is *"lossless means synchronous at the event"*, and the acceptance test is a
force-kill that loses nothing. Those two sentences select the mechanism, and only option A satisfies
them:

- **B is asynchronous, not buffered — and that distinction is smaller than it sounds but lands in
  exactly the wrong place.** `appendFile` returns a Promise and performs its `write(2)` on a native
  background executor. The window between `record()` returning and the bytes reaching the kernel is
  short (sub-millisecond to a few ms) but it is real, and the events that live in it are the ones
  immediately preceding a crash. The single most valuable capture this facility will ever take is
  the last few records before an uncatchable native death — constraint #3 documents that llama.cpp
  can kill this process with no JS error and no tombstone. Option B loses precisely those.
- **A is synchronous in the sense that matters.** A blocking TurboModule method that performs
  `write(2)` before returning means that when `record()` returns, the bytes are in the **kernel page
  cache**, which is owned by the kernel and not by the process. `am force-stop`, `kill -9`, and a
  native SIGSEGV all destroy the process without touching the page cache; the kernel writes it back
  to disk on its own schedule. **The durability boundary is process death, not power loss** — and
  process death is exactly what the acceptance test tests.
- **Precedent exists in this tree.** `src/specs/NativeEpisodeAlarm.ts` already declares
  `canScheduleExactAlarms(): boolean` — a synchronous TurboModule method, codegen'd and working on
  the S23 FE. Sync methods are a proven capability here, not a hope.
- **C is not a capture facility.** logcat truncates long lines (`ModelBaseSpikeScreen` chunks around
  it), has a ring buffer that drops under load, requires a host attached, and cannot survive a
  reboot. It was right for a spike and is wrong for this.

**No `fsync` per event.** An `fsync` on f2fs costs ~1–5 ms and buys only power-loss durability,
which is not what is being defended against. Recommendation: `fsync` on **episode boundaries and
`AppState` background transitions** — cheap, rare, and it bounds power-loss exposure to one episode.
State the boundary honestly in the report rather than claiming durability the design does not have.

**Cost of A, stated plainly:** one `src/specs/NativeCaptureLog.ts` codegen spec, one Kotlin module
(~120 lines: a `Map<String, FileOutputStream>` of open handles, `append`, `flush`, `elapsedRealtime`,
`sizeOnDisk`, `deleteStream`), and a rebuild. **`README_build.md` §4 / task 24 §9.6's `.cxx` trap
applies to the *first* build after `codegenConfig` is added, which already happened** — the
`-DREACT_NATIVE_APP_MODULE_PROVIDER` flag is in the cached configure. Adding a second spec to the
existing `jsSrcsDir` should not re-trigger it, but the runbook says `rm -rf android/app/.cxx` before
the first build anyway, because the cost of being wrong is a device session.

**Degradation, matching the alarm's precedent:** the binding uses `TurboModuleRegistry.get`, not
`getEnforcing`. Under Jest, or on a JS bundle running against an APK built before the module
existed, capture becomes a counted no-op — never a launch crash.

---

## 2. Shape of the thing

Newline-delimited JSON. One complete JSON object per line, written in a single `write()` call with
its trailing `\n` included in the same buffer, so a line is never torn by interleaving. Readers must
tolerate a truncated final line in a file (only reachable via power loss) and must ignore fields
they do not recognise (§9).

```
{"v":1,"seq":412,"run":"01J...","wallMs":1786... ,"monoMs":8123456,"stream":"modelio","type":"call","sessionId":"...","episodeId":"...","taskId":37,"surface":"task_extraction.v1", ...}
```

Every record is **envelope fields + stream payload**, flat, no nesting of the envelope. Flat because
every consumer (`jq`, `grep`, task 31's loader) filters on envelope fields first.

---

## 3. The correlation-ID contract

This is the part that cannot be re-collected if it is wrong.

### 3.1 Envelope fields — present on every record, every stream, no exceptions

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Record format version. §9. |
| `seq` | `number` | **Process-global**, starts at 1, increments once per `record()` call *across all streams*. |
| `run` | `string` | Per-process id, minted at module load. |
| `wallMs` | `number` | `Date.now()`. |
| `monoMs` | `number` | `SystemClock.elapsedRealtime()`, from the native module. |
| `stream` | `StreamName` | Which stream — also which directory. Redundant with the path, deliberately: a merged multi-stream file must stay self-describing. |
| `type` | `string` | The event type within the stream. |
| `sessionId` | `string \| null` | The `sessions` row id. Null outside a session (task input from the dashboard is the common case). |
| `episodeId` | `string \| null` | §3.3. |
| `taskId` | `number \| null` | |
| `dropped` | `{count, lastReason}?` | Present only on the first successful record after a failure. §7.2. |

### 3.2 Why `run`, which the brief does not list

After a force-kill the app relaunches and appends to the **same day's file**. Without a per-process
id, the pre-crash records and the post-crash records are one undifferentiated sequence with `seq`
restarting at 1 — so the file contains two records numbered 412 and no way to order them. The
acceptance test ("a force-kill mid-episode loses no event before the kill") is *unverifiable*
without it: proving no loss means proving the pre-kill `seq` run is contiguous, which first requires
knowing which records belong to that run.

`run` is also the join key for "what was this process's environment" — the `lifecycle.boot` record
(§5.10) carries the build, the schema version, the model path and the **set of streams compiled into
this build**, once per run rather than on every record.

### 3.3 `episodeId` is minted by capture, deterministically

There is no episode id in the database. `active_episode` is a **singleton by CHECK (`id = 1`)** —
`src/db/repositories/runtime.ts` — and the durable identity of an episode only appears at close, as
an `interactions` row.

```
episodeId = `${sessionId}#${taskId}@${startedAtMs}`
```

Deterministic, not minted-random, and that is load-bearing: `recoverOpenEpisode` at launch re-reads
the same `active_episode` row after a crash, so the recovered episode **derives the same
`episodeId`** and the post-crash records join to the pre-crash ones. A random id would make the
crash a permanent seam in the timeline — in the one case the whole facility exists to illuminate.

### 3.4 Why both clocks, and why `seq` on top of them

Three ordering mechanisms because each one fails somewhere the others do not.

- **`wallMs` is the only clock that joins to anything else.** The product DB stores wall-clock
  (`sessions.completed_at`, `interactions.timestamp`), `adb logcat` stamps wall-clock, and it is the
  only clock a human can reconcile with "that was Tuesday evening". It is also the only one that
  survives a reboot with meaning.
- **`wallMs` can move.** NTP steps it, the user can set it, and it is wrong between boot and first
  NTP sync. A backwards step mid-session makes a duration negative and an ordering wrong — and
  durations are the primary quantity tasks 17, 19 and 20 want out of this. *(The brief cites DST as
  the motivating scare; strictly, DST does not move epoch-ms — what bit task 36 was local-calendar
  arithmetic. The conclusion is right for a different reason, and the reason should be recorded
  correctly so nobody later "fixes" the wrong thing.)*
- **`monoMs` = `SystemClock.elapsedRealtime()`, not `performance.now()`.** `elapsedRealtime` counts
  across deep sleep (which `performance.now()` and `uptimeMillis` do not — and this app's entire
  hard problem is what happens while dozing), and it is **stable across process restarts within a
  boot**, so it orders the pre-crash and post-crash runs against each other. `performance.now()`
  resets per process and would be useless for exactly the case that matters. It resets at boot; a
  boot change is detectable as `monoMs` going backwards between runs, and `lifecycle.boot` records
  both clocks so the offset is always recoverable.
- **`seq` is the total order and the loss detector.** Neither clock has enough resolution to order
  two records in the same millisecond, and both can be wrong. `seq` is monotonic by construction and
  **process-global rather than per-stream** so that merging every stream for a run and sorting by
  `seq` yields the true interleaving — which is what "reconstruct the timeline end to end"
  (brief §8) actually requires.

**The consequence of a global `seq`:** a gap in one stream's file is normal. Loss is detected by
merging *all* streams for a `run` and looking for gaps in the union. Once task 42 removes the crisis
stream and task 43 removes the free-text streams, later builds will have permanent legitimate gaps —
which is why `lifecycle.boot` records the compiled-in stream set. **A gap analysis is only valid
against the stream set declared in that run's boot record.** This cannot be retrofitted, which is
why it is written down now.

---

## 4. The streams

### 4.1 The rule that shapes the table

> **Every stream has exactly one egress class and exactly one ladder fate. A stream that would need
> two is split into two streams.**

This is not tidiness. Orientation §5 settles that pruning happens by **dropping, not disabling**, and
brief §4 says removing a stream is deleting its module, its call sites and its directory. A stream
whose records are *partly* free-text cannot be dropped — it can only be **filtered**, field by field,
by code that must then be written, tested and trusted at every rung. Brief §2 classifies `modelio` as
"free-text (content) / structured (metadata)" and `coaching` as "mixed", and those two rows are
exactly the rows that would force task 43 to write a field-level scrubber instead of an `rm -rf`.

Splitting costs more directories. It buys: every ladder rung is a directory deletion plus a union
member deletion, and `tsc` then names every call site that has to go. That trade is the settled
decision, not my preference.

### 4.2 The table

**Free-text — everything here is dropped at open beta (task 43), except `crisis` which goes at
closed beta (task 42).**

| Stream | Contents | Fate |
|---|---|---|
| `conversation` | Every turn both directions, **verbatim** — user text exactly as typed, no trimming or normalisation. Turn kind tagged (§5.1). Carries `todayISO`. | dropped at open beta |
| `modeltext` | The composed `ChatMessage[]` **as sent**, and the **raw completion string before any parsing**, for every attempt of every call — constrained and unconstrained. | dropped at open beta |
| `mutationtext` | Before/after values of the free-text task fields only: `title`, `description`, `notes`. | dropped at open beta |
| `crisis` | Every `checkCrisis` hit, and near-misses per whatever §12.3 is ruled. | 🔴 **removed before closed beta** |

**Structured — all of these survive open beta.**

| Stream | Contents | Fate |
|---|---|---|
| `modelio` | Per model call and per attempt: `surface`, grammar id + hash + **slot values** (not the expanded grammar text), D10 rung, attempt index, `GenerationTimings`, `truncated`, model identity and tier, `maxTokens`, and `textRef` — the `seq` of the `modeltext` record holding the actual strings. | survives |
| `validation` | Every `LlmOutputValidationError`: `surface`, `issues[]`, which attempt, and `textRef` to the payload that failed. | survives |
| `mutation` | Field-level task changes: task id, field, non-text before/after values, actor (`user`\|`model`\|`system`), surface. Text fields carry `beforeLen`/`afterLen` and a `textRef` into `mutationtext`. | survives |
| `episode` | Session origin (`planned`\|`quickstart`), planned vs actual minutes, the five outcomes, `+5` presses, hyperfocus quanta, parks, skips, resulting `TailDirective`, crash recoveries, credit written. | survives |
| `planning` | Candidate pool **by task id** with per-factor scores, neglect multiplier, final score, chosen agenda, and both reject sets with reasons. | survives |
| `coaching` | Trigger type + `trigger_data`, queued row, the resolution union emitted, what the app dispatched, observed outcome. Any model-authored prose reaches `modeltext` via the ladder, not here. | survives |
| `runtime` | What JS can actually see — §4.3. | survives |
| `lifecycle` | Launch, boot record, startup grammar-guard result, crash-recovery firing, alarm scheduled/fired/missed with actual delta, migration runs. | survives |

**Twelve streams, twelve directories, twelve union members.** Ten in the brief; the three splits and
the reclassification are the difference.

### 4.3 🔴 `runtime` — most of what the brief asks for has no source

Brief §2: *"Thermal samples and tok/s alongside model calls, time-since-cold, battery/charging, doze
transitions."*

- **Thermal is a stub.** `TernaryBonsaiProvider`'s `thermalStatusSampler` defaults to `() => 0`
  (`src/llm/provider/ternaryBonsaiProvider.ts:56`), its own comment says it is *"wired to the native
  thermal API in Phase B"* and that never happened. Orientation §8 pins the thermal sampler to
  **task 19** ("assigned to 19 so it can't fall between them"), and §1 records that the spike read
  thermals **host-side over adb**.
- **Battery and doze transitions** need `BatteryManager` and a `PowerManager` listener — also native,
  also absent.
- **tok/s is already captured.** `GenerationTimings.predictedPerSecond` goes into `modelio` per call.
  Putting it in `runtime` as well duplicates it.
- **What JS genuinely has:** `AppState` foreground/background transitions (a usable doze *proxy*, and
  the thing that actually matters for "was the app alive"), time-since-process-start, and
  time-since-model-load (`modelHost` already times the load).

**Recommendation — do not build thermal in task 41.** Ship `runtime` with the JS-visible fields and
leave the thermal/battery fields as a declared, empty seam with task 19 named as the owner in the
code. For the findings report's own measurement, use `scripts/thermal-sampler.js` — it exists, it is
proven, and it is host-side.

**The argument on the other side, so it is a decision and not an omission:** the capture module is
already going to be Kotlin, and `PowerManager.getCurrentThermalStatus()` plus a `BatteryManager`
read is about thirty lines on top of it. It would also fill the provider's stubbed sampler, which is
a real product seam standing empty. **I am not doing it** because orientation §8 pins that work to
task 19 with a stated reason, and quietly absorbing another task's scope because it happens to be
cheap here is the shape of the problem task 45 exists to clean up. If Jason wants it, it is a
one-line ruling and about an hour. It is listed in §12.

**One consequence to price:** brief §7.5 wants measured capture overhead on the model path. On this
device tok/s drifts 8.3 → 5.8 cold-to-warm (orientation §8) and everything hits SEVERE by ~20 min —
a capture-on/capture-off comparison is **confounded by heat** unless thermal is sampled alongside.
The host-side sampler resolves this for the measurement without any in-app thermal, which is why the
recommendation lands where it does.

---

## 5. The event union

`src/capture/events.ts`. Exhaustive by construction: a new stream cannot be added without a
`STREAMS` entry, and a `STREAMS` entry cannot exist without an egress class and a ladder fate.

```ts
export type EgressClass = 'structured' | 'free_text';

export type LadderFate =
  | 'removed_before_closed_beta'   // task 42 Job A
  | 'dropped_at_open_beta'         // task 43
  | 'survives';

export const STREAMS = {
  conversation: { dir: 'conversation', egress: 'free_text',  fate: 'dropped_at_open_beta' },
  modeltext:    { dir: 'modeltext',    egress: 'free_text',  fate: 'dropped_at_open_beta' },
  mutationtext: { dir: 'mutationtext', egress: 'free_text',  fate: 'dropped_at_open_beta' },
  crisis:       { dir: 'crisis',       egress: 'free_text',  fate: 'removed_before_closed_beta' },
  modelio:      { dir: 'modelio',      egress: 'structured', fate: 'survives' },
  validation:   { dir: 'validation',   egress: 'structured', fate: 'survives' },
  mutation:     { dir: 'mutation',     egress: 'structured', fate: 'survives' },
  episode:      { dir: 'episode',      egress: 'structured', fate: 'survives' },
  planning:     { dir: 'planning',     egress: 'structured', fate: 'survives' },
  coaching:     { dir: 'coaching',     egress: 'structured', fate: 'survives' },
  runtime:      { dir: 'runtime',      egress: 'structured', fate: 'survives' },
  lifecycle:    { dir: 'lifecycle',    egress: 'structured', fate: 'survives' },
} as const satisfies Record<string, { dir: string; egress: EgressClass; fate: LadderFate }>;

export type StreamName = keyof typeof STREAMS;

/** What a call site passes. The envelope (§3.1) is stamped by record(); a call site never
 *  supplies v, seq, run, wallMs, monoMs, sessionId, episodeId or taskId. */
export type CaptureEvent =
  | ConversationEvent | ModelTextEvent | MutationTextEvent | CrisisEvent
  | ModelIoEvent | ValidationEvent | MutationEvent | EpisodeEvent
  | PlanningEvent | CoachingEvent | RuntimeEvent | LifecycleEvent;

export function record(event: CaptureEvent): void;   // src/capture/index.ts — the only entry point
```

The per-stream members follow. Field lists are the contract; types are TypeScript.

### 5.1 `ConversationEvent`

```ts
type ConversationEvent = {
  stream: 'conversation';
  type: 'turn';
  from: 'user' | 'coach';
  purpose: 'task_input' | 'coaching';
  trigger?: CoachingTrigger;          // coaching conversations only
  /** Structural, not inferred — see below. */
  kind: 'opening' | 'user' | 'recap_or_clarify' | 'clarify_answer' | 'reply' | 'crisis_referral';
  text: string;                       // VERBATIM. No trim, no normalisation, no truncation.
  todayISO: string;                   // §5.2
  queueEntryId?: number;
};
```

**On `kind`, and on not pretending to know more than the code does.** Brief §2 wants clarifying
questions and their answers tagged to match the fixtures' `clarify_answers`. The app cannot know
whether the model asked a question or recapped: `proseTurn` appends
`buildExtractionRecapInstruction()`, one instruction that means "recap **or** ask the one question"
(`chatController.ts:254`). So the tag is the **structural** fact — the coach turn that ran under the
recap-or-clarify instruction is `recap_or_clarify`, and the user turn that follows it is
`clarify_answer`. A heuristic ("did it end in a question mark") would be a guess written into the
permanent record as though it were observed. Task 31 does the semantic call at annotation time, with
the full text in front of it, which is where that judgment belongs.

### 5.2 🔴 `todayISO` — the field that is in nobody's list

`localTodayISO(deps.now())` is computed in `chatController` and threaded into
`assembleExtractionPrompt`, `validateTaskExtraction` and `extractionToTaskWrite`. Every relative date
the model resolves — "next Tuesday", "before it expires", "in three weeks" — resolves **against that
string**.

The seed fixture format carries it as a top-level `"today"` field
(`docs/eval/extraction_fixtures_seed.jsonl`). A captured conversation without it cannot be turned
into a fixture, cannot be replayed, and cannot be scored: the gold `due_resolved` is meaningless
without knowing what "today" was. Task 22's whole open question — *"from a Thursday the 4B read
'next Monday' as 11 days out"* — is unanswerable from a corpus that did not record the Thursday.

It goes on `conversation` turns and on `modelio` records for extraction surfaces. This is the
clearest example in the whole design of data that looks complete and answers nothing.

### 5.3 `ModelTextEvent` / `ModelIoEvent`

```ts
type ModelTextEvent = {
  stream: 'modeltext';
  type: 'call';
  messages: ChatMessage[];   // the composed array AS SENT, verbatim
  raw: string;               // the raw completion BEFORE any parse — brief §1's second instance
};

type ModelIoEvent = {
  stream: 'modelio';
  type: 'call';
  textRef: number;                     // seq of the modeltext record above
  surface: string;                     // 'task_extraction.v1' | 'prose.task_input' | ...
  constrained: boolean;
  grammarId: string | null;            // registry key
  grammarSha8: string | null;          // of the EXPANDED text actually handed to llama.cpp
  grammarSlots: Record<string, string[]> | null;   // buildGrammar's substitutions
  rung: 'first' | 'retry' | 'unconstrained_first' | 'unconstrained_retry';
  attempt: 1 | 2;
  maxTokens: number;
  temperature: number;
  topK: number;
  truncated: boolean;
  timings: GenerationTimings | null;
  model: { path: string; tier: ModelTier; nCtx: number; nThreads: number };
  latencyMs: number;                   // measured around generateResponse, wall
  outcome: 'ok' | 'parse_failed' | 'validation_failed' | 'truncated' | 'threw';
  todayISO?: string;                   // extraction surfaces
};
```

**Why grammar id + hash + slots, not the grammar text.** `task_extraction.v1.gbnf` is 5,090 bytes.
Recording it per attempt would roughly triple `modelio` to store a constant that is in the repo. The
hash proves *which* text was used (including task 37's fix landing), and the slots are the only part
that varies per call. If the hash ever fails to match a known grammar, the text is recoverable from
git by commit — which `lifecycle.boot` records.

**One record per attempt, not per call.** The D10 ladder runs up to two attempts and the second is
frequently the interesting one. `attempt` + `rung` + a shared `episodeId`/`seq` neighbourhood tie
them together.

**On verbatim `messages`, and the volume it costs.** The composed array for turn *N* contains the
system prompt, the field guide and turns 1..*N*−1, so a six-turn conversation stores the static
prefix six times. The obvious fix is content-addressing the static prefix and storing a hash. **I am
recommending verbatim anyway for alpha:** brief §7.5 demands *measured* volume, §5d asks for a stated
cap, and the projection in §8 puts a session at ~100 KB — optimising a quantity nobody has measured,
at the cost of making the corpus a join instead of a read, is the wrong order of operations.
Content-addressing is the lever to pull if the measurement says so, and pulling it later is a `v`
bump, not a re-collection.

### 5.4 `ValidationEvent`, and widening the error

```ts
type ValidationEvent = {
  stream: 'validation';
  type: 'failure';
  textRef: number;          // seq of the modeltext record whose `raw` failed
  surface: string;
  issues: string[];
  attempt: 1 | 2;
  errorKind: 'validation' | 'parse' | 'truncated' | 'other';
  errorMessage: string;
};
```

`LlmOutputValidationError` (`src/llm/errors.ts`) gains an optional payload:

```ts
export class LlmOutputValidationError extends Error {
  readonly surface: string;
  readonly issues: string[];
  /** The raw completion text that failed. Optional so every existing construction site compiles. */
  readonly payload?: string;
  constructor(surface: string, issues: string[], payload?: string);
  /** Returns a copy carrying the raw text. runAttempt calls this at the catch, where the raw
   *  text is in scope and the error is not yet. */
  withPayload(raw: string): LlmOutputValidationError;
}
```

`runAttempt` (`ladder.ts:94`) currently does `catch (err) { return { response, ok: false, error: ... } }`
and the malformed generation dies there. It becomes `error: enrich(err, response.text)`.

**This is a product fix, not a capture fix, and it should be built as one.** The value is that the
error carries the payload to *whoever catches it* — `LadderResult.error` propagates out to
`resolveCoaching` and `chatController` and is currently uninspectable. Capture is one consumer of
that, not the reason for it. Task 37's grammar hole — a bare `","` passing as a schema-valid title —
becomes one line in `validation` the first time it fires.

### 5.5 `MutationEvent` / `MutationTextEvent`

```ts
type MutationEvent = {
  stream: 'mutation';
  type: 'task' | 'recurrence' | 'dependency' | 'create' | 'delete';
  entityId: number;
  field: string;                        // domain field name, camelCase, matching src/types/domain.ts
  before: string | number | boolean | null;   // structured fields only
  after:  string | number | boolean | null;
  textRef?: number;                     // set instead, for title/description/notes
  beforeLen?: number;
  afterLen?: number;
  actor: 'user' | 'model' | 'system';
  surface: string;                      // 'editor' | 'chat_extraction' | 'coaching_dispatch' |
                                        // 'recurrence_sweep' | 'completion_fold' | 'episode_close'
};
```

**Why `mutation` could not stay "structured, survives" as brief §2 has it.** A task title is
free text the user typed. A mutation stream that records `title: "call Dr Havers about mum's
scan results"` is not a structured stream, and shipping it past open beta under a "structured
survives" label would be exactly the silent expiry task 42's brief warns about. Splitting the text
out is what lets the *rest* of mutation — which is real signal for tasks 17 and 19 — survive.

**Where the actor comes from, and why no call site is told.** `appServices.ts` is the single
composition point for the dependency graph. Rather than passing an actor through every repository
call, capture wraps the repository **per consumer bundle**, because the wiring is where the knowledge
already lives:

```ts
episode:   episodeDepsFrom(withMutationCapture(repos, 'system', 'episode_close'), alarm)
recurrence: recurrenceDepsFrom(withMutationCapture(repos, 'system', 'recurrence_sweep'))
chat.dispatch:      withMutationCapture(repos, 'model', 'coaching_dispatch')
chat.tasks:         withMutationCapture(repos, 'model', 'chat_extraction')
tasks (editor):     withMutationCapture(repos, 'user',  'editor')
```

`tasks.update(id, patch)` does not read the prior row (`tasks.ts:190`), so `before` requires a
`getById` first. That read lives **in the wrapper**, not in the repository — one extra indexed
primary-key read per mutation, and zero lines added to `src/db/`. Removing the mutation stream is
deleting the wrapper module and unwrapping five expressions in one file.

⚠ **A judgment I am flagging rather than burying:** task creation through the chat is attributed
`actor: 'model'`, `surface: 'chat_extraction'`. The user asked for the task; the *field values* —
duration, energy, recurrence, tags — were chosen by the model, and those are what tasks 17/19/31 are
measuring. Brief §6 says "the editor is `user`" and does not rule on chat creation. Attributing it
`user` would credit the model's guesses to the user, which is the same error shape as ruling 5's
quick-start confounder. Ruling welcome.

### 5.6 `EpisodeEvent`

```ts
type EpisodeEvent = {
  stream: 'episode';
  type: 'session_start' | 'session_close' | 'session_lapse'
      | 'start' | 'pause' | 'resume' | 'boundary_reached'
      | 'extend_short' | 'extend_hyperfocus'
      | 'complete' | 'park' | 'skip' | 'escape'
      | 'recover';
  origin: 'planned' | 'quickstart';     // ruled 2026-08-07, task 44 — also sessions.origin
  blockKind?: EpisodeBlockKind;
  plannedMinutes?: number;
  actualMinutes?: number;
  workedMs?: number;
  pausedMs?: number;
  pauseCount?: number;
  hyperfocusQuanta?: number;
  shortExtensions?: number;
  outcome?: EpisodeOutcome;
  tail?: TailDirective['kind'];
  interactionId?: number;               // the join back to the product DB
  creditMinutes?: number;               // recovery credit
  recoveryDirective?: RecoveryDirective['kind'];
  coachingEnqueued?: Array<{ trigger: CoachingTrigger; kind?: string }>;
};
```

`origin` is on every session-scoped record per brief §2 and task 44 ruling 5. Note it now exists in
**both** stores by Jason's 2026-08-07 ruling — `sessions.origin` is the permanent one, capture's copy
is the diagnostic one, and capture must never become the thing task 17 reads.

`interactionId` is the deliberate join key: it is the one id shared between capture and the product
database, so a corrupted-DB investigation can go the other way too.

### 5.7 `PlanningEvent`

```ts
type PlanningEvent = {
  stream: 'planning';
  type: 'selection_boundary' | 'plan' | 'replan';
  poolSize: number;
  eligible: Array<{ taskId: number; factors: Record<string, number>;
                    neglectMultiplier: number; score: number }>;
  capabilityRejects: Array<{ taskId: number; reason: string }>;
  dependencyRejects: Array<{ taskId: number; blockedBy: number[]; reason: string }>;
  agenda: Array<{ taskId?: number; kind: string; plannedMinutes: number; deepFocus?: boolean }>;
  checkIn: { sessionType: SessionType; sessionMinutes: number;
             energy: number; contexts: string[]; tools: string[] };
  replanReason?: 'escape_valve' | 'break_overrun' | 'hyperfocus_extend';
};
```

**Task ids only, never titles** — which is what keeps this stream genuinely structured and lets it
survive open beta. `runSelectionBoundary` already returns all three sets
(`planner.ts:95`); brief §6 is right that it just never persists them. This is the cheapest stream in
the design.

### 5.8 `CoachingEvent`

```ts
type CoachingEvent = {
  stream: 'coaching';
  type: 'enqueued' | 'opened' | 'resolution' | 'dispatched' | 'closed' | 'abandoned';
  trigger: CoachingTrigger;
  triggerKind?: string;                 // trigger_data.kind — 'repeated_extension' etc.
  queueEntryId?: number;
  urgency?: string;
  candidateTaskIds?: number[];
  action?: string;                      // the resolution union's action
  actionFields?: Record<string, string | number | boolean | null>;  // enum/numeric only
  dispatchOutcome?: string;
  ladder?: 'ok' | 'fallback' | 'crisis';
};
```

Reclassified mixed → structured. The free text a coaching conversation produces is (a) the
conversation itself, already in `conversation`, and (b) the model's raw resolution output, already in
`modeltext` via the ladder. Nothing is lost by the reclassification; what is gained is that coaching
outcomes — which tasks 17 and 19 want — survive open beta.

### 5.9 `CrisisEvent`

```ts
type CrisisEvent = {
  stream: 'crisis';
  type: 'hit' | 'near_miss';
  text: string;                  // verbatim — the whole point for task 21
  patternIndex?: number;         // which CRISIS_PATTERNS entry fired
  surface: 'chat_send' | 'coaching_resolution';
  purpose: 'task_input' | 'coaching';
};
```

Near-miss semantics are **not decided here** — §12.3. `CRISIS_PATTERNS` is currently module-private
in `src/services/coaching/crisis.ts`; whatever is ruled, the matching logic lives in
`src/capture/streams/crisis.ts` and not in the detector, so that deleting the stream cannot alter
detection. The detector is product behaviour and a hard beta gate in its own right (task 21); only
its logging is removable, per brief §4.

### 5.10 `RuntimeEvent` and `LifecycleEvent`

```ts
type RuntimeEvent = {
  stream: 'runtime';
  type: 'app_state' | 'model_load' | 'sample';
  appState?: 'active' | 'background' | 'inactive';
  msSinceProcessStart?: number;
  msSinceModelLoad?: number;
  modelLoadMs?: number;
  // ── seam, unimplemented, owner task 19 (orientation §8). Absent, not null. ──
  thermalStatus?: number;        // PowerManager 0..6
  skinC?: number;
  batteryLevel?: number;
  charging?: boolean;
};

type LifecycleEvent = {
  stream: 'lifecycle';
  type: 'boot' | 'launch' | 'grammar_guard' | 'crash_recovery'
      | 'alarm_scheduled' | 'alarm_fired' | 'alarm_missed' | 'migration' | 'capture';
  // boot only — once per run:
  build?: { version: string; debug: boolean };
  schemaVersion?: string;
  modelPath?: string;
  streamsCompiled?: StreamName[];        // §3.4 — a gap analysis is only valid against this
  formatVersion?: 1;
  bootWallMs?: number; bootMonoMs?: number;
  // grammar guard:
  grammarEnabled?: boolean;
  grammarFailures?: Array<{ surface: string; error: string }>;
  // alarm (constraint #13 — the 11 ms measurement's permanent home):
  scheduledAtMs?: number; firedAtMs?: number; deltaMs?: number; exactAllowed?: boolean;
  // migration:
  fromVersion?: string; toVersion?: string; migrationMs?: number;
  // capture's own health (§7.2):
  droppedTotal?: number; lastDropReason?: string; bytesOnDisk?: number;
};
```

The alarm fields deserve a note: task 24 measured the alarm at **11 ms late** by hand in a device
session, and orientation §9 still carries "overnight-doze alarm delivery — inferred, never measured
to completion". With `alarm_scheduled`/`alarm_fired`/`alarm_missed` in the log, that residue item
answers itself from the first overnight run, with no instrumented build.

---

## 6. On-disk layout — the contract task 42 tests against

```
/sdcard/Android/data/com.todoai/files/capture/          ← ANDROID_EXTERNAL_FILES_PATH + '/capture'
  conversation/2026-08-14.ndjson
  modeltext/2026-08-14.ndjson
  mutationtext/2026-08-14.ndjson
  crisis/2026-08-14.ndjson                              ← task 42 Job A deletes this directory
  modelio/2026-08-14.ndjson
  validation/2026-08-14.ndjson
  mutation/2026-08-14.ndjson
  episode/2026-08-14.ndjson
  planning/2026-08-14.ndjson
  coaching/2026-08-14.ndjson
  runtime/2026-08-14.ndjson
  lifecycle/2026-08-14.ndjson
```

**Rules, and each one is load-bearing for someone:**

1. **One directory per stream, named exactly `STREAMS[name].dir`.** Task 42 §3.3 enumerates these
   paths to prove a stream is empty; it can only do that against a document, and this is it.
2. **`capture/` is a directory capture owns entirely.** Nothing else writes there. Removing all of
   capture is removing that directory and `src/capture/`.
3. **Day partition by LOCAL calendar date**, via the same `localTodayISO` convention already used in
   `chatController`. Not UTC: a human asking for "yesterday's session" means their yesterday, and
   `adb pull capture/modelio/2026-08-14.ndjson` should be the obvious command. Records carry
   `wallMs` regardless, so nothing depends on the filename.
4. **Append-only. Never rewritten, never compacted in place, never edited.** Rotation deletes whole
   day directories (§8), never parts of a file.
5. **A file may end in a partial line.** Only reachable through power loss (§1.2). Readers skip a
   trailing line that does not parse; they must **not** skip a mid-file line that does not parse —
   that is a bug and should be reported loudly by the tooling.
6. **`ANDROID_EXTERNAL_FILES_PATH` from `op-sqlite`**, not a hard-coded string — the same constant
   the DB path comes from, so there is one notion of where the app's storage is (constraint #10).

---

## 7. Failure behaviour

### 7.1 It never propagates

```ts
export function record(event: CaptureEvent): void {
  try { /* stamp envelope, serialise, native append */ }
  catch (err) { dropped.count++; dropped.lastReason = String(err); }
}
```

`void` return, so no call site can accidentally start depending on it. Every call site is a
statement, never an expression. If the native module is absent (Jest, an older APK), the writer is a
no-op that counts.

### 7.2 It never goes silent

Two mechanisms, because one of them is only readable after the fact:

1. **`dropped` on the envelope.** The next *successful* `record()` after any failure carries
   `dropped: { count, lastReason }` and resets the counter. Brief §5c, exactly as written.
2. **A `lifecycle.capture` record** with `droppedTotal` and `bytesOnDisk`, written at every
   `AppState` background transition and at session close. Mechanism 1 fails in the one case that
   matters most — *no* subsequent write succeeds, because the disk is full — and then the counter
   dies with the process. Mechanism 2 does not fix that either, but it bounds the unreported window
   to one background transition and gives the tooling a running total to reconcile against.

**And the honest limit, which belongs in the record:** if the very first write of a run fails and
every subsequent one does too, nothing is logged about it anywhere on the device. `pull-capture.js`
(§10) therefore reports **runs with no boot record** as a distinct, loud condition. A silently lossy
logger produces confident wrong conclusions; this design can still be lossy, and the tooling's job is
to make that visible rather than to claim it cannot happen.

### 7.3 Ordering under concurrency

JS is single-threaded and `record()` is synchronous end to end, so `seq` assignment and the `write()`
cannot interleave. There is no lock, and none is needed. Worth stating because it is the property
that would silently break if anyone later made the append async "for performance" — a comment in
`record.ts` will say so.

---

## 8. Size, rotation, and the task 14 tension

### 8.1 Projected volume — projected, and labelled as such

From measured artifact sizes: `task_extraction.v1.gbnf` is 5,090 B (not stored — §5.3); the prompt
sources total ~20 KB of which perhaps 7 KB composes into a real extraction call; a 200-token
completion is ~800 B.

| Stream | Per session (projection) |
|---|---|
| `modeltext` | ~80 KB (≈10 model calls × ~8 KB, dominated by the re-sent conversation prefix) |
| `modelio` + `validation` | ~5 KB |
| `conversation` | ~2 KB |
| `episode` + `planning` + `mutation` + `coaching` + `lifecycle` + `runtime` | ~15 KB |
| **Total** | **~100 KB / session** |

At 2–3 sessions a day: **~250 KB/day, ~8 MB/month, ~90 MB/year.** On a device whose binding
constraint is heat and whose model file is 1.02 GiB, that is not a problem.

**This is a projection, not a measurement, and the findings report replaces it with the real number
from the S23 FE.** If it is off by 5× it is still fine; if it is off by 50× the design changes and
§5.3's content-addressing lever is the first thing to pull.

### 8.2 Cap and rotation

- **Ceiling: 512 MB** across `capture/`, checked at the `lifecycle.capture` write (background /
  session close), not per append.
- **Over the ceiling, delete whole oldest day directories** until under. Never the newest — the
  newest is what you are debugging.
- **No per-file cap.** Day partitioning already bounds files; a mid-file rotation would create a
  torn-record class of bug for no benefit.

### 8.3 The task 14 tension, resolved explicitly

Task 14 blocks *sessions* on insufficient space. Capture blocking the app is unacceptable — a logger
that can stop you working is worse than no logger.

> **Capture degrades where the product database blocks.** On `ENOSPC` or any other write failure,
> `record()` counts the drop and returns; the app never learns. Capture is never a reason a session
> cannot start.

And the direction nobody has stated: **capture's own ceiling exists so that capture cannot be the
cause of the no-space condition that blocks task 14.** 512 MB is a bound task 14 can reason about.
Task 14 should treat `capture/` as reclaimable space — that is a handoff, not a decision made here.

---

## 9. The versioning rule

**`"v": 1` on every record**, matching the `learning_data` convention documented at
`src/types/domain.ts:409–414` (*"any writer of that shape must embed an internal `"v": 1` field at
the top level … so future readers can branch on version"*).

The rule, stated so tooling can be written against it:

1. **`v` is global across streams, not per-stream.** A reader that must handle a matrix of
   per-stream versions is worse than one that handles a short ordered list of global ones. Bumping
   `v` for a change to `modelio` costs nothing to a reader that only cares about `conversation` —
   it just widens the accepted set.
2. **Adding an optional field does NOT bump `v`.** Consumers must ignore unknown fields.
3. **Removing a field, renaming one, or changing the meaning or units of an existing one DOES bump
   `v`.** Adding a *required* field bumps.
4. **Adding or removing a stream does not bump `v`.** The stream set is a build fact and is recorded
   in `lifecycle.boot.streamsCompiled` — so the ladder's prunings are legible without a version
   change, which is what keeps 42 and 43 from having to touch the format at all.
5. **`v` is per-record. A file may contain more than one `v`** — an app upgrade mid-day guarantees
   it. Tooling reads records, not files.
6. **Old versions are never rewritten.** No migration, ever. Readers branch.

---

## 10. The redaction seam and its named consumer

Per brief §5e and the 2026-08-07 ruling: **capture writes raw, locally, and the seam is at the export
boundary, not at `record()`.** Nothing leaves the device from `record()`; there is nothing to redact
at write time, and putting a scrubber there would mean the raw material task 31 needs is destroyed
before it is ever read.

**The seam is in `scripts/pull-capture.js`**, which is the only egress path:

```
node scripts/pull-capture.js --stream modelio --since 2026-08-01 --session <id> --out ./local/
                             --anonymize <module>     ← declared, unimplemented, owner: task 42 §4b
```

The script reads `STREAMS` for the egress class of each stream and:
- **`structured`** — pulls freely.
- **`free_text`** — refuses to pull without an explicit `--anonymize` module **or** an explicit
  `--raw-i-am-jason` acknowledgement. In alpha the second flag is the normal path and that is correct
  (the subject is the developer). The point is that the *shape* of the gate exists now, so task 42
  implements a transform rather than inventing a pipeline.

Three things that must stay in the record, from orientation §5 and task 43 §4, repeated here because
this is the document the egress tooling will be written against:

1. **Anonymising free text is best-effort and unsolvable.** "Anonymized" never means "safe to
   publish."
2. **Re-identification by combination is the real risk** — a task list is close to a fingerprint with
   every proper noun stripped. That is why open beta drops free text *structurally*.
3. **Structured streams anonymise essentially completely and free text does not**, and that asymmetry
   is what makes the ladder principled rather than arbitrary.

---

## 11. Removability — what deleting a stream actually costs

The proof case is `crisis` (task 42 Job A). The full change:

1. `rm src/capture/streams/crisis.ts`
2. Remove one line from `STREAMS` in `src/capture/streams.ts`
3. Remove `CrisisEvent` from the `CaptureEvent` union in `src/capture/events.ts`
4. **`npx tsc --noEmit` now names every call site.** There are two, both in `chatController.ts`.
   Delete those two statements.
5. `rm -rf` the `capture/crisis/` directory on device (and it never reappears — nothing creates it).

**Step 4 is the mechanism, and it is why the union is exhaustive rather than a `type: string` on a
firehose.** You do not grep for a stream's call sites; the compiler enumerates them, and it cannot
miss one. That is what makes "verified, not asserted" achievable for task 42 — its §3.1 bundle-grep
becomes a confirmation of something the type system already proved, rather than the only evidence.

The same five steps remove `conversation`, `modeltext` and `mutationtext` at open beta. Nothing about
them is special-cased.

**What is deliberately absent:** any enable/disable flag. Brief §4 rules that out and orientation §5
agrees — a disabled module is something a later change re-enables by accident. *(Streams surviving
into beta do get runtime controls; those are task 42 Job B's user-facing consent controls, and they
are not this. A consent toggle is a user's decision about their own data; a developer flag standing
in for deletion is a stream that is still there.)*

**Where capture touches instrumented code, exhaustively.** Call sites pass data and know nothing
else, with one unavoidable exception:

| | What the instrumented code sees |
|---|---|
| Everywhere | one `record({...})` statement |
| `sessionController.startSession` / `closeSession` | + `captureContext.setSession(id, origin)` |
| `episodeService.startEpisode` / the four closes | + `captureContext.setEpisode(...)` |
| `appServices.ts` | five repository expressions wrapped |

**Why an ambient context and not threaded parameters.** `chatController` has **no `sessionId` and no
episode** — its deps are `{model, tasks, recurrence, coaching, dispatch, now}`. Threading correlation
ids into it means changing its constructor signature, `App.tsx`'s wiring and its whole test suite, to
carry data it has no other use for. That is capture diffusing into the code it instruments, which is
the thing §4 forbids. The ambient frame is safe here for a structural reason, not a hopeful one:
**there is exactly one active session and, by database CHECK, exactly one `active_episode` (id = 1)**,
and JS is single-threaded. The ambient value cannot be ambiguous because the app cannot have two.

---

## 12. Open for Jason — decisions I am not making

### 12.1 The storage mechanism (§1) — a new TurboModule vs. a new dependency

**Recommendation: the TurboModule.** The whole acceptance test rests on synchrony, and a Promise-based
`appendFile` loses the last few events before a native crash — the ones capture exists for. Cost is
one Kotlin file and a rebuild. Say no and the honest consequence is that "lossless" becomes "loses
the final few events at a crash", which should then be written into the brief rather than left as an
implied property.

### 12.2 The four stream splits (§4.1)

**Recommendation: split.** Twelve streams instead of ten, and every ladder rung becomes `rm -rf` +
delete a union member. The alternative is that task 43 writes a field-level scrubber for `modelio`
and `mutation`, which contradicts "prune by dropping, not disabling" and puts a filter in the path of
the most sensitive data at the exact rung where nobody is reviewing it any more.

### 12.3 🔴 What "near-miss on the phrase list" means

Undefined in the brief, and I am not defining it — it is a safety-intent call and the stream is the
most sensitive one in the design. Three options:

- **(a) Nothing.** Log only `checkCrisis` hits. Task 21 reviews precision but gets no evidence about
  what the detector *missed*, which is the failure mode that matters.
- **(b) A second, deliberately looser watch-list**, maintained in `src/capture/streams/crisis.ts`
  (never in the detector), matching bare distress words the real gate excludes on purpose —
  "hopeless", "can't go on", "pointless", "worthless", "give up". Anything it matches that the gate
  did not is logged as `near_miss`. Over-triggers hugely by design; a human reads them.
- **(c) Log every turn that the gate cleared**, and let task 21 read the lot. Maximum evidence,
  and it makes `crisis` a duplicate of `conversation` with the sensitivity of neither reduced.

**Recommendation: (b).** It is the only one that produces evidence about **false negatives**, which
is the asymmetric error the detector's own comment says it is built around ("a false negative hands a
person in crisis a task suggestion"). The watch list lives in the capture module and never in
`crisis.ts`, so deleting the stream cannot change detection by one character. (c) is not worth it —
during alpha `conversation` already has every turn, so (c) buys nothing and doubles the exposure.

### 12.4 The `runtime` thermal seam (§4.3)

**Recommendation: don't build it here.** Orientation §8 pins the thermal sampler to task 19 with a
stated reason; use `scripts/thermal-sampler.js` host-side for the findings report's measurement.
Overrule me if you'd rather have it in-app now — it is ~30 lines on a module we are writing anyway
and it would also fill `TernaryBonsaiProvider`'s stubbed sampler.

### 12.5 Actor attribution for chat-created tasks (§5.5)

`actor: 'model'` / `surface: 'chat_extraction'`, or `actor: 'user'`? I recommend `model`, because the
field values being measured were chosen by the model. Brief §6 rules on the editor and dispatch and
sweeps but not on this one.

### 12.6 Retention (brief §9)

**Recommendation: keep everything, with the 512 MB ceiling as a backstop.** ~90 MB/year projected. The
findings report replaces the projection with a measurement and this can be revisited then; the
ceiling means the question can never become urgent.

---

## 13. Integration points — re-verified against `a5d4107`

Brief §6 said to check them again because the tree moves. All present; four notes.

| Brief §6 | State |
|---|---|
| `ladder.ts → runConstrained()` | ✅ `ladder.ts:105`. `LadderResult` carries `raw`, `attempts`, `response`. |
| `runAttempt()` drops the failed payload | ✅ Confirmed, `ladder.ts:94`. §5.4. |
| `types.ts → LLMProvider.generateResponse()` | ✅ `types.ts:69`. Single generation entry point — instrumenting it catches `runUnconstrained` too. |
| `runUnconstrained` | ⚠ **Not in `ladder.ts`.** It is a private function inside `chatController.ts:334`. Brief §6's claim that instrumenting `generateResponse` catches it is correct; its *location* is not where the brief implies. Its rung labels differ from the D10 ladder's, hence `modelio.rung`'s four values. |
| `chatController.ts` — `send()`, `checkCrisis`, `saveTask()` | ✅ Lines 206, 220, 274. |
| `episodeService.ts` — the ten entry points | ✅ All exported async functions, all present. |
| `planner.ts → runSelectionBoundary()` | ✅ `planner.ts:95`, returns `eligible` / `capabilityRejects` / `dependencyRejects`. Never persisted. Brief is right: nearly free. |
| `src/db/repositories/*`, `recurrence/advance.ts`, `taskCompletion.ts`, `services/coaching/` | ✅ All present. `tasks.update` does not read the prior row — §5.5. |
| `LlmOutputValidationError` | ✅ `errors.ts:8`, carries `surface` + `issues` only. |

**Also verified, and outside the brief:**

- **`main` at `a5d4107` is green.** `npx jest` 136 suites / 1588 tests passing; `npx tsc --noEmit`
  clean; `npx eslint .` 0 errors, 56 warnings. This is the run orientation §2 flags in red as never
  having happened.
- ⚠ **The test count is inflated by a stale git worktree.** `.claude/worktrees/interesting-shirley-e10fa1`
  is a checked-out worktree at `d3ead86` (detached) *inside the project*, and jest collects its tests
  too — 1588 ≈ 2 × the expected 794. The `src/` suite is the real one and it passes; the duplicate
  doubles the runtime and means "1588 tests green" is a statement about two different commits. A
  `testPathIgnorePatterns` entry for `.claude/` would fix it. Not mine to change without a ruling —
  flagged.
- **`jest.setup.js`'s op-sqlite stub will need `ANDROID_EXTERNAL_FILES_PATH`.** The real package
  destructures its path constants out of `NativeModules.OPSQLite.getConstants()` **at module import
  time** (`@op-engineering/op-sqlite/src/index.ts:22`), and the stub currently supplies only
  `ANDROID_DATABASE_PATH`. One line, but it fails at import rather than at use, which reads like an
  unrelated breakage.
- **`sessions.origin` / migration 007 (task 44, ruled 2026-08-07) is not in the tree yet.** Migrations
  stop at `006_recurrence_period`. The `episode` stream's `origin` field is designed to it; if 44
  lands after 41, capture reads the value from the session controller either way and nothing here
  changes.

---

## 14. The acceptance test, written before the implementation

Brief §8: *"a deliberate force-kill mid-episode loses no event before the kill. Buffering bugs
surface nowhere else."* Two tests, and neither substitutes for the other.

### 14.1 Headless, automatic, in the suite

`src/capture/__tests__/forceKill.test.ts` + a child-process harness:

1. Parent spawns a Node child running the **real** `record()` path over a Node `fs` writer double.
2. Child appends events as fast as it can, printing each `seq` to stdout as it *returns* from
   `record()`.
3. Parent `SIGKILL`s the child at a random point after a random delay.
4. Parent asserts: **every `seq` the child reported as returned is present in the file**; the `seq`
   run is **contiguous with no gaps**; **every line parses**; and the file does not end mid-line.
5. Fifty iterations with randomised timing.

**What it proves:** the protocol. Synchronous-at-the-event, `seq` contiguity, one complete line per
`write()`, no torn records. A buffering regression fails it immediately, which is the point of
writing it first.

**What it does not prove, stated so nobody over-reads a green:** it exercises the Node writer, not
the Kotlin one. Node's `fs.writeSync` and Kotlin's `FileOutputStream.write` have the same semantics
here, but "the same semantics" is a desktop inference, and this project's own habit is that
[the device is ground truth](../coordinator_handoff_todoAI.md).

### 14.2 On the S23 FE — Jason's run

1. Start a session, run an episode past the first model call.
2. `adb shell am force-stop com.todoai` mid-episode.
3. Relaunch, let crash recovery run, close the session.
4. `node scripts/pull-capture.js --since <today>` and check:
   - the pre-kill `run`'s `seq` sequence is contiguous from 1 with no gaps;
   - the last user action performed before the kill is present in the log;
   - `lifecycle.boot` exists for both runs, and the second run's `crash_recovery` record derives the
     **same `episodeId`** as the first run's `episode.start` (§3.3);
   - `dropped` appears nowhere, or appears with a reason that is understood.

`am force-stop` is the right instrument: it kills the process without a graceful shutdown, which is
what a real crash does, and it does not touch the kernel page cache — so a pass means the design's
durability claim (§1.2) holds exactly as stated, and a fail means it does not.

---

*Written for task 41 Phase 1. Nothing here is implemented. §12 needs rulings before Phase 2.*
