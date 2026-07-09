# todoAI — Build & Environment (README_build)

Practical setup notes for building and running **todoAI** on-device. This is the build/toolchain companion to the default `README.md` (which is stock React Native boilerplate). Scope right now: **personal build, Android only**, on a Windows dev host. iOS is deliberately deferred (see *Platform scope*). Spec of record: `ADHD_Task_Management_App_Specification_v2.2.md`.

---

## Platform scope (read first)

- **Android only, for now.** The goal is a working personal build for one user, then a small test group. iOS is a deliberate *not-yet* — deferred until public deployment with a clear profit model. The `ios/` folder from the RN scaffold is left untouched; don't spend time on it.
- **Target device (validated):** Samsung Galaxy S23 FE — Snapdragon 8 Gen 1, Adreno 730, 8 GB RAM. This is the one device the model has actually been proven on (see *Model runtime*).
- **Device envelope is otherwise open.** `minSdkVersion` is 24 (Android 7.0) from the scaffold, but that is *not* a realistic floor for an on-device LLM — RAM and CPU for the 4B model will set the true minimum. This only matters once you go past your own phone to the test group; note it and move on for now.

---

## Confirmed toolchain versions

These are the versions currently pinned in the repo (`package.json`, `android/build.gradle`). Treat them as the known-good set; change deliberately, not via `audit fix` (see *Gotchas*).

| Piece | Version |
|---|---|
| Node | ≥ 22.11.0 (required by `engines`) |
| React Native | 0.86.0 |
| React | 19.2.3 |
| New Architecture | **on** (default in RN 0.86 — required by `llama.rn`) |
| Hermes | on (RN 0.86 default) |
| `@react-native-community/cli` | 20.1.0 |
| TypeScript | ^5.8.3 |
| ESLint / Prettier | ^8.19.0 / 2.8.8 |
| Kotlin | 2.1.20 |
| Android compile/target SDK | 36 |
| Android minSdk | 24 (see caveat above) |
| Build tools | 36.0.0 |
| NDK | 27.1.12297006 |
| applicationId / namespace | `com.todoai` |

**Not yet installed:** `llama.rn`. The spike validated `llama.rn` **0.12.5** (stock/prebuilt, no custom native build). Add it when you start the runtime work:

```sh
npm install llama.rn@0.12.5
```

There is no CocoaPods/`pod install` step while iOS is deferred; on Android `llama.rn` autolinks.

---

## First-time setup (Windows → Android device)

1. **Node ≥ 22.11.0** installed and on `PATH`.
2. **JDK 17** (RN 0.86 / AGP expectation). Set **`JAVA_HOME`** explicitly — see *Gotchas*; this bites on Windows.
3. **Android Studio** with SDK Platform 36, Build-Tools 36.0.0, and NDK 27.1.12297006 installed via the SDK Manager. Set `ANDROID_HOME` and put `platform-tools` on `PATH` (for `adb`).
4. **Enable USB debugging** on the S23 FE; confirm with `adb devices` (device should show as `device`, not `unauthorized`).
5. Install JS deps:
   ```sh
   npm install
   ```
6. Start Metro in one terminal:
   ```sh
   npm start
   ```
7. Build + install to the connected device in a second terminal:
   ```sh
   npm run android
   ```

If the app launches on the device and Fast Refresh works, the base toolchain is good.

---

## Gotchas already paid for (don't rediscover these)

These cost real time during the spike. They are the whole reason this file exists.

1. **`JAVA_HOME` is not set by default on Windows.** Builds fail with confusing Gradle/JDK errors until you set it (point it at your JDK 17 install). Set it at the system level, not just the current shell.
2. **Do not run `npm audit fix --force`.** It pulls in version mismatches that break the RN/`llama.rn` dependency set. If `npm audit` complains, leave it — the pinned versions above are the known-good set. Update dependencies one at a time, on purpose, and re-test on-device.
3. **Model files must live in app-private external storage.** Push GGUF files to:
   ```
   /sdcard/Android/data/com.todoai/files/
   ```
   **Not** `/sdcard/Download/` or other shared storage — those fail to load with a generic, silent-looking error on modern Android. Example:
   ```sh
   adb push ternary-bonsai-4b-tq1_0.gguf /sdcard/Android/data/com.todoai/files/
   ```

---

## Model runtime (what actually works today)

- **Model:** Ternary-Bonsai-4B, **TQ1_0** quantization (community repack). *Not Q1_0* — that's PrismML's older 1-bit family. Native **Q2_0** exists only in PrismML's fork and would require a custom native build ("Stage B"); it is **not** needed for the 4B on stock `llama.rn`.
- **Backend:** CPU-only. `llama.rn`'s Android GPU path (OpenCL, Adreno) covers only Q4_0/Q6_K, not TQ1_0/Q2_0, and it ships no Vulkan backend. So CPU is the realistic baseline, not a temporary limit.
- **Measured on the S23 FE (CPU-only):** load 1–4 s; throughput ~8.5 tok/s burst → **~5.2 tok/s steady**, which *plateaus* (holds flat rather than degrading) across a 15-minute run; thermal drop ~39% peak→steady but stabilizes.
- **CRITICAL — use the chat/`messages` API, never raw `completion()` with a bare string.** Ternary Bonsai is instruction-tuned; it needs its embedded chat template applied. `llama.rn` applies the template automatically when you pass `messages: [{ role, content }]`. Passing a raw prompt string produces repetition loops and invalid/garbage output — this looks like a broken model or bad quant, but it's a prompting bug. This is a precondition for the grammar-constrained structured output (spec §3.3).
- **Diagnostic:** a header-only load check (the spike's `loadLlamaModelInfo`) is worth keeping around — it isolates "model file won't load" from "template/prompting is wrong," which otherwise present identically.

---

## Turning the spike into a foundation (the real remaining task-1 work)

The base build runs; the disposable spike screen (`BonsaiSpikeScreen.tsx`) is not the foundation. What's left for "task 1 done" on a personal build:

- **Repo conventions locked** before generated code flows in: TypeScript `strict`, ESLint/Prettier wired to `npm run lint`, a folder structure you're happy to grow into. Cheapest to do now while the tree is nearly empty.
- **Promote model loading into a real module** — a `TernaryBonsaiProvider` implementing the spec §3.6 `LLMProvider` interface, with **two things correct from line one** because they already bit us: the `messages`/chat-template path, and the `com.todoai` model-storage path. Everything downstream (coaching, the skill layer) plugs into this one seam, so a clean version here pays off repeatedly.
- **This file kept current** as versions change, so a fresh clone → `npm install` → `npm run android` → streams a token on the S23 FE stays reproducible for future-you.

**Personal-build "done" bar:** a fresh clone of this repo builds and streams one token on the S23 FE, following only this file. (The stricter "someone on a clean machine can do it" bar is a test-group concern, not a solo-build one.)

---

## Data layer (tasks 2 & 3 — persistence + types)

`src/db/` and `src/types/` implement the persistence layer and TypeScript types against the
validated `ADHD_Task_Management_App_Database_Schema_v2.2.sql`, per
`docs/briefs/data_layer_tasks_2_3.md`. Both the spec and schema are also copied into
`docs/reference/` so they're in-repo alongside the code that implements them.

**Dependencies added:**
- `@op-engineering/op-sqlite` (^17.1.2) — the SQLite driver, per the brief's recommended stack. Not yet confirmed on-device (see flag below).
- `better-sqlite3`, `@types/better-sqlite3` (dev) — backs a test-only `SqliteConnection` double (`src/db/testUtils/sqliteTestConnection.ts`) so repository/migration tests run real SQL under Jest without the native RN module. Never imported by app code.
- `@types/node` (dev) — tsconfig's explicit `"types"` array needed `"node"` added for `fs`/`path`/`__dirname` in test-only files.
- `@react-native/jest-preset` (dev) — `jest.config.js` already referenced this preset but it was never installed as a dependency, so `npm test` couldn't run at all before this. Pinned to `0.86.0` to match the rest of the `@react-native/*` set.

**⚠ Flag to the human — `POWER()` / on-device verification still pending:**
1. **The `active_tasks_with_neglect` view's `neglect_multiplier` column (uses `POWER()`) is expected to fail on op-sqlite's Android build.** `node_modules/@op-engineering/op-sqlite/android/build.gradle` explicitly lists SQLite compile flags (`SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_RTREE`, etc.) with no `SQLITE_ENABLE_MATH_FUNCTIONS` — SQLite omits math functions like `POWER()` unless that flag is set. This is static analysis of the build config, **not an on-device test** (no Android device was available this session). Per the brief's constraint on this exact scenario, `tasksRepository.listActiveByNeglect()` (`src/db/repositories/tasks.ts`) doesn't query the view at all: it computes `weeks_neglected` with the same POWER()-free arithmetic the view uses, then squares it in TypeScript for an identical, still-uncapped `neglectMultiplier`. **Please confirm on the S23 FE** whether the view's `POWER()` column actually fails — if a future op-sqlite build does compile in math functions, the view could be used directly again.
2. **op-sqlite itself has not been installed/loaded on a physical device.** All schema/migration/repository verification this session ran against `better-sqlite3` (desktop SQLite 3.53.2) via Jest, which confirmed the DDL and all repository SQL are correct against a real SQLite engine — but that's a proxy, not the on-device op-sqlite JSI binding on Android. Before relying on this layer: run `npm run android`, confirm the app opens the DB and `runMigrations()` (`src/db/migrations/index.ts`) applies cleanly (all 25 tables, 5 views, 2 triggers), and re-check point 1 above.

---

## Structured output (task 4 — strategy + eval design)

The structured-output reliability strategy and eval methodology (spec §3.3) are settled in
`docs/briefs/structured_output_strategy_task_4.md`. It binds the grammar work (task 5), the
system prompts (task 7), and parts of the provider runtime (task 6): recap-as-draft, JSON
Schema as single source of truth, rigid grammars, user-scale-only model output, a relative-date
union, the recurrence ask-don't-guess policy, runtime-generated grammars for ids/tags, a union
grammar (not native tool calling) for coaching resolutions, greedy decoding on constrained
calls, and a validate → retry-once → salvage fallback ladder. Seed eval fixtures live in
`docs/eval/extraction_fixtures_seed.jsonl` (16 synthetic trap cases; format in the doc §6.2).

**⚠ Needs the human before the loop closes (doc §8):** the 20–30 real example tasks as
fixtures, and the on-device grammar smoke test (does GBNF work at all via `llama.rn` on the
S23 FE, and at what tok/s cost) once task 5 produces the first grammar. No dependencies were
added — this task is design-only.

---

## Schemas, grammars, validators, mappers (task 5)

`src/llm/` implements the four structured-output surfaces named in
`docs/briefs/grammars_task_5.md` against the task 4 strategy above: `task_extraction.v1`,
`task_breakdown.v1`, `coaching_resolution.v1`, `summary.v1`. Static artifacts and pure
functions only — no model calls, no device, no DB. See `src/llm/README.md` for the surface
list, how to regenerate a `.gbnf`, and (important) the `{m,n}`-support caveat: nothing in this
layer has been validated against a real model yet, pending eval Q1 on-device.

**Dependencies added:**
- `zod` — hand-mirrored runtime validators per surface (D2/D10), derived from each surface's JSON Schema by hand rather than codegen.
- `ajv` (dev) — validates fixtures against each surface's `.json` Schema directly in `schemaDrift.test.ts`, so the drift test is a real zod↔JSON-Schema agreement check, not a declared one. Dev-only: never imported by production code.

**⚠ Flag to the human — this needs the same on-device confirmation task 4 already asked for:**
Q1 (does a GBNF-constrained call even work via `llama.rn` on the S23 FE, and does it support
`{m,n}`?) is still open — no device this session. Everything here is proven correct as *pure
TypeScript* (237 tests, `tsc` strict, `eslint` clean) but unproven as *grammar text a real
llama.cpp build actually accepts*. Treat this layer as design-complete, not device-validated.

---

## Deferred (conscious not-yet)

- **iOS build** — until public deployment with a profit model.
- **Stage B fork build** (native Q2_0 + Vulkan GPU, enables real 8B) — open roadmap decision; only needed if chasing 8B-first (spec §11).
- **Device-envelope definition** — becomes the gating question at the jump from one user to the test group, not before.
