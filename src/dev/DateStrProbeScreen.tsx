/**
 * date_str isolation probes — follow-on to Q1b
 * docs/briefs/Q1b_bounded_integer_probe_brief.md
 *
 * THROWAWAY DEV SPIKE, NOT PRODUCTION CODE, NOT BRIEF-MANDATED. Opened live on-device after
 * Q1b's Probe C (the `due` sub-grammar with the boundedIntRule digit-width fix applied to
 * days_int) still failed to parse despite NOT crashing the process. Isolating date_str alone
 * (`[0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]`) confirmed a second, independent
 * grammar bug: it fails to parse even though it has NO optionality at all — contradicting the
 * Q1 findings report's own characterized trigger ("mandatory class immediately followed by
 * optional"). Crossed with Q1b Probe A (whose grammar contains `i4 ::= [1-9] [0-9] [0-9]
 * [0-9]` — 4 consecutive mandatory classes, no literals — and parsed fine), raw class-adjacency
 * count isn't it either. What's different about date_str is multiple class-group <-> literal
 * transitions within one rule. These probes narrow down which variable actually matters:
 * separator count, or literal identity.
 *
 * Split into its own screen rather than growing Q1GrammarSpikeScreen.tsx further — that
 * harness was already ~20 buttons deep and hard to navigate via adb tap coordinates on a real
 * device, and this is a separate, narrower investigative thread, not part of the Q1b brief's
 * own scope (which was `boundedIntRule` only).
 *
 * Model load path is duplicated from Q1GrammarSpikeScreen.tsx (same convention that file
 * itself used when cribbing from the now-deleted BonsaiSpikeScreen.tsx) — a small,
 * intentional duplication for a throwaway spike, not a shared module.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';

const MODEL_FILENAME = 'Ternary-Bonsai-4B-TQ1_0.gguf';
const MODEL_PATH = `file:///sdcard/Android/data/com.todoai/files/${MODEL_FILENAME}`;
const N_CTX = 2048;
const N_THREADS = 4;
const N_GPU_LAYERS = 0;

function appendAndLog(setLog: React.Dispatch<React.SetStateAction<string[]>>, line: string): void {
  setLog((prev) => [...prev, line]);
  console.log('[DateStrProbe]', line);
}

/** Tagged, chunked JSON logging — same convention as Q1GrammarSpikeScreen.tsx's
 *  logResultJson, so scripts/q1-reassemble.js can pull these results too. */
function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value);
  const CHUNK_SIZE = 3000;
  const totalChunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    console.log(`[${tag} ${i + 1}/${totalChunks}] ${chunk}`);
  }
}

function extractTimings(result: { timings?: Record<string, number> }) {
  const t = result.timings ?? {};
  return {
    promptMs: t.prompt_ms ?? 0,
    promptPerSecond: t.prompt_per_second ?? 0,
    predictedN: t.predicted_n ?? 0,
    predictedPerSecond: t.predicted_per_second ?? 0,
  };
}

export default function DateStrProbeScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const contextRef = useRef<LlamaContext | null>(null);

  const appendLog = useCallback((line: string) => appendAndLog(setLog, line), []);

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
      throw err;
    }
  }, [appendLog]);

  const runCompletion = useCallback(
    async (
      messages: RNLlamaOAICompatibleMessage[],
      opts: { grammar: string; n_predict: number },
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

  // Probe C1 (moved here from Q1GrammarSpikeScreen.tsx) — date_str's full shape: 4-2-2 digit
  // groups, two "-" separators. Confirmed FAIL on-device (2026-07-13): "Error: failed to
  // parse grammar".
  const runProbeC1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]';
      appendLog('Probe C1: date_str full shape (4-2-2, two separators) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe C1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeC1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe C1: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeC1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D1 — ONE separator, 2-2 digit groups (the last two segments of date_str, minus the
  // 4-digit year). Tests whether a single class-literal-class transition alone is enough to
  // break parsing, or whether date_str's failure needs two separator occurrences.
  const runProbeD1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"md\\":\\"" md_str "\\"}"\nmd_str ::= [0-9] [0-9] "-" [0-9] [0-9]';
      appendLog('Probe D1: one separator, 2-2 groups ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"md":"07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D1: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D2 — TWO separators, minimal 1-1-1 digit groups. Tests whether it's the COUNT of
  // class-literal transitions in one rule (independent of how many classes are in each group)
  // that triggers the failure, by reproducing date_str's two-separator shape at the smallest
  // possible size.
  const runProbeD2 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"x\\":\\"" x_str "\\"}"\nx_str ::= [0-9] "-" [0-9] "-" [0-9]';
      appendLog('Probe D2: two separators, 1-1-1 groups ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"x":"1-2-3"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D2: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD2', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D2: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD2', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D3 — same shape as D1 (one separator, 2-2 groups) but a different literal (":"
  // instead of "-"). Tests whether the failure is specific to the "-" character or general to
  // any literal separator wedged between character-class groups.
  const runProbeD3 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"t\\":\\"" t_str "\\"}"\nt_str ::= [0-9] [0-9] ":" [0-9] [0-9]';
      appendLog('Probe D3: one separator, different literal (":") ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"t":"07:13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D3: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD3', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D3: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD3', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe E1 — candidate fix #1: NAME the digit class (`digit ::= [0-9]`) instead of writing
  // `[0-9]` inline next to the "-" literal. Tests whether the bug is about the raw
  // bracket-class token sitting in the grammar SOURCE directly next to a literal token, in
  // which case indirecting through a named rule reference (as jchar/weekday/etc. already do
  // everywhere else in this grammar) should dodge it entirely - the cheapest possible fix if
  // it works.
  const runProbeE1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= digit digit digit digit "-" digit digit "-" digit digit\n' +
        'digit ::= [0-9]';
      appendLog('Probe E1: candidate fix - named digit rule instead of inline [0-9] ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe E1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeE1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe E1: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeE1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe E2 — candidate fix #2 (guaranteed-safe fallback if E1 fails): each digit is a
  // LITERAL ALTERNATION ("0"|"1"|...|"9"), not a bracket-class at all, named or otherwise.
  // This mirrors the exact shape Probe A already validated for bounded integers and matches
  // every other confirmed-safe alternation rule in the real grammar (weekday, period, which) -
  // if E1's indirection alone isn't enough, eliminating bracket-class syntax entirely from
  // date_str's transitive closure should be maximally robust against this whole bug class.
  const runProbeE2 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= digit digit digit digit "-" digit digit "-" digit digit\n' +
        'digit ::= "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"';
      appendLog('Probe E2: candidate fix - literal digit alternation, no bracket classes ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe E2: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeE2', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe E2: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeE2', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe E3 — candidate fix #3, live after E1 AND E2 both failed: E2 has ZERO bracket
  // classes (pure literal alternation) and still failed, which rules out character classes
  // as the trigger entirely. What's common to every failing case (C1, D1, D2, D3, E1, E2) is
  // the SAME rule symbol manually repeated multiple times in one flat sequence with a literal
  // wedged between repetitions. This tries a structurally different shape: wrap each
  // digit-group in its OWN named rule using the `{m,n}` repetition OPERATOR (Q1 Stage 1
  // already confirmed `{m,n}` on a named rule works - jchar{1,20} passed), so `digit` is
  // referenced only ONCE per group-rule, and date_str combines three DISTINCT symbols
  // (year/month/day) with literals - mirroring the proven-safe pattern every other field
  // assembly in the real grammar already uses (root itself, due_weekday, etc. all interleave
  // *distinct* symbols with literals without issue).
  const runProbeE3 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= year "-" month "-" day\n' +
        'year ::= digit{4,4}\n' +
        'month ::= digit{2,2}\n' +
        'day ::= digit{2,2}\n' +
        'digit ::= [0-9]';
      appendLog('Probe E3: candidate fix - {m,n} operator on named digit rule, distinct group rules ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe E3: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeE3', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe E3: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeE3', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe E4 — candidate fix #4, live after E1/E2/E3 all failed: every failure so far (C1,
  // D1, D2, D3, E1, E2, E3) has a STANDALONE literal token ("-") sitting between two rule
  // symbols in a flat sequence. This eliminates that entirely: fold the "-" INTO each
  // digit-group's own literal alternation branches (month_dash/day_dash each enumerate
  // "-01".."-12"/"-31" as complete literal strings), so date_str becomes three bare symbol
  // references back-to-back with NO separate literal term anywhere between them.
  const runProbeE4 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= year month_dash day_dash\n' +
        'year ::= [1-9] [0-9] [0-9] [0-9]\n' +
        'month_dash ::= "-01"|"-02"|"-03"|"-04"|"-05"|"-06"|"-07"|"-08"|"-09"|"-10"|"-11"|"-12"\n' +
        'day_dash ::= "-01"|"-02"|"-03"|"-04"|"-05"|"-06"|"-07"|"-08"|"-09"|"-10"|"-11"|"-12"|"-13"|"-14"|"-15"|"-16"|"-17"|"-18"|"-19"|"-20"|"-21"|"-22"|"-23"|"-24"|"-25"|"-26"|"-27"|"-28"|"-29"|"-30"|"-31"';
      appendLog('Probe E4: candidate fix - fold "-" into literal branches, no standalone literal between symbols ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe E4: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeE4', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe E4: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeE4', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe H — isolates a NEW variable Probe G's failure just exposed: `jchar{10,10}` is an
  // EXACT-count repetition (min==max). Q1 Stage 1 only ever proved `jchar{1,20}` (a real
  // range, min<max) works. E3's `digit{4,4}`/`digit{2,2}` were ALSO exact-count - a confound
  // never isolated from "multiple distinct symbols." This tests exact-count alone, on the
  // exact same jchar rule, in the exact same wrapped-by-literals position as Probe G: does
  // `jchar{1,10}` (a real range ending at 10) parse where `jchar{10,10}` (exact 10) didn't?
  const runProbeH = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= jchar{1,10}\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe H: isolating exact-count {N,N} vs a real range {1,N} ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe H: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeH', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe H: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeH', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe I — candidate fix #6, live re-test after a poisoning scare: G and H were re-run on
  // FRESH, never-before-used contexts and genuinely failed (ruling out poisoning for THOSE
  // results) - but a poison-check on a DIFFERENT screen found the near-identical
  // `root ::= "\"" jchar{1,10} "\""` PASSES fresh. The one structural difference: that passing
  // grammar has jchar{1,10} wrapped in its OWN quote literals directly inside `root`; G/H
  // delegate through a `date_str` rule whose ENTIRE body is a bare repeated symbol with NO
  // literal of its own anywhere in that rule (root supplies the quotes instead) - unlike every
  // proven-safe pattern (title/description), which always self-wrap with their own literals.
  // This mirrors the title/description shape exactly: date_str owns its own quotes.
  const runProbeI = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":" date_str "}"\n' +
        'date_str ::= "\\"" jchar{1,10} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe I: candidate fix - date_str owns its own quote literals (title/description shape) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe I: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeI', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe I: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeI', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe J — isolates the ONE remaining untested variable after I failed fresh: identical
  // rule name (date_str), identical JSON key ("date"), identical 2-level indirection
  // (root -> date_str -> jchar) as `title` (proven safe at {1,80}) - only the bound VALUE
  // changed. This is Probe I's exact grammar with {1,10} swapped for the already-proven
  // {1,20}, to find out whether "10" specifically (or that general range) is what's broken,
  // independent of every structural variable tested so far.
  const runProbeJ = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":" date_str "}"\n' +
        'date_str ::= "\\"" jchar{1,20} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe J: Probe I\'s exact grammar, only the bound changed to {1,20} ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe J: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeJ', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe J: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeJ', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe K — control test: Probe J's exact grammar (2-level indirection, {1,20}, JSON-object
  // wrapping) with the ONLY change being the identifier itself - "date"/"date_str" swapped for
  // a neutral placeholder ("foo"/"foo_str") unrelated to dates. Every structural variable
  // (bound, indirection depth, self-quoting, wrapping) has now been matched to the PROVEN-safe
  // `title` pattern and still failed - if THIS passes, the failure is somehow keyed to the
  // literal string "date"/"date_str"; if it also fails, non-determinism (not grammar shape)
  // is the better explanation, matching Q1's own noted crash-inconsistency finding.
  const runProbeK = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo_str "}"\n' +
        'foo_str ::= "\\"" jchar{1,20} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe K: control - Probe J\'s grammar, "date"/"date_str" renamed to "foo"/"foo_str" ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe K: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeK', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe K: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeK', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe L — the decisive environment check: this is Q1's ORIGINAL candidate A, byte-for-byte
  // ("title"/"title" naming, {1,80} bound) - the exact grammar the Q1 findings report says
  // "reproduced 3 times identically" as a PASS, the bedrock every other Q1 conclusion stands
  // on. If this now fails too, the problem isn't date_str's shape at all - something has
  // drifted since Q1's original session (build, device state, thermal, memory pressure) and
  // today's entire negative result set needs to be read in that light, not as a grammar-shape
  // finding.
  const runProbeL = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"title\\":" title "}"\n' +
        'title ::= "\\"" jchar{1,80} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog("Probe L: Q1's original candidate A, reproduced byte-for-byte, today's environment ...");
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Fill in JSON for: buy milk' }],
          { grammar, n_predict: 60 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe L: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeL', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe L: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeL', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe M — the final disambiguation: L (title/{1,80}) PASSED; K (foo_str/{1,20}) FAILED -
  // two variables changed at once (name AND bound), so naming was never actually isolated from
  // bound value. This is Probe K's neutral "foo"/"foo_str" naming with L's PROVEN bound {1,80}
  // substituted for {1,20} - if this passes, the bound value (not naming) is what matters, and
  // the fix is simply: give date_str a large enough bound, exactly like title's.
  const runProbeM = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo_str "}"\n' +
        'foo_str ::= "\\"" jchar{1,80} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe M: neutral naming ("foo"/"foo_str") with the proven {1,80} bound ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe M: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeM', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe M: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeM', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe N — isolates a variable never actually controlled for: `title`'s RULE NAME matches
  // its own JSON KEY exactly ("title"/"title"). Every failing case (date/date_str,
  // foo/foo_str) used a DIFFERENT rule name than its key. This is Probe M's grammar with the
  // rule renamed from "foo_str" to "foo" (matching the "foo" key exactly, mirroring title's
  // self-referential naming) - bound {1,80} and everything else held constant.
  const runProbeN = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo "}"\n' +
        'foo ::= "\\"" jchar{1,80} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe N: rule name "foo" matches its own key "foo" exactly (title-style) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe N: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeN', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe N: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeN', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe O — DIAGNOSTIC, not a candidate fix: found while reading llama.rn's source
  // (node_modules/llama.rn/src/index.ts:408) that `jinja` defaults to true and, when the
  // jinja-templated chat path fires, `jinjaResult.grammar` SILENTLY OVERWRITES whatever
  // `grammar` param we pass, if the chat template itself produces one (e.g. via tool-calling
  // template logic). Neither this harness nor Q1's original one ever set `jinja: false`. This
  // reruns Probe M's reliably-failing grammar (foo_str/{1,80}) with jinja forced off, bypassing
  // the shared runCompletion helper to add that one option - if this now passes, our grammar
  // was never reaching the native parser as our own text at all in the failing cases.
  const runProbeO = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo_str "}"\n' +
        'foo_str ::= "\\"" jchar{1,80} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe O: DIAGNOSTIC - Probe M\'s failing grammar, with jinja:false forced ...');
      try {
        const ctx = await ensureModelLoaded();
        const result = await ctx.completion({
          messages: [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          grammar,
          n_predict: 30,
          temperature: 0,
          top_k: 1,
          jinja: false,
        } as any);
        const text = (result.text ?? '').trim();
        appendLog(`Probe O: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeO', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe O: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeO', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, ensureModelLoaded]);

  // Probe P — THE FIX, validated in the actual `due_on_date` context (not a toy grammar).
  // Confirmed variable (N vs M/O): the rule referenced from its parent must be named EXACTLY
  // like its own JSON key. Renames "date_str" to "date" (matching due_on_date's `"date":` key)
  // and gives it its own quote literals (title/description shape), bound {1,10} for the
  // YYYY-MM-DD length - structure enforcement (digits, dashes, real calendar date) is left to
  // the zod validator, same as Probe G's fallback intent, but this time via the shape that's
  // actually confirmed to parse.
  const runProbeP = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"kind\\":\\"on_date\\",\\"date\\":" date "}"\n' +
        'date ::= "\\"" jchar{1,10} "\\""\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe P: THE FIX - date_str renamed to "date" (matches its own key), in due_on_date shape ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"kind":"on_date","date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe P: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeP', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe P: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeP', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe G — candidate fix #5 (fallback, live after E1-E4 ALL failed): every composed-date
  // shape tried (raw classes with literals, named classes, literal digit alternation, {m,n}
  // on distinct sub-rules, symbols with no literal between them at all) fails to parse. Every
  // *working* pattern anywhere in the real grammar has exactly ONE rule-symbol between two
  // literals - the exact shape `title`/`description` already use (`jchar{m,n}` sandwiched by
  // literals). This gives up on grammar-enforced date STRUCTURE and falls back to that proven
  // shape: an exact-length bounded jchar string, with format enforcement moved entirely to
  // the zod validator (a regex/date check) - the same "partial fallback" the Q1 report's own
  // §7 sanctioned for fields where no working constrained shape exists.
  const runProbeG = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= jchar{10,10}\n' +
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';
      appendLog('Probe G: fallback fix - bounded jchar string, structure left to the validator ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe G: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeG', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe G: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeG', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe F — the full `due` union with BOTH bugs fixed at once (days_int via Q1b Probe A's
  // digit-width alternation, date_str via Probe G's bounded-jchar fallback, since E1-E4's
  // structural fixes all failed). Reproduces Q1b Probe C's exact grammar shape, but repaired -
  // this is the end-to-end confirmation that `due` (all three non-null branches) parses and
  // generates correctly.
  const runProbeF = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = [
        'root ::= "{\\"title\\":" title ",\\"due\\":" due "}"',
        'title ::= "\\"" jchar{1,80} "\\""',
        'due ::= "null" | due_on_date | due_in_days | due_weekday',
        'due_on_date ::= "{\\"kind\\":\\"on_date\\",\\"date\\":\\"" date_str "\\"}"',
        'date_str ::= jchar{10,10}',
        'due_in_days ::= "{\\"kind\\":\\"in_days\\",\\"days\\":" days_int "}"',
        'days_int ::= d3 | d2 | d1',
        'd3 ::= [1-9] [0-9] [0-9]',
        'd2 ::= [1-9] [0-9]',
        'd1 ::= [1-9]',
        'due_weekday ::= "{\\"kind\\":\\"weekday\\",\\"day\\":" weekday ",\\"which\\":" which "}"',
        'which ::= "\\"this\\"" | "\\"next\\""',
        'weekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""',
        'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})',
      ].join('\n');
      appendLog('Probe F: full due union, both bugs fixed (days_int + date_str) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'I have to call the insurance company on 2026-08-01' }],
          { grammar, n_predict: 60 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe F: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeF', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe F: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeF', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>date_str isolation probes (Q1b follow-on)</Text>
      <Button
        title="Probe C1: date_str full shape (4-2-2, 2 seps)"
        onPress={runProbeC1}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button title="Probe D1: one separator, 2-2 groups" onPress={runProbeD1} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="Probe D2: two separators, 1-1-1 groups"
        onPress={runProbeD2}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe D3: one separator, different literal"
        onPress={runProbeD3}
        disabled={running}
      />
      <View style={{ height: 16 }} />
      <Text style={styles.title}>Candidate fixes</Text>
      <Button title="Probe E1: fix - named digit rule" onPress={runProbeE1} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe E2: fix - literal digit alternation" onPress={runProbeE2} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe E3: fix - {m,n} operator, distinct group rules" onPress={runProbeE3} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe E4: fix - fold literal into branches" onPress={runProbeE4} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe G: fallback - bounded jchar string" onPress={runProbeG} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe H: exact-count vs range isolation" onPress={runProbeH} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe I: fix - date_str owns its own quotes" onPress={runProbeI} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe J: bound value isolation ({1,20} vs {1,10})" onPress={runProbeJ} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe K: control - rename date_str to foo_str" onPress={runProbeK} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe L: reproduce Q1's candidate A exactly" onPress={runProbeL} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe M: neutral name + proven bound {1,80}" onPress={runProbeM} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe N: rule name matches its own key" onPress={runProbeN} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe O: DIAGNOSTIC - jinja:false forced" onPress={runProbeO} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe P: THE FIX, in due_on_date shape" onPress={runProbeP} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Probe F: full due union, both bugs fixed" onPress={runProbeF} disabled={running} />
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
