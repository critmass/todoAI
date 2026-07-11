/**
 * Q1 grammar smoke-test harness — S23 FE
 * docs/briefs/Q1_grammar_smoke_test_brief.md, binding authority:
 * docs/briefs/structured_output_strategy_task_4.md §6.6–§6.7.
 *
 * THROWAWAY DEV SPIKE, NOT PRODUCTION CODE. Answers one question: does GBNF
 * grammar-constrained decoding actually work on llama.rn 0.12.5 + the 4B/TQ1_0,
 * on-device? Everything downstream of §3.3 (tasks 6/7/12) depends on the answer.
 *
 * Four independently-runnable stages (buttons below), run in order, stop early if
 * Stage 0 or 1 hard-fails:
 *   Stage 0 — trivial grammar (does the `grammar` param work at all)
 *   Stage 1 — {m,n} bounded-repetition support (falls back to boundedRepetition.ts
 *             if the as-authored grammar errors)
 *   Stage 2 — the real task_extraction.v1 grammar over 4 seed-fixture prompts
 *   Stage 3 — constrained vs unconstrained tok/s on the same prompt
 *
 * Model load is reused verbatim from BonsaiSpikeScreen.tsx (initLlama config,
 * messages-based chat-template completion, loadLlamaModelInfo diagnostic) — the
 * chat-template requirement is non-negotiable per README_build.md; a grammar cannot
 * rescue un-templated output.
 *
 * Results are NOT written to a file from inside the app (no filesystem-write native
 * module in this project, and adding one would be a second untested native module
 * on top of llama.rn itself). Instead each stage's result is logged as tagged,
 * chunked JSON ([Q1RESULT] lines, chunked because logcat truncates long lines) —
 * capture with `adb logcat` and reconstruct, or read straight off the on-screen log.
 *
 * BEFORE RUNNING:
 *  1. Model already pushed to MODEL_PATH below (see README_build.md's storage-path
 *     gotcha). Update MODEL_FILENAME if yours differs.
 *  2. `npm start` (Metro) running, device reachable (`adb reverse tcp:8081 tcp:8081`
 *     if needed).
 *  3. Run stages 0 → 1 → 2 → 3 via the buttons. Stop and report if 0 or 1 hard-fails.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  initLlama,
  loadLlamaModelInfo,
  type LlamaContext,
  type RNLlamaOAICompatibleMessage,
} from 'llama.rn';

import { buildGrammar } from '../llm/grammar/buildGrammar';
import { expandBoundedRepetition } from '../llm/grammar/boundedRepetition';
import { JCHAR_RULE, JCHAR_RULE_NAME } from '../llm/grammar/primitives';
import { validateTaskExtraction } from '../llm';
import { TASK_EXTRACTION_V1_GBNF } from './extractionGrammarText';

// TEMPORARY diagnostic helper (Q1 bisection only): boundedRepetition.ts's
// rewriteBoundedRepetition only rewrites `name{m,n}` for one named rule at a time. Live
// on-device bisection found {m,n} fails when applied directly to an inline character class
// ([0-9]{0,3}), unlike a named rule (jchar{1,20}, which passes) - this generalizes the same
// expandBoundedRepetition primitive to also catch bracket-expression and parenthesized-group
// forms, so the whole real grammar can be tested expanded in one pass.
function expandAllBoundedRepetitionOccurrences(grammarText: string): string {
  const pattern = /(\[[^\]]*\]|\([^()]*\)|\w+)\{(\d+),(\d+)\}/g;
  return grammarText.replace(pattern, (_match, element: string, min: string, max: string) =>
    expandBoundedRepetition(element, Number(min), Number(max)),
  );
}

// ---- CONFIG ----

// Verbatim load-path convention from BonsaiSpikeScreen.tsx (file:// prefix), adjusted to
// this app's package id per README_build.md's storage-path gotcha.
const MODEL_FILENAME = 'Ternary-Bonsai-4B-TQ1_0.gguf';
const MODEL_PATH = `file:///sdcard/Android/data/com.todoai/files/${MODEL_FILENAME}`;

// Same CPU-only baseline as BonsaiSpikeScreen.tsx — Adreno 730's OpenCL path doesn't cover
// TQ1_0, so n_gpu_layers stays 0. n_threads=4 was the original spike's starting point.
const N_CTX = 2048;
const N_THREADS = 4;
const N_GPU_LAYERS = 0;

// Fixed vocabulary for the context_tags dynamic slot (D7) — a small stand-in set, not the
// app's real learned vocabulary (there is no real vocabulary yet; nothing has run).
const CONTEXT_TAGS_KNOWN = ['home', 'office', 'phone', 'computer'];

// ---- MANIFEST FIELDS (strategy §6.6: "a number without its manifest is a rumor") ----
// Edit these by hand before each run - this is a throwaway spike, not a device-info library.
const LLAMA_RN_VERSION = '0.12.5'; // pinned in package.json
const DEVICE_LABEL = 'Samsung Galaxy S23 FE';
// Hashing a ~1GB GGUF from JS would need a filesystem-read native module, which this spike
// deliberately doesn't add (see file header). Run this once per model file and paste the
// result here: `certutil -hashfile <path> SHA256` (PowerShell) or `sha256sum <path>` (adb shell).
const MODEL_SHA256 = 'da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c'; // adb shell sha256sum, 2026-07-11
// Edit before each run per the brief's "note the thermal context" instruction (cold vs a few
// minutes in - steady-state is the honest condition per the original spike's plateau finding).
const RUN_NOTE = '<edit: cold start / N minutes in, warm>';

// ---- SEED FIXTURES (4 of the 16 in docs/eval/extraction_fixtures_seed.jsonl) ----
// 2 simple + the null-vs-unscheduled trap + a date case, per the brief. Copied by hand
// (Metro can't import .jsonl) — ids match the seed file exactly for traceability.

type FixtureTurn = { role: 'user'; content: string };
type SeedFixture = {
  id: string;
  today: string; // YYYY-MM-DD
  turns: FixtureTurn[];
  clarifyAnswers?: string[]; // flattened into extra trailing user turns (no real conversation loop here — task 7 doesn't exist yet)
};

const STAGE2_FIXTURES: SeedFixture[] = [
  {
    id: 'simple-scheduled-01',
    today: '2026-07-08',
    turns: [
      { role: 'user', content: 'I need to take out the trash' },
      { role: 'user', content: 'Yes, every Tuesday' },
    ],
  },
  {
    id: 'oneoff-null-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I need to renew my passport before it expires' }],
  },
  {
    id: 'trap-unsched-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I want to keep working on my novel' }],
    clarifyAnswers: [
      "It's ongoing, I never really finish it, I just want to keep coming back to it",
    ],
  },
  {
    id: 'date-weekday-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I have to call the insurance company by Friday' }],
  },
];

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Minimal Q1-only field guide + the recurrence decision tree, transcribed near-verbatim from
 * strategy §3.5 (which explicitly says that tree "goes in the task-input system prompt, near-
 * verbatim"). This is NOT task 7's system prompt — no tone/UX work, just enough grounding for
 * Stage 2/3 to be a meaningful test of the grammar rather than a test of an ungrounded model.
 */
function buildExtractionSystemPrompt(todayISO: string): string {
  const weekday = WEEKDAY_NAMES[new Date(`${todayISO}T00:00:00Z`).getUTCDay()];
  return [
    `You are extracting structured task data as JSON. Today is ${todayISO} (${weekday}).`,
    'Fields: title (short name); description (extra detail or null); estimated_duration_minutes ' +
      '(how long the task itself takes — guess if unstated, and set duration_from_user to false ' +
      'when you guessed, true when the user stated it); due (null if no due date, else a relative ' +
      'date expression); context_tags (short tags, or empty); tool_requirements (things needed, or ' +
      'empty); energy (low/med/high, or null if unclear); importance_user (1-10, or null if unstated); ' +
      'recurrence (see below).',
    'Decide recurrence in this order: ' +
      '(1) Does completing it once finish it forever? -> one-off (recurrence: null). ' +
      '(2) Is it "done after N total completions, ever"? -> count (target N). ' +
      '(3) Fixed days, with a per-period quota alongside? -> scheduled_quota. Fixed days, no quota? -> scheduled. ' +
      '(4) A quota per period but no fixed days? -> quota. ' +
      '(5) Recurs indefinitely with no schedule and no quota (ongoing project, practice, "keep at it")? -> unscheduled.',
  ].join('\n');
}

// ---- RESULT TYPES ----

type Timings = {
  promptMs: number;
  promptPerSecond: number;
  predictedN: number;
  predictedPerSecond: number;
};

type StageResult = Record<string, unknown>;

// ---- LOGGING ----

function appendAndLog(
  setLog: React.Dispatch<React.SetStateAction<string[]>>,
  line: string,
): void {
  setLog((prev) => [...prev, line]);
  console.log('[Q1Spike]', line);
}

/** Logs a JSON-serializable value as tagged, chunked lines (logcat truncates long lines, AND
 *  splits multi-line console.log calls into separate untagged lines - so this must be compact
 *  (no pretty-print newlines) or only the first chunk-line of each chunk survives a tag grep). */
function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value); // compact - no `null, 2`, see note above
  const CHUNK_SIZE = 3000;
  const totalChunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    console.log(`[${tag} ${i + 1}/${totalChunks}] ${chunk}`);
  }
}

function extractTimings(result: { timings?: Record<string, number> }): Timings {
  const t = result.timings ?? {};
  return {
    promptMs: t.prompt_ms ?? 0,
    promptPerSecond: t.prompt_per_second ?? 0,
    predictedN: t.predicted_n ?? 0,
    predictedPerSecond: t.predicted_per_second ?? 0,
  };
}

// ---- MANIFEST ----

/** Non-cryptographic string fingerprint (FNV-1a, 32-bit) - identifies "was this the exact same
 *  grammar text across runs", not a security hash. Cheap, dependency-free, fine for a manifest
 *  on a throwaway spike (contrast MODEL_SHA256 above, which is a real hash but computed
 *  out-of-band since hashing the model file in-app isn't practical here). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Shared manifest fields (§6.6) plus a fingerprint of the specific grammar text this stage
 *  used, if any (null for the unconstrained side of Stage 3). Merged into every stage's logged
 *  result so `q1-reassemble.js` can pull manifest + numbers from the same tag. */
function buildManifest(grammarText: string | null): StageResult {
  return {
    modelFilename: MODEL_FILENAME,
    modelSha256: MODEL_SHA256,
    llamaRnVersion: LLAMA_RN_VERSION,
    device: DEVICE_LABEL,
    runNote: RUN_NOTE,
    grammarFingerprint: grammarText === null ? null : fingerprint(grammarText),
  };
}

export default function Q1GrammarSpikeScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const contextRef = useRef<LlamaContext | null>(null);

  const appendLog = useCallback((line: string) => appendAndLog(setLog, line), []);

  // ---- Model load (verbatim path from BonsaiSpikeScreen.tsx) ----

  const ensureModelLoaded = useCallback(async (): Promise<LlamaContext> => {
    if (contextRef.current) return contextRef.current;
    const start = Date.now();
    appendLog(
      `Loading ${MODEL_PATH} (ctx=${N_CTX}, threads=${N_THREADS}, gpu_layers=${N_GPU_LAYERS}) ...`,
    );
    try {
      const ctx = await initLlama({
        model: MODEL_PATH,
        use_mlock: true,
        n_ctx: N_CTX,
        n_threads: N_THREADS,
        n_gpu_layers: N_GPU_LAYERS,
      });
      contextRef.current = ctx;
      appendLog(`Model loaded in ${Date.now() - start}ms`);
      return ctx;
    } catch (err: any) {
      appendLog(`LOAD FAILED: ${String(err)}`);
      appendLog(`  message: ${err?.message}`);
      appendLog(`  code: ${err?.code}`);
      throw err;
    }
  }, [appendLog]);

  // Diagnostic only (verbatim from BonsaiSpikeScreen.tsx): isolates "file won't load" from
  // "template/prompting is wrong" per README_build.md's documented gotcha.
  const checkModelInfo = useCallback(async () => {
    appendLog(`Reading model header from ${MODEL_PATH} ...`);
    try {
      const info = await loadLlamaModelInfo(MODEL_PATH);
      appendLog(`HEADER OK: ${JSON.stringify(info)}`);
    } catch (err: any) {
      appendLog(`HEADER READ FAILED: ${String(err)}`);
      appendLog(`  message: ${err?.message}`);
    }
  }, [appendLog]);

  // ---- Shared completion helper ----
  // All constrained calls: greedy (temperature 0, top_k 1 as belt-and-braces — the installed
  // llama.rn types document temperature<0 as the documented greedy trigger; top_k=1 forces
  // deterministic single-best-token selection regardless of exactly where that threshold
  // sits), no penalty samplers. Matches strategy D9.
  const runCompletion = useCallback(
    async (
      messages: RNLlamaOAICompatibleMessage[],
      opts: { grammar?: string; n_predict: number },
    ) => {
      const ctx = await ensureModelLoaded();
      return ctx.completion({
        messages,
        grammar: opts.grammar,
        n_predict: opts.n_predict,
        temperature: 0,
        top_k: 1,
      });
    },
    [ensureModelLoaded],
  );

  // ---- Stage 0 — trivial grammar ----

  const runStage0 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "yes" | "no"';
      const prompt = 'Tell me about your day in detail.'; // designed to ramble unconstrained
      appendLog('Stage 0: trivial grammar (root ::= "yes" | "no") ...');
      try {
        const result = await runCompletion([{ role: 'user', content: prompt }], {
          grammar,
          n_predict: 10,
        });
        const text = (result.text ?? '').trim();
        const constrains = text === 'yes' || text === 'no';
        const stageResult: StageResult = {
          grammar,
          rawOutput: text,
          constrains,
          timings: extractTimings(result),
          manifest: buildManifest(grammar),
        };
        appendLog(`Stage 0: output="${text}" constrains=${constrains}`);
        logResultJson('Q1RESULT:stage0', stageResult);
      } catch (err: any) {
        appendLog(`Stage 0 ERROR: ${String(err)}`);
        logResultJson('Q1RESULT:stage0', {
          error: String(err),
          message: err?.message,
          manifest: buildManifest(grammar),
        });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- Stage 1 — {m,n} bounded-repetition support ----

  const runStage1 = useCallback(async () => {
    setRunning(true);
    try {
      // A JSON-safe string capped at {1,20} — the smallest real exercise of the D3.5 risk.
      const asAuthored = `root ::= "\\"" ${JCHAR_RULE_NAME}{1,20} "\\""\n${JCHAR_RULE}`;
      const prompt = 'Say something short.';
      appendLog('Stage 1: {m,n} bounded-repetition micro-grammar, as authored ...');

      let branch: 'as-authored' | 'expander-fallback' | 'neither';
      let finalResult: StageResult;

      try {
        const result = await runCompletion([{ role: 'user', content: prompt }], {
          grammar: asAuthored,
          n_predict: 30,
        });
        branch = 'as-authored';
        appendLog(`Stage 1: {m,n} WORKS as authored. output=${JSON.stringify(result.text)}`);
        finalResult = {
          branch,
          grammar: asAuthored,
          rawOutput: result.text,
          timings: extractTimings(result),
          manifest: buildManifest(asAuthored),
        };
      } catch (asAuthoredErr: any) {
        appendLog(`Stage 1: as-authored FAILED: ${String(asAuthoredErr)}. Trying expander ...`);
        try {
          const expandedStringRule = `${JCHAR_RULE_NAME} ${expandBoundedRepetition(
            JCHAR_RULE_NAME,
            0,
            19,
          )}`; // 1 mandatory + 0..19 optional = 1..20, matching {1,20}
          const expanded = `root ::= "\\"" ${expandedStringRule} "\\""\n${JCHAR_RULE}`;
          const result = await runCompletion([{ role: 'user', content: prompt }], {
            grammar: expanded,
            n_predict: 30,
          });
          branch = 'expander-fallback';
          appendLog(`Stage 1: expander fallback WORKS. output=${JSON.stringify(result.text)}`);
          finalResult = {
            branch,
            grammar: expanded,
            asAuthoredError: String(asAuthoredErr),
            rawOutput: result.text,
            timings: extractTimings(result),
            manifest: buildManifest(expanded),
          };
        } catch (expandedErr: any) {
          branch = 'neither';
          appendLog(`Stage 1: expander fallback ALSO FAILED: ${String(expandedErr)}`);
          finalResult = {
            branch,
            asAuthoredError: String(asAuthoredErr),
            expandedError: String(expandedErr),
            manifest: buildManifest(null),
          };
        }
      }

      logResultJson('Q1RESULT:stage1', finalResult);
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: bisect the real grammar to find what fails to parse ----
  // Not part of the four Q1 stages - deleted once Stage 2's failure is isolated.

  const runBisect = useCallback(async () => {
    setRunning(true);
    try {
      const J = JCHAR_RULE;
      const candidates: Array<{ name: string; grammar: string }> = [
        {
          name: 'A-title-only',
          grammar: `root ::= "{\\"title\\":" title "}"\ntitle ::= "\\"" jchar{1,80} "\\""\n${J}`,
        },
        {
          name: 'B-title-desc',
          grammar: `root ::= "{\\"title\\":" title ",\\"description\\":" description "}"\ntitle ::= "\\"" jchar{1,80} "\\""\ndescription ::= "null" | "\\"" jchar{1,200} "\\""\n${J}`,
        },
        {
          name: 'C-plus-duration',
          grammar: `root ::= "{\\"title\\":" title ",\\"estimated_duration_minutes\\":" estimated_duration_minutes ",\\"duration_from_user\\":" duration_from_user "}"\ntitle ::= "\\"" jchar{1,80} "\\""\nestimated_duration_minutes ::= [1-9] [0-9]{0,3}\nduration_from_user ::= "true" | "false"\n${J}`,
        },
        {
          name: 'D-plus-due',
          grammar: `root ::= "{\\"title\\":" title ",\\"due\\":" due "}"\ntitle ::= "\\"" jchar{1,80} "\\""\ndue ::= "null" | due_on_date | due_in_days | due_weekday\ndue_on_date ::= "{\\"kind\\":\\"on_date\\",\\"date\\":\\"" date_str "\\"}"\ndate_str ::= [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]\ndue_in_days ::= "{\\"kind\\":\\"in_days\\",\\"days\\":" days_int "}"\ndays_int ::= [1-9] [0-9]{0,2}\ndue_weekday ::= "{\\"kind\\":\\"weekday\\",\\"day\\":" weekday ",\\"which\\":" which "}"\nwhich ::= "\\"this\\"" | "\\"next\\""\nweekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""\n${J}`,
        },
        {
          name: 'E-plus-context-tags-slot',
          grammar: buildGrammar(
            `root ::= "{\\"title\\":" title ",\\"context_tags\\":" context_tags "}"\ntitle ::= "\\"" jchar{1,80} "\\""\ncontext_tags ::= "[]" | "[" tag ("," tag){0,4} "]"\ntag ::= tag_known | new_tag\ntag_known ::= "\\"" {{context_tags_known}} "\\""\nnew_tag ::= "\\"" jchar{1,20} "\\""\n${J}`,
            { context_tags_known: CONTEXT_TAGS_KNOWN },
          ),
        },
        {
          name: 'F-plus-recurrence',
          grammar: `root ::= "{\\"title\\":" title ",\\"recurrence\\":" recurrence "}"\ntitle ::= "\\"" jchar{1,80} "\\""\nrecurrence ::= "null" | rec_scheduled_quota | rec_quota | rec_scheduled | rec_unscheduled | rec_count\nrec_scheduled_quota ::= "{\\"type\\":\\"scheduled_quota\\",\\"quota\\":" quota_int ",\\"period\\":" period ",\\"days\\":" weekday_array "}"\nrec_quota ::= "{\\"type\\":\\"quota\\",\\"quota\\":" quota_int ",\\"period\\":" period "}"\nrec_scheduled ::= "{\\"type\\":\\"scheduled\\",\\"days\\":" weekday_array "}"\nrec_unscheduled ::= "{\\"type\\":\\"unscheduled\\"}"\nrec_count ::= "{\\"type\\":\\"count\\",\\"target\\":" target_int "}"\nquota_int ::= [1-9] [0-9]{0,2}\ntarget_int ::= [1-9] [0-9]{0,2}\nperiod ::= "\\"day\\"" | "\\"week\\"" | "\\"month\\""\nweekday_array ::= "[" weekday ("," weekday){0,6} "]"\nweekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""\n${J}`,
        },
        {
          name: 'G-full-minus-comments',
          grammar: buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN })
            .split('\n')
            .map((line) => line.replace(/#.*$/, '').trimEnd())
            .filter((line) => line.length > 0)
            .join('\n'),
        },
        {
          name: 'H-full-expanded',
          grammar: expandAllBoundedRepetitionOccurrences(
            buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN })
              .split('\n')
              .map((line) => line.replace(/#.*$/, '').trimEnd())
              .filter((line) => line.length > 0)
              .join('\n'),
          ),
        },
      ];

      const results: StageResult[] = [];
      for (const candidate of candidates) {
        try {
          const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
            grammar: candidate.grammar,
            n_predict: 60,
          });
          appendLog(`Bisect [${candidate.name}]: PASS output=${JSON.stringify(result.text)}`);
          results.push({ name: candidate.name, pass: true, rawOutput: result.text });
        } catch (err: any) {
          appendLog(`Bisect [${candidate.name}]: FAIL ${String(err)}`);
          results.push({ name: candidate.name, pass: false, error: String(err) });
        }
      }
      logResultJson('Q1RESULT:bisect', results);
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: test ONLY the fully-expanded fix in isolation ----
  // Candidate D in runBisect appears to crash the native process (not just throw a catchable
  // JS error) - skip straight to the fix candidate instead of re-running that path.

  const runTestFixOnly = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = expandAllBoundedRepetitionOccurrences(
        buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN })
          .split('\n')
          .map((line) => line.replace(/#.*$/, '').trimEnd())
          .filter((line) => line.length > 0)
          .join('\n'),
      );
      appendLog(`Fix-only test: expanded grammar, ${grammar.length} chars ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 60,
        });
        appendLog(`Fix-only test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:fixonly', {
          pass: true,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Fix-only test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:fixonly', { pass: false, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: does a SMALL expanded fragment parse? ----
  // runTestFixOnly (the full expanded grammar) still fails to parse - this isolates whether
  // that's about aggregate grammar complexity, or about a single field's nesting depth (title's
  // jchar{1,80} expands to 79 nested optionals). Deliberately excludes `due`/`days_int` (the
  // field that crashed the whole process in runBisect's candidate D) - this probe carries no
  // crash risk by construction.

  const runTestExpandedSmallFragment = useCallback(async () => {
    setRunning(true);
    try {
      const J = JCHAR_RULE;
      const unexpanded = `root ::= "{\\"title\\":" title ",\\"estimated_duration_minutes\\":" estimated_duration_minutes ",\\"duration_from_user\\":" duration_from_user "}"\ntitle ::= "\\"" jchar{1,80} "\\""\nestimated_duration_minutes ::= [1-9] [0-9]{0,3}\nduration_from_user ::= "true" | "false"\n${J}`;
      const grammar = expandAllBoundedRepetitionOccurrences(unexpanded);
      appendLog(`Small-fragment test: expanded title+duration only, ${grammar.length} chars ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 60,
        });
        appendLog(`Small-fragment test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:smallfragment', {
          pass: true,
          rawOutput: result.text,
          grammarLength: grammar.length,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Small-fragment test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:smallfragment', {
          pass: false,
          error: String(err),
          grammarLength: grammar.length,
        });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: duration alone (no `title`) - isolates depth from mechanism ----
  // Small-fragment (title+duration, expanded) still failed. `title`'s jchar{1,80} expands to
  // 79 nested optionals - by far the deepest rule in the whole grammar. Dropping `title`
  // entirely leaves only estimated_duration_minutes, whose [0-9]{0,3} expands to just 3 nested
  // optionals. If THIS passes, `title`'s exceptional depth is specifically implicated. If it
  // also fails, the nested-optional expansion pattern itself is rejected regardless of depth.

  const runTestDurationOnly = useCallback(async () => {
    setRunning(true);
    try {
      const unexpanded = `root ::= "{\\"estimated_duration_minutes\\":" estimated_duration_minutes "}"\nestimated_duration_minutes ::= [1-9] [0-9]{0,3}`;
      const grammar = expandAllBoundedRepetitionOccurrences(unexpanded);
      appendLog(`Duration-only test: ${JSON.stringify(grammar)} (${grammar.length} chars) ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 20,
        });
        appendLog(`Duration-only test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:durationonly', {
          pass: true,
          grammar,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Duration-only test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:durationonly', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: is `(...)?` supported AT ALL by this parser build? ----
  // Duration-only (a 2-rule, 3-deep nested-optional fragment) still failed - this drops
  // character classes and recursion entirely, testing the bare parenthesized-optional operator
  // in isolation. If even this fails, boundedRepetition.ts's whole nested-optional strategy
  // (not just this spike's regex-based generalization of it) is the wrong fallback shape for
  // this llama.cpp build, independent of {m,n} at all.

  const runTestBareOptionalGroup = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "a" ("b")?';
      appendLog(`Bare-optional-group test: ${JSON.stringify(grammar)} ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 10,
        });
        appendLog(`Bare-optional-group test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:bareoptional', {
          pass: true,
          grammar,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Bare-optional-group test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:bareoptional', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: does NAMING the character class first fix it? ----
  // bareoptional (nested optionals over string literals) passed; durationonly (nested optionals
  // over an INLINE `[0-9]` character class) failed. This tests the refined hypothesis: repeating
  // an inline character class directly is what's unsupported - not nesting/optionals in
  // general - matching Stage 1's finding that jchar{1,20} (a NAMED rule) passed while
  // [0-9]{0,3} (inline) failed. If wrapping the class in a named rule first (`digit ::= [0-9]`)
  // and nesting THAT works, the actionable fix is "name single-char classes before repeating
  // them" - which task 5's own boundedIntRule primitive does NOT currently do.

  const runTestNamedDigitRule = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = `root ::= "{\\"estimated_duration_minutes\\":" estimated_duration_minutes "}"\nestimated_duration_minutes ::= [1-9] (digit (digit (digit)?)?)?\ndigit ::= [0-9]`;
      appendLog(`Named-digit-rule test: ${JSON.stringify(grammar)} ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 20,
        });
        appendLog(`Named-digit-rule test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:nameddigit', {
          pass: true,
          grammar,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Named-digit-rule test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:nameddigit', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: is 3-level NESTING itself the problem, independent of classes? ----
  // bareoptional (1 level, literals) passed; nameddigit (3 levels, named char-class rule)
  // failed. This isolates depth as the sole variable: same 3-level nesting shape as nameddigit,
  // but pure string literals, single rule - no character classes, no multi-rule chain.

  const runTestNestedLiteralsOnly = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "a" ("b" ("c" ("d")?)?)?';
      appendLog(`Nested-literals-only test: ${JSON.stringify(grammar)} ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 10,
        });
        appendLog(`Nested-literals-only test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:nestedliterals', {
          pass: true,
          grammar,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Nested-literals-only test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:nestedliterals', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: is ZERO-MINIMUM repetition on a char class the real trigger? ----
  // Refined hypothesis from the probes above: jchar{1,20} (min=1) passed, and jchar's own
  // internal `"u" [0-9a-fA-F]{4}` (exact, non-zero) must have parsed fine too (Stage 1 couldn't
  // have passed otherwise - the whole grammar parses upfront before any generation). Meanwhile
  // every failing case so far ([0-9]{0,3}, the digit-rule expansion) has a zero MINIMUM - the
  // class can be matched zero times. Literal-only zero-min constructs (bareoptional,
  // nestedliterals) passed fine. This runs the minimal confirming pair in one probe: `[0-9]{4}`
  // (non-zero min, predicts PASS) vs `[0-9]{0,4}` (zero min, predicts FAIL, reproducing
  // candidate C's original failure in the smallest possible form).

  const runTestZeroMinHypothesis = useCallback(async () => {
    setRunning(true);
    try {
      const cases: Array<{ name: string; grammar: string }> = [
        { name: 'nonzero-min-exact4', grammar: 'root ::= "x" [0-9]{4}' },
        { name: 'zero-min-0to4', grammar: 'root ::= "x" [0-9]{0,4}' },
      ];
      const results: StageResult[] = [];
      for (const c of cases) {
        appendLog(`Zero-min-hypothesis [${c.name}]: ${JSON.stringify(c.grammar)} ...`);
        try {
          const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
            grammar: c.grammar,
            n_predict: 10,
          });
          appendLog(`Zero-min-hypothesis [${c.name}]: PASS output=${JSON.stringify(result.text)}`);
          results.push({ name: c.name, pass: true, grammar: c.grammar, rawOutput: result.text });
        } catch (err: any) {
          appendLog(`Zero-min-hypothesis [${c.name}]: FAIL ${String(err)}`);
          results.push({ name: c.name, pass: false, grammar: c.grammar, error: String(err) });
        }
      }
      logResultJson('Q1RESULT:zerominhypothesis', results);
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- TEMPORARY diagnostic: is it TWO ADJACENT character classes, not {m,n}/zero-min at all? ----
  // zerominhypothesis refuted zero-min: a lone `[0-9]{0,4}` parsed fine. Every failing case so
  // far (candidate C originally, durationonly, nameddigit) had `[1-9]` immediately followed by
  // a second digit-class term - every passing case had at most ONE character-class term. This
  // strips out ALL repetition/optionality entirely: does a completely bare, mandatory,
  // non-repeating pair of adjacent character classes fail on its own? If so, the real bug has
  // nothing to do with {m,n} or the D3.5 fallback at all - it's about sequential character
  // classes, which is a far more fundamental (and differently-actionable) finding.

  const runTestAdjacentClassesHypothesis = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= [1-9] [0-9]';
      appendLog(`Adjacent-classes test: ${JSON.stringify(grammar)} (no repetition, no optionality) ...`);
      try {
        const result = await runCompletion([{ role: 'user', content: 'Fill in JSON for: buy milk' }], {
          grammar,
          n_predict: 10,
        });
        appendLog(`Adjacent-classes test: PASS output=${JSON.stringify(result.text)}`);
        logResultJson('Q1RESULT:adjacentclasses', {
          pass: true,
          grammar,
          rawOutput: result.text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Adjacent-classes test: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:adjacentclasses', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- Stage 2 — the real extraction grammar over seed prompts ----

  const runStage2 = useCallback(async () => {
    setRunning(true);
    try {
      appendLog(`Stage 2: task_extraction.v1.gbnf over ${STAGE2_FIXTURES.length} fixtures ...`);
      const template = TASK_EXTRACTION_V1_GBNF;
      const substituted = buildGrammar(template, { context_tags_known: CONTEXT_TAGS_KNOWN });
      // DIAGNOSTIC (temporary): Stage 0/1's comment-free grammars parsed fine; this real
      // grammar is full of `#` comments and is failing to parse. Testing whether this build's
      // GBNF parser lacks `#` line-comment support by stripping comments/blank lines before
      // use. If this fixes it, that's the Q1 finding to report - not a reason to edit the
      // checked-in .gbnf (comments stay for humans; a strip-before-use step belongs in task 6).
      const grammar = substituted
        .split('\n')
        .map((line) => line.replace(/#.*$/, '').trimEnd())
        .filter((line) => line.length > 0)
        .join('\n');
      logResultJson('Q1DEBUG:stage2grammar', { grammar });

      const perFixture: StageResult[] = [];
      for (const fixture of STAGE2_FIXTURES) {
        const messages: RNLlamaOAICompatibleMessage[] = [
          { role: 'system', content: buildExtractionSystemPrompt(fixture.today) },
          ...fixture.turns,
          ...(fixture.clarifyAnswers ?? []).map((a) => ({ role: 'user' as const, content: a })),
        ];

        try {
          const result = await runCompletion(messages, { grammar, n_predict: 200 });
          const text = result.text ?? '';
          let parsed: unknown;
          let parsesAsJson = false;
          try {
            parsed = JSON.parse(text);
            parsesAsJson = true;
          } catch {
            parsesAsJson = false;
          }

          let passesValidator = false;
          let validatorError: string | undefined;
          if (parsesAsJson) {
            try {
              validateTaskExtraction(parsed, fixture.today);
              passesValidator = true;
            } catch (validationErr: any) {
              validatorError = String(validationErr?.message ?? validationErr);
            }
          }

          appendLog(
            `Stage 2 [${fixture.id}]: parses=${parsesAsJson} validates=${passesValidator}` +
              (validatorError ? ` (${validatorError})` : ''),
          );
          perFixture.push({
            id: fixture.id,
            rawOutput: text,
            parsesAsJson,
            passesValidator,
            validatorError,
            timings: extractTimings(result),
          });
        } catch (err: any) {
          appendLog(`Stage 2 [${fixture.id}] ERROR: ${String(err)}`);
          perFixture.push({ id: fixture.id, error: String(err), message: err?.message });
        }
      }

      const validCount = perFixture.filter((r) => r.parsesAsJson).length;
      const passCount = perFixture.filter((r) => r.passesValidator).length;
      appendLog(
        `Stage 2 summary: valid JSON ${validCount}/${STAGE2_FIXTURES.length}, ` +
          `validator-passing ${passCount}/${STAGE2_FIXTURES.length}`,
      );
      logResultJson('Q1RESULT:stage2', {
        grammarLength: grammar.length,
        fixtureCount: STAGE2_FIXTURES.length,
        validCount,
        passCount,
        perFixture,
        manifest: buildManifest(grammar),
      });
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // ---- Stage 3 — constrained vs unconstrained overhead ----

  const runStage3 = useCallback(async () => {
    setRunning(true);
    try {
      appendLog('Stage 3: constrained vs unconstrained, same prompt, both temp 0 ...');
      const fixture = STAGE2_FIXTURES[0]; // simple-scheduled-01
      const messages: RNLlamaOAICompatibleMessage[] = [
        { role: 'system', content: buildExtractionSystemPrompt(fixture.today) },
        ...fixture.turns,
      ];
      const template = TASK_EXTRACTION_V1_GBNF;
      const grammar = buildGrammar(template, { context_tags_known: CONTEXT_TAGS_KNOWN });

      let unconstrained: StageResult;
      let constrained: StageResult;
      try {
        const result = await runCompletion(messages, { n_predict: 200 });
        unconstrained = {
          rawOutput: result.text,
          timings: extractTimings(result),
          manifest: buildManifest(null),
        };
        appendLog(`Stage 3 unconstrained: ${JSON.stringify(extractTimings(result))}`);
      } catch (err: any) {
        unconstrained = { error: String(err), manifest: buildManifest(null) };
        appendLog(`Stage 3 unconstrained ERROR: ${String(err)}`);
      }

      try {
        const result = await runCompletion(messages, { grammar, n_predict: 200 });
        constrained = {
          rawOutput: result.text,
          timings: extractTimings(result),
          manifest: buildManifest(grammar),
        };
        appendLog(`Stage 3 constrained: ${JSON.stringify(extractTimings(result))}`);
      } catch (err: any) {
        constrained = { error: String(err), manifest: buildManifest(grammar) };
        appendLog(`Stage 3 constrained ERROR: ${String(err)}`);
      }

      const u = (unconstrained as any).timings?.predictedPerSecond;
      const c = (constrained as any).timings?.predictedPerSecond;
      const ratio = u && c ? u / c : undefined;
      if (ratio) appendLog(`Stage 3 overhead ratio (unconstrained / constrained): ${ratio.toFixed(2)}x`);

      logResultJson('Q1RESULT:stage3', { unconstrained, constrained, overheadRatio: ratio });
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Q1 Grammar Spike — S23 FE</Text>
      <Button title="Check model header only" onPress={checkModelInfo} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Stage 0: trivial grammar" onPress={runStage0} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Stage 1: {m,n} support" onPress={runStage1} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Stage 2: real extraction grammar" onPress={runStage2} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Stage 3: overhead (on vs off)" onPress={runStage3} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="[debug] bisect grammar" onPress={runBisect} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="[debug] test fix only" onPress={runTestFixOnly} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="[debug] test small expanded fragment"
        onPress={runTestExpandedSmallFragment}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button title="[debug] test duration only" onPress={runTestDurationOnly} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="[debug] test bare optional group"
        onPress={runTestBareOptionalGroup}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button title="[debug] test named digit rule" onPress={runTestNamedDigitRule} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="[debug] test nested literals only"
        onPress={runTestNestedLiteralsOnly}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="[debug] test zero-min hypothesis"
        onPress={runTestZeroMinHypothesis}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="[debug] test adjacent classes hypothesis"
        onPress={runTestAdjacentClassesHypothesis}
        disabled={running}
      />
      <View style={{ height: 16 }} />
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 2 },
});
